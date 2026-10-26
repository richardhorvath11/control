#!/usr/bin/env node
/**
 * control-session-summarize — summary for one Claude Code session Control heard about via the hook.
 *
 *   node scripts/control-session-summarize.mjs <session_id>      (spawned detached by POST /api/sessions/activity)
 *
 * Reads .control/sessions/<id>.json (written by the endpoint), the session transcript tail, and writes
 * .control/sessions/<id>.summary.json in two steps:
 *   1. status "fallback", source "transcript_tail": deterministic — the last user prompt + last assistant
 *      text, verbatim (clipped). Clearly labeled, no model involved. Written first so the card never waits.
 *   2. status "ok", source "claude": `claude -p` on the Pro/Max login — prompt on stdin, no tools
 *      (--tools ""), --strict-mcp-config, hooks disabled for that run, ANTHROPIC_API_KEY removed from env.
 *      Output must be strict JSON {summary, next}; anything else keeps step 1 and records the error.
 * Never invents content: no transcript text → status "unavailable".
 * Env: CONTROL_SESSION_SUMMARY=fallback (skip claude), CLAUDE_BIN, SESSION_SUMMARY_TIMEOUT_MS (default 120000).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Text of one transcript message content (string | blocks). Tool calls become "[tool: Name]". */
function contentText(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const b of c) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "tool_use" && b.name) parts.push(`[tool: ${b.name}]`);
  }
  return parts.join("\n");
}

const NOISE = /^\s*<(command-|local-command|system-reminder|bash-|user-memory)/;

/**
 * Last ~maxBytes of a Claude Code transcript JSONL → [{role, text, at}], main thread only
 * (sidechains, tool results, meta and command-echo lines skipped).
 */
export function readTranscriptTail(file, maxBytes = 400_000) {
  let buf, partial = false;
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const len = Math.min(st.size, maxBytes);
    buf = Buffer.alloc(len);
    partial = len < st.size;
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
  } catch {
    return [];
  }
  const lines = buf.toString("utf8").split("\n");
  if (partial) lines.shift(); // started mid-file: first line may be partial
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain || o.isMeta) continue;
    const text = contentText(o.message?.content).trim();
    if (!text || NOISE.test(text)) continue;
    out.push({ role: o.type, text, at: typeof o.timestamp === "string" ? o.timestamp : undefined });
  }
  return out;
}

/** Deterministic, labeled fallback. Returns null when there is nothing real to show. */
export function transcriptTailFallback(msgs, lastAssistantMessage) {
  const lastUser = [...msgs].reverse().find((m) => m.role === "user" && !/^\[tool: /.test(m.text));
  const lastAsst = (lastAssistantMessage && lastAssistantMessage.trim()) || [...msgs].reverse().find((m) => m.role === "assistant" && !/^\[tool: [^\]]+\]$/.test(m.text))?.text;
  if (!lastUser && !lastAsst) return null;
  return {
    last_user: lastUser ? clip(lastUser.text.replace(/\s+/g, " "), 400) : undefined,
    last_assistant: lastAsst ? clip(lastAsst.replace(/\s+/g, " "), 600) : undefined,
  };
}

export function buildPrompt(session, msgs) {
  const lines = [];
  let budget = 14_000;
  for (const m of [...msgs].reverse()) {
    const t = `${m.role === "user" ? "USER" : "CLAUDE"}: ${clip(m.text, 1500)}`;
    if (budget - t.length < 0) break;
    budget -= t.length;
    lines.unshift(t);
  }
  const git = [
    session.repo?.slug || session.repo?.toplevel ? `repo: ${session.repo.slug || session.repo.toplevel}` : "",
    session.branch ? `branch: ${session.branch}` : "",
    session.head ? `last commit: ${session.head.sha.slice(0, 7)} ${session.head.subject}` : "",
    session.diff ? `uncommitted: ${session.diff.files_changed} file(s) +${session.diff.insertions}/-${session.diff.deletions}, ${session.diff.untracked} untracked` : "",
  ].filter(Boolean);
  return [
    "You summarize where a developer left off in a Claude Code session so they can resume later.",
    "Use ONLY the transcript excerpt and git facts below. Do not invent files, results or plans that are not in them.",
    'Reply with exactly one JSON object and nothing else: {"summary": "...", "next": "..."}',
    '- summary: 1-3 sentences, what was being worked on and its state at the end of the excerpt.',
    '- next: one concrete next step that the transcript itself implies, or "" if it does not imply one.',
    "",
    "GIT FACTS:",
    ...(git.length ? git : ["(none)"]),
    "",
    "TRANSCRIPT EXCERPT (oldest first, most recent last):",
    ...lines,
  ].join("\n");
}

