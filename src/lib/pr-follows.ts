/**
 * V0.6 chip 4 — Slack-discovered PR follows (sibling watcher state).
 *
 * File: `.control/pr-follows.json` (gitignored under `.control/`).
 * Slack inbox apply upserts follows server-side; the GitHub watcher tick
 * reads/updates snapshot fields and purges expired rows.
 *
 * Locked: TTL 48h from first discover (or last Slack re-link refresh);
 * max 5 active follows (drop oldest expires_at when adding a 6th);
 * primary watch.pr is never stored as a follow; same repo only.
 */
import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR, ensureControlDir, type WatchConfig } from "./github-inbox";

export const PR_FOLLOWS_PATH = path.join(CONTROL_DIR, "pr-follows.json");

/** Locked TTL: 48 hours from discover / Slack re-link refresh. */
export const FOLLOW_TTL_MS = 48 * 60 * 60 * 1000;

/** Max active follows; oldest by expires_at dropped when adding a 6th. */
export const FOLLOW_MAX_ACTIVE = 5;

export interface PrFollow {
  repo: string;
  pr: number;
  source: "slack";
  slack_event_id: string;
  workstreamId: string;
  created_at: string;
  expires_at: string;
  head_sha: string | null;
  ci_conclusion: string | null;
  requested_users: string[];
  requested_teams: string[];
  changes_requested_ids: string[];
  posted_event_ids: string[];
}

export interface PrFollowsState {
  follows: PrFollow[];
}

function emptyState(): PrFollowsState {
  return { follows: [] };
}

export function ephemeralWorkstreamId(repo: string, pr: number): string {
  return `ws-review-${repo.replace(/[^a-zA-Z0-9]+/g, "-")}-${pr}`;
}

export function parseIsoMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function plusFollowTtl(from: Date = new Date()): string {
  return new Date(from.getTime() + FOLLOW_TTL_MS).toISOString();
}

export async function readPrFollows(): Promise<PrFollowsState> {
  await ensureControlDir();
  try {
    const raw = await fs.readFile(PR_FOLLOWS_PATH, "utf8");
    const data = JSON.parse(raw) as PrFollowsState;
    if (!data || !Array.isArray(data.follows)) return emptyState();
    return { follows: data.follows };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyState();
    throw err;
  }
}

export async function writePrFollows(state: PrFollowsState): Promise<void> {
  await ensureControlDir();
  const tmp = `${PR_FOLLOWS_PATH}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify({ follows: state.follows }, null, 2) + "\n",
    "utf8"
  );
  await fs.rename(tmp, PR_FOLLOWS_PATH);
}

/** Drop follows with expires_at < now. Returns purged list. */
export function purgeExpiredFollows(
  follows: PrFollow[],
  now: Date = new Date()
): PrFollow[] {
  const nowMs = now.getTime();
  return follows.filter((f) => parseIsoMs(f.expires_at) >= nowMs);
}

/**
 * Upsert a Slack-discovered follow for a non-primary PR on watch.repo.
 * - Same PR → refresh expires_at (+48h from now), update slack_event_id.
 * - New PR → insert; if > FOLLOW_MAX_ACTIVE, drop oldest by expires_at.
 * - Primary watch.pr → no-op (never stored).
 * - Wrong repo → no-op (caller should already ignore).
 */
export function upsertFollowRecord(
  follows: PrFollow[],
  opts: {
    repo: string;
    pr: number;
    slack_event_id: string;
    workstreamId: string;
    watch: WatchConfig;
    now?: Date;
  }
): { follows: PrFollow[]; action: "created" | "refreshed" | "skipped"; reason?: string } {
  const now = opts.now ?? new Date();
  const repo = opts.repo.trim();
  const pr = opts.pr;

  if (repo.toLowerCase() !== opts.watch.repo.toLowerCase()) {
    return {
      follows,
      action: "skipped",
      reason: `repo ${repo} != watch.repo ${opts.watch.repo}`,
    };
  }
  if (pr === opts.watch.pr) {
    return {
      follows,
      action: "skipped",
      reason: "primary watch.pr is never stored as a follow",
    };
  }

  const expires_at = plusFollowTtl(now);
  const existingIdx = follows.findIndex(
    (f) =>
      f.pr === pr && f.repo.toLowerCase() === repo.toLowerCase()
  );

  if (existingIdx >= 0) {
    const prev = follows[existingIdx];
    const next = [...follows];
    next[existingIdx] = {
      ...prev,
      slack_event_id: opts.slack_event_id,
      workstreamId: opts.workstreamId || prev.workstreamId,
      expires_at,
      source: "slack",
    };
    return { follows: next, action: "refreshed" };
  }

  const created_at = now.toISOString();
  const row: PrFollow = {
    repo,
    pr,
    source: "slack",
    slack_event_id: opts.slack_event_id,
    workstreamId: opts.workstreamId || ephemeralWorkstreamId(repo, pr),
    created_at,
    expires_at,
    head_sha: null,
    ci_conclusion: null,
    requested_users: [],
    requested_teams: [],
    changes_requested_ids: [],
    posted_event_ids: [],
  };

  let next = [...follows, row];
  // Cap: max FOLLOW_MAX_ACTIVE; drop oldest expires_at when adding a 6th
  if (next.length > FOLLOW_MAX_ACTIVE) {
    next = [...next].sort(
      (a, b) => parseIsoMs(a.expires_at) - parseIsoMs(b.expires_at)
    );
    next = next.slice(next.length - FOLLOW_MAX_ACTIVE);
  }
  return { follows: next, action: "created" };
}

/**
 * Server-side upsert used by Slack inbox apply when a non-primary PR
 * creates/updates an ephemeral workstream.
 */
export async function upsertFollowFromSlackApply(opts: {
  repo: string;
  pr: number;
  slack_event_id: string;
  workstreamId: string;
  watch: WatchConfig;
}): Promise<{ action: "created" | "refreshed" | "skipped"; reason?: string }> {
  const state = await readPrFollows();
  const active = purgeExpiredFollows(state.follows);
  const result = upsertFollowRecord(active, opts);
  if (result.action !== "skipped") {
    await writePrFollows({ follows: result.follows });
  } else if (active.length !== state.follows.length) {
    // Still persist purge even on skip
    await writePrFollows({ follows: active });
  }
  return { action: result.action, reason: result.reason };
}
