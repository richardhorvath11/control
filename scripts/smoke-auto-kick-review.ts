/**
 * V0.7 chip 1 smoke: auto-kick idempotency helpers + templated review payload.
 * Run: npx tsx scripts/smoke-auto-kick-review.ts
 */
import {
  autoReviewIdempotencyKey,
  autoReviewKeyFromRepoPr,
  buildPrReviewAgent,
  buildPrReviewItem,
  githubPrUrl,
  parseRepoPrFromCoalesceKey,
  prReviewAgentName,
  prReviewSimDelayMs,
  repoPrFromAttention,
} from "../src/lib/pr-review-worker";
import {
  isReviewAskNeedsYou,
  reviewAskAttentionId,
  reviewAskCoalesceKey,
  type ReviewAskAttentionLike,
} from "../src/lib/coalesce-review-ask";
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

const repo = "RichardHorvath11/battle-buddy.git";
const pr = 32;
const key = reviewAskCoalesceKey(repo, pr);
assert(key === "richardhorvath11/battle-buddy#32", "coalesce key");
assert(
  autoReviewIdempotencyKey(key) ===
    "auto-review:richardhorvath11/battle-buddy#32",
  "idempotency key"
);
assert(
  autoReviewKeyFromRepoPr(repo, pr) ===
    "auto-review:richardhorvath11/battle-buddy#32",
  "key from repo/pr"
);
assert(NEEDS_YOU_EXTERNAL_CAP === 5, "cap unchanged at 5");

const parsed = parseRepoPrFromCoalesceKey(key);
assert(parsed?.repo === "richardhorvath11/battle-buddy" && parsed?.pr === 32, "parse key");

const name = prReviewAgentName(repo, pr);
assert(
  name === "Independent review · richardhorvath11/battle-buddy#32",
  "agent name"
);

const url = githubPrUrl(repo, pr);
assert(
  url === "https://github.com/richardhorvath11/battle-buddy/pull/32",
  "github pr url"
);

const delay = prReviewSimDelayMs();
assert(delay >= 3000 && delay <= 8000, `delay in 3–8s (got ${delay})`);

const agent = buildPrReviewAgent({
  id: "agent-test",
  repo,
  pr,
  workstreamId: "ws-cred",
  source: "auto",
});
assert(agent.status === "Running", "agent Running");
assert(agent.name === name, "agent name bound");
assert(agent.detail.includes("Auto-kick"), "auto detail");

const slackProv = {
  kind: "slack" as const,
  title: "#control-e2e",
  locator: "C0BVCSA4T2P · 1.1",
  excerpt: "please review",
  sourceId: "slack-att",
  url: "https://example.slack.com/archives/C0BVCSA4T2P/p1",
};

const item = buildPrReviewItem({
  id: "rev-test",
  findingId: "f-test",
  repo,
  pr,
  workstreamId: "ws-cred",
  agentId: agent.id,
  attentionProvenance: [slackProv],
});
assert(item.kind === "pr_review", "kind pr_review");
assert(item.label === "Analysis, not truth", "label");
assert(item.title === name, "review title");
assert(item.findings.length >= 1, "≥1 finding");
assert(
  item.findings[0].evidence.some((e) => e.url === url),
  "finding cites real PR URL"
);
assert(
  item.findings[0].evidence.some((e) => e.kind === "slack"),
  "optional Slack provenance"
);
assert(
  /Absence of findings is not approval/i.test(item.scopeFooter),
  "scopeFooter disclaimer"
);

const att: ReviewAskAttentionLike = {
  id: reviewAskAttentionId(repo, pr),
  routing: "now",
  title: `Review ask · ${key}`,
  why: "Slack PR link",
  suggestedAction: "open",
  provenance: [
    {
      kind: "github",
      title: key,
      locator: key,
      excerpt: "review asked",
      sourceId: "gh",
      url,
    },
    slackProv,
  ],
  createdAt: "2026-09-08T12:00:00.000Z",
  origin: "external",
  coalesceKey: key,
};
assert(isReviewAskNeedsYou(att), "isReviewAskNeedsYou");
const fromAtt = repoPrFromAttention(att as never);
assert(
  fromAtt?.repo === "richardhorvath11/battle-buddy" && fromAtt?.pr === 32,
  "repoPrFromAttention"
);

// Idempotency set simulation
const kicked: string[] = [];
const idem = autoReviewKeyFromRepoPr(repo, pr);
function tryKick() {
  if (kicked.includes(idem)) return false;
  kicked.push(idem);
  return true;
}
assert(tryKick() === true, "first kick");
assert(tryKick() === false, "second kick blocked");
assert(kicked.length === 1, "one key persisted");

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll auto-kick smoke checks passed.");
