/**
 * V0.7 chip 3 — Review runner server I/O (job files under .control/review-jobs).
 * Operators point CONTROL_REVIEW_BACKEND at a command / Claude CLI / later Cursor cloud.
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

import type { ControlReviewJobV1 } from "./review-contracts";

export const REVIEW_JOBS_DIR = path.join(CONTROL_DIR, "review-jobs");

export function reviewJobPath(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(REVIEW_JOBS_DIR, `${safe}.json`);
}

export function reviewResultPath(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(REVIEW_JOBS_DIR, `${safe}.result.json`);
}

export async function ensureReviewJobsDir(): Promise<void> {
  await fs.mkdir(CONTROL_DIR, { recursive: true });
  await fs.mkdir(REVIEW_JOBS_DIR, { recursive: true });
}

export async function writeReviewJob(
  job: ControlReviewJobV1
): Promise<string> {
  await ensureReviewJobsDir();
  const p = reviewJobPath(job.job_id);
  await fs.writeFile(p, JSON.stringify(job, null, 2), "utf8");
  return p;
}
