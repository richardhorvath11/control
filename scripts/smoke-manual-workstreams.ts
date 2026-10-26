/**
 * Smoke: manual workstreams (POST/GET/PATCH/DELETE /api/workstreams, Resume eligibility, /control-add script).
 * Hermetic: temp app dir (cwd → .control), local throwaway HTTP server; never touches the real ./.control.
 *   npx tsx scripts/smoke-manual-workstreams.ts
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

let failed = 0;
function assert(c: unknown, m: string) {
  if (c) console.log(`ok: ${m}`);
  else {
    failed++;
    console.error(`FAIL: ${m}`);
  }
}
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-manual-smoke-"));

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));
}

async function main() {
  const cwd0 = process.cwd();
  const appDir = path.join(tmp, "app");
  fs.mkdirSync(appDir, { recursive: true });
  process.chdir(appDir); // CONTROL_DIR = cwd/.control is fixed at import time
  const col = await import(path.join(ROOT, "src/app/api/workstreams/route.ts"));
  const one = await import(path.join(ROOT, "src/app/api/workstreams/[id]/route.ts"));
  const { NextRequest } = await import("next/server");
  const post = (b: unknown) => col.POST(new NextRequest("http://x/api/workstreams", { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) }));
  const list = (q = "") => col.GET(new NextRequest(`http://x/api/workstreams${q}`));
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const patch = (id: string, b: unknown) => one.PATCH(new NextRequest(`http://x/api/workstreams/${id}`, { method: "PATCH", body: JSON.stringify(b) }), ctx(id));
  const del = (id: string) => one.DELETE(new NextRequest(`http://x/api/workstreams/${id}`, { method: "DELETE" }), ctx(id));
  const getOne = (id: string) => one.GET(new NextRequest(`http://x/api/workstreams/${id}`), ctx(id));

  // ---------- 1. CRUD ----------
  assert((await post({})).status === 400, "POST without title → 400");
  assert((await post("{nope")).status === 400, "POST invalid JSON → 400");
  assert((await post({ title: "x", link: "javascript:alert(1)" })).status === 400, "POST non-http link → 400");
  assert((await post({ title: "x", repo: "not a repo" })).status === 400, "POST bad repo → 400");
  assert((await post({ title: "x", cwd: "relative/dir" })).status === 400, "POST relative cwd → 400");
  assert((await post({ title: "x", status: "done" })).status === 400, "POST status done → 400 (new items start open)");
  const r1 = await post({ title: "  Finish uploader retry backoff  ", note: "left off at jitter", link: "https://github.com/o/r/pull/7", people: "Sam, Priya ,", when: "Fri", source: "cmdk" });
  const a = (await r1.json()).item;
  assert(r1.status === 201 && /^mw_[a-z0-9]+$/.test(a.id), "POST creates item with mw_ id (201)");
  assert(a.title === "Finish uploader retry backoff" && a.status === "open" && a.source === "cmdk", "title trimmed, status open, source kept");
  assert(JSON.stringify(a.people) === JSON.stringify(["Sam", "Priya"]), "people from comma string → list");
  const b = (await (await post({ title: "Second", people: ["Lee"] })).json()).item;
  let l = (await (await list()).json()).items;
  assert(l.length === 2 && l[0].id === b.id, "GET lists open items, newest-updated first");
  assert((await getOne(a.id)).status === 200, "GET /:id → 200");
  assert((await getOne("mw_nope00")).status === 404, "GET unknown id → 404");

  await new Promise((r) => setTimeout(r, 5));
  const p1 = await (await patch(a.id, { title: "Uploader backoff", note: "", people: null, when: "Mon" })).json();
  assert(p1.ok && p1.item.title === "Uploader backoff" && p1.item.when === "Mon", "PATCH updates title/when");
  assert(p1.item.note === undefined && p1.item.people === undefined, "PATCH '' / null clears note / people");
  assert(p1.item.link === "https://github.com/o/r/pull/7", "PATCH leaves untouched fields");
  assert(Date.parse(p1.item.updated_at) > Date.parse(a.updated_at), "PATCH bumps updated_at");
  assert((await patch(a.id, { title: "" })).status === 400, "PATCH empty title → 400");
  assert((await patch(a.id, {})).status === 400, "PATCH nothing → 400");
  assert((await patch(a.id, { status: "bogus" })).status === 400, "PATCH bad status → 400");
  assert((await patch("../../etc", { title: "x" })).status === 404, "PATCH bad id → 404");
  const d1 = await (await patch(a.id, { status: "done" })).json();
  assert(d1.item.status === "done" && d1.item.done_at, "PATCH status done sets done_at");
  l = (await (await list()).json()).items;
  assert(l.length === 1 && l[0].id === b.id, "GET hides done items by default");
  l = (await (await list("?include_done=1")).json()).items;
  assert(l.length === 2, "GET ?include_done=1 includes done");
  const d2 = await (await patch(a.id, { status: "open" })).json();
  assert(d2.item.status === "open" && !d2.item.done_at, "reopen clears done_at");
  assert((await del(b.id)).status === 200, "DELETE → 200");
  assert((await del(b.id)).status === 404, "DELETE again → 404");
  l = (await (await list("?include_done=1")).json()).items;
  assert(l.length === 1 && l[0].id === a.id, "DELETE removes only that item");

  // ---------- 2. no draft / job side effects ----------
  const files = walk(path.join(appDir, ".control"));
  assert(JSON.stringify(files) === JSON.stringify(["workstreams.json"]), `CRUD wrote only .control/workstreams.json (got ${JSON.stringify(files)})`);
  const srcs = ["src/lib/manual-workstreams.ts", "src/app/api/workstreams/route.ts", "src/app/api/workstreams/[id]/route.ts"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"));
  const forbidden = /review-runner|review-jobs|slack-outbox|github-outbox|slack-draft|pr-review-worker|writeReviewJob|spawn\(/;
  assert(srcs.every((s) => !forbidden.test(s)), "endpoint + lib import nothing that drafts, queues jobs or spawns");

  // ---------- 3. Resume eligibility ----------
  const core = await import(path.join(ROOT, "src/lib/resume-core.ts"));
  const T = (m: number) => new Date(Date.UTC(2026, 9, 26, 15, m)).toISOString();
  const ws = [{ key: "pr:o/r#1", kind: "pr", title: "PR 1", events: [{ at: T(10), kind: "pr_comment", label: "c" }] }];
  const man = (id: string, at: string, status = "open") => ({ id, title: id, status, updated_at: at });
  const ses = (at: string) => ({ session_id: "s1", cwd: "/x", last_event_at: at, last_event: "Stop", ended: false });
  let src = core.pickResumeSource([], [man("mw_aaaaaa", T(20))], ws, {});
  assert(src?.kind === "manual" && src.manual.id === "mw_aaaaaa", "manual newer than GitHub/Slack → Resume source");
  assert(core.pickResumeSource([], [man("mw_aaaaaa", T(5))], ws, {}) === null, "manual older than GitHub/Slack → not chosen");
  assert(core.pickResumeSource([], [man("mw_aaaaaa", T(20), "done")], ws, {}) === null, "done manual → not eligible");
  src = core.pickResumeSource([ses(T(30))], [man("mw_aaaaaa", T(20))], ws, {});
  assert(src?.kind === "session", "newer session beats older manual");
  src = core.pickResumeSource([ses(T(15))], [man("mw_aaaaaa", T(20)), man("mw_bbbbbb", T(25))], ws, {});
  assert(src?.kind === "manual" && src.manual.id === "mw_bbbbbb", "newest open manual beats older session");
  src = core.pickResumeSource([], [man("mw_aaaaaa", T(20))], ws, { "pr:o/r#1": { key: "pr:o/r#1", last_action: { kind: "opened", label: "o", at: T(40) }, history: [] } });
  assert(src === null, "a newer user action on a PR keeps the PR as Resume");
  src = core.pickResumeSource([], [man("mw_aaaaaa", T(20))], ws, { "manual:mw_aaaaaa": { key: "manual:mw_aaaaaa", last_action: { kind: "resumed", label: "r", at: T(40) }, history: [] } });
  assert(src?.kind === "manual", "activity on manual:/session: keys doesn't count as external");
  assert(core.RESUME_KEY_RE.test("manual:mw_abc123") && !core.RESUME_KEY_RE.test("manual:../x"), "manual: keys accepted by activity API");
  assert(core.manualResumeCommand({ id: "mw_a", title: "t", status: "open", updated_at: T(1), cwd: "/a b" }) === "cd '/a b'", "manual cd command is shell-quoted");

  // Through getResume (real files in the temp app dir; ensureNext=true must still create no job)
  const rs = await import(path.join(ROOT, "src/lib/resume-server.ts"));
  const res = await rs.getResume({ ensureNext: true });
  assert(res.ok && !res.empty && res.kind === "manual" && res.manual.id === a.id, "getResume → Manual card when it's the newest thing");
  assert(res.next.status === "ok" && res.next.text === "Mon", "manual Next = the user's own 'when' (labeled), never invented");
  const files2 = walk(path.join(appDir, ".control"));
  assert(!files2.some((f) => f.startsWith("review-jobs")), "Resume on a manual item queues no worker job");
  await patch(a.id, { status: "done" });
  const res2 = await rs.getResume({ ensureNext: false });
  assert(res2.ok && res2.empty, "after mark done, Resume no longer shows it");
  process.chdir(cwd0);

  // ---------- 4. /control-add script ----------
  const add = await import(path.join(ROOT, "scripts/control-add.mjs"));
  assert(add.slugFromRemote("git@github.com:me/thing.git") === "me/thing" && add.slugFromRemote("https://github.com/me/thing") === "me/thing", "slugFromRemote ssh + https");
  assert(add.slugFromRemote("https://gitlab.com/me/thing") === undefined, "non-GitHub remote → no repo");
  const repoDir = path.join(tmp, "repo");
  fs.mkdirSync(repoDir);
  const g = (...args: string[]) => spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  g("init", "-q", "-b", "feat/x");
  g("remote", "add", "origin", "git@github.com:acme/widgets.git");
  fs.mkdirSync(path.join(repoDir, "sub"));
  const inf = add.inferGit(path.join(repoDir, "sub"));
  assert(inf.repo === "acme/widgets" && inf.branch === "feat/x" && inf.cwd === fs.realpathSync(repoDir), "infers repo/branch/root from a subdir");
  const nb = add.buildBody({ title: " t ", people: "A, B", git: false, cwd: repoDir });
  assert(nb.title === "t" && nb.source === "skill" && !nb.repo && nb.cwd === repoDir, "--no-git skips inference");

  let got: unknown = null;
  const srv = http.createServer((req, rq) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got = { url: req.url, method: req.method, body: JSON.parse(body) };
      rq.writeHead(201, { "content-type": "application/json" });
      rq.end(JSON.stringify({ ok: true, item: { id: "mw_test01", title: "t", repo: "acme/widgets", branch: "feat/x" } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const { spawn } = require("child_process");
      const p = spawn(process.execPath, [path.join(ROOT, "scripts/control-add.mjs"), ...args], { cwd: repoDir, env: { ...process.env, ...env } });
      let out = "", err = "";
      p.stdout.on("data", (c: Buffer) => (out += c));
      p.stderr.on("data", (c: Buffer) => (err += c));
      p.on("close", (code: number | null) => resolve({ code, out, err }));
    });
  const ok = await run(["--title", "Ship widgets", "--when", "Fri"], { CONTROL_BASE_URL: `127.0.0.1:${port}` });
  const gb = got as { url: string; method: string; body: Record<string, string> } | null;
  assert(ok.code === 0 && /mw_test01/.test(ok.out), "control-add posts and prints the new id");
  assert(gb?.method === "POST" && gb.url === "/api/workstreams" && gb.body.repo === "acme/widgets" && gb.body.branch === "feat/x" && gb.body.when === "Fri", "control-add body carries inferred repo/branch + fields");
  srv.close();
  const down = await run(["--title", "x"], { CONTROL_BASE_URL: "http://127.0.0.1:9" });
  assert(down.code === 1 && /Nothing was saved/.test(down.err), "Control down → exit 1, says nothing saved");
  const noTitle = await run([], {});
  assert(noTitle.code === 2, "missing title → exit 2");
  got = null;
  const dry = await run(["--title", "x", "--dry-run", "--json"], { CONTROL_BASE_URL: `127.0.0.1:${port}` });
  assert(dry.code === 0 && JSON.parse(dry.out).dry_run === true && got === null, "--dry-run sends nothing");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failure(s)` : "\nAll manual-workstream smoke checks passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
