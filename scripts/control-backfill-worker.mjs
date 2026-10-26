#!/usr/bin/env node
/**
 * control-backfill-worker — READ-ONLY first-launch scan of existing pending work.
 *
 *   node scripts/control-backfill-worker.mjs --once     # claim one requested scan, run it, exit
 *   node scripts/control-backfill-worker.mjs --watch    # poll POST /api/backfill/claim every POLL_SECONDS
 *
 * Talks to Control over HTTP only (CONTROL_BASE_URL). Holds no Slack/GitHub token:
 *   GitHub  → `gh search prs|issues` (your gh login), only when watch.repo is set
 *   Slack   → `claude -p` with ONLY the Slack MCP plugin's read tools allowed (read_channel, read_thread,
 *             search, list_user_channels, read_user_profile); every write tool is explicitly disallowed
 *   Sessions→ GET /api/sessions/activity (the hook store + summaries)
 *   Grouping→ `claude -p --tools "" --strict-mcp-config` (no tools, prompt on stdin), Pro login, never ANTHROPIC_API_KEY
 * Never posts, sends, reacts or drafts anywhere. Fails closed: unparseable output → no candidates.
 *
 * Env: CONTROL_BASE_URL (http://localhost:3000) · POLL_SECONDS (10) · CONTROL_BACKFILL_CLAUDE (claude)
 *      CONTROL_BACKFILL_GH (gh) · BACKFILL_SLACK_MAX_MSGS (150/surface) · BACKFILL_SLACK_MAX_THREADS (20/surface)
 *      BACKFILL_GH_LIMIT (50/query) · BACKFILL_CLAUDE_TIMEOUT_MS (420000)
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.CONTROL_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const POLL = Number(process.env.POLL_SECONDS || 10);
const CLAUDE = process.env.CONTROL_BACKFILL_CLAUDE || "claude";
const GH = process.env.CONTROL_BACKFILL_GH || "gh";
const MAX_MSGS = Number(process.env.BACKFILL_SLACK_MAX_MSGS || 150);
const MAX_THREADS = Number(process.env.BACKFILL_SLACK_MAX_THREADS || 20);
const GH_LIMIT = Number(process.env.BACKFILL_GH_LIMIT || 50);
const CLAUDE_TIMEOUT = Number(process.env.BACKFILL_CLAUDE_TIMEOUT_MS || 420_000);
const BACKOFF_MS = (process.env.BACKFILL_BACKOFF_MS || "2000,8000,20000").split(",").map(Number);

const SLACK = "mcp__plugin_slack_slack__";
export const SLACK_READ_TOOLS = ["slack_read_channel", "slack_read_thread", "slack_search_public_and_private", "slack_search_public", "slack_list_user_channels", "slack_read_user_profile", "slack_search_users"].map((t) => SLACK + t);
export const SLACK_WRITE_TOOLS = ["slack_send_message", "slack_send_message_draft", "slack_schedule_message", "slack_add_reaction", "slack_create_canvas", "slack_update_canvas", "slack_create_conversation", "slack_create_list", "slack_update_list", "slack_add_list_record", "slack_update_list_record", "slack_get_file_upload_url", "slack_complete_file_upload"].map((t) => SLACK + t);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), "[backfill]", ...a);

async function http(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: r.status, json };
}
const progress = (scan, source, p) => http("PUT", "/api/backfill/progress", { scan_id: scan.scan_id, source, ...p }).catch(() => null);

export function extractJson(text) {
  const t = String(text || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  for (const cand of [t, fence?.[1]]) { if (!cand) continue; try { return JSON.parse(cand); } catch { /* */ } }
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* */ } }
  return null;
}

function claudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.CONTROL_HOOK_DISABLE = "1"; // Control's own runs never report as user sessions
  return env;
}

