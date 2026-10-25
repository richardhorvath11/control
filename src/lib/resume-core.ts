/**
 * Resume (Live) — pure core. No fs, no fetch: unit-testable (scripts/smoke-resume.ts).
 *
 * Workstreams are DERIVED from Live data (no seeded ids):
 *   pr:<owner/repo>#<n>         ← GitHub inbox events, Slack pr_link events, pr_review jobs, PR snapshots
 *   slack:<channel>:<thread_ts> ← actionable Slack messages (+ replies in that thread), slack_draft jobs
 * "Last active" = the user's last recorded action on a workstream (server store, see resume-server.ts).
 */

export type ResumeEventKind =
  | "review_request"
  | "slack_message"
  | "slack_reply"
  | "pr_event"
  | "pr_updated"
  | "job_done"
  | "job_failed"
  | "pr_comment"
  | "pr_review";

export interface ResumeEvent {
  id: string;
  at: string; // ISO
  kind: ResumeEventKind;
  label: string;
  url?: string;
}

export interface ResumeFinding {
  title: string;
  body: string;
  evidence: string[];
}

export interface ResumeJobSummary {
  job_id: string;
  kind: string;
  status: "pending" | "claimed" | "done" | "failed";
  repo?: string;
  pr?: number;
  channel_id?: string;
  thread_ts?: string;
  message_ts?: string;
  created_at: string;
  finished_at?: string;
  error?: string;
  result_status?: "ok" | "error";
  summary?: string;
  findings?: ResumeFinding[];
  draft_text?: string;
}

export interface ResumeAction {
  kind: string; // opened | approved | rejected | edited_draft | requested_review | requested_draft | resumed
  label: string;
  at: string;
  detail?: { draft?: string; job_id?: string };
}

export interface ActivityRecord {
  key: string;
  last_action: ResumeAction;
  history: ResumeAction[];
}

export type ActivityStore = Record<string, ActivityRecord>;

export interface SlackLine {
  at: string;
  text: string;
  permalink?: string;
  channel_label?: string;
  why?: string;
}

export interface DerivedWorkstream {
  key: string;
  kind: "pr" | "slack";
  title: string;
  url?: string;
  repo?: string;
  pr?: number;
  channel_id?: string;
  thread_ts?: string;
  channel_label?: string;
  events: ResumeEvent[];
  jobs: ResumeJobSummary[];
  slack: SlackLine[];
  lastEventAt: string;
}

/** Minimal shapes of the durable inbox items we read (subset of github-inbox / slack-inbox). */
export interface GhItemLike {
  id: string;
  applied: boolean;
  event: { id: string; type: string; repo: string; pr_number: number; summary: string; occurred_at: string; provenance?: { url?: string }; requested_user?: string; team_slug?: string };
  effects?: { ignored?: boolean } | null;
}
export interface SlackItemLike {
  id: string;
  applied: boolean;
  event: {
    id: string;
    type: "pr_link" | "message";
    channel_id: string;
    message_ts: string;
    thread_ts?: string;
    permalink?: string;
    text_excerpt: string;
    occurred_at: string;
    repo?: string;
    pr_number?: number;
  };
  effects?: {
    ignored?: boolean;
    muted?: boolean;
    attention?: { why?: string; provenance?: { title?: string }[] } | null;
  } | null;
}
export interface SnapshotLike {
  repo: string;
  pr: number;
  title: string;
  url: string;
  head_sha: string;
  ci: { conclusion: string; url?: string };
  files: { path: string; status: string }[];
  requested_reviewers: { users: string[]; teams: string[] };
  updated_at: string;
}

