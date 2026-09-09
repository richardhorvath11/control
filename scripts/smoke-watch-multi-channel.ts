/**
 * V0.8 chip 2 smoke: slackWatch normalize + legacy migrate (no keep-alive).
 * Run: npx tsx scripts/smoke-watch-multi-channel.ts
 */
import {
  findSlackWatchSurface,
  hasLegacySlackKeys,
  isWatchConfigured,
  normalizeWatch,
  serializeWatch,
  validateSlackWatch,
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

// Legacy scalar → slackWatch.surfaces prLinks:true (migrate)
const legacy = normalizeWatch({
  repo: "acme/widgets",
  pr: 7,
  workstreamId: "ws-a",
  teams: [],
  slackPrChannelId: "CLEGACY1",
  slackPrChannelName: "#legacy",
});
assert(hasLegacySlackKeys({
  slackPrChannelId: "CLEGACY1",
  slackPrChannelName: "#legacy",
}), "detects legacy keys");
assert(legacy.slackWatch.surfaces.length === 1, "legacy scalar → one surface");
assert(legacy.slackWatch.surfaces[0]?.id === "CLEGACY1", "legacy id preserved");
assert(legacy.slackWatch.surfaces[0]?.prLinks === true, "migrated prLinks true");
assert(legacy.slackWatch.surfaces[0]?.kind === "channel", "migrated kind channel");
assert(isWatchConfigured(legacy), "legacy configured");

const serLegacy = serializeWatch(legacy);
assert(!("slackPrChannels" in serLegacy), "serialize drops slackPrChannels");
assert(!("slackPrChannelId" in serLegacy), "serialize drops scalar id");
assert(
  typeof serLegacy.slackWatch === "object" && serLegacy.slackWatch !== null,
  "serialize has slackWatch"
);

// slackPrChannelIds form
const idsOnly = normalizeWatch({
  repo: "acme/widgets",
  pr: 1,
  slackPrChannelIds: ["CAAA", "CBBB"],
});
assert(idsOnly.slackWatch.surfaces.length === 2, "ids array → 2 surfaces");
assert(idsOnly.slackWatch.surfaces[0]?.id === "CAAA", "first id");

// slackPrChannels list → migrate
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
assert(multi.slackWatch.surfaces.length === 2, "multi length 2");
assert(!!findSlackWatchSurface(multi, "C0BINFRA000"), "find second surface");
assert(!findSlackWatchSurface(multi, "CNOPE"), "unknown surface null");

const ser = serializeWatch(multi);
assert(
  Array.isArray((ser.slackWatch as { surfaces: unknown[] }).surfaces),
  "serialize has slackWatch.surfaces"
);
assert(!("slackPrChannels" in ser), "serialize omits slackPrChannels");

// Native slackWatch
const native = normalizeWatch({
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
      { id: "CENG", name: "#eng", kind: "channel", prLinks: false },
    ],
    includeDms: true,
    includeMpims: true,
    myUserId: "U123ABC",
  },
});
assert(validateSlackWatch(native.slackWatch) === null, "valid with myUserId");
assert(isWatchConfigured(native), "native configured");

const noUser = normalizeWatch({
  repo: "acme/x",
  pr: 1,
  slackWatch: {
    surfaces: [],
    includeDms: true,
    includeMpims: false,
  },
});
assert(
  validateSlackWatch(noUser.slackWatch) !== null,
  "includeDms without myUserId → validation error"
);
assert(isWatchConfigured(noUser), "includeDms alone still configured shape");

// routeSlackEvent accepts prLinks:true surface
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
assert(!applied.ignored, "second surface applies");
assert(
  applied.attention?.why.includes("#infra-prs"),
  "why uses matched surface name"
);

const wrong = routeSlackEvent({ ...okEvt, channel_id: "CWRONG" }, multi);
assert(!!wrong.ignored, "unknown channel ignored");

const wrongRepo = routeSlackEvent(
  {
    ...okEvt,
    repo: "other/repo",
    text_excerpt: "https://github.com/other/repo/pull/1",
  },
  multi
);
assert(!!wrongRepo.ignored, "wrong repo ignored");

// prLinks:false → ignore pr_link routing
const noPr = routeSlackEvent(
  { ...okEvt, channel_id: "CENG", id: "CENG_1.1" },
  native
);
assert(!!noPr.ignored, "prLinks:false ignores pr_link");
assert(
  (noPr.ignoreReason ?? "").includes("prLinks:false"),
  "documents prLinks:false"
);

// message on allowlisted surface — no attention
const msgEvt = {
  id: "C0BVCSA4T2P_2.2",
  type: "message" as const,
  channel_id: "C0BVCSA4T2P",
  channel_kind: "channel" as const,
  message_ts: "2.2",
  permalink: "https://example.slack.com/archives/C0BVCSA4T2P/p2",
  text_excerpt: "hello without PR",
  occurred_at: new Date().toISOString(),
};
const msgRouted = routeSlackEvent(msgEvt, native);
assert(!msgRouted.ignored, "message on surface allowed");
assert(msgRouted.attention === null, "message creates no Attention Item");

const msgUnknown = routeSlackEvent(
  { ...msgEvt, channel_id: "CUNKNOWN", id: "CUNKNOWN_2.2" },
  native
);
assert(!!msgUnknown.ignored, "message unknown channel ignored");
assert(msgUnknown.attention === null, "unknown message no Attention Item");

// DM via include
const dmMsg = routeSlackEvent(
  {
    ...msgEvt,
    id: "D1_3.3",
    channel_id: "D1",
    channel_kind: "im",
    message_ts: "3.3",
  },
  native
);
assert(!dmMsg.ignored, "IM allowed when includeDms + myUserId");

const dmNoUser = routeSlackEvent(
  {
    ...msgEvt,
    id: "D1_3.4",
    channel_id: "D1",
    channel_kind: "im",
    message_ts: "3.4",
  },
  noUser
);
assert(!!dmNoUser.ignored, "IM fail-closed without myUserId");

assert(NEEDS_YOU_EXTERNAL_CAP === 5, "cap unchanged");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll slackWatch smoke checks passed.");
