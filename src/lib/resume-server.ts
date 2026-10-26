/**
 * Resume (Live) — server side: gathers real sources, stores the user's last actions,
 * and caches Claude's "Next" per (workstream, activity hash) via resume_next jobs.
 * Sources: .control github/slack inbox, pr-snapshots, review jobs/results (same files the APIs serve).
 */
import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR, listInboxItems } from "./github-inbox";
import { listSlackInboxItems } from "./slack-inbox";
import { PR_SNAPSHOTS_DIR, isPrSnapshot } from "./pr-snapshot";
import { getReviewJobView } from "./review-jobs";
import {
  REVIEW_JOBS_DIR,
  REVIEW_JOB_SCHEMA,
  newReviewJobId,
  reviewJobFailPath,
  reviewResultPath,
  writeReviewJob,
} from "./review-runner";
import { isWatcherStale, readWatcherStatus } from "./watcher-status";
import { listSessions } from "./session-activity";
import {
  RESUME_KEY_RE,
  pickNewerSession,
  sessionKey,
  sessionNext,
  sessionResumeCommand,
  sessionTitle,
  activityHash,
  buildResumeContext,
  changesSince,
  deriveWorkstreams,
  groupChanges,
  prContextEvents,
  primaryAction,
  selectResume,
  type ActivityStore,
  type PrContextLike,
  type ResumeAction,
  type ResumeJobSummary,
  type SnapshotLike,
} from "./resume-core";

export const RESUME_ACTIVITY_PATH = path.join(CONTROL_DIR, "resume-activity.json");
export const RESUME_NEXT_CACHE_PATH = path.join(CONTROL_DIR, "resume-next.json");
const NEXT_STALE_MS = 6 * 60 * 1000;

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}
async function writeJsonAtomic(p: string, v: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(v, null, 2), "utf8");
  await fs.rename(tmp, p);
}

// ---------- activity (user's last action per workstream) ----------
let activityLock: Promise<unknown> = Promise.resolve();

export async function readActivity(): Promise<ActivityStore> {
  return readJson<ActivityStore>(RESUME_ACTIVITY_PATH, {});
}

const KINDS = new Set(["opened", "approved", "rejected", "edited_draft", "requested_review", "requested_draft", "resumed"]);
const DEDUPE_MS = 10 * 60 * 1000;

export function validateActivityInput(raw: unknown):
  | { ok: true; key: string; action: Omit<ResumeAction, "at"> }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "JSON object required" };
  const o = raw as Record<string, unknown>;
  const key = typeof o.key === "string" ? o.key.trim() : "";
  if (!RESUME_KEY_RE.test(key)) return { ok: false, error: "key must be pr:<owner/repo>#<n> or slack:<channel>:<ts>" };
  const kind = typeof o.kind === "string" ? o.kind : "";
  if (!KINDS.has(kind)) return { ok: false, error: `kind must be one of ${[...KINDS].join("|")}` };
  const label = typeof o.label === "string" ? o.label.trim().slice(0, 200) : "";
  if (!label) return { ok: false, error: "label required" };
  const d = o.detail && typeof o.detail === "object" ? (o.detail as Record<string, unknown>) : {};
  const detail: ResumeAction["detail"] = {};
  if (typeof d.draft === "string" && d.draft.trim()) detail.draft = d.draft.slice(0, 4000);
  if (typeof d.job_id === "string") detail.job_id = d.job_id.slice(0, 80);
  return { ok: true, key, action: { kind, label, ...(Object.keys(detail).length ? { detail } : {}) } };
}

/** Record a user action. Repeats of the same action within 10 min only refresh nothing (no Next churn). */
export async function recordActivity(key: string, action: Omit<ResumeAction, "at">, now = new Date()) {
  const run = async () => {
    const store = await readActivity();
    const rec = store[key];
    const last = rec?.last_action;
    const same = last && last.kind === action.kind && last.label === action.label && (last.detail?.draft ?? "") === (action.detail?.draft ?? "");
    if (same && now.getTime() - Date.parse(last.at) < DEDUPE_MS) return { recorded: false, record: rec };
    const a: ResumeAction = { ...action, at: now.toISOString() };
    const history = [a, ...(rec?.history || [])].slice(0, 25);
    store[key] = { key, last_action: a, history };
    await writeJsonAtomic(RESUME_ACTIVITY_PATH, store);
    return { recorded: true, record: store[key] };
  };
  const p = activityLock.then(run, run);
  activityLock = p.catch(() => undefined);
  return p;
}

// ---------- jobs ----------
function evidenceStrings(ev: unknown[] | undefined): string[] {
  return (ev || [])
    .map((e) => (typeof e === "string" ? e : e && typeof e === "object" ? String((e as Record<string, unknown>).excerpt ?? (e as Record<string, unknown>).locator ?? "") : ""))
    .filter(Boolean)
    .slice(0, 6);
}

let jobsCache: { at: number; jobs: ResumeJobSummary[] } | null = null;

