/**
 * Smoke: first-launch backfill (lib validation/decisions + worker runScan against stub claude/gh).
 * Hermetic: temp cwd (→ .control), local throwaway HTTP server; never touches real Slack/GitHub/.control.
 *   npx tsx scripts/smoke-backfill.ts
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";

let failed = 0;
function assert(c: unknown, m: string) {
  if (c) console.log(`ok: ${m}`);
  else { failed++; console.error(`FAIL: ${m}`); }
}
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-backfill-smoke-"));
process.chdir(tmp);

const DOM = "acme-team";
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const ts = (msAgo: number) => ((now - msAgo) / 1000).toFixed(6);
const T1 = ts(3600_000), T2 = ts(7200_000);
const slackUrl = (ch: string, t: string) => `https://${DOM}.slack.com/archives/${ch}/p${t.replace(".", "")}`;

async function main() {
  const L = await import(path.join(ROOT, "src/lib/backfill"));
  const W = await import(path.join(ROOT, "scripts/control-backfill-worker.mjs"));

  // ---- pure validation ----
  const raw = [
    { id: `slack:C111:${T1}`, source: "slack", url: slackUrl("C111", T1), label: "#eng · Dana", at: iso(3600_000), text: "can you review PR 7?" },
    { id: "gh:pr:o/r#7", source: "github", url: "https://github.com/o/r/pull/7", label: "o/r#7", at: iso(1800_000), text: "PR" },
    { id: "session:abc", source: "session", label: "Claude Code · o/r", at: iso(600_000), text: "Next: tests" },
    { id: `slack:C222:${T2}`, source: "slack", url: `https://example.slack.com/archives/C222/p${T2.replace(".", "")}`, label: "#x", at: iso(7200_000), text: "fixture" },
    { id: `slack:C333:${T2}`, source: "slack", url: slackUrl("C333", T2), label: "#qa-e2e · bot", at: iso(7200_000), text: "please review" },
    { id: `slack:C444:${T2}`, source: "slack", url: slackUrl("C999", T2), label: "#eng", at: iso(7200_000), text: "mismatched link" },
  ];
  assert(L.isFixtureItem(raw[3]), "example.slack.com is fixture");
  assert(L.isFixtureItem(raw[4]), "unconfigured QA channel is fixture");
  assert(!L.isFixtureItem({ ...raw[4], configured_surface: true }), "explicitly configured QA channel is not filtered by name");
  assert(!L.validRawItem(raw[5]), "permalink channel mismatch rejected");
  assert(!L.validRawItem({ ...raw[1], url: "https://github.com/o/r/issues/7" }), "PR id with issue URL rejected");
  const v = L.validateCandidates(raw, [
    { title: "Review PR 7", why: "Dana asked", source_ids: [raw[0].id, "gh:pr:o/r#7"], next_step: "review", confidence: 0.92, url: "https://evil.example/x" },
    { title: "Finish tests", source_ids: ["session:abc"], confidence: 1.7 },
    { title: "Invented", source_ids: ["slack:C9:1.1"], confidence: 0.9 },
    { title: "Partly invented", source_ids: ["session:abc", "gh:pr:o/r#99"], confidence: 0.9 },
    { title: "Fixture only", source_ids: [raw[3].id], confidence: 0.9 },
    { title: "", source_ids: ["session:abc"], confidence: 0.5 },
  ]);
  assert(v.candidates.length === 2 && v.dropped === 4, `validate keeps 2, drops 4 (got ${v.candidates.length}/${v.dropped})`);
  const rev = v.candidates.find((c: any) => c.title === "Review PR 7")!;
  assert(rev.sources[0].url === slackUrl("C111", T1) && !JSON.stringify(v).includes("evil"), "links come from raw items, never the model");
  assert(v.candidates.find((c: any) => c.title === "Finish tests")?.confidence === 1, "confidence clamped to 1");

  // ---- lifecycle + decisions (temp .control) ----
  const bad = await L.requestScan({ lookback_days: 999 });
  assert(!bad.ok && bad.status === 400, "lookback > 180 days rejected (400)");
  const s1 = await L.requestScan({ lookback_days: 60, trigger: "settings" });
  assert(s1.ok && s1.scan.lookback_days === 60, "lookback 60 accepted");
  const dup = await L.requestScan({});
  assert(!dup.ok && dup.status === 409, "second scan while active → 409");
  const cl = await L.claimScan();
  assert(cl?.scan_id === s1.scan.scan_id && cl.status === "running", "claim marks running");
  assert((await L.claimScan()) === null, "nothing else to claim");
  const cands = [
    { title: "Review PR 7", source_ids: [raw[0].id, "gh:pr:o/r#7"], confidence: 0.9 },
    { title: "Finish tests", source_ids: ["session:abc"], confidence: 0.6 },
    { title: "Reply to Dana", source_ids: [raw[0].id], confidence: 0.85 },
  ];
  // shared source between 1 & 3 is fine; validate passes
  await L.finishScan(cl.scan_id, { status: "done", raw, candidates: cands });
  let doc = await L.readCandidateDoc();
  assert(doc.candidates.length === 3, "3 candidates pending after scan");
  const created: string[] = [];
  const mk = async (c: any) => { created.push(c.title); return { id: "mw_" + created.length }; };
  const keyOf = (t: string) => doc.candidates.find((c: any) => c.title === t)!.key;
  await L.decide({ action: "rename", key: keyOf("Finish tests"), title: "Finish backfill tests" }, mk);
  await L.decide({ action: "reject", key: keyOf("Reply to Dana") }, mk);
  doc = await L.readCandidateDoc();
  assert(doc.candidates.some((c: any) => c.title === "Finish backfill tests") && doc.candidates.length === 2, "rename + reject applied");
  assert(created.length === 0, "nothing becomes a workstream without accept");
  const r1 = await L.decide({ action: "accept_high" }, mk);
  assert(r1.ok && created.join() === "Review PR 7", "accept_high accepts only ≥0.8");

  // re-scan: rejected/accepted stay hidden; newer activity resurfaces the rejected one
  const s2 = await L.requestScan({ trigger: "cmdk" });
  const c2 = await L.claimScan();
  await L.finishScan(c2.scan_id, { status: "done", raw, candidates: cands });
  doc = await L.readCandidateDoc();
  assert(doc.candidates.length === 1 && doc.candidates[0].title === "Finish tests", `re-scan hides accepted+rejected (got ${doc.candidates.map((c: any) => c.title)})`);
  const T3 = ts(60_000);
  const raw3 = [...raw, { id: `slack:C111:${T3}`, source: "slack", url: slackUrl("C111", T3), label: "#eng · Dana", at: iso(60_000), text: "ping?" }];
  await L.requestScan({}); const c3 = await L.claimScan();
  await L.finishScan(c3.scan_id, { status: "done", raw: raw3, candidates: [...cands.slice(1), { title: "Reply to Dana", source_ids: [raw[0].id, raw3.at(-1)!.id], confidence: 0.85 }] });
  doc = await L.readCandidateDoc();
  assert(doc.candidates.some((c: any) => c.title === "Reply to Dana"), "rejected item resurfaces with newer activity");

  // merge
  const [a, b] = doc.candidates.map((c: any) => c.key);
  const m = await L.decide({ action: "merge", keys: [a, b], title: "Merged one" }, mk);
  assert(m.ok && m.candidates.length === 1 && m.candidates[0].merged && m.candidates[0].sources.length >= 2, "merge combines two candidates");
  await L.requestScan({}); const c4 = await L.claimScan();
  await L.finishScan(c4.scan_id, { status: "failed", error: "boom" });
  doc = await L.readCandidateDoc();
  assert((await L.readScan()).status === "failed" && doc.candidates.length === 1, "failed scan keeps previous candidates, invents none");
  await L.requestScan({}); const c5 = await L.claimScan();
  await L.finishScan(c5.scan_id, { status: "done", raw: raw3, candidates: cands.slice(1) });
  doc = await L.readCandidateDoc();
  assert(doc.candidates.length === 1 && doc.candidates[0].title === "Merged one", "pending merge survives re-scan, duplicates folded");

  // ---- worker args ----
  const sa: string[] = W.slackReadArgs();
  const dis = sa[sa.indexOf("--disallowedTools") + 1];
  assert(["slack_send_message", "slack_send_message_draft", "slack_schedule_message", "slack_add_reaction"].every((t) => dis.includes(t)), "slack read disallows write tools");
  assert(!sa[sa.indexOf("--allowedTools") + 1].includes("send"), "slack allowed tools are read-only");
  assert(W.GROUP_ARGS.includes("--strict-mcp-config") && W.GROUP_ARGS[W.GROUP_ARGS.indexOf("--tools") + 1] === "", "grouping: no tools, strict MCP config");
  assert(W.slackItemsFromRead({ id: "C1" }, { messages: [{ ts: T1, text: "x" }] }, 0, null).items.length === 0, "no domain → Slack items dropped (fail closed)");

  // ---- worker --once end-to-end with stubs ----
  const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
  const argLog = path.join(tmp, "claude-args.log");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
echo "$@" >> ${argLog}
cat > /dev/null
if [[ -n "$ANTHROPIC_API_KEY" ]]; then echo "KEY LEAKED"; exit 3; fi
if [[ " $* " == *" --strict-mcp-config "* ]]; then cat "$STUB_GROUP"; else echo '{"me":"U1","messages":[{"ts":"${T1}","user":"U2","user_name":"Dana","text":"can you review PR 7?"}]}'; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/bash
if [[ "$*" == *"prs"*"--author"* ]]; then echo '[{"number":7,"title":"Fix","url":"https://github.com/o/r/pull/7","repository":{"nameWithOwner":"o/r"},"updatedAt":"${iso(1800_000)}","state":"open"}]'; else echo '[]'; fi
`, { mode: 0o755 });

  let lastResult: any = null;
  const srv = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const send = (code: number, x?: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(x === undefined ? "" : JSON.stringify(x)); };
    if (req.url === "/api/backfill/claim") { const s = await L.claimScan(); return s ? send(200, { scan: s, watch: { repo: "o/r", slackWatch: { surfaces: [{ id: "C111", name: "#eng" }] }, slack_team_domain: DOM } }) : send(204); }
    if (req.url === "/api/backfill/progress") { await L.reportProgress(j.scan_id, j.source, j); return send(200, {}); }
    if (req.url === "/api/backfill/result") { lastResult = await L.finishScan(j.scan_id, j); return send(200, lastResult); }
    if (req.url === "/api/sessions/activity") return send(200, { sessions: [] });
    send(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const runWorker = (group: string) => new Promise<number>((resolve) => {
    const gf = path.join(tmp, "group.json"); fs.writeFileSync(gf, group);
    const ch = spawn(process.execPath, [path.join(ROOT, "scripts/control-backfill-worker.mjs"), "--once"], {
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-should-not-pass", CONTROL_BASE_URL: `http://127.0.0.1:${port}`, CONTROL_BACKFILL_CLAUDE: path.join(bin, "claude"), CONTROL_BACKFILL_GH: path.join(bin, "gh"), BACKFILL_BACKOFF_MS: "10", STUB_GROUP: gf },
      stdio: "inherit",
    });
    ch.on("close", (c) => resolve(c ?? 1));
  });

  fs.rmSync(L.BACKFILL_DIR, { recursive: true, force: true }); // fresh state for the worker run
  await L.requestScan({ trigger: "first_live" });
  await runWorker(JSON.stringify({ candidates: [{ title: "Review o/r#7 for Dana", why: "asked in #eng", source_ids: [`slack:C111:${T1}`, "gh:pr:o/r#7"], next_step: "review", confidence: 0.9 }, { title: "Bogus", source_ids: ["gh:pr:o/r#404"], confidence: 0.99 }] }));
  let sc = await L.readScan();
  assert(sc.status === "done" && sc.counts.dropped_invalid === 1, `worker scan done, invented ids dropped (${JSON.stringify(sc.counts)})`);
  doc = await L.readCandidateDoc();
  assert(doc.candidates.some((c: any) => c.title === "Review o/r#7 for Dana" && c.sources.some((s: any) => s.url === slackUrl("C111", T1))), "worker candidate cites real derived permalink");
  assert(["github", "slack", "sessions", "grouping"].every((k) => sc.progress[k].status !== "pending"), "progress reported for every source");
  const args = fs.readFileSync(argLog, "utf8");
  assert(/--disallowedTools \S*slack_send_message/.test(args) && args.includes("--strict-mcp-config"), "worker passed read-only + strict args to claude");

  await L.requestScan({});
  await runWorker("Sorry, I can't produce JSON");
  sc = await L.readScan();
  assert(sc.status === "failed" && /grouping/.test(sc.error || ""), "unparseable grouping → scan failed (fail closed)");
  srv.close();
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
  console.log("\nsmoke-backfill: all ok");
}, (e) => { console.error(e); process.exit(1); });
