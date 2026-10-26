/**
 * Smoke: Claude Code session hook → Control. Hermetic: temp HOME / CONTROL_HOOK_HOME / cwd, local
 * throwaway HTTP server; never touches the real ~/.claude, ~/.control-hook or ./.control.
 *   npx tsx scripts/smoke-session-hook.ts
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";

let failed = 0;
function assert(c: unknown, m: string) {
  if (c) console.log(`ok: ${m}`);
  else {
    failed++;
    console.error(`FAIL: ${m}`);
  }
}
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-session-smoke-"));

async function main() {
  // ---------- 1. settings merge / idempotence / dry-run / uninstall (temp HOME) ----------
  const inst = await import(path.join(ROOT, "scripts/control-hook-install.mjs"));
  const home = path.join(tmp, "home");
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = {
    theme: "dark",
    enabledPlugins: { "slack@anthropic-plugin-directory": true },
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/notify-me" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/x/block-rm.sh" }] }],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

  // dry-run writes nothing
  const before = fs.readFileSync(settingsPath, "utf8");
  const dry = inst.run({ action: "install", dryRun: true, home, log: () => {} });
  assert(dry.changed === true, "dry-run reports a change");
  assert(fs.readFileSync(settingsPath, "utf8") === before, "dry-run leaves settings.json untouched");
  assert(!fs.existsSync(path.join(home, ".control-hook")), "dry-run creates no ~/.control-hook");
  assert(fs.readdirSync(path.dirname(settingsPath)).length === 1, "dry-run writes no backup");

  const r1 = inst.run({ action: "install", home, now: new Date("2026-10-26T10:00:00Z"), log: () => {} });
  const s1 = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const P = inst.paths(home);
  assert(r1.changed && r1.backup && fs.existsSync(r1.backup), "install backs up settings.json first");
  assert(fs.readFileSync(r1.backup, "utf8") === before, "backup is the pre-install file");
  assert(s1.theme === "dark" && s1.enabledPlugins["slack@anthropic-plugin-directory"] === true && s1.permissions.allow[0] === "Bash(git status)", "other settings kept");
  assert(s1.hooks.PreToolUse[0].hooks[0].command === "/x/block-rm.sh", "other events' hooks kept");
  assert(s1.hooks.Stop.some((g: any) => g.hooks.some((h: any) => h.command === "/usr/local/bin/notify-me")), "existing Stop hook kept");
  for (const ev of ["Stop", "SessionEnd"])
    assert(s1.hooks[ev].some((g: any) => g.hooks.some((h: any) => h.command === P.hook && h.type === "command")), `our hook registered on ${ev}`);
  assert((fs.statSync(P.hook).mode & 0o111) !== 0, "hook copied executable");
  assert(!fs.readFileSync(P.hook, "utf8").includes("__CONTROL_HOOK_NODE__"), "hook has node path templated");
  assert(inst.run({ action: "check", home }).installed === true, "check: installed");

  const backupsBefore = fs.readdirSync(path.dirname(settingsPath)).length;
  const r2 = inst.run({ action: "install", home, now: new Date("2026-10-26T10:05:00Z"), log: () => {} });
  const s2 = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert(r2.changed === false && r2.backup === null, "second install: no change, no backup");
  assert(JSON.stringify(s2) === JSON.stringify(s1), "second install: settings identical (idempotent)");
  assert(fs.readdirSync(path.dirname(settingsPath)).length === backupsBefore, "second install: no extra backup file");
  const ours = (s: any) => ["Stop", "SessionEnd"].map((e) => s.hooks[e].flatMap((g: any) => g.hooks).filter((h: any) => h.command.includes("control-session-hook")).length);
  assert(ours(s2).every((n: number) => n === 1), "exactly one Control handler per event");

  // stale path from an older install is replaced, not duplicated
  const staleMerged = inst.mergeHook({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/control-session-hook" }] }] } }, P.hook);
  assert(staleMerged.hooks.Stop.flatMap((g: any) => g.hooks).length === 1 && staleMerged.hooks.Stop[0].hooks[0].command === P.hook, "stale Control hook path replaced");

  const u1 = inst.run({ action: "uninstall", home, now: new Date("2026-10-26T10:10:00Z"), log: () => {} });
  const su = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert(u1.changed && u1.backup && fs.existsSync(u1.backup), "uninstall backs up first");
  assert(JSON.stringify(su) === JSON.stringify(original), "uninstall restores exactly the non-Control settings");
  const u2 = inst.run({ action: "uninstall", home, log: () => {} });
  assert(u2.changed === false, "second uninstall: no change");
  assert(inst.run({ action: "check", home }).installed === false, "check: not installed after uninstall");

  // empty / missing settings
  const home2 = path.join(tmp, "home2");
  inst.run({ action: "install", home: home2, log: () => {} });
  const fresh = JSON.parse(fs.readFileSync(inst.paths(home2).settings, "utf8"));
  assert(Object.keys(fresh).join() === "hooks", "install on missing settings creates hooks only");
  inst.run({ action: "uninstall", home: home2, log: () => {} });
  assert(JSON.stringify(JSON.parse(fs.readFileSync(inst.paths(home2).settings, "utf8"))) === "{}", "uninstall drops the emptied hooks key");

  // unparseable settings: fail closed
  const home3 = path.join(tmp, "home3");
  fs.mkdirSync(path.join(home3, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home3, ".claude", "settings.json"), "{ not json");
  let threw = false;
  try {
    inst.run({ action: "install", home: home3, log: () => {} });
  } catch {
    threw = true;
  }
  assert(threw && fs.readFileSync(path.join(home3, ".claude", "settings.json"), "utf8") === "{ not json", "unparseable settings: refuses, file untouched");

  // ---------- 2. queue + replay ----------
  const hookHome = path.join(tmp, "hookhome");
  process.env.CONTROL_HOOK_HOME = hookHome;
  process.env.CONTROL_HOOK_POST_TIMEOUT_MS = "1500";
  const col = await import(path.join(ROOT, "scripts/control-session-collect.mjs"));
  const received: any[] = [];
  let mode: "ok" | "500" | "400" = "ok";
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      if (mode !== "ok") {
        res.writeHead(Number(mode));
        res.end("{}");
        return;
      }
      received.push(JSON.parse(b));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const up = `http://127.0.0.1:${port}`;
  const down = "http://127.0.0.1:9"; // discard port: connection refused

  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "feat/x");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first commit");
  g("remote", "add", "origin", "git@github.com:acme/widgets.git");
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
  g("add", "a.txt");
  fs.writeFileSync(path.join(repo, "new.txt"), "y\n");
  const ev = col.buildEvent({ hook_event_name: "Stop", session_id: "sess-1", cwd: repo, transcript_path: "/t/x.jsonl", last_assistant_message: "done" }, new Date("2026-10-26T10:00:00Z"));
  assert(ev.repo?.slug === "acme/widgets" && ev.branch === "feat/x" && ev.head?.subject === "first commit", "event has repo slug, branch, last commit");
  assert(ev.diff?.files_changed === 1 && ev.diff.insertions === 1 && ev.diff.untracked === 1, "event has uncommitted diff stat + untracked");
  assert(col.remoteSlug("https://github.com/o/r.git") === "o/r", "remoteSlug https");

  const p1 = await col.postEvent(ev, down);
  assert(!p1.ok && p1.retry, "Control down → retryable failure");
  col.enqueue(ev);
  col.enqueue({ ...ev, at: "2026-10-26T10:01:00.000Z", hook_event_name: "SessionEnd" });
  const qn = () => fs.readdirSync(col.queueDir()).filter((n: string) => n.endsWith(".json"));
  assert(qn().length === 2, "two events queued on disk");
  const rDown = await col.replayQueue(down);
  assert(rDown.sent === 0 && rDown.left === 2 && qn().length === 2, "replay while down keeps the queue");
  mode = "500";
  const r500 = await col.replayQueue(up);
  assert(r500.sent === 0 && qn().length === 2, "replay on 5xx keeps the queue");
  mode = "ok";
  const rUp = await col.replayQueue(up);
  assert(rUp.sent === 2 && qn().length === 0, "replay when up drains the queue");
  assert(received.length === 2 && received[0].hook_event_name === "Stop" && received[1].hook_event_name === "SessionEnd" && received[0].replayed === true, "replayed oldest-first, marked replayed");
  col.enqueue(ev);
  mode = "400";
  const r400 = await col.replayQueue(up);
  assert(r400.dropped === 1 && qn().length === 0 && fs.readdirSync(col.queueDir()).some((n: string) => n.endsWith(".rejected")), "4xx → set aside as .rejected, not retried forever");
  mode = "ok";

  // ---------- 3. hook exit time + detached collector end-to-end ----------
  const hookBin = path.join(tmp, "bin");
  fs.mkdirSync(hookBin);
  fs.writeFileSync(path.join(hookBin, "control-session-hook"), fs.readFileSync(path.join(ROOT, "scripts/control-session-hook"), "utf8").replace("__CONTROL_HOOK_NODE__", process.execPath), { mode: 0o755 });
  fs.copyFileSync(path.join(ROOT, "scripts/control-session-collect.mjs"), path.join(hookBin, "control-session-collect.mjs"));
  const payload = JSON.stringify({ hook_event_name: "SessionEnd", reason: "prompt_input_exit", session_id: "sess-hook", cwd: repo, transcript_path: "/t/y.jsonl" });
  const times: number[] = [];
  const nBefore = received.length;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const res = spawnSync(path.join(hookBin, "control-session-hook"), [], { input: payload, env: { ...process.env, CONTROL_BASE_URL: up, CONTROL_HOOK_HOME: hookHome } });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert(res.status === 0 && res.stdout.length === 0, `hook run ${i + 1}: exit 0, no stdout`);
  }
  const med = [...times].sort((a, b) => a - b)[1];
  console.log(`   hook wall times ms: ${times.map((t) => t.toFixed(1)).join(", ")}`);
  assert(med < 100, `hook exits in <100ms (median ${med.toFixed(1)}ms)`);
  for (let i = 0; i < 50 && received.length < nBefore + 3; i++) await new Promise((r) => setTimeout(r, 100));
  assert(received.length === nBefore + 3 && received.at(-1).session_id === "sess-hook" && received.at(-1).repo.slug === "acme/widgets", "detached collector delivered all 3 events with git state");
  const dis = spawnSync(path.join(hookBin, "control-session-hook"), [], { input: payload, env: { ...process.env, CONTROL_BASE_URL: up, CONTROL_HOOK_HOME: hookHome, CONTROL_HOOK_DISABLE: "1" } });
  await new Promise((r) => setTimeout(r, 800));
  assert(dis.status === 0 && received.length === nBefore + 3, "CONTROL_HOOK_DISABLE=1 → hook is a no-op (Control's own claude -p)");
  // down → queued by the real hook path, then drained by the next successful run
  spawnSync(path.join(hookBin, "control-session-hook"), [], { input: payload.replace("sess-hook", "sess-q"), env: { ...process.env, CONTROL_BASE_URL: down, CONTROL_HOOK_HOME: hookHome } });
  for (let i = 0; i < 50 && qn().length < 1; i++) await new Promise((r) => setTimeout(r, 100));
  assert(qn().length === 1, "hook with Control down → event queued under CONTROL_HOOK_HOME/queue");
  spawnSync(path.join(hookBin, "control-session-hook"), [], { input: payload, env: { ...process.env, CONTROL_BASE_URL: up, CONTROL_HOOK_HOME: hookHome } });
  for (let i = 0; i < 50 && qn().length > 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert(qn().length === 0 && received.some((e) => e.session_id === "sess-q" && e.replayed), "next successful hook run replays the queue");
  srv.close();

  // ---------- 4. transcript tail + summary parsing ----------
  const sum = await import(path.join(ROOT, "scripts/control-session-summarize.mjs"));
  const tr = path.join(tmp, "t.jsonl");
  const line = (o: object) => JSON.stringify(o);
  fs.writeFileSync(
    tr,
    [
      line({ type: "user", message: { role: "user", content: "Add retry to the uploader" }, timestamp: "2026-10-26T09:00:00Z" }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "Looking at uploader.ts" }, { type: "tool_use", name: "Read" }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", content: "…" }] } }),
      line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "SIDECHAIN" }] } }),
      line({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "Added exponential backoff; tests still need to run." }] } }),
      "{broken",
    ].join("\n")
  );
  const msgs = sum.readTranscriptTail(tr);
  assert(msgs.length === 3 && !msgs.some((m: any) => m.text.includes("SIDECHAIN") || m.text.includes("/clear")), "transcript tail: main thread only, noise skipped");
  const fb = sum.transcriptTailFallback(msgs, undefined);
  assert(fb.last_user === "Add retry to the uploader" && fb.last_assistant.startsWith("Added exponential backoff"), "fallback = verbatim last prompt + last reply");
  assert(sum.transcriptTailFallback([], undefined) === null, "no transcript text → no fallback (fail closed)");
  assert(sum.parseSummaryReply('{"summary":"S","next":"N"}').ok, "parse strict JSON reply");
  assert(sum.parseSummaryReply("```json\n{\"summary\":\"S\"}\n```").ok, "parse fenced JSON reply");
  assert(!sum.parseSummaryReply("Sure! Here is a summary").ok, "non-JSON reply rejected");
  assert(!sum.parseSummaryReply('{"next":"x"}').ok, "reply without summary rejected");
  const prompt = sum.buildPrompt({ repo: { slug: "acme/widgets" }, branch: "feat/x" }, msgs);
  assert(prompt.includes("Use ONLY the transcript") && prompt.includes("acme/widgets") && prompt.includes("Add retry"), "prompt is grounded in transcript + git facts");

  // ---------- 5. endpoint + summarizer (temp cwd → temp .control) ----------
  const cwd0 = process.cwd();
  const appDir = path.join(tmp, "app");
  fs.mkdirSync(appDir);
  process.chdir(appDir);
  process.env.CONTROL_SESSION_SUMMARY = "off";
  const route = await import(path.join(ROOT, "src/app/api/sessions/activity/route.ts"));
  const sa = await import(path.join(ROOT, "src/lib/session-activity.ts"));
  const { NextRequest } = await import("next/server");
  const post = (b: unknown) => route.POST(new NextRequest("http://x/api/sessions/activity", { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) }));
  const get = (q = "") => route.GET(new NextRequest(`http://x/api/sessions/activity${q}`));
  assert((await post("nope")).status === 400, "endpoint: invalid JSON → 400");
  assert((await post({ hook_event_name: "Stop", session_id: "../x", cwd: "/r" })).status === 400, "endpoint: bad session_id → 400");
  assert((await post({ hook_event_name: "Other", session_id: "a", cwd: "/r" })).status === 400, "endpoint: unknown event → 400");
  assert((await post({ hook_event_name: "Stop", session_id: "a", cwd: "rel" })).status === 400, "endpoint: relative cwd → 400");
  const okRes = await post({ ...ev, session_id: "sess-api", transcript_path: tr });
  const okJson = await okRes.json();
  assert(okRes.status === 200 && okJson.ok && okJson.summary === "disabled", "endpoint: valid Stop event stored");
  await post({ ...ev, session_id: "sess-api", transcript_path: tr, hook_event_name: "SessionEnd", reason: "prompt_input_exit", at: "2026-10-26T10:30:00Z" });
  await post({ ...ev, session_id: "sess-api", at: "2026-10-26T09:00:00Z", replayed: true, branch: "old-branch" });
  const rec = JSON.parse(fs.readFileSync(path.join(appDir, ".control/sessions/sess-api.json"), "utf8"));
  assert(rec.ended === true && rec.last_event === "SessionEnd" && rec.events.length === 3, "endpoint: events appended, SessionEnd marks ended");
  assert(rec.branch === "feat/x" && rec.last_event_at === "2026-10-26T10:30:00.000Z", "endpoint: older replayed event doesn't overwrite newer state");
  await post({ hook_event_name: "Test", session_id: "control-doctor-test", cwd: "/r", control_test: true });
  const listed = await (await get()).json();
  assert(listed.sessions.length === 1 && listed.sessions[0].session_id === "sess-api", "GET hides test sessions by default");
  const one = await (await get("?session_id=control-doctor-test")).json();
  assert(one.sessions.length === 1 && one.sessions[0].test === true, "GET ?session_id returns the doctor test event");

  // summarize decision
  const now = Date.parse("2026-10-26T11:00:00Z");
  assert(!sa.shouldSummarize({ hook_event_name: "Test", test: true }, null, 100, now), "never summarize test events");
  assert(!sa.shouldSummarize({ hook_event_name: "Stop" }, null, null, now), "no transcript → no summary run");
  assert(sa.shouldSummarize({ hook_event_name: "Stop" }, null, 100, now), "first Stop → summarize");
  const done = { session_id: "x", status: "ok", source: "claude", transcript_bytes: 100, finished_at: "2026-10-26T10:58:00Z" } as const;
  assert(!sa.shouldSummarize({ hook_event_name: "SessionEnd" }, done, 100, now), "unchanged transcript → no re-run");
  assert(sa.shouldSummarize({ hook_event_name: "SessionEnd" }, done, 200, now), "SessionEnd with grown transcript → re-run");
  assert(!sa.shouldSummarize({ hook_event_name: "Stop" }, done, 200, now), "Stop within 5 min of last summary → coalesced");
  assert(sa.shouldSummarize({ hook_event_name: "Stop" }, { ...done, finished_at: "2026-10-26T10:50:00Z" }, 200, now), "Stop after 5 min with growth → re-run");
  assert(!sa.shouldSummarize({ hook_event_name: "SessionEnd" }, { ...done, claude: "running", started_at: "2026-10-26T10:59:00Z" }, 300, now), "summary already running → no second run");

  const sres = await sum.summarize(path.join(appDir, ".control/sessions"), "sess-api", { useClaude: false });
  assert(sres.status === "fallback" && sres.source === "transcript_tail" && sres.tail.last_user === "Add retry to the uploader", "summarizer without Claude → labeled transcript_tail fallback");
  fs.writeFileSync(path.join(appDir, ".control/sessions/sess-empty.json"), JSON.stringify({ session_id: "sess-empty", cwd: "/r", last_event_at: "2026-10-26T10:00:00Z" }));
  const sempty = await sum.summarize(path.join(appDir, ".control/sessions"), "sess-empty", { useClaude: false });
  assert(sempty.status === "unavailable" && !sempty.summary, "no transcript → unavailable, nothing invented");
  process.chdir(cwd0);

  // ---------- 6. Resume prefers the newer session ----------
  const core = await import(path.join(ROOT, "src/lib/resume-core.ts"));
  const ws = [
    {
      key: "pr:acme/widgets#7", kind: "pr", title: "PR 7", events: [
        { id: "1", at: "2026-10-26T10:00:00Z", kind: "pr_comment", label: "c" },
        { id: "2", at: "2026-10-26T12:00:00Z", kind: "job_done", label: "worker" },
      ], jobs: [], slack: [], lastEventAt: "2026-10-26T12:00:00Z",
    },
  ];
  const sess = (id: string, at: string, extra: object = {}) => ({ session_id: id, cwd: "/w/r", repo: { toplevel: "/w/my repo", slug: "acme/widgets" }, branch: "feat/x", last_event_at: at, last_event: "Stop", ended: false, ...extra });
  assert(core.pickNewerSession([sess("s1", "2026-10-26T11:00:00Z")], ws, {})?.session_id === "s1", "session newer than GitHub/Slack events wins (worker job events don't count)");
  assert(core.pickNewerSession([sess("s1", "2026-10-26T09:00:00Z")], ws, {}) === null, "older session loses to newer PR activity");
  const act = { "pr:acme/widgets#7": { last_action: { kind: "opened", label: "x", at: "2026-10-26T11:30:00Z" }, history: [] } };
  assert(core.pickNewerSession([sess("s1", "2026-10-26T11:00:00Z")], ws, act) === null, "a newer user action on a PR beats the session");
  assert(core.pickNewerSession([sess("t", "2026-10-26T13:00:00Z", { test: true }), sess("s2", "2026-10-26T11:00:00Z")], ws, {})?.session_id === "s2", "test sessions never picked");
  assert(core.pickNewerSession([sess("a", "2026-10-26T11:00:00Z"), sess("b", "2026-10-26T11:10:00Z")], [], {})?.session_id === "b", "newest of several sessions; works with no PR/Slack workstreams");
  assert(core.sessionResumeCommand(sess("abc-1", "x")) === "cd '/w/my repo' && claude --resume abc-1", "copyable resume command, path quoted");
  assert(core.RESUME_KEY_RE.test("session:abc-1"), "session keys accepted for activity");
  assert(core.sessionNext(sess("a", "x", { summary: { status: "ok", source: "claude", summary: "S", next: "Run tests" } })).status === "ok", "Next from Claude summary");
  const nf = core.sessionNext(sess("a", "x", { summary: { status: "fallback", source: "transcript_tail", error: "claude -p exited 1" } }));
  assert(nf.status === "unavailable" && /transcript tail/.test(nf.reason), "fallback → Next unavailable, labeled (never invented)");
  assert(core.sessionNext(sess("a", "x", { summary: { status: "fallback", source: "transcript_tail", claude: "running" } })).status === "pending", "running summary → pending");
  assert(core.sessionNext(sess("a", "x")).status === "unavailable", "no summary → unavailable");

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll session-hook smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
