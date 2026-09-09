import { promises as fs } from "fs";
import path from "path";

/** Durable GitHub comment outbox (chip 5). Separate from Slack `.control/outbox`. */
export const GITHUB_OUTBOX_DIR = path.join(
  process.cwd(),
  ".control",
  "github-outbox"
);

export type GithubOutboxStatus = "pending" | "posted" | "failed";

export interface GithubOutboxItem {
  id: string;
  status: GithubOutboxStatus;
  repo: string;
  pr: number;
  /** Exact markdown body that will be / was posted. */
  body: string;
  review_item_id: string;
  created_at: string;
  /** Present after successful ack. */
  comment_url?: string;
  comment_id?: number;
  error?: string;
  updated_at?: string;
}

function filePath(id: string) {
  // Prevent path traversal — ids are generated as gh-outbox-<hex>
  if (!/^gh-outbox-[a-z0-9]+$/i.test(id)) {
    throw new Error(`Invalid github outbox id: ${id}`);
  }
  return path.join(GITHUB_OUTBOX_DIR, `${id}.json`);
}

export async function ensureGithubOutboxDir() {
  await fs.mkdir(GITHUB_OUTBOX_DIR, { recursive: true });
}

export function newGithubOutboxId() {
  return `gh-outbox-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function writeGithubOutboxItem(item: GithubOutboxItem) {
  await ensureGithubOutboxDir();
  const fp = filePath(item.id);
  const tmp = `${fp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(item, null, 2), "utf8");
  await fs.rename(tmp, fp);
  return item;
}

export async function readGithubOutboxItem(
  id: string
): Promise<GithubOutboxItem | null> {
  try {
    const raw = await fs.readFile(filePath(id), "utf8");
    return JSON.parse(raw) as GithubOutboxItem;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function listGithubOutboxItems(
  status?: GithubOutboxStatus | "all"
): Promise<GithubOutboxItem[]> {
  await ensureGithubOutboxDir();
  let names: string[];
  try {
    names = await fs.readdir(GITHUB_OUTBOX_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const items: GithubOutboxItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(
        path.join(GITHUB_OUTBOX_DIR, name),
        "utf8"
      );
      const item = JSON.parse(raw) as GithubOutboxItem;
      if (!status || status === "all" || item.status === status) {
        items.push(item);
      }
    } catch {
      // skip corrupt files
    }
  }

  items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return items;
}

export async function updateGithubOutboxItem(
  id: string,
  patch: Partial<GithubOutboxItem>
): Promise<GithubOutboxItem | null> {
  const existing = await readGithubOutboxItem(id);
  if (!existing) return null;
  const next: GithubOutboxItem = {
    ...existing,
    ...patch,
    id: existing.id,
    updated_at: new Date().toISOString(),
  };
  await writeGithubOutboxItem(next);
  return next;
}

/** Normalize owner/name; empty → null. */
export function normalizeOutboxRepo(repo?: string | null): string | null {
  if (typeof repo !== "string") return null;
  const t = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t)) return null;
  return t;
}