/** One `claude -p` run, prompt on stdin. Returns { out } or { err }. */
function runClaude(args, prompt) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let child;
    try {
      child = spawn("env", ["-u", "ANTHROPIC_API_KEY", CLAUDE, "-p", ...args], { env: claudeEnv(), cwd: ROOT });
    } catch (e) { return resolve({ err: String(e) }); }
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, CLAUDE_TIMEOUT);
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(killer); resolve({ err: e.message }); });
    child.on("close", (code) => {
      clearTimeout(killer);
      const blob = (stdout + "\n" + stderr).toLowerCase();
      if (/not logged|please log|login required|invalid api key|setup-token/.test(blob)) return resolve({ err: "Claude not logged in (run: claude login)" });
      if (/rate limit|usage limit|overloaded|429/.test(blob) && !extractJson(stdout)) return resolve({ err: "rate limited", retry: true });
      if (code !== 0 && !extractJson(stdout)) return resolve({ err: `claude exited ${code}: ${stderr.slice(0, 300)}`, retry: true });
      resolve({ out: stdout });
    });
  });
}
async function runClaudeRetry(args, prompt, label) {
  let r;
  for (let i = 0; i <= BACKOFF_MS.length; i++) {
    r = await runClaude(args, prompt);
    if (!r.err || !r.retry || i === BACKOFF_MS.length) break;
    log(`${label}: ${r.err}; backing off ${BACKOFF_MS[i]}ms`);
    await sleep(BACKOFF_MS[i]);
  }
  return r;
}

// ---------------- GitHub (gh, read-only) ----------------
function ghJson(args) {
  for (let i = 0; i <= BACKOFF_MS.length; i++) {
    const r = spawnSync(GH, args, { encoding: "utf8", timeout: 60_000 });
    if (r.status === 0) { try { return { data: JSON.parse(r.stdout || "[]") }; } catch { return { err: "gh returned non-JSON" }; } }
    const e = (r.stderr || r.error?.message || "").trim();
    if (/rate limit|secondary rate|abuse|HTTP 403|HTTP 429/i.test(e) && i < BACKOFF_MS.length) { spawnSync("sleep", [String(BACKOFF_MS[i] / 1000)]); continue; }
    return { err: e.slice(0, 300) || `gh exit ${r.status}` };
  }
  return { err: "gh rate limited" };
}

export async function readGithub(scan, watch) {
  if (!watch.repo) { await progress(scan, "github", { status: "skipped", note: "no GitHub repo set (optional)" }); return []; }
  await progress(scan, "github", { status: "running", done: 0, total: 4 });
  const fields = "number,title,url,updatedAt,author";
  const qs = [
    ["pr", "you opened", ["search", "prs", "--repo", watch.repo, "--state", "open", "--author", "@me", "--json", fields, "--limit", String(GH_LIMIT)]],
    ["pr", "review requested from you", ["search", "prs", "--repo", watch.repo, "--state", "open", "--review-requested", "@me", "--json", fields, "--limit", String(GH_LIMIT)]],
    ["issue", "your issue", ["search", "issues", "--repo", watch.repo, "--state", "open", "--author", "@me", "--json", fields, "--limit", String(GH_LIMIT)]],
    ["issue", "assigned to you", ["search", "issues", "--repo", watch.repo, "--state", "open", "--assignee", "@me", "--json", fields, "--limit", String(GH_LIMIT)]],
  ];
  const items = new Map();
  let i = 0, errs = [];
  for (const [kind, role, args] of qs) {
    const r = ghJson(args);
    i++;
    if (r.err) errs.push(r.err);
    for (const x of r.data || []) {
      const id = `gh:${kind}:${watch.repo}#${x.number}`;
      const prev = items.get(id);
      const roles = prev ? `${prev.text.split(" — ")[0]}, ${role}` : role;
      items.set(id, { id, source: "github", url: x.url, label: `${kind === "pr" ? "PR" : "Issue"} #${x.number}`, at: new Date(x.updatedAt).toISOString(), text: `${roles} — ${x.title}` });
    }
    await progress(scan, "github", { status: "running", done: i, total: qs.length, items: items.size });
  }
  const out = [...items.values()];
  await progress(scan, "github", errs.length === qs.length ? { status: "failed", note: errs[0] } : { status: "done", done: qs.length, total: qs.length, items: out.length, note: errs.length ? `${errs.length} query failed: ${errs[0]}` : undefined });
  return out;
}

// ---------------- Slack (Slack MCP via claude -p, read tools only) ----------------
export function slackReadArgs() {
  return ["--tools", "", "--allowedTools", SLACK_READ_TOOLS.join(","), "--disallowedTools", SLACK_WRITE_TOOLS.join(","), "--permission-prompts", "none", "--output-format", "text"];
}