export async function listJobSummaries(): Promise<ResumeJobSummary[]> {
  if (jobsCache && Date.now() - jobsCache.at < 4000) return jobsCache.jobs;
  let names: string[] = [];
  try {
    names = await fs.readdir(REVIEW_JOBS_DIR);
  } catch {
    return [];
  }
  const ids = names.filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n) && !n.endsWith(".failed.json") && !n.endsWith(".claim.json")).map((n) => n.slice(0, -5));
  const out: ResumeJobSummary[] = [];
  for (const id of ids) {
    const view = await getReviewJobView(id);
    if (!view) continue;
    const j = view.job;
    let created = "";
    let finished: string | undefined;
    try {
      created = (await fs.stat(path.join(REVIEW_JOBS_DIR, `${id}.json`))).mtime.toISOString();
    } catch {
      /* ignore */
    }
    if (view.status === "done") {
      try {
        finished = (await fs.stat(reviewResultPath(id))).mtime.toISOString();
      } catch {
        finished = created;
      }
    } else if (view.status === "failed") {
      const f = await readJson<{ failed_at?: string }>(reviewJobFailPath(id), {});
      finished = f.failed_at || created;
    }
    out.push({
      job_id: j.job_id,
      kind: j.kind || "pr_review",
      status: view.status,
      repo: j.repo,
      pr: j.pr,
      channel_id: j.channel_id,
      thread_ts: j.thread_ts,
      message_ts: j.message_ts,
      created_at: created,
      finished_at: finished,
      error: view.error,
      result_status: view.result?.status,
      summary: view.result?.summary,
      findings: view.result?.findings.map((f) => ({ title: f.title, body: f.body, evidence: evidenceStrings(f.evidence) })),
      draft_text: view.result?.draft_text,
    });
  }
  jobsCache = { at: Date.now(), jobs: out };
  return out;
}

async function listSnapshots(): Promise<SnapshotLike[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(PR_SNAPSHOTS_DIR);
  } catch {
    return [];
  }
  const out: SnapshotLike[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const raw = await readJson<unknown>(path.join(PR_SNAPSHOTS_DIR, n), null);
    if (isPrSnapshot(raw)) out.push(raw as unknown as SnapshotLike);
  }
  return out;
}

// ---------- Next cache ----------
type NextCacheEntry = { activity_hash: string; job_id: string; created_at: string; prev_job_id?: string };
type NextCache = Record<string, NextCacheEntry>;

export type ResumeNextState =
  | { status: "ok"; text: string; why?: string; job_id: string; activity_hash: string }
  | { status: "pending"; job_id: string; activity_hash: string; detail: string }
  | { status: "unavailable"; reason: string; job_id?: string; activity_hash: string };

async function jobPrContext(jobId?: string): Promise<{ pc?: PrContextLike; view?: Awaited<ReturnType<typeof getReviewJobView>> }> {
  if (!jobId) return {};
  const view = await getReviewJobView(jobId);
  return { view, pc: view?.result?.resume?.pr_context as PrContextLike | undefined };
}

async function reviewWorkerHealthy(): Promise<boolean> {
  try {
    const st = await readWatcherStatus();
    const rec = st.watchers["review-worker"];
    if (!rec) return false;
    return !isWatcherStale(rec.updated_at);
  } catch {
    return false;
  }
}

