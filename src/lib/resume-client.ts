"use client";
/**
 * Live Resume: record the user's own actions (opened / edited draft / approved / rejected /
 * requested review or draft / resumed) to the server-side store behind /api/resume/activity.
 * Fire-and-forget; Demo mode records nothing.
 */
import type { ReviewItem } from "./types";

export function prResumeKey(repo: string, pr: number): string {
  return `pr:${repo.trim().toLowerCase()}#${Math.trunc(pr)}`;
}
export function slackResumeKey(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

export function resumeKeyForReview(item: Pick<ReviewItem, "kind" | "repo" | "pr" | "slackTarget">): string | null {
  if (item.kind === "pr_review" && item.repo && item.pr) return prResumeKey(item.repo, item.pr);
  if (item.kind === "slack_draft" && item.slackTarget?.channelId && item.slackTarget.threadTs) {
    return slackResumeKey(item.slackTarget.channelId, item.slackTarget.threadTs);
  }
  return null;
}

function isLive(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem("control-v0-mode") === "live";
  } catch {
    return false;
  }
}

export function recordResumeActivity(
  key: string | null | undefined,
  kind: "opened" | "approved" | "rejected" | "edited_draft" | "requested_review" | "requested_draft" | "resumed",
  label: string,
  detail?: { draft?: string; job_id?: string }
): void {
  if (!key || !isLive()) return;
  void fetch("/api/resume/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, kind, label, detail }),
  }).catch(() => undefined);
}
