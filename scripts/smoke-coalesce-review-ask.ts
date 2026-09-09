/**
 * V0.6 chip 3 smoke: coalesce Slack pr_link + GitHub review.requested.
 * Run: npx tsx scripts/smoke-coalesce-review-ask.ts
 */
import {
  reviewAskAttentionId,
  reviewAskCoalesceKey,
  mergeReviewAskAttention,
  upsertReviewAskAttention,
  unionProvenance,
  joinWhyClauses,
  normalizeRepo,
  type ReviewAskAttentionLike,
} from "../src/lib/coalesce-review-ask";
import {
  routeGithubEvent,
  type WatchConfig,
  type GithubAttentionEffect,
} from "../src/lib/github-inbox";
import { routeSlackEvent } from "../src/lib/slack-inbox";
import { mergeCheckpoint } from "../src/lib/merge-checkpoint";
import { countExternalNeedsYouFromInboxes } from "../src/lib/needs-you-cap";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";
import type { StoredGithubInboxItem } from "../src/lib/github-inbox";
import type { StoredSlackInboxItem } from "../src/lib/slack-inbox";

const watch: WatchConfig = {
  repo: "richardhorvath11/battle-buddy",
  pr: 32,
  workstreamId: "ws-cred",
  teams: ["platform"],
  slackPrChannels: [{ id: "C0BVCSA4T2P", name: "#control-e2e" }],
  slackPrChannelId: "C0BVCSA4T2P",
  slackPrChannelName: "#control-e2e",
};

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

const STABLE = "ext-att-review-richardhorvath11-battle-buddy-32";
assert(
  reviewAskAttentionId("RichardHorvath11/battle-buddy.git", 32) === STABLE,
  "stable id normalize"
);
assert(
  reviewAskCoalesceKey("RichardHorvath11/battle-buddy.git", 32) ===
    "richardhorvath11/battle-buddy#32",
  "coalesce key"
);
assert(normalizeRepo(" Acme/Repo.GIT ") === "acme/repo", "normalizeRepo");
assert(NEEDS_YOU_EXTERNAL_CAP === 5, "cap unchanged at 5");

const ghUrl = "https://github.com/richardhorvath11/battle-buddy/pull/32";
const baseGh = {
  repo: watch.repo,
  pr_number: 32,
  head_sha: "abc1234",
  occurred_at: "2026-09-08T12:00:00.000Z",
  provenance: {
    url: ghUrl,
    title: "battle-buddy#32",
    kind: "review" as const,
  },
  workstream_id: "ws-cred",
};

function slackEv(id: string, ts: string) {
  return {
    id,
    type: "pr_link" as const,
    channel_id: "C0BVCSA4T2P",
    message_ts: ts,
    permalink: `https://example.slack.com/${ts}`,
    text_excerpt: "please review https://github.com/richardhorvath11/battle-buddy/pull/32",
    repo: watch.repo,
    pr_number: 32,
    occurred_at: "2026-09-08T12:00:00.000Z",
    provenance: [] as [],
  };
}

const slackFx = routeSlackEvent(slackEv("C0BVCSA4T2P_1.1", "1.1"), watch);
assert(slackFx.attention?.id === STABLE, "1 slack stable id");
assert(slackFx.attention?.origin === "external", "1 slack origin external");
assert(!!slackFx.attention?.coalesceKey, "1 slack coalesceKey");
assert(!!slackFx.workstreamPatch?.checkpointLine, "8 slack checkpoint");

const ghTeam = routeGithubEvent(
  {
    ...baseGh,
    id: "rev-team-1",
    type: "review.requested",
    requested_via: "team",
    team_slug: "platform",
    summary: "Team @platform review requested",
  },
  watch,
  0
);
assert(ghTeam.attention?.id === STABLE, "1 gh stable id");
assert(ghTeam.attention?.origin === "external", "1 gh origin external");
assert(
  ghTeam.attention?.title === "Review ask · richardhorvath11/battle-buddy#32",
  "neutral title"
);

