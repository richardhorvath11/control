/**
 * V0.8 chip 5 — Agents watcher / worker status board.
 *
 * File: `.control/watcher-status.json` (gitignored, server-private).
 * Clients + workers use HTTP only: GET/PUT /api/watchers/status.
 * Never tell clients to open the directory. No tokens in Control.
 *
 * Watchers/workers should PUT status on each tick / action.
 */
import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR, ensureControlDir } from "./github-inbox";

export const WATCHER_STATUS_PATH = path.join(
  CONTROL_DIR,
  "watcher-status.json"
);

/** Stale threshold: 3 minutes (within 2–5 min band). */
export const WATCHER_STALE_MS = 3 * 60 * 1000;

export const KNOWN_WATCHER_IDS = [
  "slack-watch",
  "github-watch",
  "review-worker",
  "slack-outbox",
  "github-outbox",
] as const;

export type KnownWatcherId = (typeof KNOWN_WATCHER_IDS)[number];

export type WatcherStatusValue =
  | "idle"
  | "ticking"
  | "waiting"
  | "error";

export interface WatcherStatusRecord {
  id: string;
  status: WatcherStatusValue;
  last_action: string;
  detail?: string;
  updated_at: string;
}

export interface WatcherStatusState {
  watchers: Record<string, WatcherStatusRecord>;
}

export interface WatcherStatusRow extends WatcherStatusRecord {
  /** True when updated_at older than WATCHER_STALE_MS. */
  stale: boolean;
  /** Display status: "stale" when stale, else stored status. */
  display_status: WatcherStatusValue | "stale";
}

const STATUS_SET = new Set<string>(["idle", "ticking", "waiting", "error"]);

function emptyState(): WatcherStatusState {
  return { watchers: {} };
}

export function isWatcherStatusValue(v: unknown): v is WatcherStatusValue {
  return typeof v === "string" && STATUS_SET.has(v);
}

export async function readWatcherStatus(): Promise<WatcherStatusState> {
  await ensureControlDir();
  try {
    const raw = await fs.readFile(WATCHER_STATUS_PATH, "utf8");
    const data = JSON.parse(raw) as WatcherStatusState;
    if (!data || typeof data.watchers !== "object" || !data.watchers) {
      return emptyState();
    }
    return { watchers: data.watchers };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyState();
    throw err;
  }
}

export async function writeWatcherStatus(
  state: WatcherStatusState
): Promise<void> {
  await ensureControlDir();
  const tmp = `${WATCHER_STATUS_PATH}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify({ watchers: state.watchers }, null, 2) + "\n",
    "utf8"
  );
  await fs.rename(tmp, WATCHER_STATUS_PATH);
}

export function isWatcherStale(
  updatedAt: string,
  now: Date = new Date(),
  staleMs: number = WATCHER_STALE_MS
): boolean {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > staleMs;
}

/**
 * Merge known watcher ids (seed idle when never reported) with stored records.
 */
export function buildWatcherRows(
  state: WatcherStatusState,
  now: Date = new Date()
): WatcherStatusRow[] {
  const ids = new Set<string>([
    ...KNOWN_WATCHER_IDS,
    ...Object.keys(state.watchers),
  ]);
  const rows: WatcherStatusRow[] = [];
  for (const id of ids) {
    const stored = state.watchers[id];
    if (!stored) {
      rows.push({
        id,
        status: "idle",
        last_action: "—",
        updated_at: "",
        stale: false,
        display_status: "idle",
      });
      continue;
    }
    const stale =
      stored.updated_at.length > 0
        ? isWatcherStale(stored.updated_at, now)
        : false;
    rows.push({
      ...stored,
      stale,
      display_status: stale ? "stale" : stored.status,
    });
  }
  // Stable order: known first, then any extras alpha.
  const knownIndex = new Map<string, number>(
    KNOWN_WATCHER_IDS.map((id, i) => [id, i])
  );
  rows.sort((a, b) => {
    const ai = knownIndex.has(a.id) ? knownIndex.get(a.id)! : 1000;
    const bi = knownIndex.has(b.id) ? knownIndex.get(b.id)! : 1000;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
  return rows;
}

export async function listWatcherStatusRows(
  now: Date = new Date()
): Promise<WatcherStatusRow[]> {
  const state = await readWatcherStatus();
  return buildWatcherRows(state, now);
}

export async function putWatcherStatus(input: {
  id: string;
  status: WatcherStatusValue;
  last_action: string;
  detail?: string;
  now?: Date;
}): Promise<WatcherStatusRecord> {
  const id = input.id.trim();
  if (!id) throw new Error("id is required");
  if (!isWatcherStatusValue(input.status)) {
    throw new Error("status must be idle|ticking|waiting|error");
  }
  const last_action =
    typeof input.last_action === "string" ? input.last_action.trim() : "";
  if (!last_action) throw new Error("last_action is required");

  const now = input.now ?? new Date();
  const state = await readWatcherStatus();
  const record: WatcherStatusRecord = {
    id,
    status: input.status,
    last_action: last_action.slice(0, 240),
    updated_at: now.toISOString(),
  };
  if (typeof input.detail === "string" && input.detail.trim()) {
    record.detail = input.detail.trim().slice(0, 500);
  }
  state.watchers[id] = record;
  await writeWatcherStatus(state);
  return record;
}