function slackSurfacePrompt(surface, oldestUnix, myUserId) {
  return `You are a READ-ONLY Slack reader. Never send, draft, schedule, react, or create anything; only the read tools are allowed.

Read Slack conversation ${surface.id}${surface.name ? ` (${surface.name})` : ""} with the Slack read tools:
1. Call slack_read_channel for channel_id ${surface.id}, messages since unix time ${oldestUnix} (oldest=${oldestUnix}), paging until you have up to ${MAX_MSGS} messages or no more pages.
2. For messages that have thread replies (up to ${MAX_THREADS} threads, newest first), call slack_read_thread to get the replies.
${myUserId ? `3. The user is Slack member ${myUserId}.` : "3. Identify the current user's Slack member id with slack_read_user_profile (no arguments = yourself) if available."}

Output ONLY one JSON object, no prose:
{"me":"<user id or null>","messages":[{"ts":"1234567890.123456","thread_ts":"<parent ts or null>","user":"<user id>","user_name":"<display name>","text":"<message text, max 500 chars>","permalink":"<the exact permalink the tool returned, or null>","reply_count":0,"latest_reply_ts":"<ts or null>"}]}
Include thread replies as their own messages with thread_ts set. Copy ts values exactly. Never invent messages, ids or permalinks: use null when a tool did not return a permalink.`;
}

/** Slack archive permalinks: from the tool, or built from the workspace domain the tool reported. */
export function slackPermalink(domain, channel, ts, threadTs) {
  if (!domain || !/^[a-z0-9-]+$/.test(domain) || !/^\d+\.\d+$/.test(ts)) return null;
  const p = ts.replace(".", "");
  return `https://${domain}.slack.com/archives/${channel}/p${p}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ""}`;
}

export function slackItemsFromRead(surface, parsed, oldestUnix, knownDomain = null) {
  if (!parsed || !Array.isArray(parsed.messages)) return null;
  let domain = knownDomain;
  for (const m of parsed.messages) {
    const u = /^https:\/\/([a-z0-9-]+)\.slack\.com\/archives\//.exec(m?.permalink || "");
    if (u && !domain) { domain = u[1]; break; }
  }
  const me = typeof parsed.me === "string" ? parsed.me : null;
  const out = [];
  for (const m of parsed.messages.slice(0, MAX_MSGS * 3)) {
    if (!m || typeof m.ts !== "string" || !/^\d+\.\d+$/.test(m.ts)) continue;
    const tsNum = Number(m.ts);
    const latest = typeof m.latest_reply_ts === "string" && /^\d+\.\d+$/.test(m.latest_reply_ts) ? Number(m.latest_reply_ts) : tsNum;
    if (Math.max(tsNum, latest) < oldestUnix) continue;
    const thread = typeof m.thread_ts === "string" && /^\d+\.\d+$/.test(m.thread_ts) ? m.thread_ts : null;
    const given = typeof m.permalink === "string" && m.permalink.includes(`/archives/${surface.id}/p${m.ts.replace(".", "")}`) ? m.permalink : null;
    const url = given || slackPermalink(domain, surface.id, m.ts, thread);
    if (!url) continue; // fail closed: no real link, no item
    const who = m.user && me && m.user === me ? "you" : (typeof m.user_name === "string" && m.user_name) || m.user || "someone";
    out.push({
      id: `slack:${surface.id}:${m.ts}`,
      source: "slack",
      url,
      label: `${surface.name || surface.id} · ${who}${thread && thread !== m.ts ? " (thread reply)" : ""}`,
      at: new Date(Math.max(tsNum, latest) * 1000).toISOString(),
      text: String(m.text || "").slice(0, 500),
      configured_surface: true,
      ...(thread ? { thread_ts: thread } : {}),
      ...(m.reply_count ? { reply_count: Number(m.reply_count) || 0 } : {}),
    });
  }
  return { items: out, me };
}

