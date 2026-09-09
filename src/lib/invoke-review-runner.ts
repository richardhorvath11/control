/**
 * Server-side invoke of scripts/control-review-run for Live PR review workers.
 */

import { spawnSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";
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
} from "./review-runner";

export type InvokeReviewRunnerInput = {
  job_id?: string;
  repo: string;
  pr: number;
  head_sha?: string;
  workstream_id?: string;
  attention_id?: string;
  provenance?: unknown[];
  snapshot_path?: string;
};

export type InvokeReviewRunnerOutcome =
  | {
      ok: true;
      job: ControlReviewJobV1;
      result: ControlReviewResultV1;
      exitCode: number;
      backend: string;
      jobPath: string;
      resultPath: string;
    }
  | {
      ok: false;
      code: "NO_BACKEND" | "BAD_JOB" | "BAD_RESULT" | "RUNNER_EXIT" | "INVALID_BACKEND";
      error: string;
      exitCode?: number;
      job?: ControlReviewJobV1;
      result?: ControlReviewResultV1;
      jobPath?: string;
      resultPath?: string;
    };

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

  const job: ControlReviewJobV1 = {
    schema: REVIEW_JOB_SCHEMA,
    job_id: (input.job_id?.trim() || newReviewJobId()),
    repo: input.repo.trim(),
    pr: Math.trunc(input.pr),
    provenance: input.provenance ?? [],
  };
  if (input.head_sha?.trim()) job.head_sha = input.head_sha.trim();
  if (input.workstream_id?.trim()) job.workstream_id = input.workstream_id.trim();
  if (input.attention_id?.trim()) job.attention_id = input.attention_id.trim();
  if (input.snapshot_path?.trim()) job.snapshot_path = input.snapshot_path.trim();

  if (!job.repo || !Number.isFinite(job.pr) || job.pr <= 0) {
    return { ok: false, code: "BAD_JOB", error: "repo and positive pr required" };
  }

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