/** Strict parse of the model's reply. */
export function parseSummaryReply(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let o;
  try {
    o = JSON.parse(t);
  } catch {
    return { ok: false, error: `Claude reply was not JSON: ${clip(t.replace(/\s+/g, " "), 120)}` };
  }
  if (!o || typeof o.summary !== "string" || !o.summary.trim()) return { ok: false, error: "Claude reply had no summary" };
  if (o.next !== undefined && typeof o.next !== "string") return { ok: false, error: "Claude reply next was not a string" };
  return { ok: true, summary: clip(o.summary.trim(), 1200), next: clip((o.next || "").trim(), 400) };
}

function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  for (const d of [...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".local", "bin")]) {
    const p = path.join(d, "claude");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function runClaude(prompt, timeoutMs) {
  const bin = findClaude();
  if (!bin) return Promise.resolve({ ok: false, error: "claude CLI not found (install Claude Code and run claude login)" });
  const env = { ...process.env, CONTROL_HOOK_DISABLE: "1" };
  delete env.ANTHROPIC_API_KEY;
  const args = ["-p", "--tools", "", "--permission-prompts", "none", "--strict-mcp-config", "--no-session-persistence", "--settings", '{"disableAllHooks":true}'];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: `claude -p timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `claude failed to start: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) resolve({ ok: false, error: `claude -p exited ${code}: ${clip((err || out).trim().replace(/\s+/g, " "), 200)}` });
      else resolve({ ok: true, text: out });
    });
    child.stdin.end(prompt);
  });
}

function writeAtomic(p, v) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

export async function summarize(sessionsDir, sessionId, { useClaude = true, timeoutMs = 120_000 } = {}) {
  const recPath = path.join(sessionsDir, `${sessionId}.json`);
  const outPath = path.join(sessionsDir, `${sessionId}.summary.json`);
  const session = JSON.parse(fs.readFileSync(recPath, "utf8"));
  const started_at = new Date().toISOString();
  let tsz = 0, tmtime;
  if (session.transcript_path) {
    try {
      const st = fs.statSync(session.transcript_path);
      tsz = st.size;
      tmtime = st.mtime.toISOString();
    } catch {}
  }
  const msgs = session.transcript_path ? readTranscriptTail(session.transcript_path) : [];
  const tail = transcriptTailFallback(msgs, session.last_assistant_message);
  const base = { session_id: sessionId, started_at, transcript_bytes: tsz, transcript_mtime: tmtime, messages_used: msgs.length };
  if (!tail) {
    const r = { ...base, status: "unavailable", source: null, finished_at: new Date().toISOString(), error: session.transcript_path ? "transcript has no user/assistant text yet" : "no transcript_path in the hook event" };
    writeAtomic(outPath, r);
    return r;
  }
  const fallback = { ...base, status: "fallback", source: "transcript_tail", tail, summary: null, next: null };
  if (!useClaude) {
    const r = { ...fallback, finished_at: new Date().toISOString(), error: "Claude summary disabled (CONTROL_SESSION_SUMMARY=fallback)" };
    writeAtomic(outPath, r);
    return r;
  }
  writeAtomic(outPath, { ...fallback, claude: "running" });
  const res = await runClaude(buildPrompt(session, msgs), timeoutMs);
  const parsed = res.ok ? parseSummaryReply(res.text) : res;
  const r = parsed.ok
    ? { ...base, status: "ok", source: "claude", tail, summary: parsed.summary, next: parsed.next || null, finished_at: new Date().toISOString() }
    : { ...fallback, finished_at: new Date().toISOString(), error: parsed.error };
  writeAtomic(outPath, r);
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    console.error("usage: control-session-summarize.mjs <session_id>");
    process.exit(2);
  }
  const dir = process.env.CONTROL_SESSIONS_DIR || path.join(process.cwd(), ".control", "sessions");
  summarize(dir, id, {
    useClaude: process.env.CONTROL_SESSION_SUMMARY !== "fallback",
    timeoutMs: Number(process.env.SESSION_SUMMARY_TIMEOUT_MS || 120_000),
  })
    .then((r) => console.log(`${new Date().toISOString()} ${id} ${r.status}${r.error ? ` (${r.error})` : ""}`))
    .catch((e) => {
      console.error(`${new Date().toISOString()} ${id} summarize error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
