import { promises as fs } from "fs";
import path from "path";
import { GITHUB_NEEDS_YOU_CAP } from "./github-constants";
export { GITHUB_NEEDS_YOU_CAP };

export const CONTROL_DIR = path.join(process.cwd(), ".control");
export const INBOX_DIR = path.join(CONTROL_DIR, "github-inbox");
export const WATCH_PATH = path.join(CONTROL_DIR, "watch.json");
export const WATCH_EXAMPLE_PATH = path.join(process.cwd(), "watch.example.json");

export const GITHUB_EVENT_TYPES = [
  "pr.pushed",
  "ci.failed",
  "ci.passed",
  "review.requested",
  "review.changes_requested",
] as const;

export type GitHubEventType = (typeof GITHUB_EVENT_TYPES)[number];

export interface GitHubEventProvenance {
  url: string;
  title: string;
  kind: "pr" | "ci" | "review";
}

export interface GitHubInboxEvent {
  id: string;
  type: GitHubEventType;
  repo: string;
  pr_number: number;
  head_sha?: string;
  summary: string;
  occurred_at: string;
  provenance: GitHubEventProvenance;
  workstream_id?: string;
  /** For review.requested: Needs you if true else FYI */
  action_on_user?: boolean;
}

export interface WatchConfig {
  repo: string;
  pr: number;
  workstreamId: string;
}

export type AttentionRouting = "now" | "fyi" | "skip";

export interface GithubAttentionEffect {
  id: string;
  routing: "now" | "fyi";
  title: string;
  why: string;
  workstreamId: string;
  suggestedAction: "open" | "delegate" | "open_review" | "resume";
  provenance: {
    kind: "github";
    title: string;
    locator: string;
    excerpt: string;
    sourceId: string;
    url?: string;
    timestamp?: string;
  }[];
  createdAt: string;
  origin: "github";
  githubEventId: string;
  githubDedupeKey: string;
}

export interface GithubWorkstreamPatch {
  id: string;
  changedEntry: string;
  phase?: "Blocked" | "Human review" | "Running";
  status?: "blocked-on-you" | "running" | "default";
  next?: string;
  waitingOn?: string;
  lastActive?: string;
}

export interface GithubRoutingEffects {
  attention: GithubAttentionEffect | null;
  fyiLine: string | null;
  workstreamPatch: GithubWorkstreamPatch | null;
  capped?: boolean;
}

export interface StoredGithubInboxItem {
  id: string;
  event: GitHubInboxEvent;
  received_at: string;
  applied: boolean;
  duplicate: boolean;
  duplicate_of?: string;
  effects: GithubRoutingEffects | null;
}

const DEFAULT_WATCH: WatchConfig = {
  repo: "acme/nightingale",
  pr: 1847,
  workstreamId: "ws-cred",
};


function safeId(id: string): boolean {
  // Allow typical event ids from agents (hex, uuid, slug)
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(id);
}

function filePath(id: string) {
  if (!safeId(id)) {
    throw new Error(`Invalid inbox id: ${id}`);
  }
  return path.join(INBOX_DIR, `${id}.json`);
}

export async function ensureControlDir() {
  await fs.mkdir(CONTROL_DIR, { recursive: true });
}

export async function ensureInboxDir() {
  await ensureControlDir();
  await fs.mkdir(INBOX_DIR, { recursive: true });
}

