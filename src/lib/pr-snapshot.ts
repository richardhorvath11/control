/**
 * V0.7 chip 4 — Live Review PR snapshots (gh-written; Control reads only).
 * No PAT in Control. Files under gitignored `.control/pr-snapshots/`.
 */

import { promises as fs } from "fs";
import path from "path";
import { normalizeRepo } from "./coalesce-review-ask";
import { CONTROL_DIR } from "./github-inbox";

export const PR_SNAPSHOTS_DIR = path.join(CONTROL_DIR, "pr-snapshots");

export type PrSnapshotCi = {
  conclusion: string;
  url?: string;
};

export type PrSnapshotFile = {
  path: string;
  status: string;
};

export type PrSnapshot = {
  repo: string;
  pr: number;
  title: string;
  url: string;
  head_sha: string;
  ci: PrSnapshotCi;
  files: PrSnapshotFile[];
  requested_reviewers: { users: string[]; teams: string[] };
  updated_at: string;
};

/** Filename: {owner}-{repo}-{pr}.json */
export function prSnapshotFileName(repo: string, pr: number): string {
  const norm = normalizeRepo(repo);
  const parts = norm.split("/");
  const owner = parts[0] || "owner";
  const name = parts[1] || "repo";
  return `${owner}-${name}-${Math.trunc(pr)}.json`;
}

/** Relative path preferred in review_job.v1.snapshot_path */
export function prSnapshotRelPath(repo: string, pr: number): string {
  return `.control/pr-snapshots/${prSnapshotFileName(repo, pr)}`;
}

export function prSnapshotAbsPath(repo: string, pr: number): string {
  return path.join(PR_SNAPSHOTS_DIR, prSnapshotFileName(repo, pr));
}

export async function ensurePrSnapshotsDir(): Promise<void> {
  await fs.mkdir(CONTROL_DIR, { recursive: true });
  await fs.mkdir(PR_SNAPSHOTS_DIR, { recursive: true });
}

export function isPrSnapshot(raw: unknown): raw is PrSnapshot {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.repo !== "string" || !o.repo.trim()) return false;
  const pr =
    typeof o.pr === "number"
      ? o.pr
      : typeof o.pr === "string"
        ? parseInt(o.pr, 10)
        : NaN;
  if (!Number.isFinite(pr) || pr <= 0) return false;
  if (typeof o.title !== "string") return false;
  if (typeof o.url !== "string") return false;
  if (typeof o.head_sha !== "string") return false;
  if (!o.ci || typeof o.ci !== "object") return false;
  if (!Array.isArray(o.files)) return false;
  return true;
}

/** Read snapshot from disk. Returns null if missing or invalid. */
export async function readPrSnapshot(
  repo: string,
  pr: number
): Promise<PrSnapshot | null> {
  const abs = prSnapshotAbsPath(repo, pr);
  try {
    const text = await fs.readFile(abs, "utf8");
    const raw = JSON.parse(text) as unknown;
    if (!isPrSnapshot(raw)) return null;
    return {
      ...raw,
      repo: normalizeRepo(raw.repo),
      pr: Math.trunc(
        typeof raw.pr === "number" ? raw.pr : parseInt(String(raw.pr), 10)
      ),
      ci: {
        conclusion: String(
          (raw.ci as PrSnapshotCi).conclusion || "UNKNOWN"
        ).toUpperCase(),
        url:
          typeof (raw.ci as PrSnapshotCi).url === "string"
            ? (raw.ci as PrSnapshotCi).url
            : undefined,
      },
      files: (raw.files as PrSnapshotFile[]).map((f) => ({
        path: String(f.path ?? ""),
        status: String(f.status ?? "modified"),
      })),
      requested_reviewers: {
        users: Array.isArray(raw.requested_reviewers?.users)
          ? raw.requested_reviewers.users.map(String)
          : [],
        teams: Array.isArray(raw.requested_reviewers?.teams)
          ? raw.requested_reviewers.teams.map(String)
          : [],
      },
      updated_at:
        typeof raw.updated_at === "string"
          ? raw.updated_at
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** If a snapshot file exists on disk, return its relative path for job.snapshot_path. */
export async function preferSnapshotPath(
  repo: string,
  pr: number
): Promise<string | undefined> {
  const abs = prSnapshotAbsPath(repo, pr);
  try {
    await fs.access(abs);
    return prSnapshotRelPath(repo, pr);
  } catch {
    return undefined;
  }
}

/** Parse repo#pr from Independent review titles or coalesce keys. */
export function repoPrFromReviewTitle(
  title: string | undefined
): { repo: string; pr: number } | null {
  if (!title) return null;
  const m = title.match(
    /(?:Independent review(?: of)?|Review ask)\s*(?:·|-)?\s*([^#\s]+)#(\d+)/i
  );
  if (!m) return null;
  return { repo: normalizeRepo(m[1]), pr: parseInt(m[2], 10) };
}
