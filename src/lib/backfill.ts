/**
 * First-launch backfill: a READ-ONLY scan of existing pending work (Slack history, GitHub PRs/issues,
 * recent Claude Code sessions), grouped by `claude -p` into CANDIDATE workstreams the user reviews.
 * Nothing becomes a workstream until the user accepts it. Server state under .control/backfill/:
 *   scan.json       – current/last scan + per-source progress (the worker reports over HTTP)
 *   candidates.json – the last scan's validated candidates (+ the raw items they cite)
 *   decisions.json  – accept / reject / merge decisions; persist across re-scans unless newer activity
 * The backfill never posts, sends, reacts or drafts anywhere.
 */
import { promises as fs } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { CONTROL_DIR } from "./github-inbox";

export const BACKFILL_DIR = path.join(CONTROL_DIR, "backfill");
const SCAN_PATH = path.join(BACKFILL_DIR, "scan.json");
const CANDIDATES_PATH = path.join(BACKFILL_DIR, "candidates.json");
const DECISIONS_PATH = path.join(BACKFILL_DIR, "decisions.json");

export const DEFAULT_LOOKBACK_DAYS = 30;
export const MAX_LOOKBACK_DAYS = 180;
export const HIGH_CONFIDENCE = 0.8;
export const STALE_RUNNING_MS = 45 * 60_000;
export const BACKFILL_SOURCES = ["github", "slack", "sessions", "grouping"] as const;
export type BackfillSource = (typeof BACKFILL_SOURCES)[number];
export type SourceStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface SourceProgress {
  status: SourceStatus;
  done?: number;
  total?: number;
  items?: number;
  note?: string;
  updated_at?: string;
}

export interface ScanState {
  scan_id: string | null;
  status: "idle" | "requested" | "running" | "done" | "failed";
  lookback_days: number;
  trigger?: "first_live" | "settings" | "cmdk" | "manual";
  requested_at?: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress: Record<BackfillSource, SourceProgress>;
  counts?: { raw: number; candidates: number; hidden_by_decisions: number; dropped_invalid: number };
}

export interface RawItem {
  id: string; // stable: slack:<ch>:<ts> · gh:pr:<repo>#<n> · gh:issue:<repo>#<n> · session:<id>
  source: "slack" | "github" | "session";
  url?: string; // real permalink (validated); sessions have none
  label: string; // short human label, e.g. "#eng · Priya" / "PR #12"
  at: string; // last activity ISO
  text?: string;
  /** Slack: the channel is one the user explicitly configured (name-based QA/test filter not applied). */
  configured_surface?: boolean;
}

export interface CandidateSource {
  id: string;
  source: RawItem["source"];
  label: string;
  url?: string;
  at: string;
}

export interface Candidate {
  key: string; // bf_<hash of sorted source ids>
  title: string;
  why: string;
  next_step: string;
  confidence: number; // 0..1
  kind: string;
  sources: CandidateSource[];
  last_activity_at: string;
  /** Built by the user merging two candidates; carried across re-scans until decided. */
  merged?: boolean;
}

export interface Decision {
  decision: "accepted" | "rejected" | "merged";
  source_ids: string[];
  last_activity_at: string;
  at: string;
  title?: string;
  workstream_id?: string;
  merged_into?: string;
}

type CandidateDoc = { scan_id: string | null; candidates: Candidate[]; raw: RawItem[] };

function emptyProgress(): ScanState["progress"] {
  return { github: { status: "pending" }, slack: { status: "pending" }, sessions: { status: "pending" }, grouping: { status: "pending" } };
}
export function emptyScan(): ScanState {
  return { scan_id: null, status: "idle", lookback_days: DEFAULT_LOOKBACK_DAYS, progress: emptyProgress() };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
async function writeJson(file: string, v: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(v, null, 2), "utf8");
  await fs.rename(tmp, file);
}
let lock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn);
  lock = run.catch(() => undefined);
  return run;
}

export const readScan = () => readJson<ScanState>(SCAN_PATH, emptyScan());
export const readCandidateDoc = () => readJson<CandidateDoc>(CANDIDATES_PATH, { scan_id: null, candidates: [], raw: [] });
export const readDecisions = () => readJson<Record<string, Decision>>(DECISIONS_PATH, {});