export async function readSlack(scan, watch) {
  const sw = watch.slackWatch || { surfaces: [] };
  const surfaces = [...(sw.surfaces || [])];
  if (!surfaces.length && !sw.includeDms && !sw.includeMpims) { await progress(scan, "slack", { status: "skipped", note: "no Slack channels or DMs set (optional)" }); return { items: [], me: null }; }
  const oldest = Math.floor(Date.now() / 1000) - scan.lookback_days * 86400;
  if (sw.includeDms || sw.includeMpims) {
    // Discover the user's DMs / group DMs (read-only list), then read them like any surface.
    if (!sw.myUserId) { log("DMs/MPIMs enabled without myUserId — skipping DM discovery (fail closed)"); }
    else {
      const types = [sw.includeDms && "im", sw.includeMpims && "mpim"].filter(Boolean).join(",");
      const r = await runClaudeRetry(slackReadArgs(), `You are a READ-ONLY Slack reader. Call slack_list_user_channels for the current user with types ${types}. Output ONLY JSON: {"conversations":[{"id":"D…/G…/C…","name":"<display name>","kind":"im|mpim"}]} (max 20, most recent first). Never invent ids.`, "slack dm list");
      const p = r.out ? extractJson(r.out) : null;
      for (const c of (p?.conversations || []).slice(0, 20)) if (c?.id && /^[A-Z0-9]+$/.test(c.id) && !surfaces.some((s) => s.id === c.id)) surfaces.push({ id: c.id, name: c.name ? `DM ${c.name}` : c.id, kind: c.kind === "mpim" ? "mpim" : "im" });
    }
  }
  await progress(scan, "slack", { status: "running", done: 0, total: surfaces.length });
  const items = [];
  let me = sw.myUserId || null;
  const notes = [];
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    const r = await runClaudeRetry(slackReadArgs(), slackSurfacePrompt(s, oldest, me), `slack ${s.id}`);
    const parsed = r.out ? extractJson(r.out) : null;
    const got = parsed ? slackItemsFromRead(s, parsed, oldest, watch.slack_team_domain || null) : null;
    if (!got) notes.push(`${s.name || s.id}: ${r.err || "unreadable output"}`);
    else {
      items.push(...got.items);
      me = me || got.me;
      const n = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
      if (n && !got.items.length && !watch.slack_team_domain) notes.push(`${s.name || s.id}: ${n} message(s) read but no permalink/workspace domain known — dropped (set CONTROL_SLACK_DOMAIN)`);
      else if (n) notes.push(`${s.name || s.id}: read ${n} message(s)`);
    }
    await progress(scan, "slack", { status: "running", done: i + 1, total: surfaces.length, items: items.length, note: notes.join("; ") || undefined });
  }
  const allFailed = surfaces.length > 0 && notes.filter((n) => !/read \d+ message/.test(n) && !/dropped/.test(n)).length === surfaces.length;
  await progress(scan, "slack", { status: allFailed ? "failed" : "done", done: surfaces.length, total: surfaces.length, items: items.length, note: notes.join("; ") || undefined });
  return { items, me };
}

// ---------------- Claude Code sessions (hook store over HTTP) ----------------
export async function readSessions(scan) {
  await progress(scan, "sessions", { status: "running" });
  const r = await http("GET", "/api/sessions/activity").catch(() => ({ status: 0 }));
  if (r.status !== 200 || !Array.isArray(r.json?.sessions)) { await progress(scan, "sessions", { status: "failed", note: `GET /api/sessions/activity → ${r.status}` }); return []; }
  const since = Date.now() - scan.lookback_days * 86400_000;
  const out = [];
  for (const s of r.json.sessions) {
    if (s.test || !/^[A-Za-z0-9_-]{1,100}$/.test(s.session_id || "") || Date.parse(s.last_event_at) < since) continue;
    const sum = s.summary || {};
    const where = [s.repo?.slug || (s.cwd ? path.basename(s.cwd) : ""), s.branch].filter(Boolean).join(" · ");
    const bits = [sum.summary, sum.next ? `Next: ${sum.next}` : "", s.head?.subject ? `Last commit: ${s.head.subject}` : "", s.diff?.files ? `${s.diff.files} uncommitted file(s)` : "", !sum.summary ? (sum.tail?.last_assistant || s.last_assistant_message || "") : ""];
    out.push({ id: `session:${s.session_id}`, source: "session", label: `Claude Code · ${where || s.session_id.slice(0, 8)}`, at: new Date(s.last_event_at).toISOString(), text: bits.filter(Boolean).join(" · ").slice(0, 600) });
  }
  await progress(scan, "sessions", { status: "done", items: out.length });
  return out;
}

// ---------------- Grouping (claude -p, no tools) ----------------
export const GROUP_ARGS = ["--tools", "", "--permission-prompts", "none", "--strict-mcp-config", "--output-format", "text"];

