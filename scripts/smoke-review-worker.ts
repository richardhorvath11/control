/**
 * V0.8 chip 1 smoke: opaque HTTP claim/result APIs + worker (stub claude).
 * Run: npx tsx scripts/smoke-review-worker.ts
 */
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import http from "http";
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
  reviewJobClaimPath,
  REVIEW_JOBS_DIR,
  REVIEW_RESULTS_DIR,
  ensureReviewJobsDir,
  ensureReviewResultsDir,
  readReviewResultFile,
  newReviewJobId,
  buildReviewItemFromResult,
} from "../src/lib/review-runner";
import {
  claimNextReviewJob,
  completeReviewJob,
  failReviewJob,
  getReviewJobView,
} from "../src/lib/review-jobs";
import { interpretLiveReviewRunResponse } from "../src/lib/review-contracts";
import { enqueueReviewJob } from "../src/lib/invoke-review-runner";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";
import {
  autoReviewKeyFromRepoPr,
  buildPrReviewItem,
  emptyLiveReviewWorkerSlice,
  isDemoSimulatedReviewItem,
  shouldBlockAutoKick,
  scrubDemoReviewPollution,
  prReviewAgentName,
} from "../src/lib/pr-review-worker";

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
  assert(
    liveBlock.includes("/api/review/jobs/"),
    "Live poll uses GET /api/review/jobs/:id"
  );
  assert(
    !liveBlock.includes("/api/review/result?job_id"),
    "Live poll retired GET /api/review/result file path"
  );
  assert(
    liveBlock.includes("WAITING_FOR_LOCAL_WORKER_DETAIL") ||
      storeSrc.includes("newAgent.detail = WAITING_FOR_LOCAL_WORKER_DETAIL"),
    "Live agent sets Waiting detail"
  );
}

// BUG-W4 3rd pass: Demo→Live wipe + stale autoKick re-kick + no Surface checks.
{
  const storeSrc = fs.readFileSync(path.join(ROOT, "src/lib/store.ts"), "utf8");
  assert(
    storeSrc.includes("emptyLiveReviewWorkerSlice"),
    "store wipes review worker slice on Live enter/hydrate"
  );
  assert(
    /partialize:[\s\S]*usedDelegationIds[\s\S]*appliedGithubEventIds/.test(
      storeSrc
    ),
    "partialize still persists applied ids"
  );
  // agents / reviewQueue / autoKickedReviewKeys must NOT appear as persisted fields.
  const partialMatch = storeSrc.match(/partialize:\s*\(state\)\s*=>\s*\(\{([\s\S]*?)\}\)/);
  assert(!!partialMatch, "partialize block found");
  const partialBody = partialMatch![1];
  assert(
    !/reviewQueue:\s*state\.reviewQueue/.test(partialBody),
    "partialize excludes reviewQueue"
  );
  assert(
    !/agents:\s*state\.agents/.test(partialBody),
    "partialize excludes agents"
  );
  assert(
    !/autoKickedReviewKeys:\s*state\.autoKickedReviewKeys/.test(partialBody),
    "partialize excludes autoKickedReviewKeys"
  );
  assert(
    storeSrc.includes("newAgent.detail = WAITING_FOR_LOCAL_WORKER_DETAIL"),
    "Live kick sets Waiting detail synchronously before fetch"
  );
  assert(
    storeSrc.includes("shouldBlockAutoKick"),
    "Live auto-kick uses shouldBlockAutoKick (stale key re-kick)"
  );
  assert(
    storeSrc.includes("stale_key"),
    "stale autoKicked key path present"
  );
}

