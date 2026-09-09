import { promises as fs } from "fs";
import path from "path";
import {
  CONTROL_DIR,
  ensureControlDir,
  ensureWatchConfig,
  findSlackWatchSurface,
  isSlackChannelAllowlisted,
  type SlackSurfaceKind,
  type SlackWatchSurface,
  type WatchConfig,
} from "./github-inbox";
import { NEEDS_YOU_EXTERNAL_CAP } from "./github-constants";
import {
  reviewAskAttentionId,
  reviewAskCoalesceKey,
  reviewAskTitle,
} from "./coalesce-review-ask";
import { upsertFollowFromSlackApply } from "./pr-follows";

export const SLACK_INBOX_DIR = path.join(CONTROL_DIR, "slack-inbox");

export interface SlackProvenanceEntry {
  kind: "slack" | "github";
  title: string;
  locator: string;
  excerpt: string;
  sourceId: string;
  url?: string;
  timestamp?: string;
}

export interface SlackPrLinkInboxEvent {
  /** Prefer `${channel_id}_${message_ts}` for idempotent id */
  id: string;
  type: "pr_link";
  channel_id: string;
  message_ts: string;
  permalink: string;
  text_excerpt: string;
  repo: string;
  pr_number: number;
  occurred_at: string;
  provenance: SlackProvenanceEntry[];
}

/** Durable plain message (V0.8 chip 2). Store only — no Attention Item / Needs-you. */
export interface SlackMessageInboxEvent {
  id: string;
  type: "message";
  channel_id: string;
  channel_kind: SlackSurfaceKind;
  message_ts: string;
  thread_ts?: string;
  permalink: string;
  /** Truncated ~2k */
  text_excerpt: string;
  user_id?: string;
  occurred_at: string;
  mentions_me?: boolean;
}

export type SlackInboxEvent = SlackPrLinkInboxEvent | SlackMessageInboxEvent;

export interface SlackAttentionEffect {
  id: string;
  routing: "now" | "fyi";
  title: string;
  why: string;
  workstreamId: string;
  suggestedAction: "open" | "delegate" | "open_review" | "resume";
  provenance: SlackProvenanceEntry[];
  createdAt: string;
  /** pr_link Needs-you use "external" (coalesce class) */
  origin: "slack" | "external";
  slackEventId: string;
  slackDedupeKey: string;
  /** normalize(repo)#pr for coalesce with GitHub review.requested */
  coalesceKey?: string;
}

export interface SlackNewWorkstream {
  id: string;
  name: string;
  phase: "Human review";
  objective: string;
  next: string;
  changed: string[];
  waitingOn: string;
  lastActive: string;
  checkpoint: string;
  artifacts: [];
  agentIds: [];
  status: "blocked-on-you";
  ephemeral: true;
  active: true;
}

export interface SlackWorkstreamPatch {
  id: string;
  changedEntry: string;
  /** Templated Latest line; required on every non-null workstreamPatch (chip 2). */
  checkpointLine?: string;
  phase?: "Human review" | "Blocked" | "Running";
  status?: "blocked-on-you" | "running" | "default";
  next?: string;
  waitingOn?: string;
  lastActive?: string;
}

export interface SlackRoutingEffects {
  attention: SlackAttentionEffect | null;
  fyiLine: string | null;
  workstreamPatch: SlackWorkstreamPatch | null;
  newWorkstream: SlackNewWorkstream | null;
  capped?: boolean;
  ignored?: boolean;
  ignoreReason?: string;
}

export interface StoredSlackInboxItem {
  id: string;
  event: SlackInboxEvent;
  received_at: string;
  applied: boolean;
  duplicate: boolean;
  duplicate_of?: string;
  effects: SlackRoutingEffects | null;
}

function safeId(id: string): boolean {
  // Slack ts has dots; channel ids are alphanumeric. Allow underscore.
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/.test(id);
}

function filePath(id: string) {
  if (!safeId(id)) {
    throw new Error(`Invalid slack inbox id: ${id}`);
  }
  return path.join(SLACK_INBOX_DIR, `${id}.json`);
}

export async function ensureSlackInboxDir() {
  await ensureControlDir();
  await fs.mkdir(SLACK_INBOX_DIR, { recursive: true });
}

