/**
 * V0.7 chip 1 + chip 3/3b — Auto-kick / manual independent PR review worker.
 * Chip 3b: Live default backend=worker (enqueue job; local Pro Claude claims).
 * Chip 3: opt-in control-review-run backends (command/fake/claude-cli).
 * Demo keeps local sim. Fake = test-only; Live default is NOT fake.
 * Chip 4: Live Review snapshot chrome (gh snapshot + GET API). Outbox = chip 5.
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
  const url = githubPrUrl(repoNorm, pr);
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
    repo: repoNorm,
    pr,
    prUrl: url,
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

/** Demo setTimeout templated finding markers (not Live worker results). */
export function isDemoSimulatedFinding(f: {
  title?: string;
  body?: string;
}): boolean {
  const title = f.title ?? "";
  const body = f.body ?? "";
  return (
    /^Surface checks on\s+/i.test(title) &&
    /Simulated independent review/i.test(body)
  );
}

/** True when a Review item is Demo-sim Surface checks (not control.review_result.v1). */
export function isDemoSimulatedReviewItem(item: {
  kind?: string;
  findings?: { title?: string; body?: string }[];
}): boolean {
  if (item.kind !== "pr_review") return false;
  const findings = item.findings ?? [];
  return findings.some(isDemoSimulatedFinding);
}

/**
 * Independent-review agent tied to Demo-sim Complete review, or orphaned
 * Complete agent whose detail still reads like the Demo landOk path after sim.
 */
export function isDemoSimulatedPrReviewAgent(
  agent: {
    id: string;
    name?: string;
    status?: string;
    reviewItemId?: string;
    detail?: string;
  },
  reviewQueue: { id: string; kind?: string; findings?: { title?: string; body?: string }[] }[]
): boolean {
  if (!/^Independent review · /i.test(agent.name ?? "")) return false;
  if (agent.reviewItemId) {
    const linked = reviewQueue.find((r) => r.id === agent.reviewItemId);
    if (linked && isDemoSimulatedReviewItem(linked)) return true;
  }
  // Complete agent with no real linked result — Demo landOk detail.
  if (
    agent.status === "Complete" &&
    /Complete — waiting in Review/i.test(agent.detail ?? "")
  ) {
    const simForName = reviewQueue.some(
      (r) =>
        isDemoSimulatedReviewItem(r) &&
        (r as { title?: string }).title === agent.name
    );
    if (simForName) return true;
  }
  return false;
}

export type DemoPollutionSlice = {
  agents: {
    id: string;
    name?: string;
    status?: string;
    reviewItemId?: string;
    detail?: string;
  }[];
  reviewQueue: {
    id: string;
    kind?: string;
    title?: string;
    findings?: { title?: string; body?: string }[];
    agentId?: string;
  }[];
  autoKickedReviewKeys: string[];
};

/**
 * Drop Demo-sim Surface checks reviews + their agents; drop stale autoKicked
 * keys that have no Running wait agent and no real landed pr_review.
 * Used on Demo→Live / Live hydrate wipe path (and unit smoke).
 */
export function scrubDemoReviewPollution<T extends DemoPollutionSlice>(
  slice: T
): T {
  const scrubbedReviews = slice.reviewQueue.filter(
    (r) => !isDemoSimulatedReviewItem(r)
  );
  const scrubbedAgents = slice.agents.filter(
    (a) => !isDemoSimulatedPrReviewAgent(a, slice.reviewQueue)
  );
  const runningNames = new Set(
    scrubbedAgents
      .filter((a) => a.status === "Running")
      .map((a) => (a.name ?? "").toLowerCase())
  );
  const realLandedKeys = new Set<string>();
  for (const r of scrubbedReviews) {
    if (r.kind !== "pr_review" || isDemoSimulatedReviewItem(r)) continue;
    const parsed = parseRepoPrFromCoalesceKey(
      (r.title ?? "")
        .replace(/^Independent review ·\s*/i, "")
        .trim()
        .toLowerCase()
    );
    if (parsed) {
      realLandedKeys.add(autoReviewKeyFromRepoPr(parsed.repo, parsed.pr));
    }
  }
  const scrubbedKeys = slice.autoKickedReviewKeys.filter((key) => {
    const coalesce = key.replace(/^auto-review:/i, "");
    const parsed = parseRepoPrFromCoalesceKey(coalesce);
    if (!parsed) return false;
    const agentName = prReviewAgentName(parsed.repo, parsed.pr).toLowerCase();
    if (runningNames.has(agentName)) return true;
    if (realLandedKeys.has(key.toLowerCase()) || realLandedKeys.has(key))
      return true;
    return false;
  });
  return {
    ...slice,
    agents: scrubbedAgents as T["agents"],
    reviewQueue: scrubbedReviews as T["reviewQueue"],
    autoKickedReviewKeys: scrubbedKeys,
  };
}

/**
 * Auto-kick gate: block only when in-flight Running agent or a real
 * (non-Demo-sim) landed pr_review exists for repo#PR. Stale autoKicked keys
 * alone must not block re-kick after Demo→Live pollution.
 */
export function shouldBlockAutoKick(opts: {
  idemKey: string;
  agentName: string;
  autoKickedReviewKeys: string[];
  autoKickInFlight: boolean;
  agents: { id?: string; name?: string; status?: string; detail?: string }[];
  reviewQueue: {
    id?: string;
    kind?: string;
    title?: string;
    findings?: { title?: string; body?: string }[];
    agentId?: string;
  }[];
}): { block: boolean; reason: "in_flight" | "running" | "landed" | "stale_key" | "ok" } {
  if (opts.autoKickInFlight) {
    return { block: true, reason: "in_flight" };
  }
  const running = opts.agents.some(
    (a) => a.name === opts.agentName && a.status === "Running"
  );
  if (running) {
    return { block: true, reason: "running" };
  }
  const landedReal = opts.reviewQueue.some(
    (r) =>
      r.kind === "pr_review" &&
      r.title === opts.agentName &&
      !isDemoSimulatedReviewItem(r)
  );
  if (landedReal) {
    return { block: true, reason: "landed" };
  }
  if (opts.autoKickedReviewKeys.includes(opts.idemKey)) {
    // Stale key with no Running wait and no real result — allow re-kick.
    return { block: false, reason: "stale_key" };
  }
  return { block: false, reason: "ok" };
}

/** Live enter / Live hydrate: empty worker slice (dogfood-correct wipe). */
export function emptyLiveReviewWorkerSlice(): {
  agents: [];
  reviewQueue: [];
  autoKickedReviewKeys: [];
  selectedReviewId: null;
} {
  return {
    agents: [],
    reviewQueue: [],
    autoKickedReviewKeys: [],
    selectedReviewId: null,
  };
}
