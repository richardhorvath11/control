/**
 * V0.6 chip 4 smoke: Slack-discovered PR follows (TTL, cap, refresh, primary skip).
 * Run: npx tsx scripts/smoke-pr-follows.ts
 */
import { promises as fs } from "fs";
import path from "path";
import {
  FOLLOW_MAX_ACTIVE,
  FOLLOW_TTL_MS,
  PR_FOLLOWS_PATH,
  ephemeralWorkstreamId,
  parseIsoMs,
  plusFollowTtl,
  purgeExpiredFollows,
  readPrFollows,
  upsertFollowRecord,
  writePrFollows,
  type PrFollow,
} from "../src/lib/pr-follows";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";
import { routeSlackEvent } from "../src/lib/slack-inbox";
import type { WatchConfig } from "../src/lib/github-inbox";

const watch: WatchConfig = {
  repo: "richardhorvath11/battle-buddy",
  pr: 32,
  workstreamId: "ws-cred",
  teams: [],
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

const NOW = new Date("2026-09-08T14:00:00.000Z");
const TTL_MS = FOLLOW_TTL_MS;

assert(NEEDS_YOU_EXTERNAL_CAP === 5, "NEEDS_YOU_EXTERNAL_CAP unchanged at 5");
assert(FOLLOW_MAX_ACTIVE === 5, "FOLLOW_MAX_ACTIVE = 5");
assert(TTL_MS === 48 * 60 * 60 * 1000, "FOLLOW_TTL = 48h");

const ws41 = ephemeralWorkstreamId(watch.repo, 41);
assert(
  ws41 === "ws-review-richardhorvath11-battle-buddy-41",
  "ephemeral workstreamId shape"
);

// --- 1 + 7: Slack pr_link for non-primary → follow; primary never stored ---
{
  const routed = routeSlackEvent(
    {
      id: "C0BVCSA4T2P_100.1",
      type: "pr_link",
      channel_id: "C0BVCSA4T2P",
      message_ts: "100.1",
      permalink: "https://example.slack.com/p100",
      text_excerpt:
        "please review https://github.com/richardhorvath11/battle-buddy/pull/41",
      repo: watch.repo,
      pr_number: 41,
      occurred_at: NOW.toISOString(),
      provenance: [],
    },
    watch
  );
  assert(routed.newWorkstream?.id === ws41, "1: ephemeral workstream for #41");
  assert(routed.attention?.workstreamId === ws41, "1: attention on ephemeral");

  let follows: PrFollow[] = [];
  let r = upsertFollowRecord(follows, {
    repo: watch.repo,
    pr: 41,
    slack_event_id: "C0BVCSA4T2P_100.1",
    workstreamId: ws41,
    watch,
    now: NOW,
  });
  assert(r.action === "created", "1: follow created");
  follows = r.follows;
  assert(follows.length === 1, "1: one follow row");
  assert(follows[0].pr === 41, "1: pr=41");
  assert(follows[0].workstreamId === ws41, "1: workstreamId set");
  const exp = parseIsoMs(follows[0].expires_at);
  const expectedExp = NOW.getTime() + TTL_MS;
  assert(
    Math.abs(exp - expectedExp) < 2000,
    `1: expires_at ≈ now+48h (got ${follows[0].expires_at})`
  );

  // Primary never stored
  r = upsertFollowRecord(follows, {
    repo: watch.repo,
    pr: 32,
    slack_event_id: "C0BVCSA4T2P_100.2",
    workstreamId: "ws-cred",
    watch,
    now: NOW,
  });
  assert(r.action === "skipped", "7: primary watch.pr skipped");
  assert(r.follows.length === 1, "7: still one follow (no primary row)");
  assert(
    !r.follows.some((f) => f.pr === 32),
    "7: primary never in follows[]"
  );
}

// --- 4: refresh TTL on second Slack link; still one row ---
{
  let follows: PrFollow[] = [
    {
      repo: watch.repo,
      pr: 41,
      source: "slack",
      slack_event_id: "C0BVCSA4T2P_100.1",
      workstreamId: ws41,
      created_at: NOW.toISOString(),
      expires_at: plusFollowTtl(NOW),
      head_sha: null,
      ci_conclusion: null,
      requested_users: [],
      requested_teams: [],
      changes_requested_ids: [],
      posted_event_ids: [],
    },
  ];
  const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000); // +2h
  const r = upsertFollowRecord(follows, {
    repo: watch.repo,
    pr: 41,
    slack_event_id: "C0BVCSA4T2P_200.2",
    workstreamId: ws41,
    watch,
    now: later,
  });
  assert(r.action === "refreshed", "4: refresh action");
  assert(r.follows.length === 1, "4: still one follow row");
  assert(
    r.follows[0].slack_event_id === "C0BVCSA4T2P_200.2",
    "4: slack_event_id updated"
  );
  const exp = parseIsoMs(r.follows[0].expires_at);
  assert(
    Math.abs(exp - (later.getTime() + TTL_MS)) < 2000,
    "4: expires_at extended +48h from now"
  );
}