export async function readSlackInboxItem(
  id: string
): Promise<StoredSlackInboxItem | null> {
  try {
    const raw = await fs.readFile(filePath(id), "utf8");
    return JSON.parse(raw) as StoredSlackInboxItem;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSlackInboxItem(item: StoredSlackInboxItem) {
  await ensureSlackInboxDir();
  const fp = filePath(item.id);
  const tmp = `${fp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(item, null, 2) + "\n", "utf8");
  await fs.rename(tmp, fp);
  return item;
}

export async function listSlackInboxItems(): Promise<StoredSlackInboxItem[]> {
  await ensureSlackInboxDir();
  let names: string[];
  try {
    names = await fs.readdir(SLACK_INBOX_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const items: StoredSlackInboxItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(SLACK_INBOX_DIR, name), "utf8");
      items.push(JSON.parse(raw) as StoredSlackInboxItem);
    } catch {
      // skip corrupt
    }
  }
  items.sort((a, b) => a.received_at.localeCompare(b.received_at));
  return items;
}

export function countSlackNeedsYou(items: StoredSlackInboxItem[]): number {
  let n = 0;
  for (const item of items) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing === "now") n += 1;
  }
  return n;
}

/** Parse github.com/{owner}/{repo}/pull/{N} from free text. */
export function parseGithubPrUrl(
  text: string,
  expectedRepo?: string
): { repo: string; pr_number: number } | null {
  const re =
    /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/i;
  const m = text.match(re);
  if (!m) return null;
  const repo = m[1];
  const pr_number = parseInt(m[2], 10);
  if (expectedRepo && repo.toLowerCase() !== expectedRepo.toLowerCase()) {
    return null;
  }
  return { repo, pr_number };
}

export function slackDedupeKey(event: {
  channel_id: string;
  message_ts: string;
  pr_number: number;
}): string {
  return `pr_link|${event.channel_id}|${event.message_ts}|${event.pr_number}`;
}

export function validateSlackInboxEvent(
  body: unknown
): { ok: true; event: SlackInboxEvent } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.type !== "string") {
    return { ok: false, error: "Missing or invalid type" };
  }
  if (b.type !== "pr_link" && b.type !== "message") {
    return {
      ok: false,
      error: 'type must be "pr_link" or "message"',
    };
  }

  if (typeof b.channel_id !== "string" || !b.channel_id.trim()) {
    return { ok: false, error: "Missing or invalid channel_id" };
  }
  if (typeof b.message_ts !== "string" || !b.message_ts.trim()) {
    return { ok: false, error: "Missing or invalid message_ts" };
  }

  const channel_id = b.channel_id.trim();
  const message_ts = b.message_ts.trim();
  const idRaw =
    typeof b.id === "string" && b.id.trim()
      ? b.id.trim()
      : `${channel_id}_${message_ts}`;
  const id = idRaw.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safeId(id)) {
    return { ok: false, error: "Invalid id format" };
  }

  if (typeof b.permalink !== "string" || !b.permalink.trim()) {
    return { ok: false, error: "Missing or invalid permalink" };
  }
  if (typeof b.text_excerpt !== "string") {
    return { ok: false, error: "Missing or invalid text_excerpt" };
  }
  if (typeof b.occurred_at !== "string" || !b.occurred_at.trim()) {
    return { ok: false, error: "Missing or invalid occurred_at" };
  }

  if (b.type === "message") {
    const kindRaw = b.channel_kind;
    if (kindRaw !== "channel" && kindRaw !== "im" && kindRaw !== "mpim") {
      return {
        ok: false,
        error: 'channel_kind must be "channel" | "im" | "mpim"',
      };
    }
    const channel_kind = kindRaw as SlackSurfaceKind;
    const thread_ts =
      typeof b.thread_ts === "string" && b.thread_ts.trim()
        ? b.thread_ts.trim()
        : undefined;
    const user_id =
      typeof b.user_id === "string" && b.user_id.trim()
        ? b.user_id.trim()
        : undefined;
    const mentions_me =
      typeof b.mentions_me === "boolean" ? b.mentions_me : undefined;

    const event: SlackMessageInboxEvent = {
      id,
      type: "message",
      channel_id,
      channel_kind,
      message_ts,
      ...(thread_ts ? { thread_ts } : {}),
      permalink: b.permalink.trim(),
      text_excerpt: String(b.text_excerpt).slice(0, 2000),
      ...(user_id ? { user_id } : {}),
      occurred_at: b.occurred_at.trim(),
      ...(mentions_me !== undefined ? { mentions_me } : {}),
    };
    return { ok: true, event };
  }

  // pr_link
  let repo =
    typeof b.repo === "string" && b.repo.trim() ? b.repo.trim() : "";
  let pr_number =
    typeof b.pr_number === "number" && Number.isFinite(b.pr_number)
      ? Math.trunc(b.pr_number)
      : NaN;

  if (!repo || !Number.isFinite(pr_number)) {
    const parsed =
      parseGithubPrUrl(b.text_excerpt) ||
      parseGithubPrUrl(b.permalink) ||
      (typeof b.permalink === "string" ? parseGithubPrUrl(String(b.permalink)) : null);
    if (parsed) {
      if (!repo) repo = parsed.repo;
      if (!Number.isFinite(pr_number)) pr_number = parsed.pr_number;
    }
  }

  if (!repo) {
    return { ok: false, error: "Missing repo (or parseable GitHub PR URL)" };
  }
  if (!Number.isFinite(pr_number)) {
    return {
      ok: false,
      error: "Missing pr_number (or parseable GitHub PR URL)",
    };
  }

  let provenance: SlackProvenanceEntry[] = [];
  if (Array.isArray(b.provenance)) {
    for (const entry of b.provenance) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.kind !== "slack" && e.kind !== "github") continue;
      if (typeof e.title !== "string" || typeof e.locator !== "string") continue;
      provenance.push({
        kind: e.kind,
        title: e.title,
        locator: e.locator,
        excerpt: typeof e.excerpt === "string" ? e.excerpt : "",
        sourceId: typeof e.sourceId === "string" ? e.sourceId : `slack-${id}`,
        url: typeof e.url === "string" ? e.url : undefined,
        timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined,
      });
    }
  }

  if (provenance.length === 0) {
    const ghUrl = `https://github.com/${repo}/pull/${pr_number}`;
    provenance = [
      {
        kind: "slack",
        title: "Slack PR link",
        locator: `${channel_id}/${message_ts}`,
        excerpt: String(b.text_excerpt).slice(0, 240),
        sourceId: `slack-${id}`,
        url: b.permalink.trim(),
        timestamp: b.occurred_at.trim(),
      },
      {
        kind: "github",
        title: `${repo}#${pr_number}`,
        locator: `${repo}#${pr_number}`,
        excerpt: `PR #${pr_number}`,
        sourceId: `live-${pr_number}`,
        url: ghUrl,
        timestamp: b.occurred_at.trim(),
      },
    ];
  }

  const event: SlackPrLinkInboxEvent = {
    id,
    type: "pr_link",
    channel_id,
    message_ts,
    permalink: b.permalink.trim(),
    text_excerpt: String(b.text_excerpt).slice(0, 500),
    repo,
    pr_number,
    occurred_at: b.occurred_at.trim(),
    provenance,
  };

  return { ok: true, event };
}

export function routeSlackMessageEvent(
  event: SlackMessageInboxEvent,
  watch: WatchConfig
): SlackRoutingEffects {
  const gate = isSlackChannelAllowlisted(
    watch,
    event.channel_id,
    event.channel_kind
  );
  if (!gate.allowed) {
    const surfaceIds =
      watch.slackWatch.surfaces.map((c) => c.id).join(",") || "(none)";
    return {
      attention: null,
      fyiLine: null,
      workstreamPatch: null,
      newWorkstream: null,
      ignored: true,
      ignoreReason: `channel_id ${event.channel_id} (${event.channel_kind}) not allowlisted [surfaces=${surfaceIds}; includeDms=${watch.slackWatch.includeDms}; includeMpims=${watch.slackWatch.includeMpims}]`,
    };
  }

  // Store only — chip 3 adds Needs-you rules later. No Attention Item.
  return {
    attention: null,
    fyiLine: null,
    workstreamPatch: null,
    newWorkstream: null,
    capped: false,
  };
}

export function routeSlackEvent(
  event: SlackInboxEvent,
  watch: WatchConfig
): SlackRoutingEffects {
  if (event.type === "message") {
    return routeSlackMessageEvent(event, watch);
  }

  // pr_link: only surfaces with prLinks:true (not bare includeDms/Mpims).
  const matched: SlackWatchSurface | null = findSlackWatchSurface(
    watch,
    event.channel_id
  );
  if (!matched) {
    const allowed =
      watch.slackWatch.surfaces.map((c) => c.id).join(",") || "(none)";
    return {
      attention: null,
      fyiLine: null,
      workstreamPatch: null,
      newWorkstream: null,
      ignored: true,
      ignoreReason: `channel_id ${event.channel_id} not in watch.slackWatch.surfaces [${allowed}]`,
    };
  }
  if (!matched.prLinks) {
    return {
      attention: null,
      fyiLine: null,
      workstreamPatch: null,
      newWorkstream: null,
      ignored: true,
      ignoreReason: `pr_link ignored: surface ${matched.id} has prLinks:false (message events still allowed)`,
    };
  }

  // Only PRs for watched repo
  if (event.repo.toLowerCase() !== watch.repo.toLowerCase()) {
    return {
      attention: null,
      fyiLine: null,
      workstreamPatch: null,
      newWorkstream: null,
      ignored: true,
      ignoreReason: `repo ${event.repo} != watch.repo ${watch.repo}`,
    };
  }

  const channelLabel =
    matched.name?.trim() ||
    watch.slackWatch.surfaces[0]?.name?.trim() ||
    "#control-e2e";
  const why = `Review ask in ${channelLabel}`;
  const key = slackDedupeKey(event);
  const coalesceKey = reviewAskCoalesceKey(event.repo, event.pr_number);
  const attentionId = reviewAskAttentionId(event.repo, event.pr_number);

  const ghUrl = `https://github.com/${event.repo}/pull/${event.pr_number}`;
  let provenance = [...event.provenance];
  const hasSlack = provenance.some((p) => p.kind === "slack");
  const hasGh = provenance.some((p) => p.kind === "github");
  if (!hasSlack) {
    provenance = [
      {
        kind: "slack",
        title: `Slack · ${channelLabel}`,
        locator: `${event.channel_id}/${event.message_ts}`,
        excerpt: event.text_excerpt,
        sourceId: `slack-${event.id}`,
        url: event.permalink,
        timestamp: event.occurred_at,
      },
      ...provenance,
    ];
  }
  if (!hasGh) {
    provenance = [
      ...provenance,
      {
        kind: "github",
        title: `${event.repo}#${event.pr_number}`,
        locator: `${event.repo}#${event.pr_number}`,
        excerpt: `PR #${event.pr_number}`,
        sourceId: `live-${event.pr_number}`,
        url: ghUrl,
        timestamp: event.occurred_at,
      },
    ];
  }

  const repoPr = `${event.repo}#${event.pr_number}`;
  let workstreamId: string;
  let workstreamPatch: SlackWorkstreamPatch | null = null;
  let newWorkstream: SlackNewWorkstream | null = null;

  if (event.pr_number === watch.pr) {
    const checkpointLine = `Slack ask in ${channelLabel} linked ${repoPr}. Next: review that PR.`;
    workstreamId = watch.workstreamId;
    workstreamPatch = {
      id: workstreamId,
      changedEntry: `Slack review ask in ${channelLabel} · PR #${event.pr_number}`,
      checkpointLine,
      phase: "Human review",
      status: "blocked-on-you",
      waitingOn: "you",
      next: `Review PR #${event.pr_number} from Slack ask`,
      lastActive: "just now",
    };
  } else {
    const checkpointLine = `Slack ask in ${channelLabel} linked ${repoPr}. Ephemeral review stream.`;
    workstreamId = `ws-review-${event.repo.replace(/[^a-zA-Z0-9]+/g, "-")}-${event.pr_number}`;
    newWorkstream = {
      id: workstreamId,
      name: `Review · ${repoPr}`,
      phase: "Human review",
      objective: `Review ask from ${channelLabel} for ${repoPr}`,
      next: `Open PR #${event.pr_number}`,
      changed: [`Slack review ask in ${channelLabel}`],
      waitingOn: "you",
      lastActive: "just now",
      checkpoint: `Review ask from ${channelLabel}.\n\nLatest: ${checkpointLine}`,
      artifacts: [],
      agentIds: [],
      status: "blocked-on-you",
      ephemeral: true,
      active: true,
    };
  }

  const attention: SlackAttentionEffect = {
    id: attentionId,
    routing: "now",
    title: reviewAskTitle(event.repo, event.pr_number),
    why,
    workstreamId,
    suggestedAction: "open",
    provenance,
    createdAt: event.occurred_at,
    origin: "external",
    slackEventId: event.id,
    slackDedupeKey: key,
    coalesceKey,
  };

  return {
    attention,
    fyiLine: null,
    workstreamPatch,
    newWorkstream,
    capped: false,
  };
}

export async function demoteSlackNeedsYouItem(
  item: StoredSlackInboxItem,
  cap: number
): Promise<void> {
  if (!item.effects?.attention) return;
  const att = item.effects.attention;
  const evt = item.event;
  const fyiLine =
    item.effects.fyiLine ??
    (evt.type === "pr_link"
      ? `Slack (capped) · ${evt.repo}#${evt.pr_number}: ${evt.text_excerpt}`
      : `Slack (capped) · ${evt.channel_id}: ${evt.text_excerpt}`);
  const next: StoredSlackInboxItem = {
    ...item,
    effects: {
      ...item.effects,
      capped: true,
      fyiLine,
      attention: {
        ...att,
        routing: "fyi",
        why: `${att.why} (older Needs-you demoted — external cap ${cap})`,
      },
    },
  };
  await writeSlackInboxItem(next);
}

export function messageDedupeKey(event: {
  channel_id: string;
  message_ts: string;
}): string {
  return `message|${event.channel_id}|${event.message_ts}`;
}

export function findSlackDedupeMatch(
  items: StoredSlackInboxItem[],
  event: SlackInboxEvent
): StoredSlackInboxItem | null {
  for (const item of items) {
    if (item.duplicate) continue;
    if (!item.applied) continue;
    if (item.id === event.id) return item;
    if (event.type === "pr_link" && item.event.type === "pr_link") {
      if (slackDedupeKey(item.event) === slackDedupeKey(event)) return item;
    }
    if (event.type === "message" && item.event.type === "message") {
      if (messageDedupeKey(item.event) === messageDedupeKey(event)) return item;
    }
  }
  return null;
}

/**
 * Accept a Slack inbox event (pr_link | message). No Slack token in Control.
 * Wrong channel / wrong repo / prLinks:false → stored applied=false (ignored).
 * message: durable store only — no Attention Item.
 */
export async function acceptSlackInboxEvent(
  event: SlackInboxEvent
): Promise<{
  item: StoredSlackInboxItem;
  duplicate: boolean;
  applied: boolean;
}> {
  await ensureSlackInboxDir();
  const watch = await ensureWatchConfig();

  const existingSameId = await readSlackInboxItem(event.id);
  if (existingSameId) {
    return {
      item: existingSameId,
      duplicate: true,
      applied: false,
    };
  }

  const all = await listSlackInboxItems();
  const dedupeHit = findSlackDedupeMatch(all, event);
  if (dedupeHit) {
    const item: StoredSlackInboxItem = {
      id: event.id,
      event,
      received_at: new Date().toISOString(),
      applied: false,
      duplicate: true,
      duplicate_of: dedupeHit.id,
      effects: null,
    };
    await writeSlackInboxItem(item);
    return { item, duplicate: true, applied: false };
  }

  const effects = routeSlackEvent(event, watch);

  if (effects.ignored) {
    const item: StoredSlackInboxItem = {
      id: event.id,
      event,
      received_at: new Date().toISOString(),
      applied: false,
      duplicate: false,
      effects,
    };
    await writeSlackInboxItem(item);
    return { item, duplicate: false, applied: false };
  }

  const item: StoredSlackInboxItem = {
    id: event.id,
    event,
    received_at: new Date().toISOString(),
    applied: true,
    duplicate: false,
    effects,
  };
  await writeSlackInboxItem(item);

  // Chip 4: upsert PR follow for non-primary Slack-discovered PRs (server-side).
  // Primary watch.pr is never stored as a follow; wrong repo already ignored above.
  // Plain message events never create follows or Needs-you (chip 3).
  if (event.type === "pr_link") {
    const followWsId =
      effects.newWorkstream?.id ??
      effects.attention?.workstreamId ??
      effects.workstreamPatch?.id;
    if (
      followWsId &&
      event.pr_number !== watch.pr &&
      event.repo.toLowerCase() === watch.repo.toLowerCase()
    ) {
      await upsertFollowFromSlackApply({
        repo: event.repo,
        pr: event.pr_number,
        slack_event_id: event.id,
        workstreamId: followWsId,
        watch,
      });
    }

    const { enforceExternalNeedsYouCap } = await import("./needs-you-cap");
    await enforceExternalNeedsYouCap(NEEDS_YOU_EXTERNAL_CAP);
  }

  const refreshed = (await readSlackInboxItem(event.id)) ?? item;
  return { item: refreshed, duplicate: false, applied: true };
}