export function groupingPrompt(items, me) {
  const lines = items.map((it) => JSON.stringify({ id: it.id, source: it.source, where: it.label, at: it.at, thread_ts: it.thread_ts, replies: it.reply_count, text: (it.text || "").slice(0, 500) }));
  return `You find the user's GENUINELY PENDING work in the items below and group it into candidate workstreams.
${me ? `The user's Slack id is ${me}; items labelled "· you" were written by the user.` : "Items labelled \"· you\" were written by the user."}

Pending means: an ask to the user nobody (the user) answered yet; a commitment the user made ("I'll…", "will do") not yet visibly done; an open PR the user authored or must review; an unresolved thread; a follow-up from a call or meeting; unfinished Claude Code work (uncommitted changes, a stated next step).
Skip: noise, chit-chat, FYIs, bot/CI chatter, resolved or answered threads, and anything that looks like fixture/test/QA data.
Group items about the same piece of work into ONE candidate (e.g. a Slack review ask + the PR it links).

Output ONLY JSON: {"candidates":[{"title":"<≤80 chars, imperative>","why":"<one line: why it is pending>","kind":"ask|commitment|review|pr|thread|follow_up|session","source_ids":["<ids from the items, exactly as given>"],"next_step":"<one concrete next action>","confidence":0.0}]}
confidence = how sure you are that this is real, still-pending work for the user (0..1). Use only ids from the list; never invent ids, links or facts. If nothing is pending, return {"candidates":[]}.

ITEMS (one JSON per line):
${lines.join("\n")}`;
}

const isFixture = (it) => /\/\/([a-z0-9-]+\.)?example\.(slack\.)?com\//i.test(it.url || "") || /\b(fixture|smoke[- ]test|\[test\])\b/i.test(it.text || "");

export async function runScan(scan, watch) {
  log(`scan ${scan.scan_id}: lookback ${scan.lookback_days}d, repo=${watch.repo || "(none)"}, surfaces=${watch.slackWatch?.surfaces?.length || 0}`);
  const gh = await readGithub(scan, watch);
  const sl = await readSlack(scan, watch);
  const se = await readSessions(scan);
  const raw = [...gh, ...sl.items, ...se].filter((x) => !isFixture(x));
  if (!raw.length) {
    await progress(scan, "grouping", { status: "skipped", note: "nothing found to group" });
    return { status: "done", raw: [], candidates: [] };
  }
  await progress(scan, "grouping", { status: "running", items: raw.length, note: `grouping ${raw.length} item(s) with claude -p (no tools)` });
  const r = await runClaudeRetry(GROUP_ARGS, groupingPrompt(raw, sl.me), "grouping");
  const parsed = r.out ? extractJson(r.out) : null;
  if (!parsed || !Array.isArray(parsed.candidates)) {
    const err = r.err || "could not parse grouping output";
    await progress(scan, "grouping", { status: "failed", note: err });
    return { status: "failed", error: `grouping failed: ${err}`, raw, candidates: [] };
  }
  await progress(scan, "grouping", { status: "done", items: parsed.candidates.length });
  return { status: "done", raw, candidates: parsed.candidates };
}

/** Heartbeat to the watcher board (best-effort), like the other workers: id backfill-worker. */
export async function heartbeat(status, last_action, detail) {
  return http("PUT", "/api/watchers/status", { id: "backfill-worker", status, last_action, ...(detail ? { detail } : {}) }).catch(() => null);
}

async function tick() {
  const c = await http("POST", "/api/backfill/claim").catch((e) => ({ status: 0, err: e }));
  if (c.status === 204) { await heartbeat("idle", "idle — no scan requested (read-only)"); return false; }
  if (c.status !== 200 || !c.json?.scan) { if (c.status) { log(`claim → ${c.status}`); await heartbeat("error", `claim → HTTP ${c.status}`); } return false; }
  const { scan, watch } = c.json;
  await heartbeat("ticking", `scanning ${scan.lookback_days}d (${scan.scan_id})`);
  // Keep the heartbeat fresh during long claude -p runs.
  const hb = setInterval(() => void heartbeat("ticking", `scanning ${scan.lookback_days}d (${scan.scan_id})`), 30_000);
  let res;
  try { res = await runScan(scan, watch); } catch (e) { res = { status: "failed", error: String(e?.message || e) }; }
  finally { clearInterval(hb); }
  const p = await http("POST", "/api/backfill/result", { scan_id: scan.scan_id, ...res });
  await heartbeat(res.status === "failed" ? "error" : "idle", `last scan ${scan.scan_id} → ${res.status}${res.error ? ": " + String(res.error).slice(0, 120) : ""}`);
  log(`scan ${scan.scan_id} → ${res.status}; result POST ${p.status}${p.json?.scan?.counts ? " " + JSON.stringify(p.json.scan.counts) : ""}${res.error ? " · " + res.error : ""}`);
  return true;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const once = process.argv.includes("--once");
  if (once) { await tick(); process.exit(0); }
  log(`watching ${BASE} every ${POLL}s (read-only)`);
  for (;;) {
    try { await tick(); } catch (e) { log("tick error", e?.message || e); }
    await sleep(POLL * 1000);
  }
}
