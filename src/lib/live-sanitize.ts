/**
 * Live must show only real data (GitHub, Slack, Claude sessions, manual items).
 * Demo seed rows (seed.json) and anything Demo created must never reach Live surfaces.
 *
 * `stripDemoForLive` is pure and idempotent; the store applies it on every Live load,
 * on Demo→Live, and in the versioned persist migration for old `control-v0` blobs.
 */
import seed from "./seed.json";
import type { AttentionItem, SeedData, Workstream } from "./types";

/** Bump when the persisted control-v0 shape/cleanup changes. v2 = strip seed/demo-origin items in Live. */
export const CONTROL_PERSIST_VERSION = 2;

const s = seed as unknown as SeedData;
export const SEED_WORKSTREAM_IDS = new Set(s.workstreams.map((w) => w.id));
export const SEED_ATTENTION_IDS = new Set(s.attention.map((a) => a.id));
export const SEED_REVIEW_IDS = new Set(s.reviewQueue.map((r) => r.id));
export const SEED_AGENT_IDS = new Set(s.agents.map((a) => a.id));
export const SEED_FYI = new Set(s.fyi);

export const EMPTY_LIVE_DAYSTRIP: SeedData["dayStrip"] = { meetings: [], focusBlock: "" };
export const EMPTY_LIVE_SOURCES = { slack: {}, github: {}, rfc: {}, calendar: {} } as unknown as SeedData["sources"];

/** Real (Live-origin) attention: written by the GitHub/Slack inbox apply, never seed rows. */
export function isLiveAttention(a: Pick<AttentionItem, "id" | "origin">): boolean {
  if (SEED_ATTENTION_IDS.has(a.id)) return false;
  return a.origin === "github" || a.origin === "slack" || a.origin === "external";
}

/**
 * The only Live-origin client-store workstreams are the ephemeral `ws-review-*` rows the Slack
 * inbox apply creates for a linked PR. Everything else in the store is demo-origin: seed rows and
 * the `ws_*` rows Demo's suggested delegations create. (Live's real list is /api/workstreams/live.)
 */
export function isDemoWorkstream(w: Pick<Workstream, "id" | "ephemeral">): boolean {
  if (SEED_WORKSTREAM_IDS.has(w.id)) return true;
  return !(w.ephemeral === true && typeof w.id === "string" && w.id.startsWith("ws-review-"));
}

type Persistable = {
  workstreams?: unknown;
  attention?: unknown;
  fyi?: unknown;
  suggestedDelegations?: unknown;
  usedDelegationIds?: unknown;
  focusWorkstreamId?: unknown;
  selectedReviewId?: unknown;
  sources?: unknown;
  dayStrip?: unknown;
  reviewQueue?: unknown;
  agents?: unknown;
  liveFocus?: unknown;
  [k: string]: unknown;
};

/** Remove every seed / demo-origin item. Unknown keys are kept as-is. */
export function stripDemoForLive<T extends Persistable>(state: T): T {
  const arr = <X,>(v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : []);
  const workstreams = arr<Workstream>(state.workstreams).filter((w) => w && !isDemoWorkstream(w));
  const keepWs = new Set(workstreams.map((w) => w.id));
  const attention = arr<AttentionItem>(state.attention)
    .filter((a) => a && isLiveAttention(a))
    .map((a) => (a.workstreamId && !keepWs.has(a.workstreamId) ? { ...a, workstreamId: undefined } : a));
  const out: Persistable = {
    ...state,
    workstreams,
    attention,
    fyi: arr<string>(state.fyi).filter((f) => !SEED_FYI.has(f)),
    suggestedDelegations: [],
    usedDelegationIds: [],
    focusWorkstreamId:
      typeof state.focusWorkstreamId === "string" && keepWs.has(state.focusWorkstreamId) ? state.focusWorkstreamId : null,
    selectedReviewId:
      typeof state.selectedReviewId === "string" && !SEED_REVIEW_IDS.has(state.selectedReviewId) ? state.selectedReviewId : null,
    sources: EMPTY_LIVE_SOURCES,
  };
  if ("dayStrip" in state) out.dayStrip = EMPTY_LIVE_DAYSTRIP;
  if ("reviewQueue" in state) out.reviewQueue = arr<{ id: string }>(state.reviewQueue).filter((r) => r && !SEED_REVIEW_IDS.has(r.id));
  if ("agents" in state) out.agents = arr<{ id: string }>(state.agents).filter((a) => a && !SEED_AGENT_IDS.has(a.id));
  return out as T;
}

/**
 * Server-side inbox effects written before this fix can still carry a seed workstreamId (old watch.json
 * pointed at ws-cred). After each Live inbox sync, clear those refs and drop any seed workstream again.
 * Returns null when nothing needs changing.
 */
export function scrubSeedRefs<A extends { workstreamId?: string }, W extends { id: string }>(
  attention: A[],
  workstreams: W[]
): { attention: A[]; workstreams: W[] } | null {
  const badA = attention.some((a) => a.workstreamId && SEED_WORKSTREAM_IDS.has(a.workstreamId));
  const badW = workstreams.some((w) => SEED_WORKSTREAM_IDS.has(w.id));
  if (!badA && !badW) return null;
  return {
    attention: attention.map((a) => (a.workstreamId && SEED_WORKSTREAM_IDS.has(a.workstreamId) ? { ...a, workstreamId: undefined } : a)),
    workstreams: workstreams.filter((w) => !SEED_WORKSTREAM_IDS.has(w.id)),
  };
}

/** Count of seed/demo-origin items still present (0 = clean). Used by smokes and the headless proof. */
export function countDemoItems(state: Persistable): number {
  const arr = (v: unknown): { id?: string; origin?: string; ephemeral?: boolean; demo?: boolean }[] => (Array.isArray(v) ? v : []);
  return (
    arr(state.workstreams).filter((w) => isDemoWorkstream(w as never)).length +
    arr(state.attention).filter((a) => !isLiveAttention(a as never)).length +
    arr(state.reviewQueue).filter((r) => SEED_REVIEW_IDS.has(String(r.id))).length +
    arr(state.agents).filter((a) => SEED_AGENT_IDS.has(String(a.id))).length +
    arr(state.suggestedDelegations).length +
    arr(state.fyi).filter((f) => SEED_FYI.has(f as unknown as string)).length
  );
}

/** zustand persist `migrate`: v<2 blobs are stripped when the browser is in Live (control-v0-mode). */
export function migrateControlV0(persisted: unknown, fromVersion: number, mode: "demo" | "live"): unknown {
  if (!persisted || typeof persisted !== "object") return persisted;
  if (fromVersion < CONTROL_PERSIST_VERSION && mode === "live") return stripDemoForLive(persisted as Persistable);
  return persisted;
}
