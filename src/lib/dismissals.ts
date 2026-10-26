/**
 * Dismissed derived workstreams (PR / Slack / Claude session). Server-side, `.control/dismissed-workstreams.json`.
 * A dismissal is keyed by workstream key + the last-activity timestamp at dismiss time:
 * the item stays hidden across watcher ticks and reappears only when it gets NEWER activity.
 */
import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR } from "./github-inbox";

export const DISMISSALS_PATH = path.join(CONTROL_DIR, "dismissed-workstreams.json");
export const DISMISSALS_SCHEMA = "control.dismissed_workstreams.v1";

export interface Dismissal {
  key: string;
  last_activity_at: string;
  dismissed_at: string;
  title?: string;
}
export type DismissalStore = Record<string, Dismissal>;

export async function readDismissals(file = DISMISSALS_PATH): Promise<DismissalStore> {
  try {
    const doc = JSON.parse(await fs.readFile(file, "utf8")) as { items?: DismissalStore };
    return doc && typeof doc.items === "object" && doc.items ? doc.items : {};
  } catch {
    return {};
  }
}

/** Hidden iff dismissed and nothing newer than the activity seen at dismiss time. */
export function isDismissed(store: DismissalStore, key: string, lastActivityAt: string | undefined | null): boolean {
  const d = store[key];
  if (!d) return false;
  const now = Date.parse(lastActivityAt || "");
  const then = Date.parse(d.last_activity_at);
  if (!Number.isFinite(now)) return true;
  return !(Number.isFinite(then) && now > then);
}

let lock: Promise<unknown> = Promise.resolve();
export function addDismissal(d: Omit<Dismissal, "dismissed_at">, now = new Date(), file = DISMISSALS_PATH): Promise<Dismissal> {
  const run = lock.then(async () => {
    const items = await readDismissals(file);
    const rec: Dismissal = { ...d, dismissed_at: now.toISOString() };
    items[d.key] = rec;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ schema: DISMISSALS_SCHEMA, items }, null, 2), "utf8");
    await fs.rename(tmp, file);
    return rec;
  });
  lock = run.catch(() => undefined);
  return run;
}
