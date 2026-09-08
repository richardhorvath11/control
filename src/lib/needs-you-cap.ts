/**
 * Shared external Needs-you cap across GitHub + Slack inbox origins.
 * Seed Monday Needs-you are NOT external and are never demoted here.
 *
 * V0.6 chip 3: coalesced review-ask (same Attention id / coalesce key)
 * counts **once**. Demote by age of the Attention Item, not per inbox event.
 */
import { NEEDS_YOU_EXTERNAL_CAP } from "./github-constants";
import {
  demoteGithubNeedsYouItem,
  listInboxItems,
  type StoredGithubInboxItem,
} from "./github-inbox";
import {
  demoteSlackNeedsYouItem,
  listSlackInboxItems,
  type StoredSlackInboxItem,
} from "./slack-inbox";
import {
  coalesceKeyFromAttention,
  isStableReviewAskId,
} from "./coalesce-review-ask";

export { NEEDS_YOU_EXTERNAL_CAP };

type ExternalNeedsYouRef =
  | {
      origin: "github";
      item: StoredGithubInboxItem;
      at: string;
      groupKey: string;
    }
  | {
      origin: "slack";
      item: StoredSlackInboxItem;
      at: string;
      groupKey: string;
    };

function attentionGroupKey(
  att: {
    id: string;
    coalesceKey?: string;
    provenance?: { kind: string; locator?: string; url?: string }[];
    title?: string;
  },
  fallbackEventId: string
): string {
  if (att.coalesceKey) return `ck:${att.coalesceKey.toLowerCase()}`;
  if (isStableReviewAskId(att.id)) return `id:${att.id}`;
  const ck = coalesceKeyFromAttention(
    att as Parameters<typeof coalesceKeyFromAttention>[0]
  );
  if (ck && isStableReviewAskId(att.id)) return `ck:${ck}`;
  // Non-coalesce (ci.failed, changes_requested, etc.): one group per attention id
  return `id:${att.id || fallbackEventId}`;
}

/**
 * Ingest unlimited; when external Needs-you (origin github|slack|external)
 * exceed cap, demote oldest **Attention Items** (grouped) to FYI.
 * Coalesced Slack+GitHub review-ask shares one group → counts as 1.
 * Seed items are untouched.
 */
export async function enforceExternalNeedsYouCap(
  cap: number = NEEDS_YOU_EXTERNAL_CAP
): Promise<void> {
  const [githubItems, slackItems] = await Promise.all([
    listInboxItems(),
    listSlackInboxItems(),
  ]);

  const refs: ExternalNeedsYouRef[] = [];

  for (const item of githubItems) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing !== "now") continue;
    const att = item.effects.attention;
    refs.push({
      origin: "github",
      item,
      at: att.createdAt || item.event.occurred_at || item.received_at,
      groupKey: attentionGroupKey(att, item.id),
    });
  }

  for (const item of slackItems) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing !== "now") continue;
    const att = item.effects.attention;
    refs.push({
      origin: "slack",
      item,
      at: att.createdAt || item.event.occurred_at || item.received_at,
      groupKey: attentionGroupKey(att, item.id),
    });
  }

  // Group by Attention Item (coalesce key / stable id / per-event id)
  const groups = new Map<
    string,
    { at: string; refs: ExternalNeedsYouRef[] }
  >();
  for (const ref of refs) {
    const g = groups.get(ref.groupKey);
    if (!g) {
      groups.set(ref.groupKey, { at: ref.at, refs: [ref] });
    } else {
      g.refs.push(ref);
      if (ref.at < g.at) g.at = ref.at;
    }
  }

  const ordered = Array.from(groups.entries()).sort((a, b) =>
    a[1].at.localeCompare(b[1].at)
  );

  if (ordered.length <= cap) return;

  const overflow = ordered.length - cap;
  const toDemote = ordered.slice(0, overflow);

  for (const [, group] of toDemote) {
    for (const ref of group.refs) {
      if (ref.origin === "github") {
        await demoteGithubNeedsYouItem(ref.item, cap);
      } else {
        await demoteSlackNeedsYouItem(ref.item, cap);
      }
    }
  }
}

/**
 * Count unique external Needs-you Attention Items (coalesced pairs = 1).
 */
export function countExternalNeedsYouFromInboxes(
  githubItems: StoredGithubInboxItem[],
  slackItems: StoredSlackInboxItem[]
): number {
  const keys = new Set<string>();
  for (const item of githubItems) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing !== "now") continue;
    keys.add(attentionGroupKey(item.effects.attention, item.id));
  }
  for (const item of slackItems) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing !== "now") continue;
    keys.add(attentionGroupKey(item.effects.attention, item.id));
  }
  return keys.size;
}