export function normRepo(r: string): string {
  return r.trim().toLowerCase();
}
export function prKey(repo: string, pr: number): string {
  return `pr:${normRepo(repo)}#${Math.trunc(pr)}`;
}
export function slackKey(channel: string, threadTs: string): string {
  return `slack:${channel}:${threadTs}`;
}
export const RESUME_KEY_RE = /^(pr:[a-z0-9_.-]+\/[a-z0-9_.-]+#\d+|slack:[A-Z0-9]+:\d+\.\d+)$/;

const NON_WORK_JOB_KINDS = new Set(["verify", "resume_next"]);

function ts(at: string | undefined): number {
  const n = at ? Date.parse(at) : NaN;
  return Number.isFinite(n) ? n : 0;
}
function clip(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function channelLabelOf(item: SlackItemLike): string | undefined {
  const t = item.effects?.attention?.provenance?.[0]?.title;
  return t ? t.replace(/^Slack\s*·\s*/i, "").trim() : undefined;
}

export function deriveWorkstreams(input: {
  githubItems: GhItemLike[];
  slackItems: SlackItemLike[];
  jobs: ResumeJobSummary[];
  snapshots: SnapshotLike[];
}): DerivedWorkstream[] {
  const map = new Map<string, DerivedWorkstream>();
  const get = (key: string, init: () => Omit<DerivedWorkstream, "events" | "jobs" | "slack" | "lastEventAt">) => {
    let w = map.get(key);
    if (!w) {
      w = { ...init(), events: [], jobs: [], slack: [], lastEventAt: "" };
      map.set(key, w);
    }
    return w;
  };
  const prInit = (repo: string, pr: number) => () => ({
    key: prKey(repo, pr),
    kind: "pr" as const,
    title: `${normRepo(repo)}#${pr}`,
    url: `https://github.com/${normRepo(repo)}/pull/${pr}`,
    repo: normRepo(repo),
    pr,
  });

  for (const s of input.snapshots) {
    const w = get(prKey(s.repo, s.pr), prInit(s.repo, s.pr));
    if (s.title) w.title = `${s.title} (${normRepo(s.repo)}#${s.pr})`;
    if (s.url) w.url = s.url;
    w.events.push({
      id: `snap:${s.head_sha.slice(0, 7)}:${s.ci?.conclusion}`,
      at: s.updated_at,
      kind: "pr_updated",
      label: `PR state · head ${s.head_sha.slice(0, 7)} · CI ${s.ci?.conclusion || "unknown"}`,
      url: s.ci?.url || s.url,
    });
  }

  for (const it of input.githubItems) {
    if (!it.applied || it.effects?.ignored) continue;
    const e = it.event;
    const w = get(prKey(e.repo, e.pr_number), prInit(e.repo, e.pr_number));
    w.events.push({
      id: `gh:${e.id}`,
      at: e.occurred_at,
      kind: e.type === "review.requested" ? "review_request" : "pr_event",
      label: clip(e.summary || e.type, 140),
      url: e.provenance?.url,
    });
  }

  // Slack: pr_link first (attach to PR), then actionable messages; replies join existing threads.
  const msgs: SlackItemLike[] = [];
  for (const it of input.slackItems) {
    if (!it.applied || it.effects?.ignored || it.effects?.muted) continue;
    if (isFixturePermalink(it.event.permalink)) continue; // QA fixtures, not a real workspace
    const e = it.event;
    if (e.type === "pr_link" && e.repo && e.pr_number) {
      const w = get(prKey(e.repo, e.pr_number), prInit(e.repo, e.pr_number));
      const label = channelLabelOf(it);
      w.events.push({
        id: `slack:${e.id}`,
        at: e.occurred_at,
        kind: "review_request",
        label: `Review ask in Slack${label ? ` (${label})` : ""}: “${clip(e.text_excerpt, 100)}”`,
        url: e.permalink,
      });
      w.slack.push({ at: e.occurred_at, text: clip(e.text_excerpt, 400), permalink: e.permalink, channel_label: label });
    } else if (e.type === "message") {
      msgs.push(it);
    }
  }
  msgs.sort((a, b) => ts(a.event.occurred_at) - ts(b.event.occurred_at));
  for (const it of msgs) {
    const e = it.event;
    const root = e.thread_ts || e.message_ts;
    const key = slackKey(e.channel_id, root);
    const actionable = !!it.effects?.attention;
    if (!actionable && !map.has(key)) continue; // non-actionable chatter does not create a workstream
    const label = channelLabelOf(it);
    const w = get(key, () => ({
      key,
      kind: "slack" as const,
      title: `${label || e.channel_id}: “${clip(e.text_excerpt, 60)}”`,
      url: e.permalink,
      channel_id: e.channel_id,
      thread_ts: root,
      channel_label: label,
    }));
    const isReply = !!e.thread_ts && e.thread_ts !== e.message_ts;
    w.events.push({
      id: `slack:${e.id}`,
      at: e.occurred_at,
      kind: isReply ? "slack_reply" : "slack_message",
      label: `${isReply ? "Reply" : "Message"}${label ? ` in ${label}` : ""}: “${clip(e.text_excerpt, 100)}”`,
      url: e.permalink,
    });
    w.slack.push({ at: e.occurred_at, text: clip(e.text_excerpt, 400), permalink: e.permalink, channel_label: label, why: it.effects?.attention?.why });
  }

  for (const j of input.jobs) {
    if (NON_WORK_JOB_KINDS.has(j.kind)) continue;
    let w: DerivedWorkstream | undefined;
    if (j.kind === "pr_review" && j.repo && j.pr) {
      w = get(prKey(j.repo, j.pr), prInit(j.repo, j.pr));
    } else if (j.kind === "slack_draft" && j.channel_id) {
      const root = j.thread_ts || j.message_ts || "";
      if (!root) continue;
      w = map.get(slackKey(j.channel_id, root));
      if (!w) continue; // a draft for a thread we can't see in the inbox: no context to resume
    }
    if (!w) continue;
    w.jobs.push(j);
    if (j.status === "done" || j.status === "failed") {
      const what = j.kind === "pr_review" ? "Review" : "Draft reply";
      const failed = j.status === "failed" || j.result_status === "error";
      w.events.push({
        id: `job:${j.job_id}:${j.status}`,
        at: j.finished_at || j.created_at,
        kind: failed ? "job_failed" : "job_done",
        label: failed
          ? `${what} job failed: ${clip(j.error || j.summary || "unknown error", 120)}`
          : j.kind === "pr_review"
            ? `Review finished · ${j.findings?.length ?? 0} finding(s)`
            : "Draft reply ready",
      });
    }
  }

  const out = [...map.values()];
  for (const w of out) {
    w.events.sort((a, b) => ts(b.at) - ts(a.at));
    w.jobs.sort((a, b) => ts(b.finished_at || b.created_at) - ts(a.finished_at || a.created_at));
    w.slack.sort((a, b) => ts(b.at) - ts(a.at));
    w.lastEventAt = w.events[0]?.at || "";
  }
  return out.filter((w) => w.events.length > 0);
}

/** Events strictly after `since` (all when the user never acted on it), newest first. */
export function changesSince(w: DerivedWorkstream, since?: string, extra: ResumeEvent[] = []): ResumeEvent[] {
  const s = ts(since);
  return [...w.events, ...extra]
    .filter((e) => !since || ts(e.at) > s)
    .sort((a, b) => ts(b.at) - ts(a.at));
}

export interface ChangeGroup {
  kind: ResumeEventKind;
  count: number;
  latest: ResumeEvent;
}
/** Collapse repeats (e.g. 12 "Review finished") into one line per kind, newest first. */
export function groupChanges(events: ResumeEvent[]): ChangeGroup[] {
  const g = new Map<ResumeEventKind, ChangeGroup>();
  for (const e of events) {
    const cur = g.get(e.kind);
    if (!cur) g.set(e.kind, { kind: e.kind, count: 1, latest: e });
    else {
      cur.count++;
      if (ts(e.at) > ts(cur.latest.at)) cur.latest = e;
    }
  }
  return [...g.values()].sort((a, b) => ts(b.latest.at) - ts(a.latest.at));
}

export interface ResumeSelection {
  workstream: DerivedWorkstream;
  reason: string;
  rule: "most_recently_touched" | "most_new_activity";
  newCount: number;
  others: { key: string; title: string; newCount: number; lastActiveAt?: string }[];
}

/** Slack QA fixtures carry example.slack.com permalinks — not a real workspace, never a workstream. */
export function isFixturePermalink(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "example.slack.com";
  } catch {
    return false;
  }
}

/**
 * Activity score for rule 2: external events (PR comments, review requests, Slack messages/replies,
 * PR updates) count one each; our own worker job outcomes count once per kind, so re-runs can't
 * outweigh real activity.
 */
export function activityScore(changes: ResumeEvent[]): number {
  const jobKinds = new Set<string>();
  let n = 0;
  for (const c of changes) {
    if (c.kind === "job_done" || c.kind === "job_failed") jobKinds.add(c.kind);
    else n++;
  }
  return n + jobKinds.size;
}

/**
 * Rule 1: the workstream the user touched most recently (last recorded action), if any.
 * Rule 2 (nothing touched yet): the one with the most new activity; ties → newest event.
 */
export function selectResume(ws: DerivedWorkstream[], activity: ActivityStore): ResumeSelection | null {
  if (!ws.length) return null;
  const scored = ws.map((w) => {
    const last = activity[w.key]?.last_action;
    const ch = changesSince(w, last?.at);
    return { w, last, newCount: ch.length, score: activityScore(ch) };
  });
  const touched = scored.filter((s) => s.last).sort((a, b) => ts(b.last!.at) - ts(a.last!.at));
  let pick: (typeof scored)[number];
  let rule: ResumeSelection["rule"];
  let reason: string;
  if (touched.length) {
    pick = touched[0];
    rule = "most_recently_touched";
    reason = `You last worked on this: ${pick.last!.label}`;
  } else {
    pick = [...scored].sort((a, b) => b.score - a.score || ts(b.w.lastEventAt) - ts(a.w.lastEventAt))[0];
    rule = "most_new_activity";
    reason = `Most new activity (${pick.score} distinct update${pick.score === 1 ? "" : "s"}) — you haven't opened anything in Live yet`;
  }
  const others = scored
    .filter((s) => s !== pick && s.newCount > 0)
    .sort((a, b) => ts(b.w.lastEventAt) - ts(a.w.lastEventAt))
    .slice(0, 3)
    .map((s) => ({ key: s.w.key, title: s.w.title, newCount: s.newCount, lastActiveAt: s.last?.at }));
  return { workstream: pick.w, reason, rule, newCount: pick.newCount, others };
}

/** FNV-1a 32-bit hex — stable, no crypto dependency. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Cache key for the Claude "Next" line: changes when activity or the user's last action changes. */
export function activityHash(w: DerivedWorkstream, last?: ResumeAction): string {
  const parts = w.events.map((e) => `${e.id}@${e.at}`).sort();
  parts.push(`last:${last?.kind ?? "-"}:${last?.label ?? "-"}:${last?.at ?? "-"}`);
  return fnv1a(parts.join("|"));
}

export interface ResumeOpenItem {
  label: string;
  severity: "blocking" | "open" | "info";
  url?: string;
}

export interface ResumeContext {
  what: {
    kind: "pr" | "slack";
    title: string;
    url?: string;
    repo?: string;
    pr?: number;
    head_sha?: string;
    files?: { path: string; status: string }[];
    channel_label?: string;
  };
  left_off: {
    last_action?: ResumeAction;
    user_draft?: string;
    latest_review?: { job_id: string; at: string; summary: string; findings: ResumeFinding[]; draft_text?: string };
    latest_draft_reply?: { job_id: string; at: string; draft_text: string };
  };
  open: ResumeOpenItem[];
  slack: SlackLine[];
}

const ACTED = new Set(["approved", "rejected"]);

export function buildResumeContext(w: DerivedWorkstream, rec: ActivityRecord | undefined, snap?: SnapshotLike): ResumeContext {
  const last = rec?.last_action;
  const userDraft = rec?.history.find((h) => h.kind === "edited_draft" && h.detail?.draft)?.detail?.draft;
  const ctx: ResumeContext = {
    what: { kind: w.kind, title: w.title, url: w.url, repo: w.repo, pr: w.pr, channel_label: w.channel_label },
    left_off: { last_action: last, user_draft: userDraft },
    open: [],
    slack: w.slack.slice(0, 5),
  };
  if (snap) {
    ctx.what.head_sha = snap.head_sha;
    ctx.what.files = snap.files;
    const c = (snap.ci?.conclusion || "UNKNOWN").toUpperCase();
    ctx.open.push({
      label: `CI ${c} on ${snap.head_sha.slice(0, 7)}`,
      severity: c === "SUCCESS" ? "info" : c === "PENDING" ? "open" : "blocking",
      url: snap.ci?.url,
    });
    const rr = [...(snap.requested_reviewers?.users || []), ...(snap.requested_reviewers?.teams || []).map((t) => `team ${t}`)];
    ctx.open.push(
      rr.length
        ? { label: `Waiting on requested reviewer(s): ${rr.join(", ")}`, severity: "open" }
        : { label: "No reviewers requested on the PR", severity: "info" }
    );
  }
  const review = w.jobs.find((j) => j.kind === "pr_review" && j.status === "done" && j.result_status !== "error");
  if (review) {
    ctx.left_off.latest_review = {
      job_id: review.job_id,
      at: review.finished_at || review.created_at,
      summary: review.summary || "",
      findings: review.findings || [],
      draft_text: review.draft_text,
    };
    const actedAfter = rec?.history.some((h) => ACTED.has(h.kind) && ts(h.at) > ts(review.finished_at || review.created_at));
    if ((review.findings?.length ?? 0) > 0 && !actedAfter) {
      ctx.open.push({ label: `${review.findings!.length} review finding(s) not yet approved or rejected`, severity: "open" });
    }
  }
  const draft = w.jobs.find((j) => j.kind === "slack_draft" && j.status === "done" && j.draft_text);
  if (draft) {
    ctx.left_off.latest_draft_reply = { job_id: draft.job_id, at: draft.finished_at || draft.created_at, draft_text: draft.draft_text! };
  }
  const latestJob = w.jobs[0];
  if (latestJob && (latestJob.status === "failed" || latestJob.result_status === "error")) {
    ctx.open.push({ label: `Latest worker job failed: ${clip(latestJob.error || latestJob.summary || "", 160)}`, severity: "blocking" });
  }
  if (latestJob && (latestJob.status === "pending" || latestJob.status === "claimed")) {
    ctx.open.push({ label: `A ${latestJob.kind === "pr_review" ? "review" : "draft"} job is still running`, severity: "info" });
  }
  if (w.kind === "slack") {
    const newest = w.slack[0];
    const answered = rec?.history.some((h) => h.kind === "approved" && ts(h.at) > ts(newest?.at));
    if (newest && /\?\s*$/.test(newest.text) && !answered) {
      ctx.open.push({ label: `Unanswered question: “${clip(newest.text, 120)}”`, severity: "open", url: newest.permalink });
    }
  }
  return ctx;
}

export type ResumePrimaryAction =
  | { kind: "open_review"; label: string; job_id: string }
  | { kind: "open_draft"; label: string; job_id: string }
  | { kind: "focus"; label: string };

/** Resume does the next step: a pending (un-acted) review / draft reply, else Focus. Never sends. */
export function primaryAction(w: DerivedWorkstream, ctx: ResumeContext, rec?: ActivityRecord): ResumePrimaryAction {
  const after = (at: string) => rec?.history.some((h) => ACTED.has(h.kind) && ts(h.at) > ts(at));
  const r = ctx.left_off.latest_review;
  if (r && r.findings.length > 0 && !after(r.at)) {
    return { kind: "open_review", label: `Open review (${r.findings.length} finding${r.findings.length === 1 ? "" : "s"})`, job_id: r.job_id };
  }
  const d = ctx.left_off.latest_draft_reply;
  if (d && !after(d.at)) return { kind: "open_draft", label: "Open draft reply", job_id: d.job_id };
  return { kind: "focus", label: "Start focus on this" };
}

/** Extra "changed" events from the worker's gh fetch (comments / reviews newer than last active). */
export function prContextEvents(pc: PrContextLike | undefined): ResumeEvent[] {
  if (!pc) return [];
  const ev: ResumeEvent[] = [];
  for (const c of pc.comments || []) {
    if (!c.created_at) continue;
    ev.push({ id: `ghc:${c.url || c.created_at}`, at: c.created_at, kind: "pr_comment", label: `Comment by ${c.author || "someone"}: “${clip(c.body, 100)}”`, url: c.url });
  }
  for (const r of pc.reviews || []) {
    if (!r.submitted_at) continue;
    ev.push({ id: `ghr:${r.author}:${r.submitted_at}`, at: r.submitted_at, kind: "pr_review", label: `${r.author || "Reviewer"} ${String(r.state || "").toLowerCase().replace(/_/g, " ")}${r.body ? `: “${clip(r.body, 80)}”` : ""}` });
  }
  return ev;
}

export interface PrContextLike {
  error?: string;
  state?: string;
  review_decision?: string;
  review_requests?: string[];
  checks?: { name: string; state: string; url?: string }[];
  comments?: { author?: string; body: string; created_at?: string; url?: string }[];
  reviews?: { author?: string; state?: string; body?: string; submitted_at?: string }[];
  hunks?: { file: string; line: number; finding?: string; header: string; text: string }[];
  fetched_at?: string;
}