export async function ensureWatchConfig(): Promise<WatchConfig> {
  await ensureControlDir();
  try {
    const raw = await fs.readFile(WATCH_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<WatchConfig>;
    return normalizeWatch(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  let fromExample: Partial<WatchConfig> | null = null;
  try {
    const raw = await fs.readFile(WATCH_EXAMPLE_PATH, "utf8");
    fromExample = JSON.parse(raw) as Partial<WatchConfig>;
  } catch {
    fromExample = null;
  }

  const watch = normalizeWatch(fromExample ?? DEFAULT_WATCH);
  const tmp = `${WATCH_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(watch, null, 2) + "\n", "utf8");
  await fs.rename(tmp, WATCH_PATH);
  return watch;
}

function normalizeWatch(input: Partial<WatchConfig> | null): WatchConfig {
  const repo =
    typeof input?.repo === "string" && input.repo.trim()
      ? input.repo.trim()
      : DEFAULT_WATCH.repo;
  const pr =
    typeof input?.pr === "number" && Number.isFinite(input.pr)
      ? Math.trunc(input.pr)
      : DEFAULT_WATCH.pr;
  const workstreamId =
    typeof input?.workstreamId === "string" && input.workstreamId.trim()
      ? input.workstreamId.trim()
      : DEFAULT_WATCH.workstreamId;
  return { repo, pr, workstreamId };
}

export function dedupeKey(event: {
  type: string;
  pr_number: number;
  head_sha?: string;
}): string {
  return `${event.type}|${event.pr_number}|${event.head_sha ?? ""}`;
}

export function validateGithubInboxEvent(
  body: unknown
): { ok: true; event: GitHubInboxEvent } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.id !== "string" || !b.id.trim()) {
    return { ok: false, error: "Missing or invalid id" };
  }
  if (!safeId(b.id.trim())) {
    return { ok: false, error: "Invalid id format" };
  }

  if (
    typeof b.type !== "string" ||
    !(GITHUB_EVENT_TYPES as readonly string[]).includes(b.type)
  ) {
    return {
      ok: false,
      error: `type must be one of: ${GITHUB_EVENT_TYPES.join(", ")}`,
    };
  }

  if (typeof b.repo !== "string" || !b.repo.trim()) {
    return { ok: false, error: "Missing or invalid repo" };
  }

  if (typeof b.pr_number !== "number" || !Number.isFinite(b.pr_number)) {
    return { ok: false, error: "pr_number must be a number" };
  }

  if (typeof b.summary !== "string" || !b.summary.trim()) {
    return { ok: false, error: "Missing or invalid summary" };
  }

  if (typeof b.occurred_at !== "string" || !b.occurred_at.trim()) {
    return { ok: false, error: "Missing or invalid occurred_at" };
  }

  if (!b.provenance || typeof b.provenance !== "object") {
    return { ok: false, error: "Missing provenance" };
  }
  const p = b.provenance as Record<string, unknown>;
  if (typeof p.url !== "string" || !p.url.trim()) {
    return { ok: false, error: "provenance.url required" };
  }
  if (typeof p.title !== "string" || !p.title.trim()) {
    return { ok: false, error: "provenance.title required" };
  }
  if (p.kind !== "pr" && p.kind !== "ci" && p.kind !== "review") {
    return { ok: false, error: "provenance.kind must be pr|ci|review" };
  }

  if (b.head_sha !== undefined && typeof b.head_sha !== "string") {
    return { ok: false, error: "head_sha must be a string when present" };
  }
  if (b.workstream_id !== undefined && typeof b.workstream_id !== "string") {
    return { ok: false, error: "workstream_id must be a string when present" };
  }
  if (b.action_on_user !== undefined && typeof b.action_on_user !== "boolean") {
    return { ok: false, error: "action_on_user must be a boolean when present" };
  }

  const event: GitHubInboxEvent = {
    id: b.id.trim(),
    type: b.type as GitHubEventType,
    repo: b.repo.trim(),
    pr_number: Math.trunc(b.pr_number as number),
    summary: b.summary.trim(),
    occurred_at: b.occurred_at.trim(),
    provenance: {
      url: p.url.trim(),
      title: p.title.trim(),
      kind: p.kind,
    },
  };
  if (typeof b.head_sha === "string" && b.head_sha.trim()) {
    event.head_sha = b.head_sha.trim();
  }
  if (typeof b.workstream_id === "string" && b.workstream_id.trim()) {
    event.workstream_id = b.workstream_id.trim();
  }
  if (typeof b.action_on_user === "boolean") {
    event.action_on_user = b.action_on_user;
  }

  return { ok: true, event };
}

export async function readInboxItem(
  id: string
): Promise<StoredGithubInboxItem | null> {
  try {
    const raw = await fs.readFile(filePath(id), "utf8");
    return JSON.parse(raw) as StoredGithubInboxItem;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function writeInboxItem(item: StoredGithubInboxItem) {
  await ensureInboxDir();
  const fp = filePath(item.id);
  const tmp = `${fp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(item, null, 2) + "\n", "utf8");
  await fs.rename(tmp, fp);
  return item;
}

export async function listInboxItems(): Promise<StoredGithubInboxItem[]> {
  await ensureInboxDir();
  let names: string[];
  try {
    names = await fs.readdir(INBOX_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const items: StoredGithubInboxItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(INBOX_DIR, name), "utf8");
      items.push(JSON.parse(raw) as StoredGithubInboxItem);
    } catch {
      // skip corrupt
    }
  }
  items.sort((a, b) => a.received_at.localeCompare(b.received_at));
  return items;
}

export function countGithubNeedsYou(items: StoredGithubInboxItem[]): number {
  let n = 0;
  for (const item of items) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing === "now") n += 1;
  }
  return n;
}

