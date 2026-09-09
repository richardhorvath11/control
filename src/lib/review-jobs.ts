/**
 * V0.8 chip 1 — Opaque review job APIs (server-internal storage).
 * Workers claim/complete/fail over HTTP; they never read or write `.control/**`.
 */

import { promises as fs, writeFileSync } from "fs";
import path from "path";
import {
  REVIEW_JOBS_DIR,
  ensureReviewJobsDir,
  ensureReviewResultsDir,
  readReviewResultFile,
  reviewJobClaimStatePath,
  reviewJobFailPath,
  reviewJobPath,
  safeJobId,
  validateReviewJob,
  validateReviewResult,
  writeReviewResult,
  type ControlReviewJobV1,
  type ControlReviewResultV1,
} from "./review-runner";

export type ReviewJobStatus = "pending" | "claimed" | "done" | "failed";

export const REVIEW_CLAIM_LEASE_MS = 60_000;

export type ReviewJobClaimRecord = {
  worker_id: string;
  claimed_at: string;
  lease_until: string;
};

export type ReviewJobFailRecord = {
  error: string;
  failed_at: string;
};

export type ReviewJobView = {
  job: ControlReviewJobV1;
  status: ReviewJobStatus;
  result?: ControlReviewResultV1;
  error?: string;
  claim?: ReviewJobClaimRecord;
};

function defaultWorkerId(workerId?: string): string {
  const t = (workerId ?? "").trim();
  return t || `worker-${process.pid}`;
}

function leaseUntil(fromMs = Date.now()): string {
  return new Date(fromMs + REVIEW_CLAIM_LEASE_MS).toISOString();
}

async function readJsonFile(p: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

export async function readReviewJob(
  jobId: string
): Promise<ControlReviewJobV1 | null> {
  const raw = await readJsonFile(reviewJobPath(jobId));
  if (!raw) return null;
  const v = validateReviewJob(raw);
  return v.ok ? v.job : null;
}

async function readClaimRecord(
  jobId: string
): Promise<ReviewJobClaimRecord | null> {
  const raw = await readJsonFile(reviewJobClaimStatePath(jobId));
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.worker_id !== "string" || typeof o.lease_until !== "string") {
    return null;
  }
  return {
    worker_id: o.worker_id,
    claimed_at: typeof o.claimed_at === "string" ? o.claimed_at : o.lease_until,
    lease_until: o.lease_until,
  };
}

async function readFailRecord(
  jobId: string
): Promise<ReviewJobFailRecord | null> {
  const raw = await readJsonFile(reviewJobFailPath(jobId));
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    error:
      typeof o.error === "string" && o.error.trim()
        ? o.error.trim()
        : "Agent Failed",
    failed_at:
      typeof o.failed_at === "string"
        ? o.failed_at
        : new Date().toISOString(),
  };
}

function claimActive(claim: ReviewJobClaimRecord | null): boolean {
  if (!claim) return false;
  const until = Date.parse(claim.lease_until);
  return Number.isFinite(until) && until > Date.now();
}

export async function getReviewJobStatus(
  jobId: string
): Promise<ReviewJobStatus | "missing"> {
  const job = await readReviewJob(jobId);
  if (!job) return "missing";
  const result = await readReviewResultFile(jobId);
  if (result.ok) return "done";
  const fail = await readFailRecord(jobId);
  if (fail) return "failed";
  const claim = await readClaimRecord(jobId);
  if (claimActive(claim)) return "claimed";
  return "pending";
}

export async function getReviewJobView(
  jobId: string
): Promise<ReviewJobView | null> {
  const job = await readReviewJob(jobId);
  if (!job) return null;
  const resultFile = await readReviewResultFile(jobId);
  if (resultFile.ok) {
    return { job, status: "done", result: resultFile.result };
  }
  const fail = await readFailRecord(jobId);
  if (fail) {
    return { job, status: "failed", error: fail.error };
  }
  const claim = await readClaimRecord(jobId);
  if (claimActive(claim)) {
    return { job, status: "claimed", claim: claim ?? undefined };
  }
  return { job, status: "pending" };
}

type JobListEntry = { jobId: string; mtimeMs: number };

async function listJobEntries(): Promise<JobListEntry[]> {
  await ensureReviewJobsDir();
  let names: string[];
  try {
    names = await fs.readdir(REVIEW_JOBS_DIR);
  } catch {
    return [];
  }
  const out: JobListEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".claim.json")) continue;
    if (name.endsWith(".failed.json")) continue;
    if (name.endsWith(".result.json")) continue;
    const full = path.join(REVIEW_JOBS_DIR, name);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const raw = await readJsonFile(full);
    const v = validateReviewJob(raw);
    if (!v.ok) continue;
    out.push({ jobId: v.job.job_id, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.jobId.localeCompare(b.jobId));
  return out;
}

