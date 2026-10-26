/**
 * Manual workstreams — things the user is working on that Control can't see (no PR/Slack/Claude session).
 * Storage: .control/workstreams.json  ({ schema, items: ManualWorkstream[] }), atomic writes, in-process lock.
 *
 * Deliberately inert: this module only reads/writes that one file. It never creates review jobs, Slack or
 * GitHub drafts, outbox items, or anything a worker would pick up (smoke-manual-workstreams asserts this).
 */
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { CONTROL_DIR } from "./github-inbox";

export const MANUAL_WORKSTREAMS_PATH = path.join(CONTROL_DIR, "workstreams.json");
export const MANUAL_SCHEMA = "control.manual_workstreams.v1";
export const MANUAL_ID_RE = /^mw_[a-z0-9]{6,32}$/;
const MAX_ITEMS = 500;

export interface ManualWorkstream {
  id: string;
  title: string;
  note?: string;
  link?: string; // repo / PR / any URL
  people?: string[];
  when?: string; // free text: "Fri", "after standup", "by 10/30"
  repo?: string; // owner/name (e.g. inferred from cwd by /control-add)
  branch?: string;
  cwd?: string; // absolute path the item was added from
  source: "cmdk" | "api" | "skill";
  status: "open" | "done";
  created_at: string;
  updated_at: string;
  done_at?: string;
}

type Store = { schema: string; items: ManualWorkstream[] };

const LIMITS = { title: 200, note: 4000, link: 1000, person: 80, people: 20, when: 120, repo: 200, branch: 200, cwd: 1000 };

function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function cleanPeople(v: unknown): string[] | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!arr) return null;
  const out = arr
    .map((p) => (typeof p === "string" ? p.trim().slice(0, LIMITS.person) : ""))
    .filter(Boolean)
    .slice(0, LIMITS.people);
  return out.length ? out : undefined;
}

export type ManualFields = Partial<Pick<ManualWorkstream, "title" | "note" | "link" | "people" | "when" | "repo" | "branch" | "cwd">>;

/**
 * Validate a create (requireTitle) or patch body. Unknown keys are ignored. For patches, a key present with
 * "" / null clears that optional field. Returns the normalized fields plus the list of keys to clear.
 */
export function validateManualInput(raw: unknown, opts: { requireTitle: boolean }):
  | { ok: true; fields: ManualFields; clear: (keyof ManualFields)[]; status?: "open" | "done"; source?: ManualWorkstream["source"] }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "JSON object required" };
  const o = raw as Record<string, unknown>;
  const fields: ManualFields = {};
  const clear: (keyof ManualFields)[] = [];
  const title = cleanStr(o.title, LIMITS.title);
  if (opts.requireTitle && !title) return { ok: false, error: "title required" };
  if ("title" in o && !title) return { ok: false, error: "title cannot be empty" };
  if (title) fields.title = title;
  for (const k of ["note", "link", "when", "repo", "branch", "cwd"] as const) {
    if (!(k in o)) continue;
    if (o[k] === null || o[k] === "") {
      clear.push(k);
      continue;
    }
    if (typeof o[k] !== "string") return { ok: false, error: `${k} must be a string` };
    const v = cleanStr(o[k], LIMITS[k]);
    if (v) fields[k] = v;
    else clear.push(k);
  }
  if (fields.link && !/^https?:\/\/\S+$/i.test(fields.link)) return { ok: false, error: "link must be an http(s) URL" };
  if (fields.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fields.repo)) return { ok: false, error: "repo must be owner/name" };
  if (fields.cwd && !path.isAbsolute(fields.cwd)) return { ok: false, error: "cwd must be an absolute path" };
  if ("people" in o) {
    const p = cleanPeople(o.people);
    if (p === null) return { ok: false, error: "people must be a list of names or a comma-separated string" };
    if (p) fields.people = p;
    else clear.push("people");
  }
  let status: "open" | "done" | undefined;
  if ("status" in o) {
    if (o.status !== "open" && o.status !== "done") return { ok: false, error: "status must be open or done" };
    status = o.status;
  }
  let source: ManualWorkstream["source"] | undefined;
  if (o.source === "cmdk" || o.source === "skill" || o.source === "api") source = o.source;
  return { ok: true, fields, clear, status, source };
}

async function readStore(): Promise<Store> {
  try {
    const raw = JSON.parse(await fs.readFile(MANUAL_WORKSTREAMS_PATH, "utf8"));
    if (raw && Array.isArray(raw.items)) return { schema: MANUAL_SCHEMA, items: raw.items.filter((i: ManualWorkstream) => i && MANUAL_ID_RE.test(i.id)) };
  } catch {
    /* missing or unreadable → empty */
  }
  return { schema: MANUAL_SCHEMA, items: [] };
}

async function writeStore(s: Store) {
  await fs.mkdir(path.dirname(MANUAL_WORKSTREAMS_PATH), { recursive: true });
  const tmp = `${MANUAL_WORKSTREAMS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, MANUAL_WORKSTREAMS_PATH);
}

let lock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = lock.then(fn, fn);
  lock = p.catch(() => undefined);
  return p;
}

export async function listManualWorkstreams(opts: { includeDone?: boolean } = {}): Promise<ManualWorkstream[]> {
  const { items } = await readStore();
  return items
    .filter((i) => opts.includeDone || i.status !== "done")
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export async function getManualWorkstream(id: string): Promise<ManualWorkstream | null> {
  if (!MANUAL_ID_RE.test(id)) return null;
  return (await readStore()).items.find((i) => i.id === id) ?? null;
}

export function createManualWorkstream(fields: ManualFields & { title: string }, source: ManualWorkstream["source"] = "api", now = new Date()) {
  return locked(async () => {
    const s = await readStore();
    if (s.items.length >= MAX_ITEMS) throw Object.assign(new Error(`too many workstreams (max ${MAX_ITEMS}); delete some`), { status: 409 });
    const at = now.toISOString();
    const item: ManualWorkstream = { id: `mw_${randomBytes(6).toString("hex")}`, ...fields, source, status: "open", created_at: at, updated_at: at };
    s.items.push(item);
    await writeStore(s);
    return item;
  });
}

export function updateManualWorkstream(
  id: string,
  patch: { fields: ManualFields; clear: (keyof ManualFields)[]; status?: "open" | "done" },
  now = new Date(),
) {
  return locked(async () => {
    const s = await readStore();
    const i = s.items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const cur: ManualWorkstream = { ...s.items[i], ...patch.fields };
    for (const k of patch.clear) delete cur[k];
    if (patch.status && patch.status !== cur.status) {
      cur.status = patch.status;
      if (patch.status === "done") cur.done_at = now.toISOString();
      else delete cur.done_at;
    }
    cur.updated_at = now.toISOString();
    s.items[i] = cur;
    await writeStore(s);
    return cur;
  });
}

export function deleteManualWorkstream(id: string) {
  return locked(async () => {
    const s = await readStore();
    const before = s.items.length;
    s.items = s.items.filter((x) => x.id !== id);
    if (s.items.length === before) return false;
    await writeStore(s);
    return true;
  });
}