// --- 1 Slack then GitHub → one Needs-you, dual provenance ---
let attention: ReviewAskAttentionLike[] = [];
attention = upsertReviewAskAttention(
  attention,
  slackFx.attention as unknown as ReviewAskAttentionLike
).attention;
attention = upsertReviewAskAttention(
  attention,
  ghTeam.attention as unknown as ReviewAskAttentionLike
).attention;
const now1 = attention.filter((a) => a.routing === "now" && !a.resolved);
assert(now1.length === 1, "1 exactly one Needs-you (slack→gh)");
assert(now1[0].id === STABLE, "1 stable id kept");
const kinds1 = now1[0].provenance.map((p) => p.kind).sort();
assert(
  kinds1.includes("slack") && kinds1.includes("github"),
  "1 dual provenance"
);
assert(now1[0].why.includes("Team @platform"), "1 why has team");
assert(now1[0].why.includes("#control-e2e"), "1 why has slack channel");

// --- 2 Reverse order ---
attention = [];
attention = upsertReviewAskAttention(
  attention,
  ghTeam.attention as unknown as ReviewAskAttentionLike
).attention;
attention = upsertReviewAskAttention(
  attention,
  slackFx.attention as unknown as ReviewAskAttentionLike
).attention;
const now2 = attention.filter((a) => a.routing === "now" && !a.resolved);
assert(now2.length === 1, "2 reverse → one Needs-you");
assert(
  now2[0].provenance.some((p) => p.kind === "slack") &&
    now2[0].provenance.some((p) => p.kind === "github"),
  "2 dual provenance"
);

// --- 3 Cap counts coalesced as 1 ---
const ghItem: StoredGithubInboxItem = {
  id: "rev-team-1",
  event: {
    ...baseGh,
    id: "rev-team-1",
    type: "review.requested",
    requested_via: "team",
    team_slug: "platform",
    summary: "Team @platform review requested",
  },
  received_at: "2026-09-08T12:00:00.000Z",
  applied: true,
  duplicate: false,
  effects: {
    attention: ghTeam.attention,
    fyiLine: null,
    workstreamPatch: ghTeam.workstreamPatch,
  },
};
const slItem: StoredSlackInboxItem = {
  id: "C0BVCSA4T2P_1.1",
  event: slackEv("C0BVCSA4T2P_1.1", "1.1"),
  received_at: "2026-09-08T12:00:00.000Z",
  applied: true,
  duplicate: false,
  effects: {
    attention: slackFx.attention,
    fyiLine: null,
    workstreamPatch: slackFx.workstreamPatch,
    newWorkstream: null,
  },
};
assert(
  countExternalNeedsYouFromInboxes([ghItem], [slItem]) === 1,
  "3 coalesced pair counts as 1"
);

// --- 4 ci.failed → separate Needs-you ---
const ciFail = routeGithubEvent(
  {
    ...baseGh,
    id: "ci-fail-1",
    type: "ci.failed",
    summary: "lint failed",
    provenance: { url: ghUrl, title: "CI", kind: "ci" },
  },
  watch,
  0
);
assert(ciFail.attention?.id === "gh-att-ci-fail-1", "4 ci uses gh-att id");
assert(ciFail.attention?.origin === "github", "4 ci origin github");
attention = upsertReviewAskAttention(
  [],
  ghTeam.attention as unknown as ReviewAskAttentionLike
).attention;
// ci is not coalesce — simulate plain insert
attention = [ciFail.attention as unknown as ReviewAskAttentionLike, ...attention];
assert(
  attention.filter((a) => a.routing === "now").length === 2,
  "4 ci separate from review-ask"
);

