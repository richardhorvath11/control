#!/usr/bin/env node
/**
 * control-session-collect — background half of the Claude Code hook (see control-session-hook).
 *
 *   node control-session-collect.mjs <spool-file>   one hook event: collect git state, POST, else queue
 *   node control-session-collect.mjs --replay        just drain ~/.control-hook/queue/ (worker / doctor)
 *
 * Event → POST $CONTROL_BASE_URL/api/sessions/activity (default http://localhost:3000).
 * Control down → event is written to ~/.control-hook/queue/<ts>-<session>.json and replayed
 * (oldest first) after the next successful POST or on --replay. Never reads credentials.
 * Env: CONTROL_HOOK_HOME (default ~/.control-hook), CONTROL_BASE_URL, CONTROL_HOOK_POST_TIMEOUT_MS.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "control.session_activity.v1";
const HOME_DIR = () => process.env.CONTROL_HOOK_HOME || path.join(os.homedir(), ".control-hook");
export const queueDir = () => path.join(HOME_DIR(), "queue");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME_DIR(), "config.json"), "utf8"));
  } catch {
    return {};
  }
}
export function baseUrl() {
  let b = process.env.CONTROL_BASE_URL || readConfig().control_base_url || "http://localhost:3000";
  b = String(b).replace(/\/+$/, "");
  if (/^\d+$/.test(b)) b = `http://localhost:${b}`;
  if (!/^https?:\/\//.test(b)) b = `http://${b}`;
  return b;
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** owner/name from a GitHub-ish remote URL (https or ssh), else "". */
export function remoteSlug(remote) {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote || "");
  return m ? `${m[1]}/${m[2]}` : "";
}

/** Git facts for cwd. Everything optional: a non-repo cwd still yields a valid event. */
export function collectGit(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return {};
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return {};
  const remote = git(top, ["remote", "get-url", "origin"]);
  const branch = git(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(top, ["log", "-1", "--format=%H%x1f%s"]);
  const [sha, subject] = head ? head.split("\x1f") : [];
  const numstat = git(top, ["diff", "HEAD", "--numstat"]);
  const stat = git(top, ["diff", "HEAD", "--stat"]);
  const untracked = git(top, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  let insertions = 0, deletions = 0;
  const files = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d, f] = line.split("\t");
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
    files.push(f);
  }
  return {
    repo: { toplevel: top, remote: remote || undefined, slug: remoteSlug(remote) || undefined },
    branch: branch || undefined,
    head: sha ? { sha, subject: subject || "" } : undefined,
    diff: {
      files_changed: files.length,
      insertions,
      deletions,
      files: files.slice(0, 40),
      untracked: untracked.length,
      untracked_files: untracked.slice(0, 20),
      stat: stat.split("\n").slice(-41).join("\n").slice(0, 4000),
    },
  };
}

/** Hook stdin payload → Control event. Only documented hook fields are read. */
export function buildEvent(payload, now = new Date()) {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const ev = {
    schema: SCHEMA,
    hook_event_name: String(payload.hook_event_name || ""),
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    session_id: String(payload.session_id || ""),
    transcript_path: typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
    cwd,
    at: now.toISOString(),
    last_assistant_message:
      typeof payload.last_assistant_message === "string" ? payload.last_assistant_message.slice(0, 4000) : undefined,
    test: payload.control_test === true ? true : undefined,
    ...collectGit(cwd),
  };
  return ev;
}

export async function postEvent(ev, base = baseUrl()) {
  const ms = Number(process.env.CONTROL_HOOK_POST_TIMEOUT_MS || 4000);
  try {
    const r = await fetch(`${base}/api/sessions/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(ms),
    });
    if (r.ok) return { ok: true };
    // 4xx = Control rejected the event (bad payload): don't queue forever.
    return { ok: false, retry: r.status >= 500, status: r.status };
  } catch (e) {
    return { ok: false, retry: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export function enqueue(ev) {
  fs.mkdirSync(queueDir(), { recursive: true });
  const name = `${Date.parse(ev.at) || Date.now()}-${(ev.session_id || "nosession").replace(/[^A-Za-z0-9_-]/g, "")}-${process.pid}.json`;
  const tmp = path.join(queueDir(), `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(ev));
  fs.renameSync(tmp, path.join(queueDir(), name));
  return name;
}

/** Drain the queue oldest-first; stops at the first retryable failure. Returns counts. */
export async function replayQueue(base = baseUrl()) {
  let sent = 0, dropped = 0, left = 0;
  let names = [];
  try {
    names = fs.readdirSync(queueDir()).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  } catch {
    return { sent, dropped, left };
  }
  for (let i = 0; i < names.length; i++) {
    const p = path.join(queueDir(), names[i]);
    // Claim by rename so two concurrent collectors never double-send.
    const claimed = `${p}.sending-${process.pid}`;
    try {
      fs.renameSync(p, claimed);
    } catch {
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(fs.readFileSync(claimed, "utf8"));
    } catch {
      fs.renameSync(claimed, `${p}.bad`);
      dropped++;
      continue;
    }
    const r = await postEvent({ ...ev, replayed: true }, base);
    if (r.ok) {
      fs.unlinkSync(claimed);
      sent++;
    } else if (!r.retry) {
      fs.renameSync(claimed, `${p}.rejected`);
      dropped++;
    } else {
      fs.renameSync(claimed, p);
      left = names.length - i;
      break;
    }
  }
  return { sent, dropped, left };
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--replay") {
    const r = await replayQueue();
    console.log(JSON.stringify({ at: new Date().toISOString(), replay: r }));
    return;
  }
  if (!arg) {
    console.error("usage: control-session-collect.mjs <spool-file> | --replay");
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(arg, "utf8"));
  } catch (e) {
    console.error(`${new Date().toISOString()} bad hook payload ${arg}: ${e instanceof Error ? e.message : e}`);
    try { fs.unlinkSync(arg); } catch {}
    return;
  }
  try { fs.unlinkSync(arg); } catch {}
  if (!payload.session_id) return;
  const ev = buildEvent(payload);
  const r = await postEvent(ev);
  if (r.ok) {
    const rep = await replayQueue();
    console.log(`${ev.at} posted ${ev.hook_event_name} ${ev.session_id}${rep.sent || rep.left ? ` replay=${JSON.stringify(rep)}` : ""}`);
  } else if (r.retry) {
    const q = enqueue(ev);
    console.log(`${ev.at} Control unreachable (${r.error || r.status}) — queued ${q}`);
  } else {
    console.log(`${ev.at} Control rejected event (${r.status}) — dropped ${ev.session_id}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${new Date().toISOString()} collector error: ${e instanceof Error ? e.stack : e}`);
    process.exit(0);
  });
}
