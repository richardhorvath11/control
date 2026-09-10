/**
 * V0.9 chip 3 smoke: Verify Claude contracts + no Review pollution.
 * Run: npx tsx scripts/smoke-claude-verify.ts
 */
import fs from "fs";
import path from "path";
import {
  CLAUDE_VERIFY_HINTS,
  CLAUDE_VERIFY_WAIT_MS,
  REVIEW_JOB_SCHEMA,
  REVIEW_RESULT_SCHEMA,
  resolveReviewBackend,
  resolveReviewJobKind,
  validateReviewJob,
  validateReviewResult,
} from "../src/lib/review-runner";
import { NEEDS_YOU_EXTERNAL_CAP as CAP } from "../src/lib/github-constants";

const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

assert(CAP === 5, "NEEDS_YOU_EXTERNAL_CAP unchanged at 5");
assert(resolveReviewBackend({} as NodeJS.ProcessEnv) === "worker", "Live default backend=worker");
assert(CLAUDE_VERIFY_WAIT_MS === 90_000, "verify wait ≤90s");
assert(
  CLAUDE_VERIFY_HINTS.ok.includes("claude on PATH"),
  "ok hint mentions PATH"
);
assert(
  CLAUDE_VERIFY_HINTS.missing.includes("setup-token"),
  "missing hint → setup-token"
);
assert(
  CLAUDE_VERIFY_HINTS.worker_down.includes("dogfood-up"),
  "worker_down → dogfood-up"
);
assert(
  !/ANTHROPIC_API_KEY/.test(Object.values(CLAUDE_VERIFY_HINTS).join(" ")),
  "hints never require ANTHROPIC_API_KEY"
);

assert(resolveReviewJobKind({ kind: "verify" }) === "verify", "kind verify");
assert(resolveReviewJobKind({ smoke: true }) === "verify", "smoke:true → verify");

const vJob = validateReviewJob({
  schema: REVIEW_JOB_SCHEMA,
  job_id: "rj-verify-smoke",
  kind: "verify",
});
assert(vJob.ok && "job" in vJob && vJob.job.kind === "verify", "validate verify job");

const badPr = validateReviewJob({
  schema: REVIEW_JOB_SCHEMA,
  job_id: "rj-x",
  kind: "pr_review",
});
assert(!badPr.ok, "pr_review still requires repo+pr");

const result = validateReviewResult({
  schema: REVIEW_RESULT_SCHEMA,
  job_id: "rj-verify-smoke",
  status: "ok",
  summary: "claude ok",
  findings: [],
});
assert(result.ok, "minimal verify result validates");
if (result.ok) {
  assert(result.result.findings.length === 0, "findings empty");
  assert(result.result.summary === "claude ok", "summary claude ok");
}

// Source guards: no API key fields on Workers page; verify additive
const workersPage = fs.readFileSync(
  path.join(ROOT, "src/app/get-live/workers/page.tsx"),
  "utf8"
);
assert(workersPage.includes("Verify Claude"), "Workers page has Verify Claude");
assert(workersPage.includes("verify-claude"), "verify-claude testid");
assert(
  !/<input[^>]*(api.?key|anthropic)/i.test(workersPage),
  "Workers page has no API key input fields"
);
assert(
  /no ANTHROPIC_API_KEY/i.test(workersPage),
  "Workers page states no ANTHROPIC_API_KEY required"
);
assert(workersPage.includes("LOCAL_REQUIRED"), "checklist intact");
assert(workersPage.includes("dogfood-up"), "dogfood-up intact");

const runRoute = fs.readFileSync(
  path.join(ROOT, "src/app/api/review/run/route.ts"),
  "utf8"
);
assert(runRoute.includes('kind === "verify"'), "run route handles verify");
assert(runRoute.includes("findActiveVerifyJob"), "idempotent verify");
assert(runRoute.includes("WORKER_DOWN"), "worker heartbeat gate");

const statusRoute = fs.readFileSync(
  path.join(ROOT, "src/app/api/review/claude-status/route.ts"),
  "utf8"
);
assert(statusRoute.includes("claude_on_path"), "claude-status probe");

const worker = fs.readFileSync(
  path.join(ROOT, "scripts/control-review-worker.mjs"),
  "utf8"
);
assert(worker.includes('kind === "verify"'), "worker handles verify");
assert(worker.includes("runVerifyClaude"), "cheap verify path");
assert(worker.includes('summary: "claude ok"'), "worker posts claude ok");
assert(worker.includes("findings: []"), "worker empty findings");
assert(worker.includes("ANTHROPIC_API_KEY"), "worker still unsets API key");

const store = fs.readFileSync(path.join(ROOT, "src/lib/store.ts"), "utf8");
assert(
  store.includes("Never invent findings"),
  "Live still never invents findings"
);
assert(
  !store.includes('kind: "verify"'),
  "store does not auto-apply verify into Review"
);

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
assert(readme.includes("### Verify Claude"), "README Verify Claude subsection");
assert(readme.includes("NEEDS_YOU_EXTERNAL_CAP=5"), "cap documented");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll smoke-claude-verify checks passed.");
