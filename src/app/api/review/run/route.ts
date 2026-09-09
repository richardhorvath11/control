import { NextRequest, NextResponse } from "next/server";
import { invokeReviewRunner } from "@/lib/invoke-review-runner";
import {
  NO_REVIEW_BACKEND_DETAIL,
  WAITING_FOR_LOCAL_WORKER_DETAIL,
  resolveReviewBackend,
} from "@/lib/review-runner";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  job_id?: string;
  repo?: string;
  pr?: number | string;
  head_sha?: string;
  workstream_id?: string;
  attention_id?: string;
  provenance?: unknown[];
  snapshot_path?: string;
};

/**
 * POST /api/review/run — Live review path.
 * Default backend=worker: write control.review_job.v1 only (no server-spawn claude);
 * client polls GET /api/review/result?job_id=… after local worker writes result.
 * Other backends (command / fake / claude-cli / cursor-cloud): invoke control-review-run.
 */
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const pr =
    typeof body.pr === "number"
      ? body.pr
      : typeof body.pr === "string"
        ? parseInt(body.pr, 10)
        : NaN;
  if (!repo || !Number.isFinite(pr) || pr <= 0) {
    return NextResponse.json(
      { error: "repo and positive pr required" },
      { status: 400 }
    );
  }

  if (!resolveReviewBackend()) {
    return NextResponse.json(
      {
        ok: false,
        code: "NO_BACKEND",
        error: NO_REVIEW_BACKEND_DETAIL,
        backend: null,
      },
      { status: 503 }
    );
  }

  const outcome = await invokeReviewRunner({
    job_id: body.job_id,
    repo,
    pr: Math.trunc(pr),
    head_sha: body.head_sha,
    workstream_id: body.workstream_id,
    attention_id: body.attention_id,
    provenance: body.provenance,
    snapshot_path: body.snapshot_path,
  });

  if (!outcome.ok) {
    const status =
      outcome.code === "NO_BACKEND"
        ? 503
        : outcome.code === "BAD_JOB" || outcome.code === "BAD_RESULT"
          ? 400
          : 500;
    return NextResponse.json(
      {
        ok: false,
        code: outcome.code,
        error: outcome.error,
        exitCode: outcome.exitCode,
        job: outcome.job ?? null,
        result: outcome.result ?? null,
      },
      { status }
    );
  }

  if ("pending" in outcome && outcome.pending) {
    return NextResponse.json({
      ok: true,
      pending: true,
      backend: outcome.backend,
      job: outcome.job,
      jobPath: outcome.jobPath,
      resultPath: outcome.resultPath,
      detail: WAITING_FOR_LOCAL_WORKER_DETAIL,
    });
  }

  return NextResponse.json({
    ok: true,
    pending: false,
    backend: outcome.backend,
    exitCode: outcome.exitCode,
    job: outcome.job,
    result: outcome.result,
    jobPath: outcome.jobPath,
    resultPath: outcome.resultPath,
  });
}

/** GET /api/review/run — backend probe (no secrets). */
export async function GET() {
  const backend = resolveReviewBackend();
  return NextResponse.json({
    ok: true,
    backend,
    configured: !!backend,
    detail: backend
      ? backend === "worker"
        ? `CONTROL_REVIEW_BACKEND=worker (default) — ${WAITING_FOR_LOCAL_WORKER_DETAIL}`
        : `CONTROL_REVIEW_BACKEND=${backend}`
      : NO_REVIEW_BACKEND_DETAIL,
    dogfood: {
      prefer: "worker",
      auth: "claude login or CLAUDE_CODE_OAUTH_TOKEN from claude setup-token — no ANTHROPIC_API_KEY required",
      cli: "./scripts/control-review-worker --once|--watch",
    },
  });
}