// --- 5 changes_requested separate ---
const chReq = routeGithubEvent(
  {
    ...baseGh,
    id: "ch-req-1",
    type: "review.changes_requested",
    summary: "nits",
  },
  watch,
  0
);
assert(chReq.attention?.id === "gh-att-ch-req-1", "5 changes_requested id");
assert(
  chReq.attention?.id !== STABLE,
  "5 changes_requested not coalesced id"
);

// --- 6 Duplicate events → no extra; provenance not duplicated ---
attention = [];
attention = upsertReviewAskAttention(
  attention,
  ghTeam.attention as unknown as ReviewAskAttentionLike
).attention;
attention = upsertReviewAskAttention(
  attention,
  ghTeam.attention as unknown as ReviewAskAttentionLike
).attention;
assert(
  attention.filter((a) => a.routing === "now").length === 1,
  "6 no extra item on dup"
);
const ghProv = attention[0].provenance.filter((p) => p.kind === "github");
assert(ghProv.length === 1, "6 github provenance not duplicated");

// --- 7 Team miss → no GitHub partner; Slack-only ---
const teamMiss = routeGithubEvent(
  {
    ...baseGh,
    id: "rev-team-miss",
    type: "review.requested",
    requested_via: "team",
    team_slug: "unknown-team",
    summary: "nope",
  },
  watch,
  0
);
assert(teamMiss.ignored === true && !teamMiss.attention, "7 team miss ignored");
attention = upsertReviewAskAttention(
  [],
  slackFx.attention as unknown as ReviewAskAttentionLike
).attention;
assert(attention.length === 1, "7 Slack-only Needs-you");
assert(
  attention[0].provenance.some((p) => p.kind === "slack"),
  "7 slack provenance present"
);

// --- 8 Checkpoint Latest on both; seed preserved ---
const seedBody =
  "You left Friday after pushing the rotation PR. Seed prose stays.";
let cp = mergeCheckpoint(
  seedBody,
  slackFx.workstreamPatch!.checkpointLine!
);
cp = mergeCheckpoint(cp, ghTeam.workstreamPatch!.checkpointLine!);
assert(cp.startsWith(seedBody), "8 seed body preserved");
assert((cp.match(/Latest:/g) || []).length === 1, "8 single Latest");
assert(
  cp.includes("Team @platform review requested"),
  "8 Latest from second signal"
);

// Legacy migrate: old gh-att-* folds into stable
const legacy: ReviewAskAttentionLike = {
  id: "gh-att-old-rev",
  routing: "now",
  title: "Review requested · richardhorvath11/battle-buddy#32",
  why: "please look",
  workstreamId: "ws-cred",
  suggestedAction: "open",
  provenance: [
    {
      kind: "github",
      title: "richardhorvath11/battle-buddy#32",
      locator: "richardhorvath11/battle-buddy#32",
      excerpt: "please look",
      sourceId: "live-32",
      url: ghUrl,
    },
  ],
  createdAt: "2026-09-08T11:00:00.000Z",
  origin: "github",
};
attention = [legacy];
attention = upsertReviewAskAttention(
  attention,
  slackFx.attention as unknown as ReviewAskAttentionLike
).attention;
assert(attention.length === 1, "legacy migrate → one row");
assert(attention[0].id === STABLE, "legacy folded to stable id");
assert(attention[0].origin === "external", "legacy → external");

// union / join helpers
const u = unionProvenance(
  [{ kind: "slack", title: "s", locator: "a", excerpt: "", sourceId: "1", url: "https://s" }],
  [
    { kind: "github", title: "g", locator: "r#1", excerpt: "", sourceId: "2", url: "https://g" },
    { kind: "slack", title: "s2", locator: "a", excerpt: "", sourceId: "3", url: "https://s" },
  ]
);
assert(u.length === 2, "union dedupes by url");
assert(u[0].kind === "github", "stable sort kind asc");
assert(
  joinWhyClauses("A · B", "B", "C").includes("A") &&
    joinWhyClauses("A · B", "B", "C").includes("C"),
  "joinWhy distinct"
);

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll coalesce smoke assertions passed.");
