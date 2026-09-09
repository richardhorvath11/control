/**
 * V0.8 chip 3 — Deterministic Slack message actionability (no LLM).
 * First match wins. Pure / unit-testable.
 *
 * Rules:
 * 1. DM/MPIM to me — channel_kind im|mpim
 * 2. @me / user mention — mentions_me OR text contains <@myUserId>
 * 3. Thread I'm in — thread_ts set AND thread_participated:true
 * 4. DM question — channel_kind===im AND text has `?` AND excerpt length ≤ 280
 *
 * myUserId required when a rule must identify "me" via mention text (rule 2
 * without mentions_me). Missing myUserId → that rule does not match (fail closed).
 * Do not invent thread history: absent thread_participated skips rule 3.
 *
 * Note: rule 4 overlaps rule 1 for short IMs with `?` — first match means
 * im/mpim hits rule 1 with why "DM to you". Rule 4 remains in the table.
 */

import type { SlackSurfaceKind } from "./github-inbox";

export type SlackActionabilityWhy =
  | "DM to you"
  | "Mentioned you"
  | "Thread you're in"
  | "Question in DM";

export interface SlackActionabilityInput {
  channel_kind: SlackSurfaceKind;
  text_excerpt: string;
  mentions_me?: boolean;
  thread_ts?: string;
  /** Present only when watcher knows participation; never invent. */
  thread_participated?: boolean;
  /** watch.slackWatch.myUserId — needed for <@id> mention scan */
  myUserId?: string;
}

export type SlackActionabilityResult =
  | {
      actionable: true;
      why: SlackActionabilityWhy;
      rule: 1 | 2 | 3 | 4;
    }
  | { actionable: false };

const DM_QUESTION_MAX = 280;

function mentionToken(myUserId: string): string {
  return `<@${myUserId}>`;
}

/**
 * Evaluate Slack message actionability. First match wins.
 * Non-matches → ignore (no FYI).
 */
export function evaluateSlackActionability(
  input: SlackActionabilityInput
): SlackActionabilityResult {
  const kind = input.channel_kind;
  const excerpt = typeof input.text_excerpt === "string" ? input.text_excerpt : "";
  const myUserId =
    typeof input.myUserId === "string" && input.myUserId.trim()
      ? input.myUserId.trim()
      : undefined;

  // Each rule in its own function so TS does not narrow kind across the table.
  const rules: Array<() => SlackActionabilityResult | null> = [
    // 1. DM/MPIM to me (allowlist already gated; kind is enough)
    () => {
      if (kind === "im" || kind === "mpim") {
        return { actionable: true, why: "DM to you", rule: 1 };
      }
      return null;
    },
    // 2. @me / user mention
    () => {
      if (input.mentions_me === true) {
        return { actionable: true, why: "Mentioned you", rule: 2 };
      }
      if (myUserId && excerpt.includes(mentionToken(myUserId))) {
        return { actionable: true, why: "Mentioned you", rule: 2 };
      }
      // Fail closed: need myUserId to scan text; without it and no mentions_me → skip
      return null;
    },
    // 3. Thread I'm in — only when participation flag is explicitly true
    () => {
      if (
        typeof input.thread_ts === "string" &&
        input.thread_ts.trim() &&
        input.thread_participated === true
      ) {
        return { actionable: true, why: "Thread you're in", rule: 3 };
      }
      return null;
    },
    // 4. DM question (overlaps rule 1 for im; kept for spec / first-match docs)
    () => {
      if (
        kind === "im" &&
        excerpt.includes("?") &&
        excerpt.length <= DM_QUESTION_MAX
      ) {
        return { actionable: true, why: "Question in DM", rule: 4 };
      }
      return null;
    },
  ];

  for (const rule of rules) {
    const hit = rule();
    if (hit) return hit;
  }
  return { actionable: false };
}

/** Attention id for a Slack message Needs-you (stable for dedupe). */
export function slackMessageAttentionId(
  channelId: string,
  messageTs: string
): string {
  const safeTs = messageTs.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeCh = channelId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `slack-msg-${safeCh}-${safeTs}`;
}

/** Title ≤80 from excerpt, or Slack · {label}. */
export function slackMessageAttentionTitle(
  textExcerpt: string,
  channelLabel: string
): string {
  const trimmed = textExcerpt.replace(/\s+/g, " ").trim();
  if (trimmed) {
    return trimmed.length <= 80 ? trimmed : trimmed.slice(0, 80);
  }
  return `Slack · ${channelLabel}`;
}
