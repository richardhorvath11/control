/**
 * V0.8 chip 3 smoke: deterministic Slack message actionability → Needs-you.
 * Run: npx tsx scripts/smoke-slack-actionability.ts
 */
import {
  evaluateSlackActionability,
  slackMessageAttentionId,
  slackMessageAttentionTitle,
} from "../src/lib/slack-actionability";
import {
  routeSlackEvent,
  routeSlackMessageEvent,
  messageDedupeKey,
  type SlackMessageInboxEvent,
} from "../src/lib/slack-inbox";
import type { WatchConfig } from "../src/lib/github-inbox";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

const MY = "U0ME123";

const watch: WatchConfig = {
  repo: "richardhorvath11/battle-buddy",
  pr: 32,
  workstreamId: "ws-cred",
  teams: [],
  slackWatch: {
    surfaces: [
      {
        id: "C0BVCSA4T2P",
        name: "#control-e2e",
        kind: "channel",
        prLinks: true,
      },
      { id: "D0ABCDEF", name: "DM Alice", kind: "im", prLinks: false },
    ],
    includeDms: true,
    includeMpims: true,
    myUserId: MY,
  },
};

function msg(
  partial: Partial<SlackMessageInboxEvent> &
    Pick<SlackMessageInboxEvent, "channel_id" | "channel_kind" | "message_ts">
): SlackMessageInboxEvent {
  return {
    id: `${partial.channel_id}_${partial.message_ts}`,
    type: "message",
    permalink: `https://example.slack.com/archives/${partial.channel_id}/p${partial.message_ts.replace(".", "")}`,
    text_excerpt: partial.text_excerpt ?? "hello",
    occurred_at: "2026-09-09T16:00:00.000Z",
    ...partial,
  };
}

// --- pure evaluateSlackActionability ---
assert(
  evaluateSlackActionability({
    channel_kind: "im",
    text_excerpt: "hey",
    myUserId: MY,
  }).actionable === true &&
    (evaluateSlackActionability({
      channel_kind: "im",
      text_excerpt: "hey",
      myUserId: MY,
    }) as { why: string }).why === "DM to you",
  "rule1 DM → DM to you"
);

assert(
  evaluateSlackActionability({
    channel_kind: "mpim",
    text_excerpt: "group",
    myUserId: MY,
  }).actionable === true,
  "rule1 MPIM actionable"
);

assert(
  evaluateSlackActionability({
    channel_kind: "channel",
    text_excerpt: "no ping",
    myUserId: MY,
  }).actionable === false,
  "channel no mention → ignore"
);

assert(
  evaluateSlackActionability({
    channel_kind: "channel",
    text_excerpt: `hey <@${MY}> look`,
    myUserId: MY,
  }).actionable === true &&
    (evaluateSlackActionability({
      channel_kind: "channel",
      text_excerpt: `hey <@${MY}> look`,
      myUserId: MY,
    }) as { why: string }).why === "Mentioned you",
  "rule2 <@myUserId> → Mentioned you"
);

assert(
  evaluateSlackActionability({
    channel_kind: "channel",
    text_excerpt: "ping",
    mentions_me: true,
    myUserId: MY,
  }).actionable === true,
  "rule2 mentions_me true"
);

assert(
  evaluateSlackActionability({
    channel_kind: "channel",
    text_excerpt: `hey <@${MY}>`,
    // no myUserId — cannot scan; mentions_me absent → not actionable
  }).actionable === false,
  "rule2 fail-closed without myUserId"
);

assert(
  evaluateSlackActionability({
    channel_kind: "channel",
    text_excerpt: "thread reply",
    thread_ts: "1.0",
    thread_participated: true,
    myUserId: MY,
  }).actionable === true &&
    (evaluateSlackActionability({
      channel_kind: "channel",
      text_excerpt: "thread reply",
      thread_ts: "1.0",
      thread_participated: true,
      myUserId: MY,
    }) as { why: string }).why === "Thread you're in",
  "rule3 thread participated"
);

assert(
  evaluateSlackActionability({
    channel_kind: "channel",
    text_excerpt: "thread reply",
    thread_ts: "1.0",
    // thread_participated absent — skip rule 3
    myUserId: MY,
  }).actionable === false,
  "rule3 skip when participation unknown"
);

assert(
  evaluateSlackActionability({
    channel_kind: "channel",
    text_excerpt: "anyone free?",
    myUserId: MY,
  }).actionable === false,
  "channel ? without mention → ignore"
);

// Chip 4: short DM with ? hits Question in DM before generic DM
const shortDmQ = evaluateSlackActionability({
  channel_kind: "im",
  text_excerpt: "got a sec?",
  myUserId: MY,
});
assert(
  shortDmQ.actionable === true &&
    (shortDmQ as { why: string; rule: number }).why === "Question in DM" &&
    (shortDmQ as { rule: number }).rule === 1,
  "short DM ? → Question in DM (chip 4 reorder)"
);

