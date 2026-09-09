/**
 * Client-safe PR snapshot helpers (no Node fs).
 * Server I/O lives in pr-snapshot.ts.
 */

import { normalizeRepo } from "./coalesce-review-ask";

/** Mirror of server PrSnapshot shape for client fetch typing. */
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

/** Parse repo#pr from Independent review titles. */
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
