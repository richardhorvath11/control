/**
 * Smoke: Resume never shows raw ISO timestamps — every source (GitHub PR, Slack thread, Claude Code session,
 * manual) gives its "why" time as a structured `selection.at` that the UI renders relative ("12 min ago")
 * with the exact local time in a tooltip. Hermetic (temp app dir).
 *   npx tsx scripts/smoke-resume-times.ts
 */
import fs from "fs";
import os from "os";
import path from "path";

let failed = 0;
function assert(c: unknown, m: string) {
  if (c) console.log(`ok: ${m}`);
  else {
    failed++;
    console.error(`FAIL: ${m}`);
  }
}
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-times-smoke-"));

/** Every string a user can read in a Resume payload (skip machine fields: *_at, at, ids, paths, urls, hashes). */
const MACHINE_KEY = /(^|_)at$|^at$|^lastEventAt$|_id$|^id$|^key$|hash|path|^cwd$|^url$|permalink|^resume_command$|^rule$|^kind$|^status$/;
function visibleStrings(v: unknown, keyPath = "", out: [string, string][] = []): [string, string][] {
  if (typeof v === "string") {
    const k = keyPath.split(".").pop() || "";
    if (!MACHINE_KEY.test(k)) out.push([keyPath, v]);
  } else if (Array.isArray(v)) v.forEach((x, i) => visibleStrings(x, `${keyPath}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visibleStrings(x, keyPath ? `${keyPath}.${k}` : k, out);
  return out;
}

async function main() {
  const rt = await import(path.join(ROOT, "src/lib/reltime.ts"));
  const NOW = Date.parse("2026-10-26T15:00:00Z");
  // ---------- 1. formatting ----------
  assert(rt.relTime("2026-10-26T14:59:30Z", NOW) === "just now", "< 90 s → just now");
  assert(rt.relTime("2026-10-26T14:48:00Z", NOW) === "12 min ago", "12 min → '12 min ago'");
  assert(rt.relTime("2026-10-26T12:00:00Z", NOW) === "3 h ago", "3 h ago");
  assert(rt.relTime("2026-10-24T15:00:00Z", NOW) === "2 d ago", "2 d ago");
  assert(rt.relTime("2026-10-26T15:10:00Z", NOW) === "in 10 min", "future → 'in 10 min'");
  assert(rt.relTime("garbage", NOW) === "" && rt.relTime(undefined, NOW) === "", "bad/missing → empty (never 'NaN')");
  const title = rt.localTitle("2026-10-26T14:47:58.385Z", "America/Chicago");
  assert(/Oct 26, 2026/.test(title) && /9:47:58\sAM/.test(title) && /CDT/.test(title), `tooltip = exact local time with zone (${title})`);
  assert(!rt.hasIso(title), "tooltip itself is not ISO");
  for (const iso of ["2026-10-26T14:47:58.385Z", "2026-10-26T14:47:58Z", "2026-10-26T14:47:58+00:00", "2026-10-26T09:47:58-0500", "2026-10-26T14:47"]) assert(rt.hasIso(`x ${iso} y`), `detects ${iso}`);
  assert(!rt.hasIso("PR #2026 at 10-26") && !rt.hasIso("head abcdef1"), "no false positives on plain text");
  const parts = rt.splitIso("ended 2026-10-26T14:48:00Z, newer than 2026-10-26T12:00:00Z!");
  assert(parts.length === 5 && "at" in parts[1] && "at" in parts[3] && (parts[4] as { text: string }).text === "!", "splitIso splits text/time/text/time/text");
  assert(rt.humanizeIso("ended 2026-10-26T14:48:00Z", NOW) === "ended 12 min ago", "humanizeIso for plain-string spots");

  // ---------- 2. GitHub + Slack (live) sources ----------
  const core = await import(path.join(ROOT, "src/lib/resume-core.ts"));
  const T = (m: number) => new Date(Date.UTC(2026, 9, 26, 14, m)).toISOString();
  const gh = [{ id: "g1", applied: true, event: { id: "e1", type: "review.requested", repo: "acme/app", pr_number: 7, summary: "Review requested from you", occurred_at: T(1) }, effects: {} }];
  const sl = [{ id: "s1", applied: true, event: { id: "m1", type: "message", channel_id: "C2", message_ts: "200.1", permalink: "https://real.slack.com/archives/C2/p2001", text_excerpt: "can you ship today?", occurred_at: T(4) }, effects: { attention: { why: "question to you" } } }];
  const ws = core.deriveWorkstreams({ githubItems: gh, slackItems: sl, jobs: [], snapshots: [] });
  const pr = ws.find((w: { kind: string }) => w.kind === "pr"), th = ws.find((w: { kind: string }) => w.kind === "slack");
  let sel = core.selectResume(ws, {});
  assert(sel && !rt.hasIso(sel.reason) && sel.at === th.lastEventAt && sel.atLabel === "latest activity", "untouched → reason has no ISO; at = latest activity");
  sel = core.selectResume(ws, { [pr.key]: { key: pr.key, last_action: { kind: "opened", label: "Opened PR", at: T(30) }, history: [] } });
  assert(sel.workstream.key === pr.key && !rt.hasIso(sel.reason) && sel.at === T(30) && sel.atLabel === "you last worked on it", "GitHub PR: reason ISO-free; at = your last action");
  sel = core.selectResume(ws, { [th.key]: { key: th.key, last_action: { kind: "opened", label: "Opened thread", at: T(31) }, history: [] } });
  assert(sel.workstream.key === th.key && !rt.hasIso(sel.reason) && sel.at === T(31), "Slack thread: reason ISO-free; at = your last action");
  for (const w of ws) for (const e of w.events) assert(!rt.hasIso(e.label), `${w.kind} event label ISO-free (${e.label.slice(0, 40)})`);

  // ---------- 3. session + manual via the real getResume (temp app dir) ----------
  const cwd0 = process.cwd();
  const appDir = path.join(tmp, "app");
  fs.mkdirSync(appDir, { recursive: true });
  process.chdir(appDir);
  const { NextRequest } = await import("next/server");
  const sroute = await import(path.join(ROOT, "src/app/api/sessions/activity/route.ts"));
  const mroute = await import(path.join(ROOT, "src/app/api/workstreams/route.ts"));
  const rs = await import(path.join(ROOT, "src/lib/resume-server.ts"));
  const sAt = new Date(Date.now() - 12 * 60_000).toISOString();
  const r = await sroute.POST(new NextRequest("http://x/api/sessions/activity", { method: "POST", body: JSON.stringify({ hook_event_name: "SessionEnd", reason: "prompt_input_exit", session_id: "sess-times", cwd: appDir, at: sAt }) }));
  assert(r.status === 200 || r.status === 201, `session event accepted (${r.status})`);
  let res = await rs.getResume({ ensureNext: false });
  assert(res.ok && res.kind === "session", "getResume → session card");
  assert(!rt.hasIso(res.selection.reason), `session reason ISO-free ("${res.selection.reason}")`);
  assert(res.selection.at === sAt && res.selection.at_label === "ended", "session: selection.at = SessionEnd time, label 'ended'");
  assert(rt.relTime(res.selection.at) === "12 min ago", "session renders as '12 min ago'");
  let leaks = visibleStrings(res).filter(([, s]) => rt.hasIso(s));
  assert(leaks.length === 0, `session payload: no ISO in user-visible strings ${JSON.stringify(leaks)}`);

  await new Promise((x) => setTimeout(x, 5));
  const mr = await mroute.POST(new NextRequest("http://x/api/workstreams", { method: "POST", body: JSON.stringify({ title: "Times smoke", when: "Fri" }) }));
  const item = (await mr.json()).item;
  res = await rs.getResume({ ensureNext: false });
  assert(res.ok && res.kind === "manual" && !rt.hasIso(res.selection.reason), "manual reason ISO-free");
  assert(res.selection.at === item.updated_at && res.selection.at_label === "added", "manual: selection.at = updated_at, label 'added'");
  leaks = visibleStrings(res).filter(([, s]) => rt.hasIso(s));
  assert(leaks.length === 0, `manual payload: no ISO in user-visible strings ${JSON.stringify(leaks)}`);
  process.chdir(cwd0);

  // ---------- 4. UI: no raw ISO renders left in the Resume components ----------
  const ui = fs.readFileSync(path.join(ROOT, "src/components/LiveResume.tsx"), "utf8");
  assert(!/\bago\(/.test(ui), "LiveResume uses <RelTime> (old tooltip-less ago() removed)");
  assert(!/\{[\w.?]*selection\.reason\}/.test(ui), "selection.reason never rendered raw (always via <SelectionReason>)");
  const rawTimes = ui.match(/>\s*\{[\w.?]*(?:_at|\.at|lastEventAt)\}/g) || [];
  assert(rawTimes.length === 0, `no {…_at} rendered as text ${JSON.stringify(rawTimes)}`);
  const relTimes = (ui.match(/<RelTime at=/g) || []).length;
  assert(relTimes >= 8, `times render via <RelTime> (${relTimes} sites)`);
  const comp = fs.readFileSync(path.join(ROOT, "src/components/RelTime.tsx"), "utf8");
  assert(/title=\{localTitle\(at\)\}/.test(comp) && /dateTime=\{at\}/.test(comp), "<RelTime> = <time dateTime title=local time>");
  const page = fs.readFileSync(path.join(ROOT, "src/app/now/page.tsx"), "utf8");
  assert(/Left off: <TimeText/.test(page), "Focus 'Left off' renders through <TimeText> (stays live)");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failure(s)` : "\nAll Resume time smoke checks passed.");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
