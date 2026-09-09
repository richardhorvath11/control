/**
 * Server-side review invoke: worker enqueue (Live default) or control-review-run spawn.
 */

import { spawnSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { preferSnapshotPath } from "./pr-snapshot";
import {
  NO_REVIEW_BACKEND_DETAIL,
  REVIEW_JOB_SCHEMA,
  newReviewJobId,
  resolveReviewBackend,
  reviewResultPath,
  validateReviewResult,
  writeReviewJob,
  type ControlReviewJobV1,
  type ControlReviewResultV1,
  type ReviewBackend,
} from "./review-runner";

export type InvokeReviewRunnerInput = {
  job_id?: string;
  kind?: "pr_review" | "slack_draft";
  repo?: string;
  pr?: number;
  head_sha?: string;
  workstream_id?: string;
  attention_id?: string;
  provenance?: unknown[];
  snapshot_path?: string;
  /** slack_draft */
  channel_id?: string;
  thread_ts?: string;
  message_ts?: string;
  permalink?: string;
  text_excerpt?: string;
};

export type InvokeReviewRunnerOutcome =
  | {
      ok: true;
      pending: true;
      job: ControlReviewJobV1;
      backend: "worker";
      jobPath: string;
      resultPath: string;
    }
  | {
      ok: true;
      pending?: false;
      job: ControlReviewJobV1;
      result: ControlReviewResultV1;
      exitCode: number;
      backend: string;
      jobPath: string;
      resultPath: string;
    }
  | {
      ok: false;
      code:
        | "NO_BACKEND"
        | "BAD_JOB"
        | "BAD_RESULT"
        | "RUNNER_EXIT"
        | "INVALID_BACKEND";
      error: string;
      exitCode?: number;
      job?: ControlReviewJobV1;
      result?: ControlReviewResultV1;
      jobPath?: string;
      resultPath?: string;
    };

function buildJob(input: InvokeReviewRunnerInput): ControlReviewJobV1 | null {
  const kind =
    input.kind === "slack_draft"
      ? "slack_draft"
      : input.kind === "pr_review"
        ? "pr_review"
        : input.channel_id?.trim() && !input.repo?.trim()
          ? "slack_draft"
          : "pr_review";

  if (kind === "slack_draft") {
    const channel_id = (input.channel_id ?? "").trim();
    const message_ts = (input.message_ts ?? "").trim();
    if (!channel_id || !message_ts) return null;
    const thread_ts =
      (input.thread_ts ?? "").trim() || message_ts;
    const job: ControlReviewJobV1 = {
      schema: REVIEW_JOB_SCHEMA,
      job_id: input.job_id?.trim() || newReviewJobId(),
      kind: "slack_draft",
      channel_id,
      message_ts,
      thread_ts,
      provenance: input.provenance ?? [],
    };
    if (input.attention_id?.trim()) job.attention_id = input.attention_id.trim();
    if (input.permalink?.trim()) job.permalink = input.permalink.trim();
    if (typeof input.text_excerpt === "string") {
      job.text_excerpt = input.text_excerpt;
    }
    if (input.workstream_id?.trim()) {
      job.workstream_id = input.workstream_id.trim();
    }
    return job;
  }

  const repo = (input.repo ?? "").trim();
  const pr = Math.trunc(input.pr ?? 0);
  if (!repo || !Number.isFinite(pr) || pr <= 0) return null;
  const job: ControlReviewJobV1 = {
    schema: REVIEW_JOB_SCHEMA,
    job_id: input.job_id?.trim() || newReviewJobId(),
    kind: "pr_review",
    repo,
    pr,
    provenance: input.provenance ?? [],
  };
  if (input.head_sha?.trim()) job.head_sha = input.head_sha.trim();
  if (input.workstream_id?.trim()) job.workstream_id = input.workstream_id.trim();
  if (input.attention_id?.trim()) job.attention_id = input.attention_id.trim();
  if (input.snapshot_path?.trim()) job.snapshot_path = input.snapshot_path.trim();
  return job;
}

/** Fill snapshot_path from disk when caller omitted it (chip 4). */
async function withPreferredSnapshot(
  job: ControlReviewJobV1
): Promise<ControlReviewJobV1> {
  if (job.kind === "slack_draft") return job;
  if (job.snapshot_path?.trim()) return job;
  if (!job.repo || !job.pr) return job;
  const preferred = await preferSnapshotPath(job.repo, job.pr);
  if (preferred) return { ...job, snapshot_path: preferred };
  return job;
}

/** Live worker path: write job only — do not server-spawn claude. */
export async function enqueueReviewJob(
  input: InvokeReviewRunnerInput
): Promise<
  | {
      ok: true;
      job: ControlReviewJobV1;
      jobPath: string;
      resultPath: string;
      backend: "worker";
    }
  | { ok: false; code: "BAD_JOB"; error: string }
> {
  const built = buildJob(input);
  if (!built) {
    return { ok: false, code: "BAD_JOB", error: "invalid review job (repo+pr or slack_draft fields required)" };
  }
  const job = await withPreferredSnapshot(built);
  const jobPath = await writeReviewJob(job);
  return {
    ok: true,
    job,
    jobPath,
    resultPath: reviewResultPath(job.job_id),
    backend: "worker",
  };
}

export async function invokeReviewRunner(
  input: InvokeReviewRunnerInput
): Promise<InvokeReviewRunnerOutcome> {
  const backend = resolveReviewBackend();
  if (!backend) {
    return {
      ok: false,
      code: "NO_BACKEND",
      error: NO_REVIEW_BACKEND_DETAIL,
      exitCode: 4,
    };
  }

  // Gastown / Live default: enqueue only; local worker claims + runs claude -p.
  if (backend === "worker") {
    const enq = await enqueueReviewJob(input);
    if (!enq.ok) {
      return { ok: false, code: "BAD_JOB", error: enq.error };
    }
    return {
      ok: true,
      pending: true,
      job: enq.job,
      backend: "worker",
      jobPath: enq.jobPath,
      resultPath: enq.resultPath,
    };
  }

  const built = buildJob(input);
  if (!built) {
    return { ok: false, code: "BAD_JOB", error: "invalid review job (repo+pr or slack_draft fields required)" };
  }
  const job = await withPreferredSnapshot(built);

  const jobPath = await writeReviewJob(job);
  const resultPath = reviewResultPath(job.job_id);

  const script = path.join(process.cwd(), "scripts", "control-review-run");
  const r = spawnSync(
    script,
    ["--in", jobPath, "--out", resultPath],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
      env: { ...process.env },
      cwd: process.cwd(),
    }
  );

  const exitCode = r.status ?? (r.error ? 4 : 2);

  if (exitCode === 4) {
    return {
      ok: false,
      code: "NO_BACKEND",
      error:
        (r.stderr || r.stdout || "").trim() || NO_REVIEW_BACKEND_DETAIL,
      exitCode,
      job,
      jobPath,
      resultPath,
    };
  }

  if (exitCode === 3) {
    return {
      ok: false,
      code: "BAD_JOB",
      error: (r.stderr || r.stdout || "bad job/parse").trim(),
      exitCode,
      job,
      jobPath,
      resultPath,
    };
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(resultPath, "utf8");
  } catch {
    return {
      ok: false,
      code: "BAD_RESULT",
      error: "Runner did not write result file",
      exitCode,
      job,
      jobPath,
      resultPath,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      code: "BAD_RESULT",
      error: "Result file is not JSON",
      exitCode: 3,
      job,
      jobPath,
      resultPath,
    };
  }

  const v = validateReviewResult(parsed);
  if (!v.ok) {
    return {
      ok: false,
      code: "BAD_RESULT",
      error: v.error,
      exitCode: 3,
      job,
      jobPath,
      resultPath,
    };
  }

  if (exitCode !== 0 && exitCode !== 2) {
    return {
      ok: false,
      code: "RUNNER_EXIT",
      error: (r.stderr || `runner exit ${exitCode}`).trim(),
      exitCode,
      job,
      result: v.result,
      jobPath,
      resultPath,
    };
  }

  return {
    ok: true,
    job,
    result: v.result,
    exitCode,
    backend,
    jobPath,
    resultPath,
  };
}

export type { ReviewBackend };
