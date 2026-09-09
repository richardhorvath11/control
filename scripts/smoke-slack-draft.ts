/**
 * V0.8 chip 4 smoke: slack_draft job/result contracts + auto-draft eligibility.
 * Run: npx tsx scripts/smoke-slack-draft.ts
 */
import {
  REVIEW_JOB_SCHEMA,
  REVIEW_RESULT_SCHEMA,
  validateReviewJob,
  validateReviewResult,
  buildSlackDraftReviewItemFromResult,
  resolveReviewJobKind,
} from "../src/lib/review-contracts";
import {
  autoDraftIdempotencyKey,
  isAutoDraftEligible,
  isSlackMessageNeedsYou,
  shouldBlockAutoDraft,
} from "../src/lib/slack-draft-worker";
import { evaluateSlackActionability } from "../src/lib/slack-actionability";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";
import fs from "fs";
import path from "path";

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

const q = evaluateSlackActionability({
  channel_kind: "im",
  text_excerpt: "can you look?",
  myUserId: "U1",
});
assert(
  q.actionable && (q as { why: string }).why === "Question in DM",
  "short DM ? → Question in DM"
);

const mention = evaluateSlackActionability({
  channel_kind: "channel",
  text_excerpt: "hey <@U1>",
  myUserId: "U1",
});
assert(
  mention.actionable && (mention as { why: string }).why === "Mentioned you",
  "channel mention → Mentioned you (no auto-draft why)"
);

assert(
  isAutoDraftEligible({
    why: "Question in DM",
    routing: "now",
    resolved: false,
  }),
  "auto-draft eligible for Question in DM"
);
assert(
  !isAutoDraftEligible({
    why: "Mentioned you",
    routing: "now",
    resolved: false,
    slackChannelKind: "channel",
    slackTextExcerpt: "hey <@U1>?",
  }),
  "channel @mention does not auto-draft"
);

assert(
  autoDraftIdempotencyKey("slack-msg-D1-1.1") === "auto-draft:slack-msg-D1-1.1",
  "auto-draft idempotency key"
);

const jobRaw = {
  schema: REVIEW_JOB_SCHEMA,
  job_id: "rj-draft-1",
  kind: "slack_draft",
  attention_id: "slack-msg-D1-1.1",
  channel_id: "D1",
  thread_ts: "1.1",
  message_ts: "1.1",
  permalink: "https://example.slack.com/archives/D1/p11",
  text_excerpt: "can you look?",
  provenance: [],
};
assert(resolveReviewJobKind(jobRaw) === "slack_draft", "resolve kind slack_draft");
const vj = validateReviewJob(jobRaw);
assert(vj.ok, "validate slack_draft job");
if (vj.ok) {
  assert(vj.job.kind === "slack_draft", "job kind");
  assert(vj.job.channel_id === "D1", "channel_id");
  assert(vj.job.thread_ts === "1.1", "thread_ts");
}

// Back-compat pr_review without kind
const prJob = validateReviewJob({
  schema: REVIEW_JOB_SCHEMA,
  job_id: "rj-pr-1",
  repo: "owner/name",
  pr: 32,
});
assert(prJob.ok && prJob.ok && prJob.job.kind === "pr_review", "pr_review default kind");

const resultRaw = {
  schema: REVIEW_RESULT_SCHEMA,
  job_id: "rj-draft-1",
  status: "ok",
  summary: "Draft ready",
  draft_text: "Sure — looking now.",
  findings: [],
};
const vr = validateReviewResult(resultRaw);
assert(vr.ok, "validate result with draft_text");
if (vr.ok && vj.ok) {
  const item = buildSlackDraftReviewItemFromResult({
    id: "rev-d1",
    agentId: "agent-d1",
    result: vr.result,
    job: vj.job,
    channelLabel: "DM Alice",
  });
  assert(item.kind === "slack_draft", "mapped kind slack_draft");
  assert(item.draftText === "Sure — looking now.", "draft_text → draftText");
  assert(item.slackTarget?.channelId === "D1", "slackTarget channel");
  assert(item.slackTarget?.threadTs === "1.1", "slackTarget thread");
  assert(item.attentionId === "slack-msg-D1-1.1", "attentionId retained");
}

assert(
  isSlackMessageNeedsYou({
    id: "slack-msg-D1-1.1",
    origin: "slack",
    slackChannelId: "D1",
  }),
  "isSlackMessageNeedsYou"
);
assert(
  !isSlackMessageNeedsYou({
    id: "ext-att-review-x",
    origin: "external",
    coalesceKey: "owner/name#1",
  }),
  "coalesce review-ask is not slack message Needs-you"
);

const gate = shouldBlockAutoDraft({
  idemKey: "auto-draft:slack-msg-D1-1.1",
  agentName: "Draft reply · DM Alice",
  autoKickedReviewKeys: ["auto-draft:slack-msg-D1-1.1"],
  autoKickInFlight: false,
  agents: [],
  reviewQueue: [],
  attentionId: "slack-msg-D1-1.1",
});
assert(!gate.block && gate.reason === "stale_key", "stale auto-draft key allows re-kick");

// Live path must not invent draft copy
const storeSrc = fs.readFileSync(
  path.join(__dirname, "../src/lib/store.ts"),
  "utf8"
);
const draftIdx = storeSrc.indexOf("startSlackDraftWorker: (args)");
assert(draftIdx > 0, "startSlackDraftWorker present");
const draftEnd = storeSrc.indexOf("maybeAutoDraftSlackQuestions:", draftIdx);
const draftBlock = storeSrc.slice(
  draftIdx,
  draftEnd > draftIdx ? draftEnd : draftIdx + 12000
);
assert(
  !/Draft prepared\.|Sure — I('|’)ll get back/.test(draftBlock),
  "Live slack draft path does not invent templated draft copy"
);
assert(
  draftBlock.includes("WORKER_TIMEOUT_DETAIL"),
  "timeout uses WORKER_TIMEOUT_DETAIL"
);
assert(
  /do NOT resolve Needs-you|Prep ≠ done/i.test(draftBlock),
  "prep ≠ done comment present"
);

// Worker branches on kind
const workerSrc = fs.readFileSync(
  path.join(__dirname, "../scripts/control-review-worker.mjs"),
  "utf8"
);
assert(workerSrc.includes('kind === "slack_draft"'), "worker branches on slack_draft");
assert(workerSrc.includes("draft_text"), "worker mentions draft_text");
assert(!/skill pack|prompt library/i.test(workerSrc), "no skill pack in worker");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll slack-draft smoke checks passed.");
