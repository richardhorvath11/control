/**
 * Client-safe review job/result contracts + mappers.
 * No Node fs / path / child_process — safe for Zustand store and client bundles.
 * Server I/O + enqueue/spawn live in review-runner.ts / invoke-review-runner.ts.
 * Live default backend is worker (local Pro Claude) — not fake.
 */

import { normalizeRepo } from "./coalesce-review-ask";
import type { Finding, Provenance, ReviewItem } from "./types";

export const REVIEW_JOB_SCHEMA = "control.review_job.v1" as const;
export const REVIEW_RESULT_SCHEMA = "control.review_result.v1" as const;

export type ReviewBackend =
  | "worker"
  | "claude-cli"
  | "cursor-cloud"
  | "fake"
  | "command";

export type ControlReviewJobV1 = {
  schema: typeof REVIEW_JOB_SCHEMA;
  job_id: string;
  repo: string;
  pr: number;
  head_sha?: string;
  workstream_id?: string;
  attention_id?: string;
  provenance?: unknown[];
  snapshot_path?: string;
};

export type ControlReviewFindingV1 = {
  title: string;
  body: string;
  evidence?: unknown[];
};

export type ControlReviewResultV1 = {
  schema: typeof REVIEW_RESULT_SCHEMA;
  job_id: string;
  status: "ok" | "error";
  summary: string;
  findings: ControlReviewFindingV1[];
  scope?: { notes?: string };
  raw_path?: string;
};

export function isReviewBackend(v: unknown): v is ReviewBackend {
  return (
    v === "worker" ||
    v === "claude-cli" ||
    v === "cursor-cloud" ||
    v === "fake" ||
    v === "command"
  );
}

/**
 * Read env. Unset / empty ⇒ "worker" (Live Gastown dogfood default:
 * enqueue job for local Pro Claude worker — do not invent findings).
 * Invalid values ⇒ null.
 */
export function resolveReviewBackend(
  env: NodeJS.ProcessEnv = process.env
): ReviewBackend | null {
  const raw = (env.CONTROL_REVIEW_BACKEND ?? "").trim().toLowerCase();
  if (!raw) return "worker";
  if (isReviewBackend(raw)) return raw;
  return null;
}

export function newReviewJobId(): string {
  return `rj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function validateReviewJob(raw: unknown): {
  ok: true;
  job: ControlReviewJobV1;
} | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Job must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema !== REVIEW_JOB_SCHEMA) {
    return {
      ok: false,
      error: `Job schema must be ${REVIEW_JOB_SCHEMA}`,
    };
  }
  if (typeof o.job_id !== "string" || !o.job_id.trim()) {
    return { ok: false, error: "job_id required" };
  }
  if (typeof o.repo !== "string" || !o.repo.trim()) {
    return { ok: false, error: "repo required" };
  }
  const pr =
    typeof o.pr === "number"
      ? o.pr
      : typeof o.pr === "string"
        ? parseInt(o.pr, 10)
        : NaN;
  if (!Number.isFinite(pr) || pr <= 0) {
    return { ok: false, error: "pr must be a positive number" };
  }
  const job: ControlReviewJobV1 = {
    schema: REVIEW_JOB_SCHEMA,
    job_id: o.job_id.trim(),
    repo: o.repo.trim(),
    pr: Math.trunc(pr),
  };
  if (typeof o.head_sha === "string" && o.head_sha.trim()) {
    job.head_sha = o.head_sha.trim();
  }
  if (typeof o.workstream_id === "string" && o.workstream_id.trim()) {
    job.workstream_id = o.workstream_id.trim();
  }
  if (typeof o.attention_id === "string" && o.attention_id.trim()) {
    job.attention_id = o.attention_id.trim();
  }
  if (Array.isArray(o.provenance)) {
    job.provenance = o.provenance;
  }
  if (typeof o.snapshot_path === "string" && o.snapshot_path.trim()) {
    job.snapshot_path = o.snapshot_path.trim();
  }
  return { ok: true, job };
}

export function validateReviewResult(raw: unknown): {
  ok: true;
  result: ControlReviewResultV1;
} | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Result must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema !== REVIEW_RESULT_SCHEMA) {
    return {
      ok: false,
      error: `Result schema must be ${REVIEW_RESULT_SCHEMA}`,
    };
  }
  if (typeof o.job_id !== "string" || !o.job_id.trim()) {
    return { ok: false, error: "job_id required" };
  }
  if (o.status !== "ok" && o.status !== "error") {
    return { ok: false, error: "status must be ok|error" };
  }
  if (typeof o.summary !== "string") {
    return { ok: false, error: "summary required (string)" };
  }
  if (!Array.isArray(o.findings)) {
    return { ok: false, error: "findings must be an array" };
  }
  const findings: ControlReviewFindingV1[] = [];
  for (let i = 0; i < o.findings.length; i++) {
    const f = o.findings[i];
    if (!f || typeof f !== "object") {
      return { ok: false, error: `findings[${i}] must be an object` };
    }
    const fr = f as Record<string, unknown>;
    if (typeof fr.title !== "string" || typeof fr.body !== "string") {
      return {
        ok: false,
        error: `findings[${i}] needs title and body strings`,
      };
    }
    findings.push({
      title: fr.title,
      body: fr.body,
      evidence: Array.isArray(fr.evidence) ? fr.evidence : [],
    });
  }
  const result: ControlReviewResultV1 = {
    schema: REVIEW_RESULT_SCHEMA,
    job_id: o.job_id.trim(),
    status: o.status,
    summary: o.summary,
    findings,
  };
  if (o.scope && typeof o.scope === "object") {
    const notes = (o.scope as Record<string, unknown>).notes;
    result.scope = {
      notes: typeof notes === "string" ? notes : undefined,
    };
  }
  if (typeof o.raw_path === "string" && o.raw_path.trim()) {
    result.raw_path = o.raw_path.trim();
  }
  return { ok: true, result };
}

function githubPrUrlLocal(repo: string, pr: number): string {
  return `https://github.com/${normalizeRepo(repo)}/pull/${Math.trunc(pr)}`;
}