export function findDedupeMatch(
  items: StoredGithubInboxItem[],
  event: GitHubInboxEvent
): StoredGithubInboxItem | null {
  const key = dedupeKey(event);
  for (const item of items) {
    if (item.duplicate) continue;
    if (!item.applied) continue;
    if (item.id === event.id) return item;
    if (dedupeKey(item.event) === key) return item;
  }
  return null;
}

export function routeGithubEvent(
  event: GitHubInboxEvent,
  watch: WatchConfig,
  _existingNeedsYouFromGithub = 0
): GithubRoutingEffects {
  const workstreamId = event.workstream_id || watch.workstreamId;
  const key = dedupeKey(event);
  const attentionId = `gh-att-${event.id}`;
  const createdAt = event.occurred_at;

  const provenance = [
    {
      kind: "github" as const,
      title: event.provenance.title,
      locator: `${event.repo}#${event.pr_number}`,
      excerpt: event.summary,
      sourceId: `live-${event.pr_number}`,
      url: event.provenance.url,
      timestamp: event.occurred_at,
    },
  ];

  const makeAttention = (
    routing: "now" | "fyi",
    title: string,
    why: string
  ): GithubAttentionEffect => ({
    id: attentionId,
    routing,
    title,
    why,
    workstreamId,
    suggestedAction: "open",
    provenance,
    createdAt,
    origin: "github",
    githubEventId: event.id,
    githubDedupeKey: key,
  });

  const baseWs = (changedEntry: string): GithubWorkstreamPatch => ({
    id: workstreamId,
    changedEntry,
    lastActive: "just now",
  });

  let attention: GithubAttentionEffect | null = null;
  let fyiLine: string | null = null;
  let workstreamPatch: GithubWorkstreamPatch | null = null;

  switch (event.type) {
    case "pr.pushed": {
      // FYI only — never Needs you
      fyiLine = `GitHub · ${event.repo}#${event.pr_number}: ${event.summary}`;
      workstreamPatch = {
        ...baseWs(`PR pushed: ${event.summary}`),
        status: "default",
      };
      attention = makeAttention(
        "fyi",
        `PR pushed · ${event.repo}#${event.pr_number}`,
        event.summary
      );
      break;
    }
    case "ci.passed": {
      fyiLine = `CI passed · ${event.repo}#${event.pr_number}: ${event.summary}`;
      workstreamPatch = {
        ...baseWs(`CI passed: ${event.summary}`),
        status: "default",
        phase: "Human review",
      };
      attention = makeAttention(
        "fyi",
        `CI passed · ${event.repo}#${event.pr_number}`,
        event.summary
      );
      break;
    }
    case "ci.failed": {
      workstreamPatch = {
        ...baseWs(`CI failed: ${event.summary}`),
        phase: "Blocked",
        status: "blocked-on-you",
        waitingOn: "you",
        next: `Unblock CI on ${event.repo}#${event.pr_number}`,
      };
      attention = makeAttention(
        "now",
        `CI failed · ${event.repo}#${event.pr_number}`,
        event.summary
      );
      break;
    }
    case "review.requested": {
      if (event.action_on_user) {
        attention = makeAttention(
          "now",
          `Review requested · ${event.repo}#${event.pr_number}`,
          event.summary
        );
        workstreamPatch = {
          ...baseWs(`Review requested (needs you): ${event.summary}`),
          status: "blocked-on-you",
          waitingOn: "you",
          phase: "Human review",
        };
      } else {
        fyiLine = `Review requested (FYI) · ${event.repo}#${event.pr_number}: ${event.summary}`;
        attention = makeAttention(
          "fyi",
          `Review requested · ${event.repo}#${event.pr_number}`,
          event.summary
        );
        workstreamPatch = baseWs(
          `Review requested (FYI): ${event.summary}`
        );
      }
      break;
    }
    case "review.changes_requested": {
      attention = makeAttention(
        "now",
        `Changes requested · ${event.repo}#${event.pr_number}`,
        event.summary
      );
      workstreamPatch = {
        ...baseWs(`Changes requested: ${event.summary}`),
        phase: "Human review",
        status: "blocked-on-you",
        waitingOn: "you",
        next: `Address review on ${event.repo}#${event.pr_number}`,
      };
      break;
    }
  }

  // Cap is enforced after write via enforceGithubNeedsYouCap (older drop).
  void _existingNeedsYouFromGithub;
  return { attention, fyiLine, workstreamPatch, capped: false };
}


