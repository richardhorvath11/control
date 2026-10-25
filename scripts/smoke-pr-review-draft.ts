/**
 * Smoke: PR review never needs a tool / permission prompt, and its draft comment is grounded.
 * Hermetic: mock jobs HTTP API + stub `gh` + stub `claude` on PATH. Touches no real server,
 * GitHub or Slack; posts nothing.
 *   1. worker pre-fetches the diff via gh and embeds it in the prompt (stdin)
 *   2. claude is spawned with all tools disabled + prompts auto-denied, never skip-permissions
 *   3. prompt asks for draft_text; result draft_text survives to the Review item's draftText
 *   4. no draft_text → derived from findings only; no findings → "" (UI empty state)
 *   5. gh diff failure → job fails closed, claude never runs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildReviewItemFromResult, prCommentDraftFromResult, REVIEW_RESULT_SCHEMA } from "../src/lib/review-contracts";

let failed = 0;
function assert(c: unknown, m: string) { if (c) console.log(`ok  ${m}`); else { failed++; console.error(`FAIL ${m}`); } }

const DIFF_MARK = "+const SMOKE_DIFF_MARKER = 42; // src/smoke.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-prdraft-smoke-"));
const argvLog = path.join(dir, "claude-argv.txt");
const stdinLog = path.join(dir, "claude-stdin.txt");
const ghLog = path.join(dir, "gh-calls.txt");

fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
echo "$*" >> "${ghLog}"
if [ -n "$SMOKE_GH_FAIL" ] && [ "$2" = diff ]; then echo "HTTP 404" >&2; exit 1; fi
if [ "$2" = view ]; then echo '{"number":32,"title":"Smoke PR","body":"","files":[{"path":"src/smoke.ts"}]}'; exit 0; fi
if [ "$2" = diff ]; then printf 'diff --git a/src/smoke.ts b/src/smoke.ts\\n@@ -1 +1 @@\\n${DIFF_MARK}\\n'; exit 0; fi
exit 9
`, { mode: 0o755 });
fs.writeFileSync(path.join(dir, "claude"), `#!/usr/bin/env bash
for a in "$@"; do printf '[%s]\\n' "$a"; done > "${argvLog}"
cat > "${stdinLog}"
JOB=$(grep -o 'rj-smk-[a-z0-9-]*' "${stdinLog}" | head -1)
cat <<JSON
{"schema":"${REVIEW_RESULT_SCHEMA}","job_id":"$JOB","status":"ok","summary":"stub",
 "findings":[{"title":"Magic number","body":"SMOKE_DIFF_MARKER is unexplained. Name it.","evidence":["src/smoke.ts:1"]}],
 "draft_text":"Review notes:\\n- **Magic number** (\\\`src/smoke.ts:1\\\`) — name the constant.",
 "scope":{"notes":"stub"}}
JSON
`, { mode: 0o755 });

type Posted = { kind: string; body: any };
async function runWorker(jobId: string, extraEnv: Record<string, string> = {}) {
  const posted: Posted[] = [];
  let served = false;
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const u = req.url || "";
      if (u === "/api/review/jobs/claim") {
        if (served) { res.statusCode = 204; return res.end(); }
        served = true;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ job: { schema: "control.review_job.v1", job_id: jobId, kind: "pr_review", repo: "smoke-owner/smoke-repo", pr: 32, provenance: [] } }));
      }
      const m = u.match(/\/api\/review\/jobs\/[^/]+\/(result|fail)$/);
      if (m) posted.push({ kind: m[1], body: JSON.parse(b || "{}") });
      res.setHeader("content-type", "application/json"); res.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  for (const f of [argvLog, stdinLog]) fs.rmSync(f, { force: true });
  const out = await new Promise<number>((resolve) => {
    const { spawn } = require("node:child_process");
    const ch = spawn("node", ["scripts/control-review-worker.mjs", "--once"], {
      env: { ...process.env, ...extraEnv, PATH: `${dir}:${process.env.PATH}`, CONTROL_BASE_URL: `http://127.0.0.1:${port}`, CONTROL_REVIEW_WORKER_CLAUDE: path.join(dir, "claude") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    ch.on("exit", (c: number) => resolve(c ?? -1));
  });
  srv.close();
  return { code: out, posted };
}

async function main() {
  // --- happy path
  const r = await runWorker("rj-smk-ok");
  const argv = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";
  const stdin = fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, "utf8") : "";
  assert(fs.readFileSync(ghLog, "utf8").includes("pr diff 32 --repo smoke-owner/smoke-repo"), "worker pre-fetched diff via gh");
  assert(stdin.includes(DIFF_MARK), "diff embedded in claude prompt (stdin)");
  assert(/Do NOT run any tools/.test(stdin), "prompt says Do NOT run any tools");
  assert(/draft_text/.test(stdin), "prompt asks for draft_text");
  assert(argv.includes("[--tools]\n[]\n"), "claude spawned with --tools \"\" (no tools available)");
  assert(argv.includes("[--permission-prompts]\n[none]"), "claude spawned with --permission-prompts none");
  assert(!/allowedTools|allowed-tools|skip-permissions|bypassPermissions/.test(argv), "no allowedTools / skip-permissions");
  const res = r.posted.find((p) => p.kind === "result")?.body;
  assert(res && /Magic number/.test(res.draft_text || ""), "result carries draft_text to the API");
  const item = buildReviewItemFromResult({ id: "rev-smk", repo: "smoke-owner/smoke-repo", pr: 32, agentId: "a", result: res });
  assert(/Magic number/.test(item.draftText || "") && /src\/smoke\.ts:1/.test(item.draftText || ""), "Review item draftText pre-filled from claude draft");

  // --- fallback + empty
  const base = { schema: REVIEW_RESULT_SCHEMA, job_id: "x", status: "ok" as const, summary: "s" };
  const derived = prCommentDraftFromResult({ ...base, findings: [{ title: "Null deref", body: "x may be null here. Guard it.", evidence: ["src/a.ts:10 x.y"] }] } as any);
  assert(/\*\*Null deref\*\*/.test(derived) && derived.includes("`src/a.ts:10`") && derived.includes("x may be null here."), "no draft_text → derived from findings only");
  assert(!derived.includes("Guard it"), "derived draft keeps first sentence only (concise)");
  assert(prCommentDraftFromResult({ ...base, findings: [] } as any) === "", "no findings → empty draft (UI empty state)");

  // --- fail closed
  const f = await runWorker("rj-smk-fail", { SMOKE_GH_FAIL: "1" });
  assert(f.posted.some((p) => p.kind === "fail" && /could not fetch PR diff/.test(p.body.error || "")), "gh diff failure → job failed (fail closed)");
  assert(!fs.existsSync(argvLog), "gh failure → claude never spawned");
  assert(!f.posted.some((p) => p.kind === "result"), "gh failure → no result/findings");

  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nsmoke-pr-review-draft: all passed");
}
main();
