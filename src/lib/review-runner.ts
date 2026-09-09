/**
 * V0.7 chip 3 / 3b — Review runner server I/O (jobs + results under .control/).
 * Live default: worker (enqueue only; local Pro Claude claims jobs).
 * Operators may opt into command / claude-cli (server-spawn) / fake (test) / cursor-cloud.
 * No in-product skill pack or prompt library.
 *
 * Client-safe contracts/mappers live in review-contracts.ts — do NOT import this
 * module from client components or the Zustand store (pulls in Node fs/path).
 */

import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR } from "./github-inbox";

export {
  REVIEW_JOB_SCHEMA,
  REVIEW_RESULT_SCHEMA,
  NO_REVIEW_BACKEND_DETAIL,
  WAITING_FOR_LOCAL_WORKER_DETAIL,
  WORKER_TIMEOUT_DETAIL,
  DEFAULT_WORKER_WAIT_MS,
  isReviewBackend,
  resolveReviewBackend,
  newReviewJobId,
  validateReviewJob,
  validateReviewResult,
  mapResultFindingsToFindings,
  buildReviewItemFromResult,
  buildFakeReviewResult,
  buildCursorCloudStubResult,
  type ReviewBackend,
  type ControlReviewJobV1,
  type ControlReviewFindingV1,
  type ControlReviewResultV1,
} from "./review-contracts";

import type { ControlReviewJobV1, ControlReviewResultV1 } from "./review-contracts";
import { validateReviewResult } from "./review-contracts";

export const REVIEW_JOBS_DIR = path.join(CONTROL_DIR, "review-jobs");
export const REVIEW_JOBS_IN_PROGRESS_DIR = path.join(
  REVIEW_JOBS_DIR,
  "in-progress"
);
export const REVIEW_RESULTS_DIR = path.join(CONTROL_DIR, "review-results");

function safeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function reviewJobPath(jobId: string): string {
  return path.join(REVIEW_JOBS_DIR, `${safeJobId(jobId)}.json`);
}

export function reviewJobClaimPath(jobId: string): string {
  return path.join(REVIEW_JOBS_DIR, `${safeJobId(jobId)}.claimed`);
}

/** Chip 3b: results live under .control/review-results/{job_id}.json */
export function reviewResultPath(jobId: string): string {
  return path.join(REVIEW_RESULTS_DIR, `${safeJobId(jobId)}.json`);
}

/** Legacy chip-3 colocated result path (still checked on poll for compat). */
export function reviewResultLegacyPath(jobId: string): string {
  return path.join(REVIEW_JOBS_DIR, `${safeJobId(jobId)}.result.json`);
}

export async function ensureReviewJobsDir(): Promise<void> {
  await fs.mkdir(CONTROL_DIR, { recursive: true });
  await fs.mkdir(REVIEW_JOBS_DIR, { recursive: true });
}

export async function ensureReviewResultsDir(): Promise<void> {
  await fs.mkdir(CONTROL_DIR, { recursive: true });
  await fs.mkdir(REVIEW_RESULTS_DIR, { recursive: true });
}

export async function writeReviewJob(
  job: ControlReviewJobV1
): Promise<string> {
  await ensureReviewJobsDir();
  const p = reviewJobPath(job.job_id);
  await fs.writeFile(p, JSON.stringify(job, null, 2), "utf8");
  return p;
}

export async function writeReviewResult(
  result: ControlReviewResultV1
): Promise<string> {
  await ensureReviewResultsDir();
  const p = reviewResultPath(result.job_id);
  await fs.writeFile(p, JSON.stringify(result, null, 2), "utf8");
  return p;
}

export async function readReviewResultFile(
  jobId: string
): Promise<
  | { ok: true; result: ControlReviewResultV1; path: string }
  | { ok: false; pending: true }
  | { ok: false; pending: false; error: string }
> {
  const candidates = [reviewResultPath(jobId), reviewResultLegacyPath(jobId)];
  for (const p of candidates) {
    let rawText: string;
    try {
      rawText = await fs.readFile(p, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, pending: false, error: "Result file is not JSON" };
    }
    const v = validateReviewResult(parsed);
    if (!v.ok) {
      return { ok: false, pending: false, error: v.error };
    }
    return { ok: true, result: v.result, path: p };
  }
  return { ok: false, pending: true };
}
