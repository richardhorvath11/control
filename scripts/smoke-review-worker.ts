/**
 * V0.7 chip 3b smoke: local Pro Claude worker claim → result path (stub claude).
 * Run: npx tsx scripts/smoke-review-worker.ts
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  REVIEW_JOB_SCHEMA,
  REVIEW_RESULT_SCHEMA,
  WAITING_FOR_LOCAL_WORKER_DETAIL,
  WORKER_TIMEOUT_DETAIL,
  resolveReviewBackend,
  validateReviewResult,
  writeReviewJob,
  reviewResultPath,
  REVIEW_JOBS_DIR,
  REVIEW_RESULTS_DIR,
  ensureReviewJobsDir,
  ensureReviewResultsDir,
  readReviewResultFile,
  newReviewJobId,
} from "../src/lib/review-runner";
import { interpretLiveReviewRunResponse } from "../src/lib/review-contracts";
import { enqueueReviewJob } from "../src/lib/invoke-review-runner";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";
import { autoReviewKeyFromRepoPr } from "../src/lib/pr-review-worker";

const ROOT = path.resolve(__dirname, "..");
const WORKER = path.join(ROOT, "scripts", "control-review-worker");

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

assert(NEEDS_YOU_EXTERNAL_CAP === 5, "cap unchanged at 5");
assert(
  autoReviewKeyFromRepoPr("richardhorvath11/battle-buddy", 32).startsWith(
    "auto-review:"
  ),
  "chip1 auto-kick key intact"
);
assert(
  WAITING_FOR_LOCAL_WORKER_DETAIL.includes("local worker"),
  "waiting detail copy"
);
assert(WORKER_TIMEOUT_DETAIL.includes("control-review-worker"), "timeout copy");
assert(/timed out|Waiting/i.test(WORKER_TIMEOUT_DETAIL), "timeout copy mentions waiting/timed out");
assert(
  !/Review runner failed/i.test(WORKER_TIMEOUT_DETAIL),
  "timeout copy is not Review runner failed"
);

// BUG-W4a/b: Live timeout path must not invent Demo/fake Surface checks.
{
  const storeSrc = fs.readFileSync(path.join(ROOT, "src/lib/store.ts"), "utf8");
  const liveIdx = storeSrc.indexOf("Never invent findings");
  const demoIdx = storeSrc.indexOf("// Demo: keep local sim");
  assert(liveIdx > 0 && demoIdx > liveIdx, "Live block before Demo sim");
  const liveBlock = storeSrc.slice(liveIdx, demoIdx);
  assert(
    !liveBlock.includes("buildPrReviewItem"),
    "Live path must not call buildPrReviewItem (no templated Surface checks)"
  );
  assert(
    !liveBlock.includes("buildFakeReviewResult"),
    "Live path must not call buildFakeReviewResult"
  );
  assert(
    liveBlock.includes("WORKER_TIMEOUT_DETAIL"),
    "Live poll timeout uses WORKER_TIMEOUT_DETAIL"
  );
  assert(
    liveBlock.includes("landFailed(WORKER_TIMEOUT_DETAIL"),
    "timeout lands Failed via WORKER_TIMEOUT_DETAIL"
  );
  assert(
    liveBlock.includes("interpretLiveReviewRunResponse"),
    "Live path uses interpretLiveReviewRunResponse"
  );
  assert(
    !liveBlock.includes('"Review runner failed"'),
    "Live path must not emit Review runner failed string"
  );
  assert(
    liveBlock.includes("landFailed(WORKER_TIMEOUT_DETAIL, false)"),
    "timeout lands Failed (not Blocked)"
  );
}

// Client interpreter: canonical worker enqueue → wait (not fail-fast).
{
  const canonical = interpretLiveReviewRunResponse(true, 200, {
    ok: true,
    pending: true,
    backend: "worker",
    detail: WAITING_FOR_LOCAL_WORKER_DETAIL,
    job: { job_id: "rj-test-1" },
  });
  assert(canonical.action === "wait_worker", "canonical pending → wait_worker");
  if (canonical.action === "wait_worker") {
    assert(canonical.jobId === "rj-test-1", "canonical job id");
  }

  // Soft shape: ok + job, pending omitted (residual mis-parse).
  const soft = interpretLiveReviewRunResponse(true, 200, {
    ok: true,
    job: { job_id: "rj-soft" },
  });
  assert(soft.action === "wait_worker", "ok+job without pending → wait_worker");

  // backend:worker without pending flag
  const be = interpretLiveReviewRunResponse(true, 200, {
    ok: true,
    backend: "worker",
    job: { job_id: "rj-be" },
  });
  assert(be.action === "wait_worker", "backend worker → wait_worker");

  // Empty/error body must not invent findings; no Review runner failed copy.
  const empty = interpretLiveReviewRunResponse(false, 500, {});
  assert(empty.action === "fail", "empty 500 → fail");
  if (empty.action === "fail") {
    assert(
      empty.detail === WORKER_TIMEOUT_DETAIL,
      "empty fail uses WORKER_TIMEOUT_DETAIL not Review runner failed"
    );
    assert(!/Review runner failed/i.test(empty.detail), "no Review runner failed");
  }

  // Timeout copy used for Live soft fail; zero findings implied (no apply_result).
  assert(
    interpretLiveReviewRunResponse(true, 200, {
      ok: true,
      pending: true,
      backend: "worker",
      job: { job_id: "rj-x" },
      result: undefined,
    }).action === "wait_worker",
    "pending never maps to apply_result/findings"
  );
}

{
  const prev = process.env.CONTROL_REVIEW_BACKEND;
  delete process.env.CONTROL_REVIEW_BACKEND;
  assert(resolveReviewBackend() === "worker", "unset ⇒ worker");
  if (prev !== undefined) process.env.CONTROL_REVIEW_BACKEND = prev;
  else delete process.env.CONTROL_REVIEW_BACKEND;
}

async function main() {
  await ensureReviewJobsDir();
  await ensureReviewResultsDir();

  const jobId = `rj-smoke-worker-${Date.now().toString(36)}`;
  const enq = await enqueueReviewJob({
    job_id: jobId,
    repo: "richardhorvath11/battle-buddy",
    pr: 32,
    provenance: [],
  });
  assert(enq.ok, "enqueueReviewJob ok");
  if (!enq.ok) {
    process.exit(1);
  }
  assert(fs.existsSync(enq.jobPath), "job file on disk");
  assert(
    enq.jobPath.includes(`${path.sep}review-jobs${path.sep}`),
    "job under review-jobs"
  );
  assert(
    enq.resultPath.includes(`${path.sep}review-results${path.sep}`),
    "result path under review-results"
  );

  // Pending: no result yet
  const pending = await readReviewResultFile(jobId);
  assert(!pending.ok && pending.pending === true, "result pending before worker");

  // Isolate: park other pending jobs so --once claims *this* smoke job
  // (leftover Live enqueues from dogfood must not steal the claim).
  const parked: string[] = [];
  for (const name of fs.readdirSync(REVIEW_JOBS_DIR)) {
    if (!name.endsWith(".json")) continue;
    if (name.startsWith(jobId.replace(/[^a-zA-Z0-9._-]/g, "_"))) continue;
    const full = path.join(REVIEW_JOBS_DIR, name);
    const claimed = full.replace(/\.json$/, ".claimed");
    if (fs.existsSync(claimed)) continue;
    const park = full + ".park-smoke";
    try {
      fs.renameSync(full, park);
      parked.push(park);
    } catch {
      /* ignore */
    }
  }
  const unpark = () => {
    for (const park of parked) {
      try {
        fs.renameSync(park, park.replace(/\.park-smoke$/, ""));
      } catch {
        /* ignore */
      }
    }
  };

  // Stub claude on PATH that emits valid control.review_result.v1
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-claude-stub-"));
  const stubClaude = path.join(binDir, "claude");
  fs.writeFileSync(
    stubClaude,
    `#!/usr/bin/env bash
# ignore args; emit one valid result JSON on stdout
# (worker passes job via -p prompt; we just need parseable JSON)
cat <<'JSON'
{
  "schema": "${REVIEW_RESULT_SCHEMA}",
  "job_id": "${jobId}",
  "status": "ok",
  "summary": "Stub Pro worker review of richardhorvath11/battle-buddy#32",
  "findings": [{
    "title": "Stub surface check",
    "body": "From control-review-worker smoke (API key unset path).",
    "evidence": []
  }],
  "scope": { "notes": "smoke stub — not invented by Control UI" }
}
JSON
`,
    { mode: 0o755 }
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    ANTHROPIC_API_KEY: "should-be-unset-by-worker",
  };
  const r = spawnSync(WORKER, ["--once"], {
    encoding: "utf8",
    cwd: ROOT,
    env,
  });
  unpark();
  assert(
    r.status === 0,
    `worker --once exit 0 (got ${r.status}) stderr=${r.stderr} stdout=${r.stdout}`
  );

  const resultFile = reviewResultPath(jobId);
  assert(fs.existsSync(resultFile), `result file at ${resultFile}`);
  const raw = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const vr = validateReviewResult(raw);
  assert(vr.ok, "result schema valid");
  if (vr.ok) {
    assert(vr.result.status === "ok", "status ok");
    assert(vr.result.findings.length >= 1, "≥1 finding from worker");
    assert(vr.result.job_id === jobId, "job_id matches");
  }

  const claimed = path.join(
    REVIEW_JOBS_DIR,
    `${jobId.replace(/[^a-zA-Z0-9._-]/g, "_")}.claimed`
  );
  assert(fs.existsSync(claimed), "claim sidecar written");

  const after = await readReviewResultFile(jobId);
  assert(after.ok === true, "readReviewResultFile finds result");

  // --once with nothing left → exit 1
  const empty = spawnSync(WORKER, ["--once"], {
    encoding: "utf8",
    cwd: ROOT,
    env,
  });
  assert(empty.status === 1, `no pending → exit 1 (got ${empty.status})`);

  // Missing claude → exit 4 + error result (keep PATH so bash wrapper works)
  const jobId2 = `rj-smoke-noclaude-${Date.now().toString(36)}`;
  await writeReviewJob({
    schema: REVIEW_JOB_SCHEMA,
    job_id: jobId2,
    repo: "richardhorvath11/battle-buddy",
    pr: 99,
    provenance: [],
  });
  const missingClaude = path.join(
    os.tmpdir(),
    `control-no-claude-${Date.now()}`,
    "claude"
  );
  const r4 = spawnSync(WORKER, ["--once"], {
    encoding: "utf8",
    cwd: ROOT,
    env: {
      ...process.env,
      CONTROL_REVIEW_WORKER_CLAUDE: missingClaude,
    },
  });
  assert(r4.status === 4, `claude missing → exit 4 (got ${r4.status}) stderr=${r4.stderr}`);
  const errRes = await readReviewResultFile(jobId2);
  assert(errRes.ok === true, "error result written when claude missing");
  if (errRes.ok) {
    assert(errRes.result.status === "error", "status error");
    assert(/claude/i.test(errRes.result.summary), "summary mentions claude");
  }

  // Cleanup smoke artifacts (best-effort)
  for (const id of [jobId, jobId2]) {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
    for (const f of [
      path.join(REVIEW_JOBS_DIR, `${safe}.json`),
      path.join(REVIEW_JOBS_DIR, `${safe}.claimed`),
      path.join(REVIEW_JOBS_DIR, "in-progress", `${safe}.json`),
      path.join(REVIEW_RESULTS_DIR, `${safe}.json`),
    ]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    fs.rmSync(binDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (failed > 0) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll review-worker smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
