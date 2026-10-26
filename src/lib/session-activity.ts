/**
 * Claude Code sessions as a Resume source. Events arrive from the user's Claude Code hook
 * (scripts/control-session-hook → control-session-collect.mjs → POST /api/sessions/activity).
 *
 * Storage: .control/sessions/<session_id>.json          (latest git state + event log; endpoint-owned)
 *          .control/sessions/<session_id>.summary.json  (summarizer-owned; see control-session-summarize.mjs)
 * The summary runs detached (never inside the request): Stop → at most every SUMMARY_MIN_INTERVAL_MS
 * when the transcript grew; SessionEnd → whenever the transcript changed since the last summary.
 * Test events (doctor) are stored but never summarized and never shown by Resume.
 */
import { spawn } from "child_process";
import { promises as fs, statSync } from "fs";
import path from "path";
import { CONTROL_DIR } from "./github-inbox";

export const SESSIONS_DIR = path.join(CONTROL_DIR, "sessions");
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const SUMMARY_MIN_INTERVAL_MS = 5 * 60_000;
const SUMMARY_PENDING_STALE_MS = 3 * 60_000;
const MAX_EVENTS = 50;

export interface SessionDiff {
  files_changed: number;
  insertions: number;
  deletions: number;
  files?: string[];
  untracked: number;
  untracked_files?: string[];
  stat?: string;
}

export interface SessionEventInput {
  hook_event_name: "Stop" | "SessionEnd" | "Test";
  reason?: string;
  session_id: string;
  transcript_path?: string;
  cwd: string;
  at: string;
  last_assistant_message?: string;
  test?: boolean;
  replayed?: boolean;
  repo?: { toplevel: string; remote?: string; slug?: string };
  branch?: string;
  head?: { sha: string; subject: string };
  diff?: SessionDiff;
}

export interface SessionRecord extends Omit<SessionEventInput, "hook_event_name" | "replayed"> {
  first_seen_at: string;
  last_event_at: string;
  last_event: string;
  ended: boolean;
  events: { event: string; at: string; reason?: string; replayed?: boolean }[];
}

export interface SessionSummary {
  session_id: string;
  status: "ok" | "fallback" | "unavailable" | "pending";
  source: "claude" | "transcript_tail" | null;
  summary?: string | null;
  next?: string | null;
  tail?: { last_user?: string; last_assistant?: string };
  started_at?: string;
  finished_at?: string;
  transcript_bytes?: number;
  error?: string;
  claude?: "running";
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

export function validateSessionEvent(raw: unknown): { ok: true; ev: SessionEventInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be a JSON object" };
  const r = raw as Record<string, unknown>;
  const name = r.hook_event_name;
  if (name !== "Stop" && name !== "SessionEnd" && name !== "Test") return { ok: false, error: "hook_event_name must be Stop, SessionEnd or Test" };
  if (typeof r.session_id !== "string" || !SESSION_ID_RE.test(r.session_id)) return { ok: false, error: "session_id missing or invalid" };
  if (typeof r.cwd !== "string" || !path.isAbsolute(r.cwd)) return { ok: false, error: "cwd must be an absolute path" };
  const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
  const tp = r.transcript_path;
  if (tp !== undefined && (typeof tp !== "string" || !path.isAbsolute(tp) || !tp.endsWith(".jsonl")))
    return { ok: false, error: "transcript_path must be an absolute .jsonl path" };
  const repo = r.repo && typeof r.repo === "object" ? (r.repo as Record<string, unknown>) : undefined;
  const head = r.head && typeof r.head === "object" ? (r.head as Record<string, unknown>) : undefined;
  const diff = r.diff && typeof r.diff === "object" ? (r.diff as Record<string, unknown>) : undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, n).map((x) => (x as string).slice(0, 300)) : undefined);
  return {
    ok: true,
    ev: {
      hook_event_name: name,
      reason: str(r.reason, 60),
      session_id: r.session_id,
      transcript_path: tp as string | undefined,
      cwd: r.cwd,
      at,
      last_assistant_message: str(r.last_assistant_message, 4000),
      test: r.test === true || name === "Test" ? true : undefined,
      replayed: r.replayed === true ? true : undefined,
      repo: repo && typeof repo.toplevel === "string" ? { toplevel: repo.toplevel.slice(0, 500), remote: str(repo.remote, 500), slug: str(repo.slug, 200) } : undefined,
      branch: str(r.branch, 200),
      head: head && typeof head.sha === "string" ? { sha: head.sha.slice(0, 64), subject: str(head.subject, 300) ?? "" } : undefined,
      diff: diff
        ? {
            files_changed: num(diff.files_changed),
            insertions: num(diff.insertions),
            deletions: num(diff.deletions),
            files: strs(diff.files, 40),
            untracked: num(diff.untracked),
            untracked_files: strs(diff.untracked_files, 20),
            stat: str(diff.stat, 4000),
          }
        : undefined,
    },
  };
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeAtomic(p: string, v: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(v, null, 2));
  await fs.rename(tmp, p);
}