function prReviewAgentNameLocal(repo: string, pr: number): string {
  return `Independent review · ${normalizeRepo(repo)}#${Math.trunc(pr)}`;
}

function evidenceToProvenance(
  entry: unknown,
  fallback: { repo: string; pr: number }
): Provenance {
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    const kindRaw = typeof e.kind === "string" ? e.kind : "github";
    const kind: Provenance["kind"] =
      kindRaw === "slack" ||
      kindRaw === "github" ||
      kindRaw === "rfc" ||
      kindRaw === "calendar"
        ? kindRaw
        : "github";
    return {
      kind,
      title:
        typeof e.title === "string" && e.title
          ? e.title
          : `${fallback.repo}#${fallback.pr}`,
      locator:
        typeof e.locator === "string" && e.locator
          ? e.locator
          : `${fallback.repo}#${fallback.pr}`,
      excerpt:
        typeof e.excerpt === "string"
          ? e.excerpt
          : "Evidence from review runner.",
      sourceId:
        typeof e.sourceId === "string" && e.sourceId
          ? e.sourceId
          : `runner-${fallback.repo.replace(/[^a-z0-9]+/gi, "-")}-${fallback.pr}`,
      url: typeof e.url === "string" ? e.url : undefined,
      timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined,
    };
  }
  const text = typeof entry === "string" ? entry : String(entry ?? "");
  const repo = normalizeRepo(fallback.repo);
  return {
    kind: "github",
    title: `${repo}#${fallback.pr}`,
    locator: `${repo}#${fallback.pr}`,
    excerpt: text || "Evidence from review runner.",
    sourceId: `runner-${repo.replace(/[^a-z0-9]+/gi, "-")}-${fallback.pr}`,
    url: githubPrUrlLocal(repo, fallback.pr),
  };
}

export function mapResultFindingsToFindings(
  result: ControlReviewResultV1,
  opts: { repo: string; pr: number; idPrefix?: string }
): Finding[] {
  const repo = normalizeRepo(opts.repo);
  const pr = Math.trunc(opts.pr);
  const prefix = opts.idPrefix ?? "f";
  return result.findings.map((f, i) => ({
    id: `${prefix}-${i}`,
    title: f.title,
    body: f.body,
    evidence: (f.evidence ?? []).map((e) =>
      evidenceToProvenance(e, { repo, pr })
    ),
  }));
}

export function buildReviewItemFromResult(opts: {
  id: string;
  findingIdPrefix?: string;
  repo: string;
  pr: number;
  workstreamId?: string;
  agentId: string;
  result: ControlReviewResultV1;
}): ReviewItem {
  const repo = normalizeRepo(opts.repo);
  const pr = Math.trunc(opts.pr);
  const findings = mapResultFindingsToFindings(opts.result, {
    repo,
    pr,
    idPrefix: opts.findingIdPrefix ?? opts.id,
  });
  const scopeNotes =
    opts.result.scope?.notes?.trim() ||
    `Examined ${repo}#${pr} · runner ${opts.result.job_id}. Absence of findings is not approval.`;
  return {
    id: opts.id,
    kind: "pr_review",
    title: prReviewAgentNameLocal(repo, pr),
    workstreamId: opts.workstreamId,
    label: "Analysis, not truth",
    analysisNote:
      opts.result.summary?.trim() ||
      "Second-pass review (auto or delegated). Findings are claims with evidence — not an approval.",
    findings,
    scopeFooter: scopeNotes,
    status: "pending",
    agentId: opts.agentId,
    repo,
    pr,
    prUrl: githubPrUrlLocal(repo, pr),
  };
}

