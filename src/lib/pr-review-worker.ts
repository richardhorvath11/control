/**
 * V0.7 chip 1 + chip 3/3b — Auto-kick / manual independent PR review worker.
 * Chip 3b: Live default backend=worker (enqueue job; local Pro Claude claims).
 * Chip 3: opt-in control-review-run backends (command/fake/claude-cli).
 * Demo keeps local sim. Fake = test-only; Live default is NOT fake.
 * Snapshot UI / GitHub outbox / skill packs = later chips (cut).
 */

import type { Agent, AttentionItem, Finding, Provenance, ReviewItem } from "./types";
import { normalizeRepo, reviewAskCoalesceKey } from "./coalesce-review-ask";

export type PrReviewWorkerSource = "auto" | "manual";

export type StartPrReviewWorkerArgs = {
  repo: string;
  pr: number;
  workstreamId?: string;
  attentionId?: string;
  source: PrReviewWorkerSource;
  /** Optional Attention provenance (Slack + GitHub) for finding evidence. */
  attentionProvenance?: Provenance[];
};

/** Persist key: auto-review:{coalesceKey} e.g. auto-review:richardhorvath11/battle-buddy#32 */
export function autoReviewIdempotencyKey(coalesceKey: string): string {
  return `auto-review:${coalesceKey.trim().toLowerCase()}`;
}

export function autoReviewKeyFromRepoPr(repo: string, pr: number): string {
  return autoReviewIdempotencyKey(reviewAskCoalesceKey(repo, pr));
}

export function parseRepoPrFromCoalesceKey(
  coalesceKey: string
): { repo: string; pr: number } | null {
  const m = coalesceKey
    .trim()
    .toLowerCase()
    .match(/^([^#\s]+)#(\d+)$/);
  if (!m) return null;
  return { repo: m[1], pr: parseInt(m[2], 10) };
}

/** Simulated completion delay 3–8s (same spirit as today's delegate timer). */
export function prReviewSimDelayMs(): number {
  return 3000 + Math.floor(Math.random() * 5000);
}

export function githubPrUrl(repo: string, pr: number): string {
  return `https://github.com/${normalizeRepo(repo)}/pull/${Math.trunc(pr)}`;
}

export function prReviewAgentName(repo: string, pr: number): string {
  return `Independent review · ${normalizeRepo(repo)}#${Math.trunc(pr)}`;
}

export function buildPrReviewAgent(opts: {
  id: string;
  repo: string;
  pr: number;
  workstreamId?: string;
  source: PrReviewWorkerSource;
}): Agent {
  return {
    id: opts.id,
    name: prReviewAgentName(opts.repo, opts.pr),
    status: "Running",
    workstreamId: opts.workstreamId,
    detail:
      opts.source === "auto"
        ? "Auto-kick from review ask — working."
        : "Delegated from Now — working.",
    startedAt: "just now",
  };
}

function buildTemplatedFindings(opts: {
  findingId: string;
  repo: string;
  pr: number;
  attentionProvenance?: Provenance[];
}): Finding[] {
  const repoNorm = normalizeRepo(opts.repo);
  const pr = Math.trunc(opts.pr);
  const url = githubPrUrl(repoNorm, pr);
  const locator = `${repoNorm}#${pr}`;

  const githubEvidence: Provenance = {
    kind: "github",
    title: `${repoNorm}#${pr}`,
    locator,
    excerpt: `Independent pass over ${locator} (simulated). Analysis, not truth.`,
    sourceId: `ext-pr-${repoNorm.replace(/[^a-z0-9]+/gi, "-")}-${pr}`,
    url,
  };

  const slackFromAtt = (opts.attentionProvenance ?? []).filter(
    (p) => p.kind === "slack"
  );
  const evidence: Provenance[] = [githubEvidence];
  if (slackFromAtt[0]) {
    evidence.push({ ...slackFromAtt[0] });
  }

  return [
    {
      id: opts.findingId,
      title: `Surface checks on ${locator}`,
      body: `Simulated independent review of ${locator}. Confirm CI status, outstanding review threads, and whether the ask still needs a human judgment. Findings are claims with evidence — not an approval.`,
      evidence,
    },
  ];
}

export function buildPrReviewItem(opts: {
  id: string;
  findingId: string;
  repo: string;
  pr: number;
  workstreamId?: string;
  agentId: string;
  attentionProvenance?: Provenance[];
}): ReviewItem {
  const repoNorm = normalizeRepo(opts.repo);
  const pr = Math.trunc(opts.pr);
  const title = prReviewAgentName(repoNorm, pr);
  return {
    id: opts.id,
    kind: "pr_review",
    title,
    workstreamId: opts.workstreamId,
    label: "Analysis, not truth",
    analysisNote:
      "Second-pass review (auto or delegated). Findings are claims with evidence — not an approval.",
    findings: buildTemplatedFindings({
      findingId: opts.findingId,
      repo: repoNorm,
      pr,
      attentionProvenance: opts.attentionProvenance,
    }),
    scopeFooter: `Examined ${repoNorm}#${pr} · open ask provenance. Absence of findings is not approval.`,
    status: "pending",
    agentId: opts.agentId,
  };
}

/** Prefer coalesceKey / github locator on an Attention row. */
export function repoPrFromAttention(
  att: Pick<AttentionItem, "coalesceKey" | "title" | "provenance">
): { repo: string; pr: number } | null {
  if (att.coalesceKey) {
    const parsed = parseRepoPrFromCoalesceKey(att.coalesceKey);
    if (parsed) return parsed;
  }
  for (const p of att.provenance ?? []) {
    if (p.kind === "github" && p.locator) {
      const m = p.locator.trim().match(/^([^#\s]+)#(\d+)$/);
      if (m) return { repo: normalizeRepo(m[1]), pr: parseInt(m[2], 10) };
    }
    if (p.url) {
      const m = p.url.match(
        /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/i
      );
      if (m) return { repo: normalizeRepo(m[1]), pr: parseInt(m[2], 10) };
    }
  }
  const tm = (att.title ?? "").match(
    /(?:Review ask|Review requested|Independent review)\s·\s([^#\s]+)#(\d+)/i
  );
  if (tm) return { repo: normalizeRepo(tm[1]), pr: parseInt(tm[2], 10) };
  return null;
}
