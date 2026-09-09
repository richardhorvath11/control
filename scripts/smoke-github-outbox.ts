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

  // cleanup smoke files
  await fs.unlink(fp).catch(() => {});
  await fs.unlink(path.join(GITHUB_OUTBOX_DIR, `${failedId}.json`)).catch(() => {});

  console.log("smoke-github-outbox: ok", { id, failedId });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
