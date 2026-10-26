/**
 * Smoke: Live hygiene + optional sources.
 *  1. control-v0 migration strips seed/demo items in Live (old polluted state), keeps them in Demo.
 *  2. Dismiss derived workstreams: persistent, keyed by key + last activity; newer activity re-shows; Resume skips.
 *  3. Primary PR removed: watch.json migration drops `pr` (+ seed workstreamId) and keeps the rest.
 *  4. Every source optional: no-repo save, Slack-only, nothing at all; old configs still work.
 *  5. Tick with no repo exits 0 ("skipped"); doctor shows GitHub/Slack rows as SKIP, not FAIL.
 * Hermetic: temp app dir (cwd → .control), throwaway copies of scripts; never touches the real ./.control,
 * the running server, GitHub or Slack. Posts nothing.
 *   npx tsx scripts/smoke-live-clean.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

let failed = 0;
function assert(c: unknown, m: string) {
  if (c) console.log(`ok: ${m}`);
  else { failed++; console.error(`FAIL: ${m}`); }
}
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-liveclean-"));

async function main() {
  // ---------- 1. sanitize / migration (pure) ----------
  const ls = await import(path.join(ROOT, "src/lib/live-sanitize.ts"));
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/seed.json"), "utf8"));
  const liveWs = { id: "ws-review-acme-app-7", title: "Review acme/app#7", ephemeral: true };
  const liveAtt = { id: "att-gh-1", origin: "github", title: "real", workstreamId: "ws-cred" };
  const polluted = {
    workstreams: [...seed.workstreams, liveWs, { id: "ws-abc123", title: "demo delegate" }],
    attention: [...seed.attention, liveAtt],
    reviewQueue: seed.reviewQueue, agents: seed.agents, fyi: seed.fyi,
    suggestedDelegations: seed.suggestedDelegations, usedDelegationIds: ["del-priya"],
    dayStrip: seed.dayStrip, sources: seed.sources, focusWorkstreamId: "ws-cred",
  };
  assert(ls.countDemoItems(polluted) > 0, `polluted fixture has demo items (${ls.countDemoItems(polluted)})`);
  const mig = ls.migrateControlV0(structuredClone(polluted), 0, "live");
  assert(ls.countDemoItems(mig) === 0, "v0 → v2 in Live: zero demo items remain");
  assert(mig.workstreams.length === 1 && mig.workstreams[0].id === liveWs.id, "keeps the real ws-review-* workstream only");
  assert(mig.attention.length === 1 && mig.attention[0].id === "att-gh-1" && !mig.attention[0].workstreamId, "keeps real GitHub attention; dangling seed workstreamId cleared");
  assert(mig.dayStrip.meetings.length === 0 && mig.suggestedDelegations.length === 0 && mig.focusWorkstreamId == null, "seed meetings, delegations and focus gone");
  const demo = ls.migrateControlV0(structuredClone(polluted), 0, "demo");
  assert(demo.workstreams.length === polluted.workstreams.length, "Demo mode: migration leaves seed state alone");
  assert(ls.CONTROL_PERSIST_VERSION >= 2, "persist version bumped");
  const sc = ls.scrubSeedRefs([{ id: "ext-att-1", workstreamId: "ws-cred" }, { id: "x", workstreamId: "ws-review-a-1" }], [{ id: "ws-cred" }, { id: "ws-review-a-1" }]);
  assert(sc && !sc.attention[0].workstreamId && sc.attention[1].workstreamId === "ws-review-a-1" && sc.workstreams.length === 1, "post-sync scrub clears seed ws refs from real server items");
  assert(ls.scrubSeedRefs([{ id: "a" }], [{ id: "ws-review-a-1" }]) === null, "scrub no-op when clean");

  // ---------- temp app dir ----------
  const cwd0 = process.cwd();
  const appDir = path.join(tmp, "app");
  fs.mkdirSync(path.join(appDir, ".control"), { recursive: true });
  process.chdir(appDir);
  const { NextRequest } = await import("next/server");
  const gi = await import(path.join(ROOT, "src/lib/github-inbox.ts"));
  const wroute = await import(path.join(ROOT, "src/app/api/watch/route.ts"));
  const sroute = await import(path.join(ROOT, "src/app/api/sessions/activity/route.ts"));
  const droute = await import(path.join(ROOT, "src/app/api/workstreams/dismiss/route.ts"));
  const lroute = await import(path.join(ROOT, "src/app/api/workstreams/live/route.ts"));
  const rs = await import(path.join(ROOT, "src/lib/resume-server.ts"));
  const dz = await import(path.join(ROOT, "src/lib/dismissals.ts"));
  const watchFile = path.join(appDir, ".control/watch.json");
  const put = async (b: unknown) => { const r = await wroute.PUT(new NextRequest("http://x/api/watch", { method: "PUT", body: JSON.stringify(b) })); return { status: r.status, body: await r.json() }; };
  const get = async () => (await wroute.GET()).json();

  // ---------- 3/4. watch: missing, legacy migration, optional sources ----------
  let g = await get();
  assert(g.watch && g.watch.repo === "" && g.watch.configured === false && !("pr" in g.watch), "missing watch.json → empty config, no example copied, no pr");
  fs.writeFileSync(watchFile, JSON.stringify({ repo: "acme/app", pr: 32, workstreamId: "ws-cred", teams: ["core"], slackWatch: { surfaces: [{ id: "C0AAA", name: "#eng", kind: "channel", prLinks: true }], includeDms: false, includeMpims: false } }));
  g = await get();
  const onDisk = JSON.parse(fs.readFileSync(watchFile, "utf8"));
  assert(!("pr" in onDisk) && !("workstreamId" in onDisk), "old config: pr + seed workstreamId dropped from watch.json");
  assert(onDisk.repo === "acme/app" && onDisk.teams[0] === "core" && onDisk.slackWatch.surfaces[0].id === "C0AAA", "old config: repo, teams, Slack surfaces kept");
  assert(g.watch.configured === true && g.watch.sources.github && g.watch.sources.slack && !("pr" in g.watch), "old config still works (both sources on)");
  let r = await put({ repo: "acme/app", pr: 99, teams: [], slackWatch: { surfaces: [], includeDms: false, includeMpims: false } });
  assert(r.status === 200 && !("pr" in JSON.parse(fs.readFileSync(watchFile, "utf8"))), "PUT with a stray pr: accepted, pr not stored");
  r = await put({ repo: "", teams: [], slackWatch: { surfaces: [{ id: "C0BBB", name: "#x", kind: "channel", prLinks: true }], includeDms: false, includeMpims: false } });
  assert(r.status === 200 && r.body.watch.configured && !r.body.watch.sources.github && r.body.watch.sources.slack, "Slack-only save (no repo) → 200, configured, github off");
  r = await put({ teams: [], slackWatch: { surfaces: [], includeDms: false, includeMpims: false } });
  assert(r.status === 200 && r.body.watch.repo === "" && !r.body.watch.sources.github && !r.body.watch.sources.slack, "nothing-at-all save → 200 (sessions + manual only)");
  r = await put({ repo: "acme/app", teams: [], slackWatch: { surfaces: [], includeDms: false, includeMpims: false } });
  assert(r.status === 200 && r.body.watch.sources.github && !r.body.watch.sources.slack, "GitHub-only save → 200");
  r = await put({ repo: "not a repo", teams: [], slackWatch: { surfaces: [], includeDms: false, includeMpims: false } });
  assert(r.status === 400, "malformed repo still rejected (400)");
  assert(gi.isWatchConfigured({ repo: "", slackWatch: { surfaces: [{ id: "C1", kind: "channel", prLinks: true }], includeDms: false, includeMpims: false } }) === true, "isWatchConfigured: Slack-only true");
  assert(gi.isWatchConfigured({ repo: "a/b", slackWatch: { surfaces: [], includeDms: false, includeMpims: false } }) === true, "isWatchConfigured: repo-only true");
  assert(gi.hasRemovedWatchKeys({ pr: 1 }) && gi.hasRemovedWatchKeys({ workstreamId: "ws-cred" }) && !gi.hasRemovedWatchKeys({ repo: "a/b" }), "hasRemovedWatchKeys");

  // ---------- 2. dismiss ----------
  const post = (b: unknown) => droute.POST(new NextRequest("http://x/api/workstreams/dismiss", { method: "POST", body: JSON.stringify(b) }));
  const t1 = new Date(Date.now() - 30 * 60_000).toISOString();
  const ev = (at: string) => sroute.POST(new NextRequest("http://x/api/sessions/activity", { method: "POST", body: JSON.stringify({ hook_event_name: "SessionEnd", reason: "prompt_input_exit", session_id: "sess-dismiss", cwd: appDir, at }) }));
  await ev(t1);
  let list = await (await lroute.GET()).json();
  const row = list.items.find((x: { kind: string }) => x.kind === "session");
  assert(row && row.key, `session shows in /api/workstreams/live (${row?.key})`);
  let res = await rs.getResume({ ensureNext: false });
  assert(res.ok && res.kind === "session", "Resume picks the session before dismiss");
  assert((await post({ key: "manual:abc" })).status === 400, "dismiss manual key → 400 (manual items are deleted)");
  assert((await post({ key: "bogus key!" })).status === 400, "bad key → 400");
  assert((await post({ key: "pr:acme/app#404" })).status === 404, "unknown key → 404");
  const d = await post({ key: row.key });
  const dj = await d.json();
  assert(d.status === 200 && dj.dismissal.last_activity_at === row.last_activity_at, "dismiss → 200, server-side last_activity_at recorded");
  const stored = JSON.parse(fs.readFileSync(path.join(appDir, ".control/dismissed-workstreams.json"), "utf8"));
  assert(stored.schema === dz.DISMISSALS_SCHEMA && stored.items[row.key], "persisted under .control/dismissed-workstreams.json");
  list = await (await lroute.GET()).json();
  assert(!list.items.some((x: { key: string }) => x.key === row.key) && list.dismissed === 1, "dismissed row hidden from the list (dismissed count 1)");
  res = await rs.getResume({ ensureNext: false });
  assert(!(res.ok && res.kind === "session"), `Resume skips the dismissed item (kind=${res.kind ?? res.ok})`);
  await ev(t1); // same activity again → still hidden
  list = await (await lroute.GET()).json();
  assert(!list.items.some((x: { key: string }) => x.key === row.key), "same activity → stays dismissed");
  await ev(new Date().toISOString()); // newer activity → reappears
  list = await (await lroute.GET()).json();
  assert(list.items.some((x: { key: string }) => x.key === row.key), "newer activity → reappears");
  assert(dz.isDismissed({ k: { key: "k", last_activity_at: t1, dismissed_at: t1 } }, "k", t1) && !dz.isDismissed({ k: { key: "k", last_activity_at: t1, dismissed_at: t1 } }, "k", new Date().toISOString()), "isDismissed rule");

  process.chdir(cwd0);

  // ---------- 5. tick + doctor with no repo ----------
  const fake = path.join(tmp, "root");
  fs.mkdirSync(path.join(fake, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fake, ".control"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts/github-watcher-tick.sh"), path.join(fake, "scripts/github-watcher-tick.sh"));
  const env = { ...process.env, CONTROL_BASE_URL: "http://127.0.0.1:9" };
  let tk = spawnSync("bash", [path.join(fake, "scripts/github-watcher-tick.sh")], { env, encoding: "utf8", timeout: 30000 });
  assert(tk.status === 0 && /skipped/.test(tk.stdout), `tick with no watch.json → exit 0, skipped (${tk.status})`);
  fs.writeFileSync(path.join(fake, ".control/watch.json"), JSON.stringify({ repo: "", teams: [], slackWatch: { surfaces: [], includeDms: false, includeMpims: false } }));
  tk = spawnSync("bash", [path.join(fake, "scripts/github-watcher-tick.sh")], { env, encoding: "utf8", timeout: 30000 });
  assert(tk.status === 0 && /skipped: no GitHub repo/.test(tk.stdout), `tick with empty repo → exit 0, skipped (${tk.status} ${tk.stderr.slice(0, 200)})`);
  const wf = path.join(tmp, "doctor-watch.json");
  fs.writeFileSync(wf, JSON.stringify({ repo: "", teams: [], slackWatch: { surfaces: [], includeDms: false, includeMpims: false } }));
  const doc = spawnSync(path.join(ROOT, "scripts/control-doctor"), ["--fast", "--json"], { env: { ...env, CONTROL_WATCH_PATH: wf }, encoding: "utf8", timeout: 120000 });
  let rows: { name: string; status: string; fix?: string }[] = [];
  const jl = doc.stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  try { rows = (JSON.parse(jl ?? "{}").steps ?? []).map((x: { name: string; result: string; fix?: string }) => ({ name: x.name, status: x.result, fix: x.fix })); } catch { /* below */ }
  const by = (re: RegExp) => rows.filter((x) => re.test(x.name));
  const ghRows = by(/gh auth|github-watch|dry-run/i);
  const slRows = by(/slack mcp/i);
  assert(ghRows.length >= 1 && ghRows.every((x) => x.status === "SKIP"), `doctor: GitHub rows SKIP (${JSON.stringify(ghRows.map((x) => [x.name, x.status]))})`);
  assert(slRows.length >= 1 && slRows.every((x) => x.status === "SKIP"), `doctor: Slack MCP row SKIP (${JSON.stringify(slRows.map((x) => [x.name, x.status]))})`);
  assert([...ghRows, ...slRows].every((x) => !x.fix), "doctor: skipped rows carry no fix (not failures)");
  assert(!/\] (gh auth|Slack MCP|github-watcher-tick --dry-run) — [^\n]*\n\s+fix:/.test(doc.stdout) && !/fix these[^\n]*\n(\s+- [^\n]*\n)*\s+- (gh auth|Slack MCP|github-watcher)/.test(doc.stdout), "doctor: skipped sources not listed under fixes");
}

main()
  .catch((e) => { failed++; console.error(e); })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
    process.exit(failed ? 1 : 0);
  });
