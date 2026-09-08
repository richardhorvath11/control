/**
 * Shared external Needs-you cap across GitHub + Slack inbox origins.
 * Seed Monday Needs-you are NOT external and are never demoted here.
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

export { NEEDS_YOU_EXTERNAL_CAP };

type ExternalNeedsYouRef =
  | {
      origin: "github";
      item: StoredGithubInboxItem;
      at: string;
    }
  | {
      origin: "slack";
      item: StoredSlackInboxItem;
      at: string;
    };

/**
 * Ingest unlimited; when external Needs-you (origin github|slack) exceed cap,
 * demote oldest to FYI. Seed items are untouched.
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
    refs.push({
      origin: "github",
      item,
      at: item.event.occurred_at || item.received_at,
    });
  }

  for (const item of slackItems) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing !== "now") continue;
    refs.push({
      origin: "slack",
      item,
      at: item.event.occurred_at || item.received_at,
    });
  }

  refs.sort((a, b) => a.at.localeCompare(b.at));

  if (refs.length <= cap) return;

  const overflow = refs.length - cap;
  const toDemote = refs.slice(0, overflow);

  for (const ref of toDemote) {
    if (ref.origin === "github") {
      await demoteGithubNeedsYouItem(ref.item, cap);
    } else {
      await demoteSlackNeedsYouItem(ref.item, cap);
    }
  }
}

export function countExternalNeedsYouFromInboxes(
  githubItems: StoredGithubInboxItem[],
  slackItems: StoredSlackInboxItem[]
): number {
  let n = 0;
  for (const item of githubItems) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing === "now") n += 1;
  }
  for (const item of slackItems) {
    if (!item.applied || item.duplicate) continue;
    if (item.effects?.attention?.routing === "now") n += 1;
  }
  return n;
}