{
  const repo = "richardhorvath11/battle-buddy";
  const pr = 77;
  const agentName = prReviewAgentName(repo, pr);
  const idemKey = autoReviewKeyFromRepoPr(repo, pr);
  const sim = buildPrReviewItem({
    id: "rev-sim",
    findingId: "f-sim",
    repo,
    pr,
    agentId: "agent-sim",
  });
  assert(isDemoSimulatedReviewItem(sim), "templated Surface checks detected as Demo-sim");
  assert(
    /Surface checks/i.test(sim.findings[0]?.title ?? ""),
    "sim title is Surface checks"
  );
  assert(
    /Simulated independent review/i.test(sim.findings[0]?.body ?? ""),
    "sim body is Simulated independent review"
  );

  const polluted = {
    agents: [
      {
        id: "agent-sim",
        name: agentName,
        status: "Complete",
        reviewItemId: "rev-sim",
        detail: "Complete — waiting in Review.",
      },
    ],
    reviewQueue: [sim],
    autoKickedReviewKeys: [idemKey],
  };
  const scrubbed = scrubDemoReviewPollution(polluted);
  assert(scrubbed.reviewQueue.length === 0, "scrub drops Surface checks review");
  assert(scrubbed.agents.length === 0, "scrub drops Demo Complete agent");
  assert(
    scrubbed.autoKickedReviewKeys.length === 0,
    "scrub drops stale autoKicked key with no Running/real land"
  );

  const wipe = emptyLiveReviewWorkerSlice();
  assert(wipe.agents.length === 0, "Live wipe agents empty");
  assert(wipe.reviewQueue.length === 0, "Live wipe reviews empty");
  assert(wipe.autoKickedReviewKeys.length === 0, "Live wipe keys empty");

  // Polluted localStorage scenario: key present + Surface checks Complete → re-kick.
  const gateStale = shouldBlockAutoKick({
    idemKey,
    agentName,
    autoKickedReviewKeys: [idemKey],
    autoKickInFlight: false,
    agents: polluted.agents,
    reviewQueue: polluted.reviewQueue,
  });
  // Complete (not Running) + Demo-sim review → must NOT block (stale_key).
  assert(gateStale.block === false, "stale Demo Complete does not block re-kick");
  assert(gateStale.reason === "stale_key", "reason stale_key");

  const gateRunning = shouldBlockAutoKick({
    idemKey,
    agentName,
    autoKickedReviewKeys: [idemKey],
    autoKickInFlight: false,
    agents: [
      {
        id: "a1",
        name: agentName,
        status: "Running",
        detail: WAITING_FOR_LOCAL_WORKER_DETAIL,
      },
    ],
    reviewQueue: [],
  });
  assert(gateRunning.block === true, "Running wait_worker blocks re-kick");
  assert(gateRunning.reason === "running", "reason running");

  const realReview = {
    ...sim,
    id: "rev-real",
    findings: [
      {
        title: "Real worker finding",
        body: "From control.review_result.v1 — not simulated.",
      },
    ],
  };
  assert(!isDemoSimulatedReviewItem(realReview), "real result not Demo-sim");
  const gateLanded = shouldBlockAutoKick({
    idemKey,
    agentName,
    autoKickedReviewKeys: [idemKey],
    autoKickInFlight: false,
    agents: [],
    reviewQueue: [realReview],
  });
  assert(gateLanded.block === true, "real landed review blocks re-kick");
  assert(gateLanded.reason === "landed", "reason landed");
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


{
  const wsrc = fs.readFileSync(
    path.join(ROOT, "scripts/control-review-worker.mjs"),
    "utf8"
  );
  assert(!wsrc.includes(".claimed"), "worker source has no .claimed");
  assert(!/review-results/.test(wsrc), "worker source has no review-results writes");
  assert(wsrc.includes("/api/review/jobs/claim"), "worker claims via HTTP");
  assert(wsrc.includes("CONTROL_BASE_URL"), "worker uses CONTROL_BASE_URL");
  assert(
    wsrc.includes("/api/review/jobs/") && wsrc.includes("/result"),
    "worker posts result via HTTP"
  );
  assert(wsrc.includes("/fail"), "worker posts fail via HTTP");
  const gsrc = fs.readFileSync(
    path.join(ROOT, "scripts/github-outbox-worker"),
    "utf8"
  );
  assert(
    !gsrc.includes(".control"),
    "github-outbox-worker does not touch .control storage"
  );
  assert(gsrc.includes("/api/github/outbox"), "github-outbox-worker uses HTTP API");
  assert(gsrc.includes("/claim"), "github-outbox-worker uses claim API");
}


function startJobsHttpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const send = (status: number, body?: unknown) => {
        if (status === 204) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const readBody = async (): Promise<Record<string, unknown>> => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (!chunks.length) return {};
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          return {};
        }
      };
      try {
        if (req.method === "POST" && url.pathname === "/api/review/jobs/claim") {
          const body = await readBody();
          const job = await claimNextReviewJob(
            typeof body.worker_id === "string" ? body.worker_id : undefined
          );
          if (!job) return send(204);
          return send(200, { ok: true, job });
        }
        const m = url.pathname.match(
          /^\/api\/review\/jobs\/([^/]+)(?:\/(heartbeat|result|fail))?$/
        );
        if (!m) return send(404, { error: "not found" });
        const jobId = decodeURIComponent(m[1]);
        const action = m[2];
        if (req.method === "GET" && !action) {
          const view = await getReviewJobView(jobId);
          if (!view) return send(404, { error: "Job not found" });
          return send(200, {
            ok: true,
            job: view.job,
            status: view.status,
            result: view.result ?? null,
            error: view.error ?? null,
          });
        }
        if (req.method === "POST" && action === "heartbeat") {
          await readBody();
          return send(200, { ok: true });
        }
        if (req.method === "POST" && action === "result") {
          const body = await readBody();
          const out = await completeReviewJob(jobId, body);
          if (!out.ok) return send(out.status, { error: out.error });
          return send(200, { ok: true, result: out.result });
        }
        if (req.method === "POST" && action === "fail") {
          const body = await readBody();
          const out = await failReviewJob(
            jobId,
            typeof body.error === "string" ? body.error : undefined
          );
          if (!out.ok) return send(out.status, { error: out.error });
          return send(200, { ok: true, error: out.error, status: "failed" });
        }
        return send(404, { error: "not found" });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : "server error" });
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function spawnOnce(
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(WORKER, ["--once"], {
      cwd: ROOT,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
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
  assert(fs.existsSync(enq.jobPath), "job file on disk (server-internal)");

  const pendingView = await getReviewJobView(jobId);
  assert(pendingView?.status === "pending", "job pending before claim");

  // Isolate: park other pending jobs so claim hits *this* smoke job
  const parked: string[] = [];
  for (const name of fs.readdirSync(REVIEW_JOBS_DIR)) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".claim.json") || name.endsWith(".failed.json")) continue;
    if (name.startsWith(jobId.replace(/[^a-zA-Z0-9._-]/g, "_"))) continue;
    const full = path.join(REVIEW_JOBS_DIR, name);
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

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-claude-stub-"));
  const stubClaude = path.join(binDir, "claude");
  fs.writeFileSync(
    stubClaude,
    `#!/usr/bin/env bash
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

  const envBase = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    ANTHROPIC_API_KEY: "should-be-unset-by-worker",
  };

  try {
    // BUG-V08C1-1 stress: many concurrent claims → exactly one winner
    const STRESS_N = 24;
    const stress = await Promise.all(
      Array.from({ length: STRESS_N }, (_, i) =>
        claimNextReviewJob(`stress-w${i}`)
      )
    );
    const won = stress.filter(Boolean);
    assert(won.length === 1, `stress ${STRESS_N} concurrent claims → exactly one job (got ${won.length})`);
    assert(won[0]?.job_id === jobId, "claimed the smoke job");
    const emptyClaim = await claimNextReviewJob("w-after");
    assert(emptyClaim === null, "post-stress claim empty (204 shape)");

    const bad = await completeReviewJob(jobId, { schema: "nope" });
    assert(!bad.ok && bad.status === 400, "invalid result body → 4xx");
    const still = await getReviewJobView(jobId);
    assert(still?.status === "claimed", "invalid result does not mark done");

    const okRes = {
      schema: REVIEW_RESULT_SCHEMA,
      job_id: jobId,
      status: "ok" as const,
      summary: "API complete smoke",
      findings: [
        {
          title: "Real worker finding",
          body: "From control.review_result.v1 via POST result.",
          evidence: [],
        },
      ],
    };
    const done = await completeReviewJob(jobId, okRes);
    assert(done.ok, "valid POST result ok");
    const viewDone = await getReviewJobView(jobId);
    assert(viewDone?.status === "done", "job status done");
    assert(viewDone?.result?.findings.length === 1, "result findings present");
    const mapped = buildReviewItemFromResult({
      id: "rev-smoke-api",
      repo: "richardhorvath11/battle-buddy",
      pr: 32,
      agentId: "agent-smoke",
      result: viewDone!.result!,
    });
    assert(mapped.findings.length === 1, "import path maps findings");
    assert(
      !/Simulated independent review/i.test(mapped.findings[0]?.body ?? ""),
      "imported finding is not Demo-sim"
    );

    // Fail path: no invented findings
    const jobFail = `rj-smoke-fail-${Date.now().toString(36)}`;
    await writeReviewJob({
      schema: REVIEW_JOB_SCHEMA,
      job_id: jobFail,
      repo: "richardhorvath11/battle-buddy",
      pr: 33,
      provenance: [],
    });
    const claimedFail = await claimNextReviewJob("w-fail");
    assert(claimedFail?.job_id === jobFail, "claimed fail job");
    const failed = await failReviewJob(jobFail, "Agent Failed — claude missing");
    assert(failed.ok, "fail API ok");
    const failView = await getReviewJobView(jobFail);
    assert(failView?.status === "failed", "status failed");
    assert(!failView?.result, "fail has no result/findings");
    const failFile = await readReviewResultFile(jobFail);
    assert(
      !failFile.ok && failFile.pending === true,
      "fail does not write a result file with findings"
    );

    const httpSrv = await startJobsHttpServer();
    const env = { ...envBase, CONTROL_BASE_URL: httpSrv.url };

    // BUG-V08C1-1 HTTP stress: many POST /claim → one 200, rest 204
    {
      const jobHttp = `rj-smoke-http-stress-${Date.now().toString(36)}`;
      await enqueueReviewJob({
        job_id: jobHttp,
        repo: "richardhorvath11/battle-buddy",
        pr: 32,
        provenance: [],
      });
      const N = 20;
      const posts = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          fetch(`${httpSrv.url}/api/review/jobs/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ worker_id: `http-stress-${i}` }),
          }).then(async (r) => ({
            status: r.status,
            body: r.status === 204 ? null : await r.json(),
          }))
        )
      );
      const ok200 = posts.filter((p) => p.status === 200);
      const empty204 = posts.filter((p) => p.status === 204);
      assert(
        ok200.length === 1,
        `HTTP stress: exactly one 200 (got ${ok200.length})`
      );
      assert(
        empty204.length === N - 1,
        `HTTP stress: rest 204 (got ${empty204.length}/${N - 1})`
      );
      const claimedId =
        ok200[0] &&
        typeof ok200[0].body === "object" &&
        ok200[0].body &&
        (ok200[0].body as { job?: { job_id?: string } }).job?.job_id;
      assert(claimedId === jobHttp, "HTTP stress claimed the stress job");
      // release so later --once tests are not blocked by this claim
      await failReviewJob(jobHttp, "stress cleanup");
      for (const f of [
        path.join(REVIEW_JOBS_DIR, `${jobHttp.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`),
        path.join(REVIEW_JOBS_DIR, `${jobHttp.replace(/[^a-zA-Z0-9._-]/g, "_")}.claim.json`),
        path.join(REVIEW_JOBS_DIR, `${jobHttp.replace(/[^a-zA-Z0-9._-]/g, "_")}.failed.json`),
      ]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }

    // Fresh job for worker --once
    const jobW = `rj-smoke-http-${Date.now().toString(36)}`;
    await enqueueReviewJob({
      job_id: jobW,
      repo: "richardhorvath11/battle-buddy",
      pr: 32,
      provenance: [],
    });

    const r = await spawnOnce(env);
    assert(
      r.status === 0,
      `worker --once exit 0 (got ${r.status}) stderr=${r.stderr} stdout=${r.stdout}`
    );
    assert(!fs.existsSync(reviewJobClaimPath(jobW)), "worker did not write .claimed");
    const after = await getReviewJobView(jobW);
    assert(after?.status === "done", "worker POST result → done");
    assert((after?.result?.findings.length ?? 0) >= 1, "≥1 finding from worker");

    const empty = await spawnOnce(env);
    assert(empty.status === 1, `no pending → exit 1 (got ${empty.status})`);

    // Concurrent --once
    const jobC = `rj-smoke-conc-${Date.now().toString(36)}`;
    await enqueueReviewJob({
      job_id: jobC,
      repo: "richardhorvath11/battle-buddy",
      pr: 32,
      provenance: [],
    });
    const [a, b] = await Promise.all([spawnOnce(env), spawnOnce(env)]);
    const codes = [a.status, b.status].sort();
    assert(
      codes[0] === 0 && codes[1] === 1,
      `two --once → one 0 one 1 (got ${a.status},${b.status})`
    );
    assert(!fs.existsSync(reviewJobClaimPath(jobC)), "concurrent workers wrote no .claimed");

    // Missing claude → exit 4 + fail API (no fake findings)
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
    const r4 = await spawnOnce({
      ...process.env,
      CONTROL_BASE_URL: httpSrv.url,
      CONTROL_REVIEW_WORKER_CLAUDE: missingClaude,
    });
    assert(
      r4.status === 4,
      `claude missing → exit 4 (got ${r4.status}) stderr=${r4.stderr}`
    );
    const errView = await getReviewJobView(jobId2);
    assert(errView?.status === "failed", "claude missing → job failed");
    assert(!errView?.result, "no invented findings on fail");

    await httpSrv.close();

    for (const id of [jobId, jobFail, jobW, jobC, jobId2]) {
      const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
      for (const f of [
        path.join(REVIEW_JOBS_DIR, `${safe}.json`),
        path.join(REVIEW_JOBS_DIR, `${safe}.claimed`),
        path.join(REVIEW_JOBS_DIR, `${safe}.claim.json`),
        path.join(REVIEW_JOBS_DIR, `${safe}.failed.json`),
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
  } finally {
    unpark();
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
