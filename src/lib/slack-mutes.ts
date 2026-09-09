/**
 * V0.8 chip 5 — Slack thread mutes / snoozes.
 *
 * File: `.control/slack-mutes.json` (gitignored, server-private).
 * Clients use HTTP only: GET/POST/DELETE /api/slack/mutes.
 * Mute key covers a thread root: channel_id + (thread_ts || message_ts).
 * Default snooze TTL: 7 days. No Slack tokens in Control.
 */
import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR, ensureControlDir } from "./github-inbox";

export const SLACK_MUTES_PATH = path.join(CONTROL_DIR, "slack-mutes.json");

/** Default snooze: 7 days. */
export const MUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SlackMute {
  /** `${channel_id}|${thread_root_ts}` */
  key: string;
  channel_id: string;
  /** Thread root ts (thread_ts if present, else message_ts). */
  thread_ts: string;
  created_at: string;
  expires_at: string;
}

export interface SlackMutesState {
  mutes: SlackMute[];
}

function emptyState(): SlackMutesState {
  return { mutes: [] };
}

export function slackMuteKey(channelId: string, threadRootTs: string): string {
  return `${channelId.trim()}|${threadRootTs.trim()}`;
}

/** Thread root for mute: thread_ts if set, else message_ts. */
export function slackMuteThreadRoot(
  channelId: string,
  opts: { thread_ts?: string | null; message_ts: string }
): { key: string; channel_id: string; thread_ts: string } {
  const channel_id = channelId.trim();
  const thread_ts =
    typeof opts.thread_ts === "string" && opts.thread_ts.trim()
      ? opts.thread_ts.trim()
      : opts.message_ts.trim();
  return {
    key: slackMuteKey(channel_id, thread_ts),
    channel_id,
    thread_ts,
  };
}

function parseIsoMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function plusMuteTtl(from: Date = new Date()): string {
  return new Date(from.getTime() + MUTE_TTL_MS).toISOString();
}

export function purgeExpiredMutes(
  mutes: SlackMute[],
  now: Date = new Date()
): SlackMute[] {
  const nowMs = now.getTime();
  return mutes.filter((m) => parseIsoMs(m.expires_at) >= nowMs);
}

export async function readSlackMutes(): Promise<SlackMutesState> {
  await ensureControlDir();
  try {
    const raw = await fs.readFile(SLACK_MUTES_PATH, "utf8");
    const data = JSON.parse(raw) as SlackMutesState;
    if (!data || !Array.isArray(data.mutes)) return emptyState();
    return { mutes: data.mutes };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyState();
    throw err;
  }
}

export async function writeSlackMutes(state: SlackMutesState): Promise<void> {
  await ensureControlDir();
  const tmp = `${SLACK_MUTES_PATH}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify({ mutes: state.mutes }, null, 2) + "\n",
    "utf8"
  );
  await fs.rename(tmp, SLACK_MUTES_PATH);
}

/**
 * Active (non-expired) mute for this thread root, or null.
 */
export async function findActiveMute(
  channelId: string,
  threadRootTs: string,
  now: Date = new Date()
): Promise<SlackMute | null> {
  const key = slackMuteKey(channelId, threadRootTs);
  const state = await readSlackMutes();
  const active = purgeExpiredMutes(state.mutes, now);
  return active.find((m) => m.key === key) ?? null;
}

export async function isSlackThreadMuted(
  channelId: string,
  threadRootTs: string,
  now: Date = new Date()
): Promise<boolean> {
  const hit = await findActiveMute(channelId, threadRootTs, now);
  return hit !== null;
}

export async function upsertSlackMute(opts: {
  channel_id: string;
  thread_ts?: string | null;
  message_ts?: string | null;
  expires_at?: string | null;
  now?: Date;
}): Promise<SlackMute> {
  const now = opts.now ?? new Date();
  const message_ts =
    typeof opts.message_ts === "string" && opts.message_ts.trim()
      ? opts.message_ts.trim()
      : typeof opts.thread_ts === "string" && opts.thread_ts.trim()
        ? opts.thread_ts.trim()
        : "";
  if (!opts.channel_id?.trim()) {
    throw new Error("channel_id is required");
  }
  if (!message_ts && !(typeof opts.thread_ts === "string" && opts.thread_ts.trim())) {
    throw new Error("thread_ts or message_ts is required");
  }
  const root = slackMuteThreadRoot(opts.channel_id, {
    thread_ts: opts.thread_ts,
    message_ts: message_ts || String(opts.thread_ts).trim(),
  });

  let expires_at: string;
  if (typeof opts.expires_at === "string" && opts.expires_at.trim()) {
    const ms = parseIsoMs(opts.expires_at);
    if (!ms) throw new Error("expires_at must be ISO-8601");
    expires_at = new Date(ms).toISOString();
  } else {
    expires_at = plusMuteTtl(now);
  }

  const state = await readSlackMutes();
  const kept = purgeExpiredMutes(state.mutes, now).filter(
    (m) => m.key !== root.key
  );
  const mute: SlackMute = {
    key: root.key,
    channel_id: root.channel_id,
    thread_ts: root.thread_ts,
    created_at: now.toISOString(),
    expires_at,
  };
  kept.push(mute);
  await writeSlackMutes({ mutes: kept });
  return mute;
}

export async function removeSlackMute(key: string): Promise<boolean> {
  const k = key.trim();
  if (!k) return false;
  const state = await readSlackMutes();
  const next = state.mutes.filter((m) => m.key !== k);
  if (next.length === state.mutes.length) return false;
  await writeSlackMutes({ mutes: next });
  return true;
}

export async function listActiveSlackMutes(
  now: Date = new Date()
): Promise<SlackMute[]> {
  const state = await readSlackMutes();
  const active = purgeExpiredMutes(state.mutes, now);
  if (active.length !== state.mutes.length) {
    await writeSlackMutes({ mutes: active });
  }
  return active;
}
