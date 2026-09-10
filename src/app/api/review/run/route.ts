import { NextRequest, NextResponse } from "next/server";
import { invokeReviewRunner } from "@/lib/invoke-review-runner";
import { findActiveVerifyJob } from "@/lib/review-jobs";
import {
  CLAUDE_VERIFY_HINTS,
  NO_REVIEW_BACKEND_DETAIL,
  WAITING_FOR_LOCAL_WORKER_DETAIL,
  resolveReviewBackend,
} from "@/lib/review-runner";
import { listWatcherStatusRows } from "@/lib/watcher-status";

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  job_id?: string;
  kind?: "pr_review" | "slack_draft" | "verify";
  /** Alias for kind: verify — tiny Claude smoke, no Review / Needs-you. */
  smoke?: boolean;
  repo?: string;
  pr?: number | string;
  head_sha?: string;
  workstream_id?: string;
  attention_id?: string;
  provenance?: unknown[];
  snapshot_path?: string;
  channel_id?: string;
  thread_ts?: string;
  message_ts?: string;
  permalink?: string;
  text_excerpt?: string;
};

function reviewWorkerAlive(
  rows: Awaited<ReturnType<typeof listWatcherStatusRows>>
): boolean {
  const row = rows.find((r) => r.id === "review-worker");
  if (!row || !row.updated_at) return false;
  if (row.stale) return false;
  const status = row.display_status || row.status;
  if (status === "error" || status === "stale") return false;
  return status === "idle" || status === "ticking" || status === "waiting";
}

/**
 * POST /api/review/run — Live review path (pr_review | slack_draft | verify).
 * Default backend=worker: enqueue control.review_job.v1 only (no server-spawn claude);
 * worker claims via POST /api/review/jobs/claim; client polls GET /api/review/jobs/:id.
 *
 * kind=verify / smoke:true — V0.9 chip 3 Claude smoke. Does NOT create Needs-you
 * or PR Review items; ephemeral / Agents only. Idempotent while pending|claimed.
 */
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const kind =
    body.kind === "verify" || body.smoke === true
      ? "verify"
      : body.kind === "slack_draft"
        ? "slack_draft"
        : body.kind === "pr_review"
          ? "pr_review"
          : typeof body.channel_id === "string" &&
              body.channel_id.trim() &&
              !(typeof body.repo === "string" && body.repo.trim())
            ? "slack_draft"
            : "pr_review";

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

  if (kind === "verify") {
    const rows = await listWatcherStatusRows();
    if (!reviewWorkerAlive(rows)) {
      return NextResponse.json(
        {
          ok: false,
          code: "WORKER_DOWN",
          error: CLAUDE_VERIFY_HINTS.worker_down,
          hint: CLAUDE_VERIFY_HINTS.worker_down,
        },
        { status: 503 }
      );
    }

    const existing = await findActiveVerifyJob();
    if (existing) {
      return NextResponse.json({
        ok: true,
        pending: true,
        backend: "worker",
        job: existing,
        detail: WAITING_FOR_LOCAL_WORKER_DETAIL,
        idempotent: true,
      });
    }

    const outcome = await invokeReviewRunner({
      job_id: body.job_id,
      kind: "verify",
    });
    return respondOutcome(outcome);
  }

  if (kind === "slack_draft") {
    const channel_id =
      typeof body.channel_id === "string" ? body.channel_id.trim() : "";
    const message_ts =
      typeof body.message_ts === "string" ? body.message_ts.trim() : "";
    if (!channel_id || !message_ts) {
      return NextResponse.json(
        { error: "channel_id and message_ts required for slack_draft" },
        { status: 400 }
      );
    }

    const outcome = await invokeReviewRunner({
      job_id: body.job_id,
      kind: "slack_draft",
      channel_id,
      message_ts,
      thread_ts:
        typeof body.thread_ts === "string" ? body.thread_ts : undefined,
      permalink:
        typeof body.permalink === "string" ? body.permalink : undefined,
      text_excerpt:
        typeof body.text_excerpt === "string" ? body.text_excerpt : undefined,
      workstream_id: body.workstream_id,
      attention_id: body.attention_id,
      provenance: body.provenance,
    });

    return respondOutcome(outcome);
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

  const outcome = await invokeReviewRunner({
    job_id: body.job_id,
    kind: "pr_review",
    repo,
    pr: Math.trunc(pr),
    head_sha: body.head_sha,
    workstream_id: body.workstream_id,
    attention_id: body.attention_id,
    provenance: body.provenance,
    snapshot_path: body.snapshot_path,
  });

  return respondOutcome(outcome);
}

function respondOutcome(
  outcome: Awaited<ReturnType<typeof invokeReviewRunner>>
) {
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
      kinds: ["pr_review", "slack_draft", "verify"],
      verify: "POST { kind:\"verify\" } or { smoke:true } — no Needs-you / no fake Review",
    },
  });
}
