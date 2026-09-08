import { promises as fs } from "fs";
import path from "path";
import {
  CONTROL_DIR,
  ensureControlDir,
  ensureWatchConfig,
  type WatchConfig,
} from "./github-inbox";
import { NEEDS_YOU_EXTERNAL_CAP } from "./github-constants";

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

export interface SlackInboxEvent {
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

export interface SlackAttentionEffect {
  id: string;
  routing: "now" | "fyi";
  title: string;
  why: string;
  workstreamId: string;
  suggestedAction: "open" | "delegate" | "open_review" | "resume";
  provenance: SlackProvenanceEntry[];
  createdAt: string;
  origin: "slack";
  slackEventId: string;
  slackDedupeKey: string;
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

  if (typeof b.type !== "string" || b.type !== "pr_link") {
    return { ok: false, error: 'type must be "pr_link"' };
  }

  if (typeof b.channel_id !== "string" || !b.channel_id.trim()) {
    return { ok: false, error: "Missing or invalid channel_id" };
  }
  if (typeof b.message_ts !== "string" || !b.message_ts.trim()) {
    return { ok: false, error: "Missing or invalid message_ts" };
  }

  const channel_id = b.channel_id.trim();
  const message_ts = b.message_ts.trim();
  // Idempotent id: channel_ts
  const idRaw =
    typeof b.id === "string" && b.id.trim()
      ? b.id.trim()
      : `${channel_id}_${message_ts}`;
  // Sanitize dots in ts for filesystem-safe id (keep original message_ts on event)
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

  let repo =
    typeof b.repo === "string" && b.repo.trim() ? b.repo.trim() : "";
  let pr_number =
    typeof b.pr_number === "number" && Number.isFinite(b.pr_number)
      ? Math.trunc(b.pr_number)
      : NaN;

  // Allow deriving repo/pr from text_excerpt or permalink if omitted
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

  // Ensure dual provenance defaults when not provided
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

  const event: SlackInboxEvent = {
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

export function routeSlackEvent(
  event: SlackInboxEvent,
  watch: WatchConfig
): SlackRoutingEffects {
  // Wrong channel → ignore
  if (event.channel_id !== watch.slackPrChannelId) {
    return {
      attention: null,
      fyiLine: null,
      workstreamPatch: null,
      newWorkstream: null,
      ignored: true,
      ignoreReason: `channel_id ${event.channel_id} != watch.slackPrChannelId ${watch.slackPrChannelId}`,
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
    watch.slackPrChannelName?.trim() || "#control-e2e";
  const why = `Review ask in ${channelLabel} · PR #${event.pr_number}`;
  const key = slackDedupeKey(event);
  const attentionId = `slack-att-${event.id}`;

  // Ensure dual provenance
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
    title: `Review ask · ${event.repo}#${event.pr_number}`,
    why,
    workstreamId,
    suggestedAction: "open",
    provenance,
    createdAt: event.occurred_at,
    origin: "slack",
    slackEventId: event.id,
    slackDedupeKey: key,
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
  const fyiLine =
    item.effects.fyiLine ??
    `Slack (capped) · ${item.event.repo}#${item.event.pr_number}: ${item.event.text_excerpt}`;
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

export function findSlackDedupeMatch(
  items: StoredSlackInboxItem[],
  event: SlackInboxEvent
): StoredSlackInboxItem | null {
  const key = slackDedupeKey(event);
  for (const item of items) {
    if (item.duplicate) continue;
    if (!item.applied) continue;
    if (item.id === event.id) return item;
    if (slackDedupeKey(item.event) === key) return item;
  }
  return null;
}

/**
 * Accept a Slack PR-link event. No Slack token in Control.
 * Wrong channel / wrong repo → stored applied=false (ignored).
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

  const { enforceExternalNeedsYouCap } = await import("./needs-you-cap");
  await enforceExternalNeedsYouCap(NEEDS_YOU_EXTERNAL_CAP);

  const refreshed = (await readSlackInboxItem(event.id)) ?? item;
  return { item: refreshed, duplicate: false, applied: true };
}