const recPath = (id: string) => path.join(SESSIONS_DIR, `${id}.json`);
const sumPath = (id: string) => path.join(SESSIONS_DIR, `${id}.summary.json`);

/** Upsert: newest event wins for git state; an older replayed event only appends to the log. */
export async function upsertSession(ev: SessionEventInput): Promise<SessionRecord> {
  const prev = await readJson<SessionRecord>(recPath(ev.session_id));
  const newer = !prev || Date.parse(ev.at) >= Date.parse(prev.last_event_at);
  const { hook_event_name, replayed, ...state } = ev;
  const events = [...(prev?.events ?? []), { event: hook_event_name, at: ev.at, reason: ev.reason, replayed }]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_EVENTS);
  const rec: SessionRecord = newer
    ? {
        ...(prev ?? {}),
        ...Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined)),
        last_assistant_message: ev.last_assistant_message ?? prev?.last_assistant_message,
        first_seen_at: prev?.first_seen_at ?? ev.at,
        last_event_at: ev.at,
        last_event: hook_event_name,
        ended: hook_event_name === "SessionEnd",
        events,
      } as SessionRecord
    : { ...prev!, events, ended: prev!.ended || hook_event_name === "SessionEnd" };
  await writeAtomic(recPath(ev.session_id), rec);
  return rec;
}

export async function readSessionSummary(id: string): Promise<SessionSummary | null> {
  return readJson<SessionSummary>(sumPath(id));
}

export async function listSessions(): Promise<(SessionRecord & { summary: SessionSummary | null })[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out: (SessionRecord & { summary: SessionSummary | null })[] = [];
  for (const n of names) {
    if (!n.endsWith(".json") || n.endsWith(".summary.json")) continue;
    const rec = await readJson<SessionRecord>(path.join(SESSIONS_DIR, n));
    if (!rec?.session_id) continue;
    out.push({ ...rec, summary: await readSessionSummary(rec.session_id) });
  }
  return out.sort((a, b) => Date.parse(b.last_event_at) - Date.parse(a.last_event_at));
}

function transcriptSize(p?: string): number | null {
  if (!p) return null;
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

/** Pure decision: should this event (re)start the summarizer? */
export function shouldSummarize(
  ev: Pick<SessionEventInput, "hook_event_name" | "test">,
  prev: SessionSummary | null,
  size: number | null,
  now = Date.now()
): boolean {
  if (ev.test || ev.hook_event_name === "Test") return false;
  if (size === null || size === 0) return false;
  if (prev?.claude === "running" && prev.started_at && now - Date.parse(prev.started_at) < SUMMARY_PENDING_STALE_MS) return false;
  if (!prev || prev.status === "unavailable") return true;
  if (prev.transcript_bytes === size) return false;
  if (ev.hook_event_name === "SessionEnd") return true;
  const last = Date.parse(prev.finished_at ?? prev.started_at ?? "") || 0;
  return now - last >= SUMMARY_MIN_INTERVAL_MS;
}

/** Spawn the summarizer detached. Disabled with CONTROL_SESSION_SUMMARY=off. */
export async function maybeStartSummary(ev: SessionEventInput): Promise<"started" | "skipped" | "disabled"> {
  if (process.env.CONTROL_SESSION_SUMMARY === "off") return "disabled";
  const prev = await readSessionSummary(ev.session_id);
  const rec = await readJson<SessionRecord>(recPath(ev.session_id));
  if (!shouldSummarize(ev, prev, transcriptSize(rec?.transcript_path))) return "skipped";
  const script = path.join(process.cwd(), "scripts", "control-session-summarize.mjs");
  const logFd = await fs.open(path.join(SESSIONS_DIR, "summarize.log"), "a");
  try {
    const child = spawn(process.execPath, [script, ev.session_id], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
      env: { ...process.env, CONTROL_HOOK_DISABLE: "1", CONTROL_SESSIONS_DIR: SESSIONS_DIR },
    });
    child.unref();
  } finally {
    await logFd.close();
  }
  return "started";
}