function tryWxClaim(jobId: string, rec: ReviewJobClaimRecord): boolean {
  try {
    writeFileSync(reviewJobClaimStatePath(jobId), JSON.stringify(rec, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Atomically claim the oldest pending job. Returns the job or null (204).
 */
export async function claimNextReviewJob(
  workerId?: string
): Promise<ControlReviewJobV1 | null> {
  await ensureReviewJobsDir();
  const worker_id = defaultWorkerId(workerId);
  const entries = await listJobEntries();
  for (const entry of entries) {
    const status = await getReviewJobStatus(entry.jobId);
    if (status !== "pending") continue;
    await unlinkQuiet(reviewJobClaimStatePath(entry.jobId));
    const rec: ReviewJobClaimRecord = {
      worker_id,
      claimed_at: new Date().toISOString(),
      lease_until: leaseUntil(),
    };
    if (!tryWxClaim(entry.jobId, rec)) continue;
    const job = await readReviewJob(entry.jobId);
    if (!job) {
      await unlinkQuiet(reviewJobClaimStatePath(entry.jobId));
      continue;
    }
    return job;
  }
  return null;
}

export async function heartbeatReviewJob(
  jobId: string,
  workerId?: string
): Promise<
  | { ok: true; claim: ReviewJobClaimRecord }
  | { ok: false; status: number; error: string }
> {
  const view = await getReviewJobView(jobId);
  if (!view) return { ok: false, status: 404, error: "Job not found" };
  if (view.status !== "claimed" || !view.claim) {
    return { ok: false, status: 409, error: "Job is not claimed" };
  }
  const want = (workerId ?? "").trim();
  if (want && view.claim.worker_id && want !== view.claim.worker_id) {
    return { ok: false, status: 409, error: "Claim held by another worker" };
  }
  const rec: ReviewJobClaimRecord = {
    worker_id: view.claim.worker_id,
    claimed_at: view.claim.claimed_at,
    lease_until: leaseUntil(),
  };
  await fs.writeFile(
    reviewJobClaimStatePath(jobId),
    JSON.stringify(rec, null, 2),
    "utf8"
  );
  return { ok: true, claim: rec };
}

export async function completeReviewJob(
  jobId: string,
  raw: unknown,
  workerId?: string
): Promise<
  | { ok: true; result: ControlReviewResultV1 }
  | { ok: false; status: number; error: string }
> {
  const view = await getReviewJobView(jobId);
  if (!view) return { ok: false, status: 404, error: "Job not found" };

  const v = validateReviewResult(raw);
  if (!v.ok) {
    return { ok: false, status: 400, error: v.error };
  }
  if (v.result.job_id !== jobId && safeJobId(v.result.job_id) !== safeJobId(jobId)) {
    return { ok: false, status: 400, error: "result.job_id must match path id" };
  }

  if (view.status === "done") {
    if (
      view.result &&
      view.result.status === v.result.status &&
      view.result.summary === v.result.summary
    ) {
      return { ok: true, result: view.result };
    }
    return { ok: false, status: 409, error: "Job already done" };
  }
  if (view.status === "failed") {
    return { ok: false, status: 409, error: "Job already failed" };
  }
  if (view.status === "claimed" && view.claim) {
    const want = (workerId ?? "").trim();
    if (want && view.claim.worker_id && want !== view.claim.worker_id) {
      return { ok: false, status: 409, error: "Claim held by another worker" };
    }
  }

  const result: ControlReviewResultV1 = { ...v.result, job_id: jobId };
  await ensureReviewResultsDir();
  await writeReviewResult(result);
  await unlinkQuiet(reviewJobFailPath(jobId));
  await unlinkQuiet(reviewJobClaimStatePath(jobId));
  return { ok: true, result };
}

export async function failReviewJob(
  jobId: string,
  error?: string
): Promise<
  | { ok: true; error: string }
  | { ok: false; status: number; error: string }
> {
  const view = await getReviewJobView(jobId);
  if (!view) return { ok: false, status: 404, error: "Job not found" };
  if (view.status === "done") {
    return { ok: false, status: 409, error: "Job already done" };
  }
  const message =
    typeof error === "string" && error.trim()
      ? error.trim()
      : "Agent Failed";
  if (view.status === "failed") {
    return { ok: true, error: view.error || message };
  }
  const rec: ReviewJobFailRecord = {
    error: message,
    failed_at: new Date().toISOString(),
  };
  await ensureReviewJobsDir();
  await fs.writeFile(
    reviewJobFailPath(jobId),
    JSON.stringify(rec, null, 2),
    "utf8"
  );
  await unlinkQuiet(reviewJobClaimStatePath(jobId));
  return { ok: true, error: message };
}
