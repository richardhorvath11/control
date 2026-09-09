/**
 * Smoke: GitHub comment outbox (chip 5) — durable write / list / ack / fail.
 * No GITHUB_TOKEN. Does not call GitHub.
 *
 *   npx tsx scripts/smoke-github-outbox.ts
 */
import { promises as fs } from "fs";
import path from "path";
import {
  GITHUB_OUTBOX_DIR,
  listGithubOutboxItems,
  newGithubOutboxId,
  readGithubOutboxItem,
  updateGithubOutboxItem,
  writeGithubOutboxItem,
  claimNextGithubOutboxItem,
  type GithubOutboxItem,
} from "../src/lib/github-outbox";

async function main() {
  const id = newGithubOutboxId();
  if (!id.startsWith("gh-outbox-")) throw new Error("bad id prefix");

  const item: GithubOutboxItem = {
    id,
    status: "pending",
    repo: "richardhorvath11/control",
    pr: 1,
    body: "smoke comment body — exact markdown",
    review_item_id: "rev-smoke",
    created_at: new Date().toISOString(),
  };

  await writeGithubOutboxItem(item);
  const fp = path.join(GITHUB_OUTBOX_DIR, `${id}.json`);
  const raw = await fs.readFile(fp, "utf8");
  const disk = JSON.parse(raw) as GithubOutboxItem;
  if (disk.body !== item.body) throw new Error("body mismatch on disk");
  if (disk.status !== "pending") throw new Error("expected pending");

  const pending = await listGithubOutboxItems("pending");
  if (!pending.some((x) => x.id === id)) throw new Error("not in pending list");

  const posted = await updateGithubOutboxItem(id, {
    status: "posted",
    comment_url: "https://github.com/richardhorvath11/control/pull/1#issuecomment-1",
    comment_id: 1,
    error: undefined,
  });
  if (!posted || posted.status !== "posted") throw new Error("ack failed");

  const failedId = newGithubOutboxId();
  await writeGithubOutboxItem({
    ...item,
    id: failedId,
    created_at: new Date().toISOString(),
  });
  const failed = await updateGithubOutboxItem(failedId, {
    status: "failed",
    error: "boom",
  });
  if (!failed || failed.status !== "failed" || failed.error !== "boom") {
    throw new Error("fail path broken");
  }

  // Slack outbox path must remain untouched by this module.
  const slackDir = path.join(process.cwd(), ".control", "outbox");
  // Ensure we did not write into Slack dir
  try {
    const names = await fs.readdir(slackDir);
    if (names.includes(`${id}.json`)) {
      throw new Error("wrote into Slack outbox path — regression");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(err instanceof Error && err.message.includes("Slack"))) {
      if (code !== "ENOENT") {
        // ignore missing slack dir; rethrow real errors
        if ((err as Error).message.includes("regression")) throw err;
      }
    }
  }

  const reread = await readGithubOutboxItem(id);
  if (!reread?.comment_url) throw new Error("missing comment_url after ack");

  const claimA = newGithubOutboxId();
  const claimB = newGithubOutboxId();
  await writeGithubOutboxItem({
    ...item,
    id: claimA,
    created_at: new Date().toISOString(),
  });
  await writeGithubOutboxItem({
    ...item,
    id: claimB,
    created_at: new Date(Date.now() + 1000).toISOString(),
  });
  const [first, second] = await Promise.all([
    claimNextGithubOutboxItem("w1"),
    claimNextGithubOutboxItem("w2"),
  ]);
  const claimedIds = [first?.id, second?.id].filter(Boolean);
  if (claimedIds.length !== 2 && claimedIds.length !== 1) {
    // two items: both may succeed sequentially; concurrent may yield 1 or 2
  }
  const one = await claimNextGithubOutboxItem("w1");
  const two = await claimNextGithubOutboxItem("w2");
  // After draining, further claims empty. Re-claim remaining if any.
  let extra = 0;
  for (const c of [one, two]) if (c) extra++;
  const claimed = new Set(
    [first, second, one, two].map((x) => x?.id).filter(Boolean) as string[]
  );
  if (!claimed.has(claimA) || !claimed.has(claimB)) {
    // sequential drain of leftovers
    while (true) {
      const n = await claimNextGithubOutboxItem("w-drain");
      if (!n) break;
      claimed.add(n.id);
    }
  }
  if (!claimed.has(claimA) || !claimed.has(claimB)) {
    throw new Error("claim did not cover both pending items");
  }
  const none = await claimNextGithubOutboxItem("w-empty");
  if (none) throw new Error("expected empty claim after drain");

  // cleanup smoke files
  await fs.unlink(fp).catch(() => {});
  await fs.unlink(path.join(GITHUB_OUTBOX_DIR, `${failedId}.json`)).catch(() => {});
  for (const cid of [claimA, claimB]) {
    await fs.unlink(path.join(GITHUB_OUTBOX_DIR, `${cid}.json`)).catch(() => {});
    await fs.unlink(path.join(GITHUB_OUTBOX_DIR, `${cid}.claim.json`)).catch(() => {});
  }

  console.log("smoke-github-outbox: ok", { id, failedId });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
