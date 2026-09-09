/**
 * V0.7 chip 2 smoke: multi-channel watch normalize + legacy scalar migration.
 * Run: npx tsx scripts/smoke-watch-multi-channel.ts
 */
import {
  findSlackPrChannel,
  isWatchConfigured,
  normalizeWatch,
  serializeWatch,
} from "../src/lib/github-inbox";
import { routeSlackEvent } from "../src/lib/slack-inbox";
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

// Legacy scalar → n=1
const legacy = normalizeWatch({
  repo: "acme/widgets",
  pr: 7,
  workstreamId: "ws-a",
  teams: [],
  slackPrChannelId: "CLEGACY1",
  slackPrChannelName: "#legacy",
});
assert(legacy.slackPrChannels.length === 1, "legacy scalar → one channel");
assert(legacy.slackPrChannels[0]?.id === "CLEGACY1", "legacy id preserved");
assert(legacy.slackPrChannelId === "CLEGACY1", "derived slackPrChannelId");
assert(legacy.slackPrChannelName === "#legacy", "derived name");
assert(isWatchConfigured(legacy), "legacy configured");

// slackPrChannelIds form
const idsOnly = normalizeWatch({
  repo: "acme/widgets",
  pr: 1,
  slackPrChannelIds: ["CAAA", "CBBB"],
});
assert(idsOnly.slackPrChannels.length === 2, "ids array → 2 channels");
assert(idsOnly.slackPrChannelId === "CAAA", "first id derived");

// Multi-channel list
const multi = normalizeWatch({
  repo: "richardhorvath11/battle-buddy",
  pr: 32,
  workstreamId: "ws-cred",
  teams: [],
  slackPrChannels: [
    { id: "C0BVCSA4T2P", name: "#control-e2e" },
    { id: "C0BINFRA000", name: "#infra-prs" },
  ],
});
assert(multi.slackPrChannels.length === 2, "multi length 2");
assert(!!findSlackPrChannel(multi, "C0BINFRA000"), "find second channel");
assert(!findSlackPrChannel(multi, "CNOPE"), "unknown channel null");

const ser = serializeWatch(multi);
assert(Array.isArray(ser.slackPrChannels), "serialize has slackPrChannels");
assert(!("slackPrChannelId" in ser), "serialize omits legacy scalar");

// routeSlackEvent accepts any watched channel
const okEvt = {
  id: "C0BINFRA000_1.1",
  type: "pr_link" as const,
  channel_id: "C0BINFRA000",
  message_ts: "1.1",
  permalink: "https://example.slack.com/archives/C0BINFRA000/p1",
  text_excerpt: "https://github.com/richardhorvath11/battle-buddy/pull/99",
  repo: "richardhorvath11/battle-buddy",
  pr_number: 99,
  occurred_at: new Date().toISOString(),
  provenance: [],
};
const applied = routeSlackEvent(okEvt, multi);
assert(!applied.ignored, "second channel applies");
assert(
  applied.attention?.why.includes("#infra-prs"),
  "why uses matched channel name"
);

const wrong = routeSlackEvent({ ...okEvt, channel_id: "CWRONG" }, multi);
assert(!!wrong.ignored, "unknown channel ignored");

const wrongRepo = routeSlackEvent(
  { ...okEvt, repo: "other/repo", text_excerpt: "https://github.com/other/repo/pull/1" },
  multi
);
assert(!!wrongRepo.ignored, "wrong repo ignored");

assert(NEEDS_YOU_EXTERNAL_CAP === 5, "cap unchanged");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll multi-channel watch smoke checks passed.");
