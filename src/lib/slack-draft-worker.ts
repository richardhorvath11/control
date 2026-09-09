/**
 * V0.8 chip 4 — Draft reply → Review slack_draft via opaque review job APIs.
 * Live: enqueue control.review_job.v1 kind=slack_draft; local worker returns draft_text.
 * Demo: no auto; no invented Live drafts. Prep ≠ done (Needs-you stays).
 */

import type { Agent, AttentionItem } from "./types";
import { slackDraftAgentName } from "./review-contracts";

export type SlackDraftWorkerSource = "auto" | "manual";

export type StartSlackDraftWorkerArgs = {
  attentionId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  permalink: string;
  textExcerpt: string;
  channelKind?: "channel" | "im" | "mpim";
  channelLabel?: string;
  workstreamId?: string;
  provenance?: unknown[];
  source: SlackDraftWorkerSource;
  why?: string;
};

/** Persist key: auto-draft:{attentionId} — once per attention (Live only). */
export function autoDraftIdempotencyKey(attentionId: string): string {
  return `auto-draft:${attentionId.trim()}`;
}

export function isSlackMessageNeedsYou(
  att: Pick<AttentionItem, "id" | "origin" | "coalesceKey" | "slackChannelId">
): boolean {
  if (att.origin !== "slack") return false;
  if (att.coalesceKey) return false; // pr_link coalesce class
  if (att.slackChannelId) return true;
  return att.id.startsWith("slack-msg-");
}

/**
 * Auto-draft eligibility (Live only):
 * - why exactly "Question in DM" (preferred after chip 4 rule reorder), OR
 * - why "DM to you" AND im AND excerpt has ? AND ≤280 (compat)
 * Channel @mention does not auto-draft.
 */
export function isAutoDraftEligible(
  att: Pick<
    AttentionItem,
    | "why"
    | "slackChannelKind"
    | "slackTextExcerpt"
    | "routing"
    | "resolved"
  >
): boolean {
  if (att.routing !== "now" || att.resolved) return false;
  const why = (att.why ?? "").trim();
  if (why === "Question in DM") return true;
  if (why === "DM to you") {
    const kind = att.slackChannelKind;
    const excerpt = att.slackTextExcerpt ?? "";
    if (kind === "im" && excerpt.includes("?") && excerpt.length <= 280) {
      return true;
    }
  }
  return false;
}

export function buildSlackDraftAgent(opts: {
  id: string;
  channelLabel?: string;
  workstreamId?: string;
  source: SlackDraftWorkerSource;
}): Agent {
  return {
    id: opts.id,
    name: slackDraftAgentName(opts.channelLabel),
    status: "Running",
    workstreamId: opts.workstreamId,
    detail:
      opts.source === "auto"
        ? "Auto-draft from DM question — working."
        : "Draft reply from Now — working.",
    startedAt: "just now",
  };
}

export function shouldBlockAutoDraft(opts: {
  idemKey: string;
  agentName: string;
  autoKickedReviewKeys: string[];
  autoKickInFlight: boolean;
  agents: { name?: string; status?: string }[];
  reviewQueue: {
    kind?: string;
    attentionId?: string;
    title?: string;
  }[];
  attentionId: string;
}): { block: boolean; reason: string } {
  if (opts.autoKickInFlight) return { block: true, reason: "in_flight" };
  const running = opts.agents.some(
    (a) => a.name === opts.agentName && a.status === "Running"
  );
  if (running) return { block: true, reason: "running" };
  const landed = opts.reviewQueue.some(
    (r) =>
      r.kind === "slack_draft" &&
      (r.attentionId === opts.attentionId || r.title === opts.agentName)
  );
  if (landed) return { block: true, reason: "landed" };
  if (opts.autoKickedReviewKeys.includes(opts.idemKey)) {
    // Stale key with no Running / no landed draft — allow re-kick.
    return { block: false, reason: "stale_key" };
  }
  return { block: false, reason: "ok" };
}

export function channelLabelFromAttention(
  att: Pick<AttentionItem, "slackChannelId" | "provenance" | "title">
): string {
  const fromProv = att.provenance?.find((p) => p.kind === "slack")?.title;
  if (fromProv) {
    return fromProv.replace(/^Slack ·\s*/i, "").trim() || fromProv;
  }
  return att.slackChannelId || "Slack";
}
