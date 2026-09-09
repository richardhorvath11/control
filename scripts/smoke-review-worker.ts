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