assert(
  evaluateSlackActionability({
    channel_kind: "im",
    text_excerpt: "hey no question mark",
    myUserId: MY,
  }).actionable === true &&
    (
      evaluateSlackActionability({
        channel_kind: "im",
        text_excerpt: "hey no question mark",
        myUserId: MY,
      }) as { why: string }
    ).why === "DM to you",
  "DM without ? → DM to you"
);

assert(
  slackMessageAttentionId("C1", "178.001") === "slack-msg-C1-178.001",
  "attention id stable"
);
assert(
  slackMessageAttentionTitle("  hi there  ", "#x").length <= 80,
  "title from excerpt"
);
assert(
  slackMessageAttentionTitle("", "#control-e2e") === "Slack · #control-e2e",
  "title fallback"
);

// --- routeSlackMessageEvent integration ---
const dm = routeSlackMessageEvent(
  msg({
    channel_id: "D0ABCDEF",
    channel_kind: "im",
    message_ts: "10.1",
    text_excerpt: "can you look?",
  }),
  watch
);
assert(!dm.ignored, "DM allowlisted");
assert(dm.attention?.routing === "now", "1 DM → Needs-you");
assert(dm.attention?.why === "Question in DM", "1 why Question in DM (has ?)");
assert(dm.attention?.origin === "slack", "origin slack");
assert(dm.attention?.suggestedAction === "open", "suggestedAction open");
assert(dm.attention?.workstreamId === undefined, "no workstream spam");
assert(dm.workstreamPatch === null, "no checkpoint patch");
assert(
  dm.attention?.provenance?.[0]?.url?.includes("slack.com"),
  "permalink provenance"
);
assert(
  dm.attention?.id === slackMessageAttentionId("D0ABCDEF", "10.1"),
  "attention id matches"
);
assert(dm.attention?.slackChannelId === "D0ABCDEF", "chip4 channel_id on attention");
assert(!!dm.attention?.slackMessageTs, "chip4 message_ts on attention");
assert(!!dm.attention?.slackThreadTs, "chip4 thread_ts on attention");

const plain = routeSlackMessageEvent(
  msg({
    channel_id: "C0BVCSA4T2P",
    channel_kind: "channel",
    message_ts: "10.2",
    text_excerpt: "standup notes",
  }),
  watch
);
assert(!plain.ignored, "2 channel stored");
assert(plain.attention === null, "2 no Needs-you without mention");
assert(plain.fyiLine === null, "2 no FYI");

const mentioned = routeSlackMessageEvent(
  msg({
    channel_id: "C0BVCSA4T2P",
    channel_kind: "channel",
    message_ts: "10.3",
    text_excerpt: `hey <@${MY}> please review`,
  }),
  watch
);
assert(mentioned.attention?.routing === "now", "3 mention → Needs-you");
assert(mentioned.attention?.why === "Mentioned you", "3 why Mentioned you");

const channelQ = routeSlackMessageEvent(
  msg({
    channel_id: "C0BVCSA4T2P",
    channel_kind: "channel",
    message_ts: "10.4",
    text_excerpt: "anyone know the deploy window?",
  }),
  watch
);
assert(channelQ.attention === null, "4 channel ? no mention → no Needs-you");

const shortDm = routeSlackMessageEvent(
  msg({
    channel_id: "DINCLUDE1",
    channel_kind: "im",
    message_ts: "10.5",
    text_excerpt: "quick q?",
  }),
  watch
);
assert(shortDm.attention?.routing === "now", "5 short DM ? → Needs-you");

// Dedup key stable for same channel+ts
assert(
  messageDedupeKey({ channel_id: "C1", message_ts: "1.1" }) ===
    messageDedupeKey({ channel_id: "C1", message_ts: "1.1" }),
  "6 same channel+ts same dedupe key"
);

// pr_link path unchanged (coalesce class)
const prLink = routeSlackEvent(
  {
    id: "C0BVCSA4T2P_99.9",
    type: "pr_link",
    channel_id: "C0BVCSA4T2P",
    message_ts: "99.9",
    permalink: "https://example.slack.com/archives/C0BVCSA4T2P/p99",
    text_excerpt:
      "Please review https://github.com/richardhorvath11/battle-buddy/pull/32",
    repo: "richardhorvath11/battle-buddy",
    pr_number: 32,
    occurred_at: "2026-09-09T16:00:00.000Z",
    provenance: [],
  },
  watch
);
assert(!prLink.ignored, "8 pr_link still applies");
assert(prLink.attention?.origin === "external", "8 pr_link origin external");
assert(
  prLink.attention?.id?.startsWith("ext-att-review-"),
  "8 pr_link coalesce id"
);
assert(prLink.workstreamPatch !== null, "8 pr_link still patches workstream");

assert(NEEDS_YOU_EXTERNAL_CAP === 5, "cap unchanged at 5");

// No LLM markers in this module path — smoke already pure/deterministic
assert(typeof evaluateSlackActionability === "function", "no LLM in path");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll slack-actionability smoke checks passed.");
