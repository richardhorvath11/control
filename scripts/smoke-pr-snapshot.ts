/**
 * V0.7 chip 4 smoke: PR snapshot paths, prefer-fill, client title parse.
 * Cap NEEDS_YOU_EXTERNAL_CAP=5 unchanged. No network / no gh required.
 */
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import { NEEDS_YOU_EXTERNAL_CAP } from "../src/lib/github-constants";
import {
  PR_SNAPSHOTS_DIR,
  isPrSnapshot,
  preferSnapshotPath,
  prSnapshotAbsPath,
  prSnapshotFileName,
  prSnapshotRelPath,
  readPrSnapshot,
} from "../src/lib/pr-snapshot";
import { repoPrFromReviewTitle } from "../src/lib/pr-snapshot-client";
import {
  REVIEW_RESULT_SCHEMA,
  buildReviewItemFromResult,
} from "../src/lib/review-contracts";

assert.equal(NEEDS_YOU_EXTERNAL_CAP, 5, "cap unchanged at 5");

assert.equal(
  prSnapshotFileName("RichardHorvath11/battle-buddy", 32),
  "richardhorvath11-battle-buddy-32.json"
);
assert.equal(
  prSnapshotRelPath("richardhorvath11/battle-buddy", 32),
  ".control/pr-snapshots/richardhorvath11-battle-buddy-32.json"
);

const parsed = repoPrFromReviewTitle(
  "Independent review · richardhorvath11/battle-buddy#32"
);
assert.ok(parsed);
assert.equal(parsed!.repo, "richardhorvath11/battle-buddy");
assert.equal(parsed!.pr, 32);

const fixture = {
  repo: "richardhorvath11/battle-buddy",
  pr: 32,
  title: "Fix staging cred rotation retries",
  url: "https://github.com/richardhorvath11/battle-buddy/pull/32",
  head_sha: "abcdef0123456789",
  ci: {
    conclusion: "SUCCESS",
    url: "https://github.com/richardhorvath11/battle-buddy/pull/32/checks",
  },
  files: [
    { path: "packages/creds/src/retry.ts", status: "modified" },
    { path: "README.md", status: "added" },
  ],
  requested_reviewers: { users: [] as string[], teams: [] as string[] },
  updated_at: "2026-09-09T12:00:00.000Z",
};
assert.ok(isPrSnapshot(fixture));

async function main() {
  await fs.mkdir(PR_SNAPSHOTS_DIR, { recursive: true });
  const abs = prSnapshotAbsPath(fixture.repo, fixture.pr);
  const prev = await fs.readFile(abs, "utf8").catch(() => null);
  await fs.writeFile(abs, JSON.stringify(fixture, null, 2) + "\n", "utf8");

  try {
    const loaded = await readPrSnapshot(fixture.repo, fixture.pr);
    assert.ok(loaded);
    assert.equal(loaded!.title, fixture.title);
    assert.equal(loaded!.files.length, 2);
    assert.equal(loaded!.ci.conclusion, "SUCCESS");

    const preferred = await preferSnapshotPath(fixture.repo, fixture.pr);
    assert.equal(
      preferred,
      ".control/pr-snapshots/richardhorvath11-battle-buddy-32.json"
    );

    const item = buildReviewItemFromResult({
      id: "rev-smoke",
      repo: fixture.repo,
      pr: fixture.pr,
      agentId: "agent-smoke",
      result: {
        schema: REVIEW_RESULT_SCHEMA,
        job_id: "rj-smoke",
        status: "ok",
        summary: "Smoke analysis",
        findings: [
          {
            title: "Check retries",
            body: "Analysis claim",
            evidence: [
              {
                kind: "github",
                title: "PR",
                locator: "richardhorvath11/battle-buddy#32",
                excerpt: "e",
                sourceId: "s",
                url: fixture.url,
              },
            ],
          },
        ],
      },
    });
    assert.equal(item.kind, "pr_review");
    assert.equal(item.repo, "richardhorvath11/battle-buddy");
    assert.equal(item.pr, 32);
    assert.equal(item.prUrl, fixture.url);
    assert.equal(item.label, "Analysis, not truth");
    assert.match(item.prUrl!, /^https:\/\/github\.com\//);

    const missing = await readPrSnapshot("nobody/none", 999999);
    assert.equal(missing, null);
    const noPref = await preferSnapshotPath("nobody/none", 999999);
    assert.equal(noPref, undefined);

    console.log("smoke-pr-snapshot: ok");
  } finally {
    if (prev != null) {
      await fs.writeFile(abs, prev, "utf8");
    } else {
      await fs.unlink(abs).catch(() => undefined);
    }
  }
}

void main();
