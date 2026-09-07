import { promises as fs } from "fs";
import path from "path";
import { SLACK_E2E } from "./slack-e2e";
import type { Provenance } from "./types";

export const OUTBOX_DIR = path.join(process.cwd(), ".control", "outbox");

export type OutboxStatus = "pending" | "posted" | "failed";

export interface SlackOutboxItem {
  id: string;
  status: OutboxStatus;
  channel_id: string;
  thread_ts: string;
  text: string;
  created_at: string;
  review_item_id: string;
  provenance?: Provenance[] | Record<string, unknown> | null;
  reply_ts?: string;
  permalink?: string;
  error?: string;
  updated_at?: string;
}

export function resolveChannelId(override?: string | null) {
  return (
    (typeof override === "string" && override.trim()) ||
    process.env.SLACK_E2E_CHANNEL_ID?.trim() ||
    SLACK_E2E.channelId
  );
}

export function resolveThreadTs(override?: string | null) {
  return (
    (typeof override === "string" && override.trim()) ||
    process.env.SLACK_E2E_THREAD_TS?.trim() ||
    SLACK_E2E.threadTs
  );
}

function filePath(id: string) {
  // Prevent path traversal — ids are generated as outbox-<hex>
  if (!/^outbox-[a-z0-9]+$/i.test(id)) {
    throw new Error(`Invalid outbox id: ${id}`);
  }
  return path.join(OUTBOX_DIR, `${id}.json`);
}

export async function ensureOutboxDir() {
  await fs.mkdir(OUTBOX_DIR, { recursive: true });
}

export function newOutboxId() {
  return `outbox-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function writeOutboxItem(item: SlackOutboxItem) {
  await ensureOutboxDir();
  const fp = filePath(item.id);
  const tmp = `${fp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(item, null, 2), "utf8");
  await fs.rename(tmp, fp);
  return item;
}

export async function readOutboxItem(
  id: string
): Promise<SlackOutboxItem | null> {
  try {
    const raw = await fs.readFile(filePath(id), "utf8");
    return JSON.parse(raw) as SlackOutboxItem;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function listOutboxItems(
  status?: OutboxStatus | "all"
): Promise<SlackOutboxItem[]> {
  await ensureOutboxDir();
  let names: string[];
  try {
    names = await fs.readdir(OUTBOX_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const items: SlackOutboxItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(OUTBOX_DIR, name), "utf8");
      const item = JSON.parse(raw) as SlackOutboxItem;
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

export async function updateOutboxItem(
  id: string,
  patch: Partial<SlackOutboxItem>
): Promise<SlackOutboxItem | null> {
  const existing = await readOutboxItem(id);
  if (!existing) return null;
  const next: SlackOutboxItem = {
    ...existing,
    ...patch,
    id: existing.id,
    updated_at: new Date().toISOString(),
  };
  await writeOutboxItem(next);
  return next;
}