// ---------- validation helpers (pure; shared with smokes) ----------
const SLACK_PERMALINK_RE = /^https:\/\/([a-z0-9-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})(\?.*)?$/;
const GH_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)$/;
const FIXTURE_CHANNEL_RE = /(^|[-_#\s])(qa|test|tests|testing|e2e|fixture|fixtures|sandbox)([-_\s]|$)/i;

/** Fixture/test noise: example.slack.com permalinks, QA/test/e2e channels, explicit fixture text. */
export function isFixtureItem(it: Pick<RawItem, "url" | "label" | "text" | "configured_surface">): boolean {
  if (it.url && /\/\/([a-z0-9-]+\.)?example\.(slack\.)?com\//i.test(it.url)) return true;
  const ch = (it.label || "").split("·")[0].trim();
  if (!it.configured_surface && FIXTURE_CHANNEL_RE.test(ch)) return true;
  if (/\b(fixture|smoke[- ]test|\[test\])\b/i.test(it.text || "")) return true;
  return false;
}

/** Real permalinks only: Slack archives links whose channel + ts match the item id; GitHub PR/issue URLs. */
export function validRawItem(it: RawItem): boolean {
  if (!it || typeof it.id !== "string" || !it.id || typeof it.label !== "string") return false;
  if (!Number.isFinite(Date.parse(it.at))) return false;
  if (it.source === "slack") {
    const m = /^slack:([A-Z0-9]+):(\d+\.\d+)$/.exec(it.id);
    const u = SLACK_PERMALINK_RE.exec(it.url || "");
    return !!m && !!u && u[2] === m[1] && u[3] === m[2].replace(".", "").padEnd(16, "0").slice(0, 16);
  }
  if (it.source === "github") {
    const m = /^gh:(pr|issue):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(it.id);
    const u = GH_URL_RE.exec(it.url || "");
    return !!m && !!u && u[1] === m[2] && u[3] === m[3] && (m[1] === "pr") === (u[2] === "pull");
  }
  if (it.source === "session") return /^session:[A-Za-z0-9_-]{1,100}$/.test(it.id) && !it.url;
  return false;
}

export function candidateKey(sourceIds: string[]): string {
  return "bf_" + createHash("sha1").update([...new Set(sourceIds)].sort().join("\n")).digest("hex").slice(0, 16);
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/**
 * Validate the grouper's output against the raw items it was given. Fail closed: a candidate must cite
 * at least one known raw item; links and timestamps come from the raw items, never from the model.
 */
export function validateCandidates(rawIn: unknown[], candIn: unknown[]): { raw: RawItem[]; candidates: Candidate[]; dropped: number } {
  const raw = (Array.isArray(rawIn) ? rawIn : []).filter((r): r is RawItem => validRawItem(r as RawItem) && !isFixtureItem(r as RawItem));
  const byId = new Map(raw.map((r) => [r.id, r]));
  let dropped = 0;
  const out = new Map<string, Candidate>();
  for (const c0 of Array.isArray(candIn) ? candIn : []) {
    const c = c0 as Record<string, unknown>;
    const ids = Array.isArray(c?.source_ids) ? [...new Set((c.source_ids as unknown[]).filter((x): x is string => typeof x === "string"))] : [];
    const srcs = ids.map((id) => byId.get(id)).filter((x): x is RawItem => !!x);
    const title = clip(c?.title, 140);
    const conf = typeof c?.confidence === "number" && Number.isFinite(c.confidence) ? Math.max(0, Math.min(1, c.confidence)) : NaN;
    if (!srcs.length || srcs.length !== ids.length || !title || !Number.isFinite(conf)) { dropped++; continue; }
    const sources = srcs.map((s) => ({ id: s.id, source: s.source, label: s.label, url: s.url, at: s.at }));
    const last = sources.map((s) => s.at).sort().at(-1)!;
    const key = candidateKey(sources.map((s) => s.id));
    if (out.has(key)) { dropped++; continue; }
    out.set(key, { key, title, why: clip(c.why, 240), next_step: clip(c.next_step, 200), confidence: Math.round(conf * 100) / 100, kind: clip(c.kind, 40) || "pending", sources, last_activity_at: last });
  }
  return { raw, candidates: [...out.values()].sort((a, b) => b.confidence - a.confidence || b.last_activity_at.localeCompare(a.last_activity_at)), dropped };
}

/** Hidden by an earlier decision unless something in it is newer than what the user decided on. */
export function hiddenByDecision(c: Candidate, decisions: Record<string, Decision>): boolean {
  const ds = Object.values(decisions).filter((d) => d.decision !== "merged");
  const covered = c.sources.every((s) => ds.some((d) => d.source_ids.includes(s.id) && Date.parse(s.at) <= Date.parse(d.last_activity_at)));
  return covered;
}

export function confidenceBucket(c: number): "high" | "medium" | "low" {
  return c >= HIGH_CONFIDENCE ? "high" : c >= 0.5 ? "medium" : "low";
}

// ---------- scan lifecycle ----------
export function requestScan(opts: { lookback_days?: number; trigger?: ScanState["trigger"] }) {
  return locked(async () => {
    const cur = await readScan();
    const busy = (cur.status === "requested" || cur.status === "running") && Date.now() - Date.parse(cur.requested_at || "") < STALE_RUNNING_MS;
    if (busy) return { ok: false as const, status: 409, error: "a scan is already in progress", scan: cur };
    const days = Math.round(Number(opts.lookback_days ?? DEFAULT_LOOKBACK_DAYS));
    if (!Number.isFinite(days) || days < 1 || days > MAX_LOOKBACK_DAYS) return { ok: false as const, status: 400, error: `lookback_days must be 1–${MAX_LOOKBACK_DAYS}`, scan: cur };
    const scan: ScanState = { scan_id: `bfs_${randomBytes(5).toString("hex")}`, status: "requested", lookback_days: days, trigger: opts.trigger ?? "manual", requested_at: new Date().toISOString(), progress: emptyProgress() };
    await writeJson(SCAN_PATH, scan);
    return { ok: true as const, scan };
  });
}

export function claimScan() {
  return locked(async () => {
    const cur = await readScan();
    if (cur.status !== "requested") return null;
    const scan: ScanState = { ...cur, status: "running", started_at: new Date().toISOString() };
    await writeJson(SCAN_PATH, scan);
    return scan;
  });
}

export function reportProgress(scanId: string, source: BackfillSource, p: SourceProgress) {
  return locked(async () => {
    const cur = await readScan();
    if (cur.scan_id !== scanId || cur.status !== "running") return null;
    cur.progress[source] = {
      status: p.status,
      ...(Number.isFinite(p.done) ? { done: p.done } : {}),
      ...(Number.isFinite(p.total) ? { total: p.total } : {}),
      ...(Number.isFinite(p.items) ? { items: p.items } : {}),
      ...(p.note ? { note: clip(p.note, 300) } : {}),
      updated_at: new Date().toISOString(),
    };
    await writeJson(SCAN_PATH, cur);
    return cur;
  });
}

export function finishScan(scanId: string, body: { status: "done" | "failed"; raw?: unknown[]; candidates?: unknown[]; error?: string }) {
  return locked(async () => {
    const cur = await readScan();
    if (cur.scan_id !== scanId || cur.status !== "running") return { ok: false as const, status: 409, error: "no such running scan" };
    cur.finished_at = new Date().toISOString();
    if (body.status === "failed") {
      cur.status = "failed";
      cur.error = clip(body.error, 500) || "scan failed";
      await writeJson(SCAN_PATH, cur);
      return { ok: true as const, scan: cur }; // keep the previous candidates; invent nothing
    }
    const v = validateCandidates(body.raw ?? [], body.candidates ?? []);
    const decisions = await readDecisions();
    // Keep the user's pending merges; a fresh candidate fully inside one is a duplicate of it.
    const prev = await readCandidateDoc();
    const merges = prev.candidates.filter((c) => c.merged && !decisions[c.key]);
    const inMerge = (c: Candidate) => merges.some((m) => c.sources.every((s) => m.sources.some((x) => x.id === s.id)));
    const visible = [...merges, ...v.candidates.filter((c) => !hiddenByDecision(c, decisions) && !inMerge(c) && !merges.some((m) => m.key === c.key))];
    await writeJson(CANDIDATES_PATH, { scan_id: scanId, candidates: visible, raw: v.raw } satisfies CandidateDoc);
    cur.status = "done";
    cur.counts = { raw: v.raw.length, candidates: visible.length, hidden_by_decisions: v.candidates.length - visible.length, dropped_invalid: v.dropped };
    await writeJson(SCAN_PATH, cur);
    return { ok: true as const, scan: cur };
  });
}

// ---------- decisions (user only) ----------
function decisionFor(c: Candidate, decision: Decision["decision"], extra: Partial<Decision> = {}): Decision {
  return { decision, source_ids: c.sources.map((s) => s.id), last_activity_at: c.last_activity_at, at: new Date().toISOString(), title: c.title, ...extra };
}

export type DecideAction =
  | { action: "reject"; key: string }
  | { action: "rename"; key: string; title: string }
  | { action: "merge"; keys: [string, string]; title?: string }
  | { action: "accept"; key: string; title?: string }
  | { action: "accept_high" };

/**
 * Apply a review decision. `accept` calls `createWorkstream` (injected; creates a manual workstream so it is
 * on /now and Resume-eligible). Returns the updated pending candidates.
 */
export function decide(a: DecideAction, createWorkstream: (c: Candidate) => Promise<{ id: string }>) {
  return locked(async () => {
    const doc = await readCandidateDoc();
    const decisions = await readDecisions();
    const find = (k: string) => doc.candidates.find((c) => c.key === k);
    const accepted: { key: string; workstream_id: string }[] = [];
    const acceptOne = async (c: Candidate) => {
      const ws = await createWorkstream(c);
      decisions[c.key] = decisionFor(c, "accepted", { workstream_id: ws.id });
      doc.candidates = doc.candidates.filter((x) => x.key !== c.key);
      accepted.push({ key: c.key, workstream_id: ws.id });
    };
    if (a.action === "accept_high") {
      for (const c of doc.candidates.filter((x) => x.confidence >= HIGH_CONFIDENCE)) await acceptOne(c);
    } else if (a.action === "merge") {
      const [x, y] = a.keys.map(find);
      if (!x || !y || x.key === y.key) return { ok: false as const, status: 404, error: "pick two different pending candidates" };
      const sources = [...new Map([...x.sources, ...y.sources].map((s) => [s.id, s])).values()];
      const merged: Candidate = {
        key: candidateKey(sources.map((s) => s.id)),
        title: clip(a.title, 140) || x.title,
        why: [x.why, y.why].filter(Boolean).join(" · ").slice(0, 240),
        next_step: x.next_step || y.next_step,
        confidence: Math.max(x.confidence, y.confidence),
        kind: x.kind,
        sources,
        last_activity_at: [x.last_activity_at, y.last_activity_at].sort().at(-1)!,
        merged: true,
      };
      decisions[x.key] = decisionFor(x, "merged", { merged_into: merged.key });
      decisions[y.key] = decisionFor(y, "merged", { merged_into: merged.key });
      doc.candidates = [merged, ...doc.candidates.filter((c) => c.key !== x.key && c.key !== y.key)];
    } else {
      const c = find(a.key);
      if (!c) return { ok: false as const, status: 404, error: "no such pending candidate" };
      if (a.action === "reject") {
        decisions[c.key] = decisionFor(c, "rejected");
        doc.candidates = doc.candidates.filter((x) => x.key !== c.key);
      } else if (a.action === "rename") {
        const t = clip(a.title, 140);
        if (!t) return { ok: false as const, status: 400, error: "title required" };
        c.title = t;
      } else if (a.action === "accept") {
        if (a.title && clip(a.title, 140)) c.title = clip(a.title, 140);
        await acceptOne(c);
      }
    }
    await writeJson(DECISIONS_PATH, decisions);
    await writeJson(CANDIDATES_PATH, doc);
    return { ok: true as const, candidates: doc.candidates, accepted };
  });
}

export async function backfillSummary() {
  const [scan, doc, decisions] = await Promise.all([readScan(), readCandidateDoc(), readDecisions()]);
  const vals = Object.values(decisions);
  return {
    scan,
    candidates: doc.candidates,
    decided: { accepted: vals.filter((d) => d.decision === "accepted").length, rejected: vals.filter((d) => d.decision === "rejected").length },
    ever_scanned: !!scan.scan_id,
  };
}