export async function getResume(opts: { ensureNext: boolean }) {
  const [githubItems, slackItems, jobs, snapshots, activity] = await Promise.all([
    listInboxItems(),
    listSlackInboxItems(),
    listJobSummaries(),
    listSnapshots(),
    readActivity(),
  ]);
  const workstreams = deriveWorkstreams({ githubItems: githubItems as never, slackItems: slackItems as never, jobs, snapshots });
  const sel = selectResume(workstreams, activity);

  // A Claude Code session newer than every GitHub/Slack event and user action wins.
  const session = pickNewerSession(await listSessions(), workstreams, activity);
  if (session) {
    const key = sessionKey(session.session_id);
    const sm = session.summary;
    return {
      ok: true as const,
      empty: false as const,
      kind: "session" as const,
      selection: {
        key,
        rule: "newer_session" as const,
        reason: `Your latest Claude Code session (${session.ended ? "ended" : "last turn"} ${session.last_event_at}) is newer than any GitHub/Slack activity`,
        others: sel ? [{ key: sel.workstream.key, title: sel.workstream.title, newCount: sel.newCount }, ...sel.others].slice(0, 3) : [],
      },
      workstream: { key, kind: "session" as const, title: sessionTitle(session), repo: session.repo?.slug },
      last_active: activity[key]?.last_action ?? null,
      session: {
        session_id: session.session_id,
        cwd: session.cwd,
        repo: session.repo ?? null,
        branch: session.branch ?? null,
        head: session.head ?? null,
        diff: session.diff ?? null,
        last_event: session.last_event,
        last_event_at: session.last_event_at,
        ended: session.ended,
        resume_command: sessionResumeCommand(session),
        summary: sm
          ? { status: sm.status, source: sm.source, text: sm.summary ?? null, tail: sm.tail ?? null, error: sm.error ?? null, running: sm.claude === "running" }
          : null,
      },
      next: sessionNext(session),
    };
  }

  if (!sel) {
    return {
      ok: true as const,
      empty: true as const,
      emptyReason:
        "Nothing in Live yet: no PR, Slack thread or worker job from the watched repo and Slack surfaces. Set them up in Get Live and start the workers.",
      counts: { workstreams: 0, githubItems: githubItems.length, slackItems: slackItems.length, jobs: jobs.length },
    };
  }
  const w = sel.workstream;
  const rec = activity[w.key];
  const snap = w.kind === "pr" ? snapshots.find((s) => `pr:${s.repo.toLowerCase()}#${s.pr}` === w.key) : undefined;
  const context = buildResumeContext(w, rec, snap);
  const hash = activityHash(w, rec?.last_action);

  const cache = await readJson<NextCache>(RESUME_NEXT_CACHE_PATH, {});
  let entry = cache[w.key];
  const baseChanges = changesSince(w, rec?.last_action.at);

  if ((!entry || entry.activity_hash !== hash) && opts.ensureNext) {
    const job_id = newReviewJobId();
    await writeReviewJob({
      schema: REVIEW_JOB_SCHEMA,
      job_id,
      kind: "resume_next",
      workstream_key: w.key,
      activity_hash: hash,
      ...(w.repo && w.pr ? { repo: w.repo, pr: w.pr } : {}),
      resume_context: {
        workstream: { key: w.key, kind: w.kind, title: w.title, url: w.url },
        selected_because: sel.reason,
        last_active_at: rec?.last_action.at ?? null,
        changes_since_last_active: baseChanges.slice(0, 25).map((e) => ({ at: e.at, kind: e.kind, label: e.label })),
        context,
      },
    });
    const prevDone = entry ? entry.job_id : undefined;
    entry = { activity_hash: hash, job_id, created_at: new Date().toISOString(), prev_job_id: prevDone ?? entry?.prev_job_id };
    cache[w.key] = entry;
    await writeJsonAtomic(RESUME_NEXT_CACHE_PATH, cache);
    jobsCache = null;
  }

  let next: ResumeNextState;
  let pc: PrContextLike | undefined;
  if (!entry || entry.activity_hash !== hash) {
    next = { status: "unavailable", reason: "Not generated yet for the latest activity", activity_hash: hash };
  } else {
    const cur = await jobPrContext(entry.job_id);
    const view = cur.view;
    pc = cur.pc;
    if (!view) {
      next = { status: "unavailable", reason: "Next job record missing", job_id: entry.job_id, activity_hash: hash };
    } else if (view.status === "done") {
      const r = view.result!;
      const text = r.resume?.next?.trim() || "";
      next =
        r.status === "ok" && text
          ? { status: "ok", text, why: r.resume?.why, job_id: entry.job_id, activity_hash: hash }
          : { status: "unavailable", reason: r.summary?.replace(/^Next unavailable\s*[—-]\s*/i, "") || "Claude returned no Next", job_id: entry.job_id, activity_hash: hash };
    } else if (view.status === "failed") {
      next = { status: "unavailable", reason: view.error || "worker job failed", job_id: entry.job_id, activity_hash: hash };
    } else {
      const age = Date.now() - Date.parse(entry.created_at);
      const healthy = await reviewWorkerHealthy();
      if (!healthy && view.status === "pending") {
        next = { status: "unavailable", reason: "review worker is not running (start ./scripts/dogfood-up); job is queued", job_id: entry.job_id, activity_hash: hash };
      } else if (age > NEXT_STALE_MS) {
        next = { status: "unavailable", reason: `no answer from the worker after ${Math.round(age / 60000)} min`, job_id: entry.job_id, activity_hash: hash };
      } else {
        next = { status: "pending", job_id: entry.job_id, activity_hash: hash, detail: view.status === "claimed" ? "Claude is writing Next…" : "Queued for the review worker…" };
      }
    }
    if (!pc && entry.prev_job_id) pc = (await jobPrContext(entry.prev_job_id)).pc;
  }

  const changes = changesSince(w, rec?.last_action.at, prContextEvents(pc));
  return {
    ok: true as const,
    empty: false as const,
    selection: { key: w.key, rule: sel.rule, reason: sel.reason, others: sel.others },
    workstream: { key: w.key, kind: w.kind, title: w.title, url: w.url, repo: w.repo, pr: w.pr, channel_id: w.channel_id, thread_ts: w.thread_ts, channel_label: w.channel_label },
    last_active: rec?.last_action ?? null,
    changes: { total: changes.length, groups: groupChanges(changes).slice(0, 8), items: changes.slice(0, 12) },
    context,
    pr_context: pc ?? null,
    next,
    primary_action: primaryAction(w, context, rec),
  };
}