/** Fake-backend fixture findings (test / smoke only — not Live default). */
export function buildFakeReviewResult(
  job: ControlReviewJobV1
): ControlReviewResultV1 {
  const repo = normalizeRepo(job.repo);
  const pr = Math.trunc(job.pr);
  const url = githubPrUrlLocal(repo, pr);
  const locator = `${repo}#${pr}`;
  return {
    schema: REVIEW_RESULT_SCHEMA,
    job_id: job.job_id,
    status: "ok",
    summary: `Fake backend surface checks on ${locator} (test-only).`,
    findings: [
      {
        title: `Surface checks on ${locator}`,
        body: `Fake independent review of ${locator}. Confirm CI status, outstanding review threads, and whether the ask still needs a human judgment. Findings are claims with evidence — not an approval. (CONTROL_REVIEW_BACKEND=fake — CI/smoke only.)`,
        evidence: [
          {
            kind: "github",
            title: locator,
            locator,
            excerpt: `Fake pass over ${locator}. Analysis, not truth.`,
            sourceId: `fake-pr-${repo.replace(/[^a-z0-9]+/gi, "-")}-${pr}`,
            url,
          },
        ],
      },
    ],
    scope: {
      notes: `Examined ${locator} · fake backend (test-only). Absence of findings is not approval.`,
    },
  };
}

export function buildCursorCloudStubResult(
  job: ControlReviewJobV1
): ControlReviewResultV1 {
  return {
    schema: REVIEW_RESULT_SCHEMA,
    job_id: job.job_id,
    status: "error",
    summary: "Agent Failed — cursor-cloud not configured",
    findings: [],
    scope: {
      notes: "cursor-cloud backend stub; configure a real cloud agent later.",
    },
  };
}

export const NO_REVIEW_BACKEND_DETAIL =
  "No review backend — set CONTROL_REVIEW_BACKEND (worker | claude-cli | cursor-cloud | fake | command).";

/** Agent detail while Live waits for ./scripts/control-review-worker. */
export const WAITING_FOR_LOCAL_WORKER_DETAIL =
  "Waiting for local worker (claude Pro).";

/** Failed/Blocked detail when no worker claims the job in time (no result file). */
export const WORKER_TIMEOUT_DETAIL =
  "Waiting timed out — run ./scripts/control-review-worker";

/** Default client poll wait for local worker result (ms). */
export const DEFAULT_WORKER_WAIT_MS = 180_000;


/** POST /api/review/run body as seen by the Live browser client. */
export type LiveReviewRunResponse = {
  ok?: boolean;
  pending?: boolean;
  code?: string;
  error?: string;
  detail?: string;
  backend?: string | null;
  job?: { job_id?: string } | null;
  /** Tolerate top-level job_id if present. */
  job_id?: string;
  result?: ControlReviewResultV1 | null;
};

export type LiveReviewRunDecision =
  | { action: "no_backend"; detail: string }
  | { action: "wait_worker"; jobId: string }
  | { action: "apply_result"; result: ControlReviewResultV1 }
  | { action: "fail"; detail: string; blocked: boolean };

/**
 * Interpret POST /api/review/run for the Live client kick path.
 * Live default backend is worker: successful enqueue (job on disk, no sync result)
 * must enter wait/poll — never fail-fast runner copy, never Demo sim findings.
 */
export function interpretLiveReviewRunResponse(
  httpOk: boolean,
  httpStatus: number,
  data: LiveReviewRunResponse
): LiveReviewRunDecision {
  if (httpStatus === 503 || data.code === "NO_BACKEND") {
    return {
      action: "no_backend",
      detail: (data.error ?? "").trim() || NO_REVIEW_BACKEND_DETAIL,
    };
  }

  const jobId =
    (typeof data.job?.job_id === "string" && data.job.job_id.trim()) ||
    (typeof data.job_id === "string" && data.job_id.trim()) ||
    "";

  const backendWorker = data.backend === "worker";
  const pendingFlag = data.pending === true;
  const detailMentionsWorker =
    typeof data.detail === "string" &&
    /local worker|control-review-worker/i.test(data.detail);
  const textMentionsWorker = /control-review-worker|local worker/i.test(
    `${data.error ?? ""} ${data.detail ?? ""}`
  );

  const workerShaped =
    pendingFlag || backendWorker || detailMentionsWorker || textMentionsWorker;

  // Enqueue success: ok + job + no usable sync result ⇒ wait (do not require
  // perfect pending detection — residual BUG-W4 fell through to fail-fast).
  const syncResult =
    data.result && data.pending !== true ? data.result : null;

  if (jobId && !syncResult) {
    if (
      workerShaped ||
      (httpOk && data.ok === true) ||
      (httpOk && pendingFlag) ||
      (httpOk && backendWorker)
    ) {
      return { action: "wait_worker", jobId };
    }
  }

  // Soft shapes: worker flags without ok, but we still have a job id.
  if (jobId && workerShaped && !syncResult) {
    return { action: "wait_worker", jobId };
  }

  if (httpOk && data.ok && syncResult) {
    return { action: "apply_result", result: syncResult };
  }

  // Live path: never surface the old fail-fast runner copy — worker is the default.
  const detail =
    (data.error ?? "").trim() ||
    (data.result?.summary ?? "").trim() ||
    WORKER_TIMEOUT_DETAIL;

  return {
    action: "fail",
    detail,
    blocked: workerShaped || httpStatus >= 500,
  };
}
