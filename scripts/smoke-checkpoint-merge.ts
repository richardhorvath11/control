/**
 * V0.6 chip 2 smoke: mergeCheckpoint + route templates + changed cap.
 * Run: npx tsx scripts/smoke-checkpoint-merge.ts
 */
import {
  mergeCheckpoint,
  prependChangedEntry,
  CHANGED_ENTRY_CAP,
  trimCheckpointSummary,
} from "../src/lib/merge-checkpoint";
import { routeGithubEvent, type WatchConfig } from "../src/lib/github-inbox";
import { routeSlackEvent } from "../src/lib/slack-inbox";

const watch: WatchConfig = {
  repo: "richardhorvath11/battle-buddy",
  pr: 32,
  workstreamId: "ws-cred",
  teams: ["platform"],
  slackWatch: {
    surfaces: [
      { id: "C0BVCSA4T2P", name: "#control-e2e", kind: "channel", prLinks: true },
    ],
    includeDms: false,
    includeMpims: false,
  },
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

const seedBody =
  "You left Friday after pushing the rotation PR. Seed prose stays.";

const m1 = mergeCheckpoint(
  seedBody,
  "CI red on r#32 — boom. Next: unblock CI."
);
assert(m1.startsWith(seedBody), "1a pre-Latest seed remains");
assert(
  m1.endsWith("Latest: CI red on r#32 — boom. Next: unblock CI."),
  "1b Latest CI red"
);

const m2 = mergeCheckpoint(m1, "CI green on r#32 — ok.");
assert(!m2.includes("CI red"), "2a old Latest gone");
assert((m2.match(/Latest:/g) || []).length === 1, "2b single Latest");
assert(m2.includes(seedBody), "2c seed still there");

let changed: string[] = [];
for (let i = 0; i < 12; i++) changed = prependChangedEntry(changed, "e" + i);
assert(changed.length === CHANGED_ENTRY_CAP, "7 changed.length <= 8");
assert(changed[0] === "e11", "7 newest first");

const same = prependChangedEntry(changed, "e11");
assert(
  same[0] === "e11" && same.length === 8,
  "no double prepend when already first"
);

const baseEv = {
  repo: watch.repo,
  pr_number: 32,
  head_sha: "abc1234",
  summary: "lint failed on auth",
  occurred_at: "2026-09-08T12:00:00.000Z",
  provenance: {
    url: "https://github.com/richardhorvath11/battle-buddy/pull/32",
    title: "t",
    kind: "ci" as const,
  },
  workstream_id: "ws-cred",
};

const ciFail = routeGithubEvent(
  { ...baseEv, id: "ci-fail-1", type: "ci.failed" },
  watch,
  0
);
assert(!!ciFail.workstreamPatch?.checkpointLine, "1 route has checkpointLine");
assert(
  ciFail.workstreamPatch!.checkpointLine!.includes("CI red on"),
  "1 template CI red"
);
assert(
  ciFail.workstreamPatch!.checkpointLine!.includes("Next: unblock CI."),
  "1 next unblock"
);

const ciPass = routeGithubEvent(
  {
    ...baseEv,
    id: "ci-pass-1",
    type: "ci.passed",
    summary: "all green",
  },
  watch,
  0
);
assert(
  ciPass.workstreamPatch!.checkpointLine!.includes("CI green on"),
  "2 template CI green"
);

const teamIgn = routeGithubEvent(
  {
    ...baseEv,
    id: "rev-team-x",
    type: "review.requested",
    requested_via: "team",
    team_slug: "unknown-team",
    summary: "team ask",
  },
  watch,
  0
);
assert(
  teamIgn.ignored === true && teamIgn.workstreamPatch === null,
  "4 unknown team ignored"
);

const teamOk = routeGithubEvent(
  {
    ...baseEv,
    id: "rev-team-p",
    type: "review.requested",
    requested_via: "team",
    team_slug: "platform",
    summary: "CODEOWNERS",
  },
  watch,
  0
);
assert(
  !!teamOk.workstreamPatch?.checkpointLine?.includes(
    "Team @platform review requested"
  ),
  "team template"
);

const userRev = routeGithubEvent(
  {
    ...baseEv,
    id: "rev-user",
    type: "review.requested",
    requested_via: "user",
    summary: "please look",
  },
  watch,
  0
);
assert(
  userRev.workstreamPatch!.checkpointLine!.startsWith("Review requested on"),
  "user review template"
);

const chReq = routeGithubEvent(
  {
    ...baseEv,
    id: "ch-req",
    type: "review.changes_requested",
    summary: "nits",
  },
  watch,
  0
);
assert(
  chReq.workstreamPatch!.checkpointLine!.includes("Next: address review."),
  "changes_requested template"
);

const pushed = routeGithubEvent(
  { ...baseEv, id: "push-1", type: "pr.pushed", summary: "two commits" },
  watch,
  0
);
assert(
  pushed.workstreamPatch!.checkpointLine!.startsWith("New commits on"),
  "pr.pushed template"
);

const slackPrimary = routeSlackEvent(
  {
    id: "C0BVCSA4T2P_1.1",
    type: "pr_link",
    channel_id: "C0BVCSA4T2P",
    message_ts: "1.1",
    permalink: "https://example.slack.com/p1",
    text_excerpt: "please review PR 32",
    repo: watch.repo,
    pr_number: 32,
    occurred_at: "2026-09-08T12:00:00.000Z",
    provenance: [],
  },
  watch
);
assert(
  !!slackPrimary.workstreamPatch?.checkpointLine?.includes(
    "Next: review that PR."
  ),
  "5 slack primary Latest"
);
assert(slackPrimary.newWorkstream === null, "5 no ephemeral for primary");

const slackOther = routeSlackEvent(
  {
    id: "C0BVCSA4T2P_2.2",
    type: "pr_link",
    channel_id: "C0BVCSA4T2P",
    message_ts: "2.2",
    permalink: "https://example.slack.com/p2",
    text_excerpt: "please review PR 99",
    repo: watch.repo,
    pr_number: 99,
    occurred_at: "2026-09-08T12:00:00.000Z",
    provenance: [],
  },
  watch
);
assert(
  !!slackOther.newWorkstream?.checkpoint.includes("Latest: Slack ask in"),
  "6 ephemeral Latest"
);
assert(
  slackOther.newWorkstream!.checkpoint.startsWith(
    "Review ask from #control-e2e."
  ),
  "6 ephemeral seed"
);
assert(slackOther.workstreamPatch === null, "6 no patch for ephemeral");

assert(
  trimCheckpointSummary("x".repeat(200)).length <= 120,
  "summary trim <=120"
);

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll smoke assertions passed.");
