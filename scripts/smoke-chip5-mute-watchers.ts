/**
 * V0.8 chip 5 smoke: mute suppresses Needs-you; unmute/expiry restores;
 * watcher status rows + stale; cap unchanged.
 * Run: npx tsx scripts/smoke-chip5-mute-watchers.ts
 */
import { promises as fs } from "fs";
import path from "path";
import {
  routeSlackMessageEvent,
  type SlackMessageInboxEvent,
} from "../src/lib/slack-inbox";
import type { WatchConfig } from "../src/lib/github-inbox";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";
import {
  MUTE_TTL_MS,
  plusMuteTtl,
  purgeExpiredMutes,
  slackMuteKey,
  slackMuteThreadRoot,
  type SlackMute,
} from "../src/lib/slack-mutes";
import {
  KNOWN_WATCHER_IDS,
  WATCHER_STALE_MS,
  buildWatcherRows,
  isWatcherStale,
  isWatcherStatusValue,
  type WatcherStatusState,
} from "../src/lib/watcher-status";

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

assert(NEEDS_YOU_EXTERNAL_CAP === 5, "cap unchanged at 5");
assert(MUTE_TTL_MS === 7 * 24 * 60 * 60 * 1000, "mute TTL 7d");
assert(WATCHER_STALE_MS >= 2 * 60 * 1000 && WATCHER_STALE_MS <= 5 * 60 * 1000, "stale 2–5 min");

const watch: WatchConfig = {
  repo: "richardhorvath11/battle-buddy",
  pr: 32,
  workstreamId: "ws-cred",
  teams: [],
  slackWatch: {
    surfaces: [
      { id: "C0TEST", name: "#eng", kind: "channel", prLinks: true },
    ],
    includeDms: true,
    includeMpims: false,
    myUserId: "U0ME",
  },
};

function msg(
  partial: Partial<SlackMessageInboxEvent> &
    Pick<SlackMessageInboxEvent, "channel_id" | "channel_kind" | "message_ts">
): SlackMessageInboxEvent {
  return {
    id: `${partial.channel_id}_${partial.message_ts}`,
    type: "message",
    permalink: `https://example.slack.com/archives/${partial.channel_id}/p1`,
    text_excerpt: partial.text_excerpt ?? "<@U0ME> please look",
    occurred_at: "2026-09-09T16:00:00.000Z",
    mentions_me: true,
    ...partial,
  };
}

const root = "1789000000.100001";
const e1 = msg({
  channel_id: "C0TEST",
  channel_kind: "channel",
  message_ts: root,
  text_excerpt: "<@U0ME> please look",
  mentions_me: true,
});
const unmuted = routeSlackMessageEvent(e1, watch);
assert(unmuted.attention?.routing === "now", "unmuted → Needs-you");
assert(!unmuted.muted, "unmuted flag false");

const mutedFx = routeSlackMessageEvent(e1, watch, { muted: true });
assert(mutedFx.attention === null, "muted → no Needs-you");
assert(mutedFx.muted === true, "muted flag set");
assert(!mutedFx.ignored, "muted still stores (not ignored)");

const reply = msg({
  channel_id: "C0TEST",
  channel_kind: "channel",
  message_ts: "1789000000.200002",
  thread_ts: root,
  text_excerpt: "<@U0ME> bump",
  mentions_me: true,
});
const replyMuted = routeSlackMessageEvent(reply, watch, { muted: true });
assert(replyMuted.attention === null, "muted thread reply → no Needs-you");

const key = slackMuteThreadRoot("C0TEST", {
  thread_ts: root,
  message_ts: "1789000000.200002",
});
assert(key.key === slackMuteKey("C0TEST", root), "mute key uses thread root");

const now = new Date("2026-09-09T12:00:00.000Z");
const mute: SlackMute = {
  key: key.key,
  channel_id: "C0TEST",
  thread_ts: root,
  created_at: now.toISOString(),
  expires_at: plusMuteTtl(now),
};
assert(
  purgeExpiredMutes([mute], now).length === 1,
  "active mute not purged"
);
const afterExpiry = new Date(now.getTime() + MUTE_TTL_MS + 1000);
assert(
  purgeExpiredMutes([mute], afterExpiry).length === 0,
  "expired mute purged → Needs-you allowed again"
);

assert(isWatcherStatusValue("ticking"), "ticking ok");
assert(!isWatcherStatusValue("running"), "running rejected");

const empty: WatcherStatusState = { watchers: {} };
const rows = buildWatcherRows(empty, now);
assert(
  rows.length >= KNOWN_WATCHER_IDS.length,
  "empty seed lists known watchers"
);
assert(
  rows.every((r) => r.status === "idle"),
  "seeded rows idle"
);

const freshIso = now.toISOString();
const staleIso = new Date(now.getTime() - WATCHER_STALE_MS - 1000).toISOString();
assert(!isWatcherStale(freshIso, now), "fresh not stale");
assert(isWatcherStale(staleIso, now), "old is stale");

const withPut: WatcherStatusState = {
  watchers: {
    "slack-watch": {
      id: "slack-watch",
      status: "ticking",
      last_action: "polled 2 surfaces",
      updated_at: freshIso,
    },
    "github-watch": {
      id: "github-watch",
      status: "ticking",
      last_action: "diffed",
      updated_at: staleIso,
    },
  },
};
const built = buildWatcherRows(withPut, now);
const sw = built.find((r) => r.id === "slack-watch")!;
const gw = built.find((r) => r.id === "github-watch")!;
assert(sw.display_status === "ticking" && !sw.stale, "PUT updates last action/tick");
assert(gw.stale && gw.display_status === "stale", "stale → display stale");

// Client bundle hygiene: no .control path literals in client components
const clientFiles = [
  "src/components/ModeBanner.tsx",
  "src/app/agents/page.tsx",
  "src/app/settings/page.tsx",
  "src/app/now/page.tsx",
];
for (const f of clientFiles) {
  const src = require("fs").readFileSync(path.join(process.cwd(), f), "utf8");
  // settings mentions .control/watch.json in help text — allowed as operator docs.
  // Agents / ModeBanner / Now must not instruct opening watcher-status or slack-mutes paths.
  if (f.includes("agents") || f.includes("ModeBanner") || f.includes("now/page")) {
    assert(
      !src.includes("watcher-status.json") && !src.includes("slack-mutes.json"),
      `${f} does not expose mute/watcher file paths`
    );
  }
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