// --- 3: forced expiry → purge removes follow ---
{
  const past = new Date(NOW.getTime() - 1000).toISOString();
  const follows: PrFollow[] = [
    {
      repo: watch.repo,
      pr: 41,
      source: "slack",
      slack_event_id: "x",
      workstreamId: ws41,
      created_at: past,
      expires_at: past,
      head_sha: "abc",
      ci_conclusion: "FAILURE",
      requested_users: [],
      requested_teams: [],
      changes_requested_ids: [],
      posted_event_ids: [],
    },
    {
      repo: watch.repo,
      pr: 42,
      source: "slack",
      slack_event_id: "y",
      workstreamId: ephemeralWorkstreamId(watch.repo, 42),
      created_at: NOW.toISOString(),
      expires_at: plusFollowTtl(NOW),
      head_sha: null,
      ci_conclusion: null,
      requested_users: [],
      requested_teams: [],
      changes_requested_ids: [],
      posted_event_ids: [],
    },
  ];
  const active = purgeExpiredFollows(follows, NOW);
  assert(active.length === 1 && active[0].pr === 42, "3: expired #41 purged");
}

// --- 5: six distinct PRs → only 5 retained (oldest expires_at dropped) ---
{
  let follows: PrFollow[] = [];
  for (let i = 0; i < 6; i++) {
    const pr = 50 + i;
    // Stagger expires so oldest is clear: first created expires soonest
    const t = new Date(NOW.getTime() + i * 60_000);
    const r = upsertFollowRecord(follows, {
      repo: watch.repo,
      pr,
      slack_event_id: `evt-${pr}`,
      workstreamId: ephemeralWorkstreamId(watch.repo, pr),
      watch,
      now: t,
    });
    follows = r.follows;
  }
  assert(follows.length === 5, "5: only 5 follows retained");
  assert(
    !follows.some((f) => f.pr === 50),
    "5: oldest (#50) dropped"
  );
  assert(
    [51, 52, 53, 54, 55].every((p) => follows.some((f) => f.pr === p)),
    "5: newest five kept"
  );
}

// --- 6: different repo rejected ---
{
  const r = upsertFollowRecord([], {
    repo: "other/org-repo",
    pr: 99,
    slack_event_id: "z",
    workstreamId: "ws-x",
    watch,
    now: NOW,
  });
  assert(r.action === "skipped", "6: different repo skipped");
  assert(r.follows.length === 0, "6: no follow row for other repo");

  const routed = routeSlackEvent(
    {
      id: "C0BVCSA4T2P_300.3",
      type: "pr_link",
      channel_id: "C0BVCSA4T2P",
      message_ts: "300.3",
      permalink: "https://example.slack.com/p300",
      text_excerpt: "https://github.com/other/org-repo/pull/99",
      repo: "other/org-repo",
      pr_number: 99,
      occurred_at: NOW.toISOString(),
      provenance: [],
    },
    watch
  );
  assert(routed.ignored === true, "6: slack route ignores other repo");
}


async function smokeFileRoundtrip() {
  // --- 8: empty follows file shape + read/write roundtrip (temp) ---
  const backup = path.join(
    path.dirname(PR_FOLLOWS_PATH),
    `pr-follows.smoke-bak.${Date.now()}.json`
  );
  let hadFile = false;
  try {
    await fs.access(PR_FOLLOWS_PATH);
    hadFile = true;
    await fs.copyFile(PR_FOLLOWS_PATH, backup);
  } catch {
    /* none */
  }

  await writePrFollows({ follows: [] });
  const empty = await readPrFollows();
  assert(empty.follows.length === 0, "8: empty follows → chip-1-ready");

  const sample: PrFollow = {
    repo: watch.repo,
    pr: 41,
    source: "slack",
    slack_event_id: "C0B_smoke",
    workstreamId: ws41,
    created_at: NOW.toISOString(),
    expires_at: plusFollowTtl(NOW),
    head_sha: null,
    ci_conclusion: null,
    requested_users: [],
    requested_teams: [],
    changes_requested_ids: [],
    posted_event_ids: [],
  };
  await writePrFollows({ follows: [sample] });
  const round = await readPrFollows();
  assert(round.follows.length === 1 && round.follows[0].pr === 41, "8: roundtrip");

  // restore
  if (hadFile) {
    await fs.copyFile(backup, PR_FOLLOWS_PATH);
    await fs.unlink(backup);
  } else {
    await writePrFollows({ follows: [] });
    try {
      await fs.unlink(backup);
    } catch {
      /* */
    }
  }
}

smokeFileRoundtrip()
  .then(() => {
    console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