/**
 * Keep at most GITHUB_NEEDS_YOU_CAP GitHub Needs-you items.
 * When over cap, older GitHub Needs-you drop to FYI (ingest stays unlimited).
 */
export async function enforceGithubNeedsYouCap(
  cap: number = GITHUB_NEEDS_YOU_CAP
): Promise<StoredGithubInboxItem[]> {
  const all = await listInboxItems();
  const needsYou = all
    .filter(
      (item) =>
        item.applied &&
        !item.duplicate &&
        item.effects?.attention?.routing === "now"
    )
    .sort((a, b) => {
      const ta = a.event.occurred_at || a.received_at;
      const tb = b.event.occurred_at || b.received_at;
      return ta.localeCompare(tb);
    });

  if (needsYou.length <= cap) return all;

  const overflow = needsYou.length - cap;
  const toDemote = needsYou.slice(0, overflow);

  for (const item of toDemote) {
    if (!item.effects?.attention) continue;
    const att = item.effects.attention;
    const fyiLine =
      item.effects.fyiLine ??
      `GitHub (capped) · ${item.event.repo}#${item.event.pr_number}: ${item.event.summary}`;
    const next: StoredGithubInboxItem = {
      ...item,
      effects: {
        ...item.effects,
        capped: true,
        fyiLine,
        attention: {
          ...att,
          routing: "fyi",
          why: `${att.why} (older Needs-you demoted — GitHub cap ${cap})`,
        },
      },
    };
    await writeInboxItem(next);
  }

  return listInboxItems();
}

/**
 * Accept an event into the durable inbox and apply routing.
 * Idempotent on id; also dedupes by (type, pr_number, head_sha).
 * Malformed callers must use validateGithubInboxEvent first — this never
 * writes on invalid input (caller rejects with 4xx).
 */
export async function acceptGithubInboxEvent(
  event: GitHubInboxEvent
): Promise<{
  item: StoredGithubInboxItem;
  duplicate: boolean;
  applied: boolean;
}> {
  await ensureInboxDir();
  const watch = await ensureWatchConfig();

  const existingSameId = await readInboxItem(event.id);
  if (existingSameId) {
    return {
      item: existingSameId,
      duplicate: true,
      applied: false,
    };
  }

  const all = await listInboxItems();
  const dedupeHit = findDedupeMatch(all, event);
  if (dedupeHit) {
    const item: StoredGithubInboxItem = {
      id: event.id,
      event,
      received_at: new Date().toISOString(),
      applied: false,
      duplicate: true,
      duplicate_of: dedupeHit.id,
      effects: null,
    };
    await writeInboxItem(item);
    return { item, duplicate: true, applied: false };
  }

  const needsYou = countGithubNeedsYou(all);
  const effects = routeGithubEvent(event, watch, needsYou);
  const item: StoredGithubInboxItem = {
    id: event.id,
    event,
    received_at: new Date().toISOString(),
    applied: true,
    duplicate: false,
    effects,
  };
  await writeInboxItem(item);
  // Newest keeps Needs-you; older GitHub Needs-you drop when over cap.
  await enforceGithubNeedsYouCap();
  const refreshed = (await readInboxItem(event.id)) ?? item;
  return { item: refreshed, duplicate: false, applied: true };
}
