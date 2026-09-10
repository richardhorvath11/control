"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import seed from "./seed.json";
import type {
  Agent,
  AttentionItem,
  Mode,
  ReviewItem,
  SeedData,
  SeedLiveMode,
  Workstream,
} from "./types";
import { NEEDS_YOU_EXTERNAL_CAP } from "./github-constants";
import {
  DEFAULT_SEED_LIVE_MODE,
  readSeedLiveMode,
  writeSeedLiveMode,
} from "./seed-live-mode";
import {
  mergeCheckpoint,
  prependChangedEntry,
} from "./merge-checkpoint";
import {
  coalesceKeyFromAttention,
  isReviewAskNeedsYou,
  reviewAskCoalesceKey,
  upsertReviewAskAttention,
} from "./coalesce-review-ask";
import {
  autoReviewKeyFromRepoPr,
  buildPrReviewAgent,
  buildPrReviewItem,
  emptyLiveReviewWorkerSlice,
  parseRepoPrFromCoalesceKey,
  prReviewAgentName,
  prReviewSimDelayMs,
  repoPrFromAttention,
  shouldBlockAutoKick,
  type StartPrReviewWorkerArgs,
} from "./pr-review-worker";
import {
  autoDraftIdempotencyKey,
  buildSlackDraftAgent,
  channelLabelFromAttention,
  isAutoDraftEligible,
  isSlackMessageNeedsYou,
  shouldBlockAutoDraft,
  type StartSlackDraftWorkerArgs,
} from "./slack-draft-worker";
import {
  NO_REVIEW_BACKEND_DETAIL,
  WAITING_FOR_LOCAL_WORKER_DETAIL,
  WORKER_TIMEOUT_DETAIL,
  DEFAULT_WORKER_WAIT_MS,
  buildReviewItemFromResult,
  buildSlackDraftReviewItemFromResult,
  interpretLiveReviewRunResponse,
  type ControlReviewResultV1,
} from "./review-contracts";
import { SLACK_E2E } from "./slack-e2e";

const initial = seed as SeedData;

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Bumped on Demo reset so in-flight Live polls / Demo timers cannot land. */
let reviewWorkerEpoch = 0;

/** Sync guard: auto-kick idempotency that cannot race Zustand persist. */
const autoKickInFlight = new Set<string>();

interface ControlState {
  clockLabel: string;
  mode: Mode;
  /** Demo (Monday seed) vs Live (apply durable inboxes). localStorage `control-v0-mode`. */
  seedLiveMode: SeedLiveMode;
  focusWorkstreamId: string | null;
  dayStrip: SeedData["dayStrip"];
  workstreams: Workstream[];
  attention: AttentionItem[];
  reviewQueue: ReviewItem[];
  agents: Agent[];
  suggestedDelegations: SeedData["suggestedDelegations"];
  fyi: string[];
  sources: SeedData["sources"];
  usedDelegationIds: string[];
  /** Event ids already merged from GitHub inbox into this store */
  appliedGithubEventIds: string[];
  /** Event ids already merged from Slack inbox into this store */
  appliedSlackEventIds: string[];
  /**
   * Idempotency keys for Live auto-kick PR review workers:
   * auto-review:{coalesceKey} (e.g. auto-review:richardhorvath11/battle-buddy#32).
   * Not persisted (control-v0 partialize). Cleared on Demo reset and Demo→Live
   * wipe; stale keys (no Running wait / no real landed review) allow re-kick.
   */
  autoKickedReviewKeys: string[];
  selectedReviewId: string | null;
  confirmModal: null | {
    title: string;
    body: string;
    confirmLabel: string;
    subtitle?: string;
    onConfirm: () => void | Promise<void>;
    loading?: boolean;
    error?: string;
  };
  launcherOpen: boolean;
  _hasHydrated: boolean;

  pendingReviewCount: () => number;
  runningAgentCount: () => number;
  needsYou: () => AttentionItem[];
  activeWorkstreams: () => Workstream[];

  setHasHydrated: (v: boolean) => void;
  setMode: (mode: Mode) => void;
  /** Read localStorage `control-v0-mode` into state (no side effects). */
  hydrateSeedLiveMode: () => void;
  /**
   * Switch Demo ↔ Live. Persists `control-v0-mode`.
   * Demo → reset to Monday seed (clear applied ids; inbox files kept).
   * Live → apply durable inboxes (current poll path).
   */
  setSeedLiveMode: (mode: SeedLiveMode) => void;
  startFocus: (workstreamId?: string) => void;
  endFocus: () => void;
  setSelectedReview: (id: string | null) => void;
  setLauncherOpen: (open: boolean) => void;
  openConfirm: (modal: ControlState["confirmModal"]) => void;
  closeConfirm: () => void;

  resolveAttention: (id: string) => void;
  updateCheckpoint: (workstreamId: string, text: string) => void;

  /** Merge durable GitHub inbox effects into Attention + workstreams (idempotent). */
  applyGithubInboxItems: (
    items: {
      id: string;
      applied: boolean;
      duplicate: boolean;
      effects: {
        attention: AttentionItem | null;
        fyiLine: string | null;
        workstreamPatch: {
          id: string;
          changedEntry: string;
          checkpointLine?: string;
          phase?: Workstream["phase"];
          status?: Workstream["status"];
          next?: string;
          waitingOn?: string;
          lastActive?: string;
        } | null;
        capped?: boolean;
      } | null;
    }[]
  ) => void;
  /** Merge durable Slack inbox effects into Attention + workstreams (idempotent). */
  applySlackInboxItems: (
    items: {
      id: string;
      applied: boolean;
      duplicate: boolean;
      effects: {
        attention: AttentionItem | null;
        fyiLine: string | null;
        workstreamPatch: {
          id: string;
          changedEntry: string;
          checkpointLine?: string;
          phase?: Workstream["phase"];
          status?: Workstream["status"];
          next?: string;
          waitingOn?: string;
          lastActive?: string;
        } | null;
        newWorkstream?: Workstream | null;
        capped?: boolean;
      } | null;
    }[]
  ) => void;
  syncGithubInbox: () => Promise<void>;
  syncSlackInbox: () => Promise<void>;
  /** Poll both external inboxes (GitHub + Slack). */
  syncExternalInboxes: () => Promise<void>;

  /**
   * Clear persisted Zustand (localStorage key control-v0) and rehydrate from seed.
   * Clears applied inbox ids so Demo ignores prior live merges; does NOT delete
   * inbox files or break watchers. Forces seedLiveMode=demo (control-v0-mode).
   * Used by ⌘K "Reset demo state" and after POST /api/demo/reset.
   */
  resetDemoState: () => void;

  delegate: (delegationId: string) => void;
  delegateAttention: (attentionId: string) => void;
  /**
   * Enqueue independent PR review worker (Running → Complete/Failed → Review).
   * Live: write control.review_job.v1 → control-review-run → map result (no invented findings).
   * Demo: local sim findings (fake backend is test-only; Live default is NOT fake).
   * Auto: Live only, once per auto-review:{coalesceKey}; does not resolve Needs-you.
   * Manual: same runner path as auto-kick; may resolve attention when attentionId set.
   */
  startPrReviewWorker: (args: StartPrReviewWorkerArgs) => void;
  /** Live: auto-kick once per coalesce-class Needs-you not yet in autoKickedReviewKeys. */
  maybeAutoKickReviewAsks: () => void;
  /**
   * Chip 4: Draft reply for origin:slack message Needs-you.
   * Live: enqueue slack_draft job → poll → Review. Never invent draft_text.
   * Does NOT resolve Needs-you (prep ≠ done). Demo: no auto; no invented drafts.
   */
  startSlackDraftWorker: (args: StartSlackDraftWorkerArgs) => void;
  /** Live: auto-draft once per DM-question Needs-you (auto-draft:{attentionId}). */
  maybeAutoDraftSlackQuestions: () => void;

  approveReview: (id: string) => void;
  applyApproveReview: (id: string) => void;
  rejectReview: (id: string) => void;
  editReviewDraft: (id: string, text: string) => void;
  confirmPostSlack: (id: string) => Promise<void>;
  applySlackOutboxPosted: (
    id: string,
    reply: { ts?: string; channel?: string; permalink?: string }
  ) => void;
  applySlackOutboxFailed: (id: string, error?: string) => void;
  pollSlackOutbox: (reviewId: string, outboxId: string) => void;

  /** Chip 5: confirm-gated GitHub comment outbox (no PAT in Control). */
  confirmPostGithub: (id: string, body: string) => Promise<void>;
  applyGithubOutboxPosted: (
    id: string,
    comment: { url?: string; id?: number }
  ) => void;
  applyGithubOutboxFailed: (id: string, error?: string) => void;
  pollGithubOutbox: (reviewId: string, outboxId: string) => void;

  approveAgentPermission: (agentId: string) => void;
  dismissAgentPermission: (agentId: string) => void;

  recomputeMode: () => void;
}

export const useControlStore = create<ControlState>()(
  persist(
    (set, get) => ({
      clockLabel: initial.clockLabel,
      mode: initial.mode,
      seedLiveMode: DEFAULT_SEED_LIVE_MODE,
      focusWorkstreamId: initial.focusWorkstreamId,
      dayStrip: initial.dayStrip,
      workstreams: initial.workstreams as Workstream[],
      attention: initial.attention as AttentionItem[],
      reviewQueue: initial.reviewQueue as ReviewItem[],
      agents: initial.agents as Agent[],
      suggestedDelegations:
        initial.suggestedDelegations as SeedData["suggestedDelegations"],
      fyi: initial.fyi,
      sources: initial.sources as SeedData["sources"],
      usedDelegationIds: [],
      appliedGithubEventIds: [],
      appliedSlackEventIds: [],
      autoKickedReviewKeys: [],
      selectedReviewId: initial.reviewQueue[0]?.id ?? null,
      confirmModal: null,
      launcherOpen: false,
      _hasHydrated: false,

      setHasHydrated: (v) => set({ _hasHydrated: v }),

      pendingReviewCount: () =>
        get().reviewQueue.filter((r) => r.status === "pending").length,

      runningAgentCount: () =>
        get().agents.filter((a) => a.status === "Running").length,

      needsYou: () =>
        get().attention.filter((a) => a.routing === "now" && !a.resolved),

      activeWorkstreams: () =>
        get().workstreams.filter((w) => w.active !== false),

      setMode: (mode) => set({ mode }),

      hydrateSeedLiveMode: () => {
        const mode = readSeedLiveMode();
        // Live hydrate: wipe Demo-sim pollution that may still sit in memory
        // from pre-fix persist (agents/reviewQueue/autoKicked no longer
        // partialize, but in-session Demo→refresh edge still needs this).
        if (mode === "live") {
          set({
            seedLiveMode: "live",
            ...emptyLiveReviewWorkerSlice(),
          });
        } else {
          set({ seedLiveMode: mode });
        }
      },

      setSeedLiveMode: (mode) => {
        const prev = get().seedLiveMode;
        writeSeedLiveMode(mode);
        // Optional QA echo — ignore failures (offline / no server).
        void fetch("/api/demo/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        }).catch(() => {});
        if (mode === "demo") {
          set({ seedLiveMode: "demo" });
          get().resetDemoState();
          return;
        }
        // Demo→Live (and any non-live → live): wipe agents / reviewQueue /
        // autoKickedReviewKeys so Demo Surface checks + stale idempotency
        // keys cannot poison Live Waiting/poll. Hard refresh alone is not
        // the product fix — Live enter clears pollution.
        reviewWorkerEpoch += 1;
        autoKickInFlight.clear();
        if (prev !== "live") {
          // Demo→Live / first Live: wipe seed Monday Needs-you (Priya etc.) so
          // empty Live Now is dogfood-correct. Keep only durable external items
          // if any somehow present; seed rows have no github|slack|external origin.
          const keptAttention = get().attention.filter(
            (a) =>
              a.origin === "github" ||
              a.origin === "slack" ||
              a.origin === "external"
          );
          set({
            seedLiveMode: "live",
            ...emptyLiveReviewWorkerSlice(),
            attention: keptAttention,
            fyi: [],
            suggestedDelegations: [],
            usedDelegationIds: [],
          });
          get().recomputeMode();
        } else {
          set({ seedLiveMode: "live" });
        }
        // Live enter: kick once for review-asks / DM questions already present, then apply inboxes.
        get().maybeAutoKickReviewAsks();
        get().maybeAutoDraftSlackQuestions();
        void get().syncExternalInboxes().then(() => {
          get().maybeAutoKickReviewAsks();
          get().maybeAutoDraftSlackQuestions();
        });
      },

      startFocus: (workstreamId) => {
        const ws =
          workstreamId ??
          get().focusWorkstreamId ??
          get().workstreams.find((w) => w.id === "ws-cred")?.id ??
          get().workstreams[0]?.id ??
          null;
        set({ mode: "focus", focusWorkstreamId: ws });
      },

      endFocus: () => {
        set({ mode: "morning", focusWorkstreamId: null });
        get().recomputeMode();
      },

      setSelectedReview: (id) => set({ selectedReviewId: id }),

      setLauncherOpen: (open) => set({ launcherOpen: open }),

      openConfirm: (modal) => set({ confirmModal: modal }),

      closeConfirm: () => set({ confirmModal: null }),

      resolveAttention: (id) => {
        set({
          attention: get().attention.map((a) =>
            a.id === id ? { ...a, resolved: true } : a
          ),
        });
        get().recomputeMode();
      },

      updateCheckpoint: (workstreamId, text) => {
        set({
          workstreams: get().workstreams.map((w) =>
            w.id === workstreamId ? { ...w, checkpoint: text } : w
          ),
        });
      },

      applyGithubInboxItems: (items) => {
        let attention = [...get().attention];
        let workstreams = [...get().workstreams];
        let fyi = [...get().fyi];
        const appliedIds = new Set(get().appliedGithubEventIds);
        let changed = false;

        for (const item of items) {
          if (!item.applied || item.duplicate || !item.effects) continue;
          const effects = item.effects;
          const already = appliedIds.has(item.id);

          if (effects.attention) {
            const att = { ...effects.attention } as AttentionItem;
            if (isReviewAskNeedsYou(att) || att.coalesceKey || att.origin === "external") {
              // Coalesce class: merge-by-stable-id (migrate legacy gh-att-* too)
              const before = attention;
              const result = upsertReviewAskAttention(attention, att);
              attention = result.attention as AttentionItem[];
              if (attention !== before) changed = true;
              // Reconcile demotion routing from server on the merged row
              if (result.index >= 0 && att.routing === "fyi") {
                const cur = attention[result.index];
                if (cur && cur.routing !== "fyi") {
                  attention = attention.map((a, i) =>
                    i === result.index
                      ? { ...a, routing: "fyi", why: att.why }
                      : a
                  );
                  changed = true;
                }
              }
            } else {
              const existingIdx = attention.findIndex((a) => a.id === att.id);
              if (existingIdx >= 0) {
                // Reconcile routing (server may have demoted older Needs-you).
                const prev = attention[existingIdx];
                if (prev.routing !== att.routing || prev.why !== att.why) {
                  attention = attention.map((a, i) =>
                    i === existingIdx
                      ? {
                          ...a,
                          routing: att.routing,
                          why: att.why,
                          provenance: att.provenance,
                        }
                      : a
                  );
                  changed = true;
                }
              } else if (!already) {
                if (att.routing === "now") {
                  attention = [att, ...attention];
                } else {
                  attention = [...attention, att];
                }
                changed = true;
              }
            }
          }

          if (!already) {
            // Prefer attention routing=fyi (keeps provenance). String FYI only when no attention row.
            if (
              effects.fyiLine &&
              !(effects.attention && effects.attention.routing === "fyi") &&
              !fyi.includes(effects.fyiLine)
            ) {
              fyi = [effects.fyiLine, ...fyi];
              changed = true;
            }

            // Checkpoint Latest still runs on every applied event (incl. coalesce second signal).
            if (effects.workstreamPatch) {
              const patch = effects.workstreamPatch;
              workstreams = workstreams.map((w) => {
                if (w.id !== patch.id) return w;
                const nextChanged = prependChangedEntry(
                  w.changed,
                  patch.changedEntry
                );
                const nextCheckpoint = patch.checkpointLine
                  ? mergeCheckpoint(w.checkpoint, patch.checkpointLine)
                  : w.checkpoint;
                return {
                  ...w,
                  changed: nextChanged,
                  checkpoint: nextCheckpoint,
                  phase: patch.phase ?? w.phase,
                  status: patch.status ?? w.status,
                  next: patch.next ?? w.next,
                  waitingOn: patch.waitingOn ?? w.waitingOn,
                  lastActive: patch.checkpointLine
                    ? "just now"
                    : (patch.lastActive ?? w.lastActive),
                };
              });
              changed = true;
            }

            appliedIds.add(item.id);
            changed = true;
          } else if (
            effects.fyiLine &&
            !(effects.attention && effects.attention.routing === "fyi") &&
            !fyi.includes(effects.fyiLine)
          ) {
            fyi = [effects.fyiLine, ...fyi];
            changed = true;
          }
        }

        // Client-side safety: demote oldest external (github|slack|external) Needs-you over shared cap.
        // Seed Monday Needs-you are not external and are never demoted here.
        const externalNow = attention
          .filter(
            (a) =>
              (a.origin === "github" ||
                a.origin === "slack" ||
                a.origin === "external") &&
              a.routing === "now" &&
              !a.resolved
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (externalNow.length > NEEDS_YOU_EXTERNAL_CAP) {
          const demoteIds = new Set(
            externalNow
              .slice(0, externalNow.length - NEEDS_YOU_EXTERNAL_CAP)
              .map((a) => a.id)
          );
          // Keep demoted items as attention with routing=fyi (provenance + Open source).
          // Do NOT collapse to plain fyi strings — that strips actionable UI (E2E-1).
          attention = attention.map((a) => {
            if (!demoteIds.has(a.id)) return a;
            return {
              ...a,
              routing: "fyi" as const,
              why: `${a.why} (older Needs-you demoted — external cap ${NEEDS_YOU_EXTERNAL_CAP})`,
            };
          });
          changed = true;
        }

        if (!changed) return;

        set({
          attention,
          workstreams,
          fyi,
          appliedGithubEventIds: Array.from(appliedIds),
        });
        get().recomputeMode();
        get().maybeAutoKickReviewAsks();
        get().maybeAutoDraftSlackQuestions();
      },

      syncGithubInbox: async () => {
        if (get().seedLiveMode !== "live") return;
        try {
          const res = await fetch("/api/github/inbox");
          if (!res.ok) return;
          const data = (await res.json()) as {
            items?: Parameters<ControlState["applyGithubInboxItems"]>[0];
          };
          if (Array.isArray(data.items)) {
            get().applyGithubInboxItems(data.items);
          }
        } catch {
          // offline / no watcher — seed still boots
        }
      },

      applySlackInboxItems: (items) => {
        let attention = [...get().attention];
        let workstreams = [...get().workstreams];
        let fyi = [...get().fyi];
        const appliedIds = new Set(get().appliedSlackEventIds);
        let changed = false;

        for (const item of items) {
          if (!item.applied || item.duplicate || !item.effects) continue;
          const effects = item.effects;
          const already = appliedIds.has(item.id);

          if (effects.newWorkstream && !already) {
            const nw = effects.newWorkstream as Workstream;
            if (!workstreams.some((w) => w.id === nw.id)) {
              workstreams = [...workstreams, nw];
              changed = true;
            }
          }

          if (effects.attention) {
            const att = { ...effects.attention } as AttentionItem;
            if (isReviewAskNeedsYou(att) || att.coalesceKey || att.origin === "external") {
              const before = attention;
              const result = upsertReviewAskAttention(attention, att);
              attention = result.attention as AttentionItem[];
              if (attention !== before) changed = true;
              if (result.index >= 0 && att.routing === "fyi") {
                const cur = attention[result.index];
                if (cur && cur.routing !== "fyi") {
                  attention = attention.map((a, i) =>
                    i === result.index
                      ? { ...a, routing: "fyi", why: att.why }
                      : a
                  );
                  changed = true;
                }
              }
            } else {
              const existingIdx = attention.findIndex((a) => a.id === att.id);
              if (existingIdx >= 0) {
                const prev = attention[existingIdx];
                const needsSlackFields =
                  !!att.slackChannelId && !prev.slackChannelId;
                if (
                  prev.routing !== att.routing ||
                  prev.why !== att.why ||
                  needsSlackFields
                ) {
                  attention = attention.map((a, i) =>
                    i === existingIdx
                      ? {
                          ...a,
                          routing: att.routing,
                          why: att.why,
                          provenance: att.provenance,
                          slackChannelId:
                            att.slackChannelId ?? a.slackChannelId,
                          slackChannelKind:
                            att.slackChannelKind ?? a.slackChannelKind,
                          slackMessageTs:
                            att.slackMessageTs ?? a.slackMessageTs,
                          slackThreadTs: att.slackThreadTs ?? a.slackThreadTs,
                          slackPermalink:
                            att.slackPermalink ?? a.slackPermalink,
                          slackTextExcerpt:
                            att.slackTextExcerpt ?? a.slackTextExcerpt,
                        }
                      : a
                  );
                  changed = true;
                }
              } else if (!already) {
                if (att.routing === "now") {
                  attention = [att, ...attention];
                } else {
                  attention = [...attention, att];
                }
                changed = true;
              }
            }
          }

          if (!already) {
            // Prefer attention routing=fyi (keeps provenance). String FYI only when no attention row.
            if (
              effects.fyiLine &&
              !(effects.attention && effects.attention.routing === "fyi") &&
              !fyi.includes(effects.fyiLine)
            ) {
              fyi = [effects.fyiLine, ...fyi];
              changed = true;
            }

            // Checkpoint Latest still runs on every applied event (incl. coalesce second signal).
            if (effects.workstreamPatch) {
              const patch = effects.workstreamPatch;
              workstreams = workstreams.map((w) => {
                if (w.id !== patch.id) return w;
                const nextChanged = prependChangedEntry(
                  w.changed,
                  patch.changedEntry
                );
                const nextCheckpoint = patch.checkpointLine
                  ? mergeCheckpoint(w.checkpoint, patch.checkpointLine)
                  : w.checkpoint;
                return {
                  ...w,
                  changed: nextChanged,
                  checkpoint: nextCheckpoint,
                  phase: patch.phase ?? w.phase,
                  status: patch.status ?? w.status,
                  next: patch.next ?? w.next,
                  waitingOn: patch.waitingOn ?? w.waitingOn,
                  lastActive: patch.checkpointLine
                    ? "just now"
                    : (patch.lastActive ?? w.lastActive),
                };
              });
              changed = true;
            }

            appliedIds.add(item.id);
            changed = true;
          } else if (
            effects.fyiLine &&
            !(effects.attention && effects.attention.routing === "fyi") &&
            !fyi.includes(effects.fyiLine)
          ) {
            fyi = [effects.fyiLine, ...fyi];
            changed = true;
          }
        }

        const externalNow = attention
          .filter(
            (a) =>
              (a.origin === "github" ||
                a.origin === "slack" ||
                a.origin === "external") &&
              a.routing === "now" &&
              !a.resolved
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (externalNow.length > NEEDS_YOU_EXTERNAL_CAP) {
          const demoteIds = new Set(
            externalNow
              .slice(0, externalNow.length - NEEDS_YOU_EXTERNAL_CAP)
              .map((a) => a.id)
          );
          // Keep demoted items as attention with routing=fyi (provenance + Open source).
          attention = attention.map((a) => {
            if (!demoteIds.has(a.id)) return a;
            return {
              ...a,
              routing: "fyi" as const,
              why: `${a.why} (older Needs-you demoted — external cap ${NEEDS_YOU_EXTERNAL_CAP})`,
            };
          });
          changed = true;
        }

        if (!changed) return;

        set({
          attention,
          workstreams,
          fyi,
          appliedSlackEventIds: Array.from(appliedIds),
        });
        get().recomputeMode();
        get().maybeAutoKickReviewAsks();
        get().maybeAutoDraftSlackQuestions();
      },

      syncSlackInbox: async () => {
        if (get().seedLiveMode !== "live") return;
        try {
          const res = await fetch("/api/slack/inbox");
          if (!res.ok) return;
          const data = (await res.json()) as {
            items?: Parameters<ControlState["applySlackInboxItems"]>[0];
          };
          if (Array.isArray(data.items)) {
            get().applySlackInboxItems(data.items);
          }
        } catch {
          // offline / no watcher — seed still boots
        }
      },

      syncExternalInboxes: async () => {
        // Demo: APIs still accept watcher POSTs; UI must not apply inbox into Zustand.
        if (get().seedLiveMode !== "live") return;
        await Promise.all([
          get().syncGithubInbox(),
          get().syncSlackInbox(),
        ]);
      },

      resetDemoState: () => {
        // Clear persisted Zustand key control-v0, then rehydrate in-memory from seed.
        // Does NOT delete durable inbox files or watch/follows — soft-ignore via cleared applied ids.
        reviewWorkerEpoch += 1;
        autoKickInFlight.clear();
        try {
          useControlStore.persist.clearStorage();
        } catch {
          try {
            localStorage.removeItem("control-v0");
          } catch {
            /* ignore */
          }
        }
        writeSeedLiveMode("demo");
        set({
          clockLabel: initial.clockLabel,
          mode: initial.mode,
          seedLiveMode: "demo",
          focusWorkstreamId: initial.focusWorkstreamId,
          dayStrip: initial.dayStrip,
          workstreams: initial.workstreams as Workstream[],
          attention: initial.attention as AttentionItem[],
          reviewQueue: initial.reviewQueue as ReviewItem[],
          agents: initial.agents as Agent[],
          suggestedDelegations:
            initial.suggestedDelegations as SeedData["suggestedDelegations"],
          fyi: [...initial.fyi],
          sources: initial.sources as SeedData["sources"],
          usedDelegationIds: [],
          appliedGithubEventIds: [],
          appliedSlackEventIds: [],
          autoKickedReviewKeys: [],
          selectedReviewId: initial.reviewQueue[0]?.id ?? null,
          confirmModal: null,
          launcherOpen: false,
        });
        get().recomputeMode();
      },

      recomputeMode: () => {
        const { mode, needsYou } = get();
        if (mode === "focus") return;
        const open = needsYou();
        set({ mode: open.length === 0 ? "clear" : "morning" });
      },

      startPrReviewWorker: (args) => {
        const repo = args.repo;
        const pr = Math.trunc(args.pr);
        if (!repo || !Number.isFinite(pr) || pr <= 0) return;

        const coalesceKey = reviewAskCoalesceKey(repo, pr);
        const idemKey = autoReviewKeyFromRepoPr(repo, pr);
        const agentName = prReviewAgentName(repo, pr);

        const live = get().seedLiveMode === "live";

        if (args.source === "auto") {
          if (!live) return;
          const gate = shouldBlockAutoKick({
            idemKey,
            agentName,
            autoKickedReviewKeys: get().autoKickedReviewKeys,
            autoKickInFlight: autoKickInFlight.has(idemKey),
            agents: get().agents,
            reviewQueue: get().reviewQueue,
          });
          if (gate.block) return;
          // Stale autoKicked key (Demo Complete, no Running wait, no real
          // control.review_result.v1 review) → drop key and allow re-kick.
          if (gate.reason === "stale_key") {
            set({
              autoKickedReviewKeys: get().autoKickedReviewKeys.filter(
                (k) => k !== idemKey
              ),
            });
          }
          autoKickInFlight.add(idemKey);
          set({
            autoKickedReviewKeys: [...get().autoKickedReviewKeys, idemKey],
          });
        }

        const agentId = uid("agent");
        const epoch = reviewWorkerEpoch;
        const newAgent = buildPrReviewAgent({
          id: agentId,
          repo,
          pr,
          workstreamId: args.workstreamId,
          source: args.source,
        });
        // Live: Waiting detail synchronously before fetch so UI never shows
        // a blank/Demo Complete row while enqueue is in flight.
        if (live) {
          newAgent.detail = WAITING_FOR_LOCAL_WORKER_DETAIL;
        }

        set({
          agents: [...get().agents, newAgent],
        });

        // Auto-kick does not resolve Needs-you. Manual may resolve canned rows.
        if (args.source === "manual" && args.attentionId) {
          get().resolveAttention(args.attentionId);
        }

        const provenance = args.attentionProvenance;
        const workstreamId = args.workstreamId;
        const source = args.source;

        const stillCurrent = () => {
          if (epoch !== reviewWorkerEpoch) return false;
          const a = get().agents.find((x) => x.id === agentId);
          return !!a && a.status === "Running";
        };

        const landOk = (reviewItem: ReviewItem, summaryDetail?: string) => {
          // BUG-W4b: never land invented/stale findings onto a non-running agent
          // (e.g. after Failed, Demo reset, or mode switch).
          if (!stillCurrent()) return;
          set({
            agents: get().agents.map((a) =>
              a.id === agentId
                ? {
                    ...a,
                    status: "Complete",
                    needsReview: true,
                    reviewItemId: reviewItem.id,
                    completedAt: "just now",
                    detail: summaryDetail ?? "Complete — waiting in Review.",
                  }
                : a
            ),
            reviewQueue: [...get().reviewQueue, reviewItem],
            workstreams: get().workstreams.map((w) => {
              if (!workstreamId || w.id !== workstreamId) return w;
              const agentIds = w.agentIds.includes(agentId)
                ? w.agentIds
                : [...w.agentIds, agentId];
              return {
                ...w,
                agentIds,
                lastActive: "just now",
              };
            }),
          });

          // Optional checkpoint Latest (nice-to-have); badge only — no toast.
          if (workstreamId) {
            const targetWs = get().workstreams.find((w) => w.id === workstreamId);
            if (targetWs && !targetWs.ephemeral) {
              const kickLabel =
                source === "auto"
                  ? `Auto-kick review · ${coalesceKey}`
                  : `Delegated review · ${coalesceKey}`;
              get().updateCheckpoint(
                workstreamId,
                `${targetWs.checkpoint} ${kickLabel} completed and landed in Review.`
              );
            }
          }
        };

        const landFailed = (detail: string, blocked = false) => {
          if (!stillCurrent()) return;
          set({
            agents: get().agents.map((a) =>
              a.id === agentId
                ? {
                    ...a,
                    status: blocked ? "Blocked on permission" : "Failed",
                    completedAt: "just now",
                    detail,
                    needsReview: false,
                  }
                : a
            ),
            workstreams: get().workstreams.map((w) => {
              if (!workstreamId || w.id !== workstreamId) return w;
              const agentIds = w.agentIds.includes(agentId)
                ? w.agentIds
                : [...w.agentIds, agentId];
              return { ...w, agentIds, lastActive: "just now" };
            }),
          });
        };

        // Live: default worker enqueue → poll results; or sync control-review-run.
        // Never invent findings (no Demo templated "Surface checks").
        if (live) {
          const applyResult = (result: ControlReviewResultV1) => {
            // Only real control.review_result.v1 from job APIs — never fabricate.
            if (result.status === "error") {
              landFailed(
                result.summary?.trim() || "Agent Failed",
                /not configured|No review backend|control-review-worker/i.test(
                  result.summary ?? ""
                )
              );
              return;
            }
            const reviewId = uid("rev");
            const reviewItem = buildReviewItemFromResult({
              id: reviewId,
              findingIdPrefix: uid("f"),
              repo,
              pr,
              workstreamId,
              agentId,
              result,
            });
            landOk(reviewItem);
          };

          const setWaitingDetail = () => {
            if (!stillCurrent()) return;
            set({
              agents: get().agents.map((a) =>
                a.id === agentId
                  ? {
                      ...a,
                      status: "Running",
                      detail: WAITING_FOR_LOCAL_WORKER_DETAIL,
                    }
                  : a
              ),
            });
          };

          const pollResult = async (jobId: string): Promise<void> => {
            const waitMs = DEFAULT_WORKER_WAIT_MS;
            const intervalMs = 2000;
            const started = Date.now();
            while (Date.now() - started < waitMs) {
              if (!stillCurrent()) return;
              await new Promise((r) => window.setTimeout(r, intervalMs));
              if (!stillCurrent()) return;
              try {
                const poll = await fetch(
                  `/api/review/jobs/${encodeURIComponent(jobId)}`
                );
                const pdata = (await poll.json().catch(() => ({}))) as {
                  ok?: boolean;
                  status?: "pending" | "claimed" | "done" | "failed";
                  error?: string;
                  result?: ControlReviewResultV1 | null;
                };
                if (pdata.status === "done" && pdata.result) {
                  applyResult(pdata.result);
                  return;
                }
                if (pdata.status === "failed") {
                  // POST /fail — Agent Failed; no invented findings.
                  landFailed(
                    (pdata.error ?? "").trim() || "Agent Failed",
                    false
                  );
                  return;
                }
                if (pdata.ok === false && pdata.error) {
                  landFailed(pdata.error);
                  return;
                }
              } catch {
                // keep waiting — transient poll errors
              }
            }
            // BUG-W4a: timeout with no result → Failed + worker copy (never
            // fail-fast runner copy; never map templated Surface checks).
            landFailed(WORKER_TIMEOUT_DETAIL, false);
          };

          void (async () => {
            try {
              const res = await fetch("/api/review/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  repo,
                  pr,
                  workstream_id: workstreamId,
                  attention_id: args.attentionId,
                  provenance: provenance ?? [],
                }),
              });
              const data = (await res.json().catch(() => ({}))) as {
                ok?: boolean;
                pending?: boolean;
                code?: string;
                error?: string;
                detail?: string;
                backend?: string | null;
                job?: { job_id?: string } | null;
                job_id?: string;
                result?: ControlReviewResultV1 | null;
              };

              const decision = interpretLiveReviewRunResponse(
                res.ok,
                res.status,
                data
              );

              if (decision.action === "no_backend") {
                landFailed(decision.detail, true);
                return;
              }

              // Worker enqueue (default Live backend): Waiting → poll. Never
              // treat pending/ok-without-result as fail-fast (forbidden).
              if (decision.action === "wait_worker") {
                setWaitingDetail();
                await pollResult(decision.jobId);
                return;
              }

              if (decision.action === "apply_result") {
                applyResult(decision.result);
                return;
              }

              // fail — Live never uses the old fail-fast runner copy.
              landFailed(decision.detail, decision.blocked);
            } catch (err) {
              landFailed(
                err instanceof Error
                  ? err.message
                  : "Review runner request failed"
              );
            }
          })();
          return;
        }

        // Demo: keep local sim (fake backend is test-only; Live default is NOT fake).
        const delay = prReviewSimDelayMs();
        window.setTimeout(() => {
          // BUG-W4b: if mode flipped to Live (or reset), do not invent Surface checks.
          if (epoch !== reviewWorkerEpoch) return;
          if (get().seedLiveMode === "live") return;
          if (!stillCurrent()) return;
          const reviewId = uid("rev");
          const findingId = uid("f");
          const reviewItem = buildPrReviewItem({
            id: reviewId,
            findingId,
            repo,
            pr,
            workstreamId,
            agentId,
            attentionProvenance: provenance,
          });
          landOk(reviewItem);
        }, delay);
      },


      maybeAutoKickReviewAsks: () => {
        if (get().seedLiveMode !== "live") return;
        for (const att of get().attention) {
          if (!isReviewAskNeedsYou(att)) continue;
          // Only open Needs-you on Now (not cap-demoted FYI).
          if (att.routing !== "now" || att.resolved) continue;
          const key =
            att.coalesceKey ||
            coalesceKeyFromAttention(att) ||
            null;
          if (!key) continue;
          const parsed = parseRepoPrFromCoalesceKey(key);
          if (!parsed) continue;
          get().startPrReviewWorker({
            repo: parsed.repo,
            pr: parsed.pr,
            workstreamId: att.workstreamId,
            attentionId: att.id,
            source: "auto",
            attentionProvenance: att.provenance,
          });
        }
      },

      startSlackDraftWorker: (args) => {
        const channelId = (args.channelId ?? "").trim();
        const messageTs = (args.messageTs ?? "").trim();
        if (!channelId || !messageTs) return;

        const threadTs = (args.threadTs ?? "").trim() || messageTs;
        const attentionId = args.attentionId;
        const channelLabel = args.channelLabel?.trim() || channelId;
        const idemKey = autoDraftIdempotencyKey(attentionId);
        const agentName = buildSlackDraftAgent({
          id: "tmp",
          channelLabel,
          source: args.source,
        }).name;
        const live = get().seedLiveMode === "live";

        // Demo: no invented drafts. Manual Draft reply in Demo is a no-op
        // (Live inbox messages are not applied in Demo).
        if (!live) return;

        if (args.source === "auto") {
          const gate = shouldBlockAutoDraft({
            idemKey,
            agentName,
            autoKickedReviewKeys: get().autoKickedReviewKeys,
            autoKickInFlight: autoKickInFlight.has(idemKey),
            agents: get().agents,
            reviewQueue: get().reviewQueue,
            attentionId,
          });
          if (gate.block) return;
          if (gate.reason === "stale_key") {
            set({
              autoKickedReviewKeys: get().autoKickedReviewKeys.filter(
                (k) => k !== idemKey
              ),
            });
          }
          autoKickInFlight.add(idemKey);
          set({
            autoKickedReviewKeys: [...get().autoKickedReviewKeys, idemKey],
          });
        }

        const agentId = uid("agent");
        const epoch = reviewWorkerEpoch;
        const newAgent = buildSlackDraftAgent({
          id: agentId,
          channelLabel,
          workstreamId: args.workstreamId,
          source: args.source,
        });
        newAgent.detail = WAITING_FOR_LOCAL_WORKER_DETAIL;

        set({
          agents: [...get().agents, newAgent],
        });
        // Prep ≠ done: do NOT resolve Needs-you on Draft reply.

        const workstreamId = args.workstreamId;
        const stillCurrent = () => {
          if (epoch !== reviewWorkerEpoch) return false;
          const a = get().agents.find((x) => x.id === agentId);
          return !!a && a.status === "Running";
        };

        const landOk = (reviewItem: ReviewItem, summaryDetail?: string) => {
          if (!stillCurrent()) return;
          set({
            agents: get().agents.map((a) =>
              a.id === agentId
                ? {
                    ...a,
                    status: "Complete",
                    needsReview: true,
                    reviewItemId: reviewItem.id,
                    completedAt: "just now",
                    detail: summaryDetail ?? "Complete — waiting in Review.",
                  }
                : a
            ),
            reviewQueue: [...get().reviewQueue, reviewItem],
            workstreams: get().workstreams.map((w) => {
              if (!workstreamId || w.id !== workstreamId) return w;
              const agentIds = w.agentIds.includes(agentId)
                ? w.agentIds
                : [...w.agentIds, agentId];
              return { ...w, agentIds, lastActive: "just now" };
            }),
          });
        };

        const landFailed = (detail: string, blocked = false) => {
          if (!stillCurrent()) return;
          set({
            agents: get().agents.map((a) =>
              a.id === agentId
                ? {
                    ...a,
                    status: blocked ? "Blocked on permission" : "Failed",
                    completedAt: "just now",
                    detail,
                    needsReview: false,
                  }
                : a
            ),
          });
        };

        const applyResult = (
          result: ControlReviewResultV1,
          jobMeta: {
            channel_id: string;
            message_ts: string;
            thread_ts: string;
            permalink: string;
            text_excerpt?: string;
            attention_id?: string;
            provenance?: unknown[];
            workstream_id?: string;
          }
        ) => {
          if (result.status === "error") {
            landFailed(
              result.summary?.trim() || "Agent Failed",
              /not configured|No review backend|control-review-worker/i.test(
                result.summary ?? ""
              )
            );
            return;
          }
          // Never invent draft — require worker draft_text.
          if (typeof result.draft_text !== "string") {
            landFailed("Agent Failed — slack_draft missing draft_text");
            return;
          }
          const reviewId = uid("rev");
          const reviewItem = buildSlackDraftReviewItemFromResult({
            id: reviewId,
            agentId,
            result,
            job: {
              schema: "control.review_job.v1",
              job_id: result.job_id,
              kind: "slack_draft",
              channel_id: jobMeta.channel_id,
              message_ts: jobMeta.message_ts,
              thread_ts: jobMeta.thread_ts,
              permalink: jobMeta.permalink,
              text_excerpt: jobMeta.text_excerpt,
              attention_id: jobMeta.attention_id,
              provenance: jobMeta.provenance ?? [],
              workstream_id: jobMeta.workstream_id,
            },
            workstreamId,
            channelLabel,
            workspace: SLACK_E2E.workspace,
          });
          landOk(reviewItem);
        };

        const setWaitingDetail = () => {
          if (!stillCurrent()) return;
          set({
            agents: get().agents.map((a) =>
              a.id === agentId
                ? {
                    ...a,
                    status: "Running",
                    detail: WAITING_FOR_LOCAL_WORKER_DETAIL,
                  }
                : a
            ),
          });
        };

        const jobMeta = {
          channel_id: channelId,
          message_ts: messageTs,
          thread_ts: threadTs,
          permalink: (args.permalink ?? "").trim(),
          text_excerpt: args.textExcerpt,
          attention_id: attentionId,
          provenance: args.provenance ?? [],
          workstream_id: workstreamId,
        };

        const pollResult = async (jobId: string): Promise<void> => {
          const waitMs = DEFAULT_WORKER_WAIT_MS;
          const intervalMs = 2000;
          const started = Date.now();
          while (Date.now() - started < waitMs) {
            if (!stillCurrent()) return;
            await new Promise((r) => window.setTimeout(r, intervalMs));
            if (!stillCurrent()) return;
            try {
              const poll = await fetch(
                `/api/review/jobs/${encodeURIComponent(jobId)}`
              );
              const pdata = (await poll.json().catch(() => ({}))) as {
                ok?: boolean;
                status?: "pending" | "claimed" | "done" | "failed";
                error?: string;
                result?: ControlReviewResultV1 | null;
                job?: {
                  channel_id?: string;
                  message_ts?: string;
                  thread_ts?: string;
                  permalink?: string;
                  text_excerpt?: string;
                  attention_id?: string;
                  provenance?: unknown[];
                  workstream_id?: string;
                };
              };
              if (pdata.status === "done" && pdata.result) {
                const j = pdata.job;
                applyResult(pdata.result, {
                  channel_id: j?.channel_id ?? jobMeta.channel_id,
                  message_ts: j?.message_ts ?? jobMeta.message_ts,
                  thread_ts: j?.thread_ts ?? jobMeta.thread_ts,
                  permalink: j?.permalink ?? jobMeta.permalink,
                  text_excerpt: j?.text_excerpt ?? jobMeta.text_excerpt,
                  attention_id: j?.attention_id ?? jobMeta.attention_id,
                  provenance: j?.provenance ?? jobMeta.provenance,
                  workstream_id: j?.workstream_id ?? jobMeta.workstream_id,
                });
                return;
              }
              if (pdata.status === "failed") {
                landFailed((pdata.error ?? "").trim() || "Agent Failed", false);
                return;
              }
              if (pdata.ok === false && pdata.error) {
                landFailed(pdata.error);
                return;
              }
            } catch {
              /* transient */
            }
          }
          landFailed(WORKER_TIMEOUT_DETAIL, false);
        };

        void (async () => {
          try {
            const res = await fetch("/api/review/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                kind: "slack_draft",
                channel_id: channelId,
                message_ts: messageTs,
                thread_ts: threadTs,
                permalink: jobMeta.permalink,
                text_excerpt: args.textExcerpt,
                attention_id: attentionId,
                workstream_id: workstreamId,
                provenance: args.provenance ?? [],
              }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              pending?: boolean;
              code?: string;
              error?: string;
              detail?: string;
              backend?: string | null;
              job?: { job_id?: string } | null;
              job_id?: string;
              result?: ControlReviewResultV1 | null;
            };

            const decision = interpretLiveReviewRunResponse(
              res.ok,
              res.status,
              data
            );

            if (decision.action === "no_backend") {
              landFailed(decision.detail, true);
              return;
            }
            if (decision.action === "wait_worker") {
              setWaitingDetail();
              await pollResult(decision.jobId);
              return;
            }
            if (decision.action === "apply_result") {
              applyResult(decision.result, jobMeta);
              return;
            }
            landFailed(decision.detail, decision.blocked);
          } catch (err) {
            landFailed(
              err instanceof Error
                ? err.message
                : "Review runner request failed"
            );
          }
        })();
      },

      maybeAutoDraftSlackQuestions: () => {
        if (get().seedLiveMode !== "live") return;
        for (const att of get().attention) {
          if (!isSlackMessageNeedsYou(att)) continue;
          if (!isAutoDraftEligible(att)) continue;
          const channelId = att.slackChannelId?.trim();
          const messageTs = att.slackMessageTs?.trim();
          if (!channelId || !messageTs) continue;
          get().startSlackDraftWorker({
            attentionId: att.id,
            channelId,
            messageTs,
            threadTs: att.slackThreadTs?.trim() || messageTs,
            permalink: att.slackPermalink ?? "",
            textExcerpt: att.slackTextExcerpt ?? "",
            channelKind: att.slackChannelKind,
            channelLabel: channelLabelFromAttention(att),
            workstreamId: att.workstreamId,
            provenance: att.provenance,
            source: "auto",
            why: att.why,
          });
        }
      },

      delegate: (delegationId) => {
        const del = get().suggestedDelegations.find(
          (d) => d.id === delegationId
        );
        if (!del || get().usedDelegationIds.includes(delegationId)) return;

        // Chip 3: manual PR review uses the same startPrReviewWorker path as auto-kick.
        if (del.kind === "pr_review") {
          set({
            usedDelegationIds: [...get().usedDelegationIds, delegationId],
          });
          let repo = "richardhorvath11/battle-buddy";
          let pr = 32;
          let attentionProvenance = undefined as
            | import("./types").Provenance[]
            | undefined;
          if (del.attentionId) {
            const att = get().attention.find((a) => a.id === del.attentionId);
            if (att) {
              attentionProvenance = att.provenance;
              const parsed = repoPrFromAttention(att);
              if (parsed) {
                repo = parsed.repo;
                pr = parsed.pr;
              }
            }
          }
          get().startPrReviewWorker({
            repo,
            pr,
            workstreamId: del.workstreamId,
            attentionId: del.attentionId,
            source: "manual",
            attentionProvenance,
          });
          return;
        }

        const agentId = uid("agent");
        const delay = prReviewSimDelayMs();

        // BUG-5: Priya investigate → ephemeral workstream
        let workstreamId = del.workstreamId;
        if (del.kind === "investigate") {
          const ephId = uid("ws");
          const eph: Workstream = {
            id: ephId,
            name: del.label,
            phase: "Delegated",
            objective: "Answer Priya's deploy-impact question for staging rotation.",
            next: "Agent investigating deploy impact",
            changed: [`Delegated “${del.label}”`],
            waitingOn: "agent",
            lastActive: "just now",
            checkpoint: `Delegated “${del.label}” — agent running.`,
            artifacts: [],
            agentIds: [agentId],
            status: "running",
            ephemeral: true,
            active: true,
          };
          workstreamId = ephId;
          set({
            workstreams: [...get().workstreams, eph],
          });
        }

        const newAgent: Agent = {
          id: agentId,
          name: del.label,
          status: "Running",
          workstreamId,
          detail: "Delegated from Now — working.",
          startedAt: "just now",
        };

        set({
          agents: [...get().agents, newAgent],
          usedDelegationIds: [...get().usedDelegationIds, delegationId],
        });

        if (del.attentionId) {
          get().resolveAttention(del.attentionId);
        }

        window.setTimeout(() => {
          const reviewId = uid("rev");
          const wsId = workstreamId;
          let reviewItem: ReviewItem;

          if (del.kind === "investigate") {
            reviewItem = {
              id: reviewId,
              kind: "investigation",
              title: "Investigation: deploy impact of staging rotation",
              workstreamId: wsId,
              label: "Analysis, not truth",
              analysisNote:
                "Prepared answer for Priya. Analysis only — confirm before treating as decision.",
              findings: [
                {
                  id: uid("f"),
                  title: "Deploys are blocked only while the deploy lock is held",
                  body: "Current PR holds the staging deploy lock for MAX_RETRIES × 18s. At five retries that is ~90s. Nightingale's 11:00 push would wait if rotation is mid-flight; it would not be cancelled. Dropping to three retries (RFC §4.2) shortens the window to ~54s.",
                  evidence: [
                    {
                      kind: "github",
                      title: "lock.ts · deploy lock TTL",
                      locator: "packages/creds/src/lock.ts:22",
                      excerpt: "ttlMs: MAX_RETRIES * 18_000",
                      sourceId: "pr-cred",
                    },
                    {
                      kind: "slack",
                      title: "#infra · Priya",
                      locator: "8:54 AM",
                      excerpt: "Nightingale has a staging push queued for ~11.",
                      sourceId: "slack-infra",
                    },
                  ],
                },
              ],
              scopeFooter:
                "Examined PR lock behavior · #infra thread · RFC §4.2. Absence of findings is not approval.",
              status: "pending",
              agentId,
            };
          } else {
            reviewItem = {
              id: reviewId,
              kind: "slack_draft",
              title: "Draft reply",
              workstreamId: wsId,
              label: "Draft reply",
              analysisNote: "Draft only — posting requires confirmation.",
              findings: [],
              scopeFooter: "Draft only.",
              draftText: "Draft prepared.",
              targetLabel: "#infra",
              status: "pending",
              agentId,
            };
          }

          set({
            agents: get().agents.map((a) =>
              a.id === agentId
                ? {
                    ...a,
                    status: "Complete",
                    needsReview: true,
                    reviewItemId: reviewId,
                    completedAt: "just now",
                    detail: "Complete — waiting in Review.",
                  }
                : a
            ),
            reviewQueue: [...get().reviewQueue, reviewItem],
            // Ephemeral short jobs leave Active when complete; stay searchable
            workstreams: get().workstreams.map((w) => {
              if (w.id !== wsId) return w;
              if (w.ephemeral) {
                return {
                  ...w,
                  active: false,
                  phase: "Human review",
                  status: "blocked-on-you",
                  waitingOn: "you",
                  lastActive: "just now",
                  next: "Review investigation result",
                  checkpoint:
                    w.checkpoint +
                    ` Agent completed — landed in Review.`,
                  changed: [
                    `Investigation complete — in Review`,
                    ...w.changed,
                  ],
                  agentIds: w.agentIds.includes(agentId)
                    ? w.agentIds
                    : [...w.agentIds, agentId],
                };
              }
              return w;
            }),
          });

          // Focus mode: badge only, no UI interrupt. Morning/clear: still no toast.
          const checkpointTarget = wsId ?? del.workstreamId ?? "ws-cred";
          const targetWs = get().workstreams.find((w) => w.id === checkpointTarget);
          if (targetWs && !targetWs.ephemeral) {
            get().updateCheckpoint(
              checkpointTarget,
              targetWs.checkpoint +
                ` Delegated “${del.label}” completed and landed in Review.`
            );
          }
        }, delay);
      },

      delegateAttention: (attentionId) => {
        const attEarly = get().attention.find((a) => a.id === attentionId);
        // Chip 3: review-ask Delegate uses same runner path as auto-kick.
        if (attEarly && isReviewAskNeedsYou(attEarly)) {
          const parsed = repoPrFromAttention(attEarly);
          if (parsed) {
            get().startPrReviewWorker({
              repo: parsed.repo,
              pr: parsed.pr,
              workstreamId: attEarly.workstreamId,
              attentionId: attEarly.id,
              source: "manual",
              attentionProvenance: attEarly.provenance,
            });
            return;
          }
        }
        const matching = get().suggestedDelegations.find(
          (d) => d.attentionId === attentionId
        );
        if (matching) {
          get().delegate(matching.id);
          return;
        }
        // Generic investigate for attention without canned delegation
        const att = attEarly ?? get().attention.find((a) => a.id === attentionId);
        if (!att) return;
        const syntheticId = uid("del");
        set({
          suggestedDelegations: [
            ...get().suggestedDelegations,
            {
              id: syntheticId,
              label: `Investigate: ${att.title}`,
              kind: "investigate",
              attentionId: att.id,
              workstreamId: att.workstreamId,
            },
          ],
        });
        get().delegate(syntheticId);
      },

      approveReview: (id) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item || item.status !== "pending") return;

        if (item.kind === "slack_draft") {
          const channel =
            item.slackTarget?.channelName ??
            item.targetLabel ??
            "#control-e2e";
          get().openConfirm({
            title: "Post to Slack?",
            body: item.draftText ?? "",
            confirmLabel: `Post to ${channel}`,
            subtitle:
              "Queues a durable outbox record for Grok’s Slack MCP poster — nothing reaches Slack until you confirm. Cancel leaves Review unchanged.",
            onConfirm: () => get().confirmPostSlack(id),
          });
          return;
        }

        // BUG-3: PR / investigation approve needs confirm
        get().openConfirm({
          title: "Approve analysis?",
          body: `${item.title}\n\nThis records approval of analysis, not merge.`,
          confirmLabel: "Approve analysis",
          subtitle: "External-ish judgment — confirm before applying.",
          onConfirm: () => get().applyApproveReview(id),
        });
      },

      applyApproveReview: (id) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item || item.status !== "pending") return;

        set({
          reviewQueue: get().reviewQueue.map((r) =>
            r.id === id ? { ...r, status: "approved" } : r
          ),
          confirmModal: null,
        });

        if (item.workstreamId) {
          const ws = get().workstreams.find((w) => w.id === item.workstreamId);
          if (ws) {
            get().updateCheckpoint(
              item.workstreamId,
              `${ws.checkpoint} You approved “${item.title}” in Review.`
            );
            set({
              workstreams: get().workstreams.map((w) =>
                w.id === item.workstreamId
                  ? {
                      ...w,
                      next:
                        item.id === "rev-pr"
                          ? "Land retry-limit decision (approved analysis — still your call on 5→3)."
                          : w.next,
                      changed: [
                        `Approved review: ${item.title}`,
                        ...w.changed,
                      ],
                    }
                  : w
              ),
            });
          }
        }

        if (item.id === "rev-pr") {
          get().resolveAttention("att-retry");
        }

        const remaining = get().reviewQueue.filter(
          (r) =>
            (r.status === "pending" || r.status === "queued") && r.id !== id
        );
        set({
          selectedReviewId: remaining[0]?.id ?? null,
        });
        get().recomputeMode();
      },

      rejectReview: (id) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        set({
          reviewQueue: get().reviewQueue.map((r) =>
            r.id === id ? { ...r, status: "rejected" } : r
          ),
        });
        if (item?.workstreamId) {
          get().updateCheckpoint(
            item.workstreamId,
            get().workstreams.find((w) => w.id === item.workstreamId)!
              .checkpoint + ` You rejected “${item.title}”.`
          );
        }
        const remaining = get().reviewQueue.filter(
          (r) =>
            (r.status === "pending" || r.status === "queued") && r.id !== id
        );
        set({ selectedReviewId: remaining[0]?.id ?? null });
        get().recomputeMode();
      },

      editReviewDraft: (id, text) => {
        set({
          reviewQueue: get().reviewQueue.map((r) =>
            r.id === id ? { ...r, draftText: text, status: "pending" } : r
          ),
        });
      },

      confirmPostSlack: async (id) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item || (item.status !== "pending" && item.status !== "queued"))
          return;
        if (item.status === "queued") return;

        const textBody = item.draftText ?? "";
        // Harness defaults only for seed Priya (rev-slack); Live drafts use item.slackTarget.
        const channelId =
          item.slackTarget?.channelId ??
          (item.id === "rev-slack" ? SLACK_E2E.channelId : "");
        const threadTs =
          item.slackTarget?.threadTs ??
          (item.id === "rev-slack" ? SLACK_E2E.threadTs : "");
        if (!channelId || !threadTs) {
          const current = get().confirmModal;
          if (current) {
            set({
              confirmModal: {
                ...current,
                loading: false,
                error:
                  "Missing slackTarget channel/thread — cannot queue outbox.",
              },
            });
          }
          return;
        }

        const modal = get().confirmModal;
        if (modal) {
          set({
            confirmModal: { ...modal, loading: true, error: undefined },
          });
        }

        try {
          const res = await fetch("/api/slack/outbox", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: textBody,
              channelId,
              threadTs,
              reviewItemId: id,
              provenance: item.provenance ?? null,
            }),
          });

          let data: {
            error?: string;
            item?: { id: string; status?: string };
          } = {};
          try {
            data = (await res.json()) as typeof data;
          } catch {
            data = {};
          }

          // User cancelled while in flight — do not apply success or reopen.
          if (!get().confirmModal) return;

          if (!res.ok || !data.item?.id) {
            const current = get().confirmModal;
            if (current) {
              set({
                confirmModal: {
                  ...current,
                  loading: false,
                  error:
                    data.error ||
                    `Outbox write failed (HTTP ${res.status}). Review stays pending.`,
                },
              });
            }
            return;
          }

          const outboxId = data.item.id;

          // Queued — close modal; do NOT mark Posted until MCP ack.
          set({
            reviewQueue: get().reviewQueue.map((r) =>
              r.id === id
                ? {
                    ...r,
                    status: "queued",
                    slackOutboxId: outboxId,
                    slackQueueStatus: "pending",
                  }
                : r
            ),
            confirmModal: null,
          });

          get().pollSlackOutbox(id, outboxId);
        } catch (err) {
          if (!get().confirmModal) return;
          const current = get().confirmModal;
          if (current) {
            set({
              confirmModal: {
                ...current,
                loading: false,
                error:
                  err instanceof Error
                    ? err.message
                    : "Network error writing Slack outbox. Review stays pending.",
              },
            });
          }
        }
      },

      pollSlackOutbox: (reviewId, outboxId) => {
        let attempts = 0;
        const maxAttempts = 120; // ~4 min at 2s
        const tick = async () => {
          attempts += 1;
          const item = get().reviewQueue.find((r) => r.id === reviewId);
          if (!item || item.slackOutboxId !== outboxId) return;
          if (item.status === "approved" || item.status === "rejected") return;
          if (item.slackQueueStatus === "posted" || item.slackQueueStatus === "failed")
            return;

          try {
            const res = await fetch(`/api/slack/outbox/${outboxId}`);
            if (res.ok) {
              const data = (await res.json()) as {
                item?: {
                  status?: string;
                  reply_ts?: string;
                  permalink?: string;
                  channel_id?: string;
                  error?: string;
                };
              };
              const ob = data.item;
              if (ob?.status === "posted") {
                get().applySlackOutboxPosted(reviewId, {
                  ts: ob.reply_ts,
                  channel: ob.channel_id,
                  permalink: ob.permalink,
                });
                return;
              }
              if (ob?.status === "failed") {
                get().applySlackOutboxFailed(reviewId, ob.error);
                return;
              }
            }
          } catch {
            // keep polling
          }

          if (attempts < maxAttempts) {
            window.setTimeout(() => {
              void tick();
            }, 2000);
          }
        };
        window.setTimeout(() => {
          void tick();
        }, 1500);
      },

      applySlackOutboxPosted: (id, reply) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item) return;
        if (item.status === "approved") return;

        const textBody = item.draftText ?? "";

        set({
          reviewQueue: get().reviewQueue.map((r) =>
            r.id === id
              ? {
                  ...r,
                  status: "approved",
                  slackQueueStatus: "posted",
                  postedReply: reply.ts
                    ? {
                        ts: reply.ts,
                        channel: reply.channel,
                        permalink: reply.permalink,
                      }
                    : r.postedReply,
                }
              : r
          ),
        });

        if (textBody) {
          const sources = { ...get().sources };
          const thread = sources.slack["slack-infra"];
          if (thread) {
            sources.slack = {
              ...sources.slack,
              "slack-infra": {
                ...thread,
                messages: [
                  ...thread.messages,
                  {
                    author: "You",
                    time: "just now",
                    body: textBody,
                  },
                ],
              },
            };
            set({ sources });
          }
        }

        if (item.workstreamId) {
          const ws = get().workstreams.find((w) => w.id === item.workstreamId);
          if (ws) {
            get().updateCheckpoint(
              item.workstreamId,
              ws.checkpoint +
                ` Posted Slack reply to Priya` +
                (reply.ts ? ` (ts ${reply.ts})` : "") +
                `.`
            );
            set({
              workstreams: get().workstreams.map((w) =>
                w.id === item.workstreamId
                  ? {
                      ...w,
                      changed: [
                        "Replied to Priya in #control-e2e (E2E harness via MCP).",
                        ...w.changed,
                      ],
                    }
                  : w
              ),
            });
          }
        }

        get().resolveAttention("att-priya");

        // Keep posted item selected so Review shows approved + permalink
        // (same outbox ack UX as GitHub / BUG-C5-1).
        set({ selectedReviewId: id });
        get().recomputeMode();
      },

      applySlackOutboxFailed: (id, error) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item) return;
        // Fail closed: return to pending so the user can retry Approve.
        set({
          reviewQueue: get().reviewQueue.map((r) =>
            r.id === id
              ? {
                  ...r,
                  status: "pending",
                  slackQueueStatus: "failed",
                  // keep slackOutboxId for diagnostics
                }
              : r
          ),
        });
        get().openConfirm({
          title: "Slack outbox failed",
          body: item.draftText ?? "",
          confirmLabel: "Dismiss",
          subtitle:
            error ||
            "MCP poster reported failure. Review is pending again — nothing was posted.",
          onConfirm: () => get().closeConfirm(),
        });
      },

      confirmPostGithub: async (id, body) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item || item.kind !== "pr_review") return;
        if (item.status !== "pending" && item.status !== "queued") return;
        if (item.status === "queued") return;

        const textBody = typeof body === "string" ? body : "";
        const trimmed = textBody.trim();
        if (!trimmed) {
          const modal = get().confirmModal;
          if (modal) {
            set({
              confirmModal: {
                ...modal,
                loading: false,
                error: "Comment body is empty — nothing queued.",
              },
            });
          }
          return;
        }

        const repo =
          item.repo ||
          (item.title.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#\d+/) ||
            [])[1] ||
          "";
        const pr =
          item.pr && item.pr > 0
            ? item.pr
            : (() => {
                const m = item.title.match(/#(\d+)/);
                return m ? parseInt(m[1], 10) : 0;
              })();

        const modal = get().confirmModal;
        if (modal) {
          set({
            confirmModal: { ...modal, loading: true, error: undefined },
          });
        }

        try {
          const res = await fetch("/api/github/outbox", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              body: trimmed,
              repo,
              pr,
              reviewItemId: id,
            }),
          });

          let data: {
            error?: string;
            item?: { id: string; status?: string };
          } = {};
          try {
            data = (await res.json()) as typeof data;
          } catch {
            data = {};
          }

          // User cancelled while in flight — do not apply success or reopen.
          if (!get().confirmModal) return;

          if (!res.ok || !data.item?.id) {
            const current = get().confirmModal;
            if (current) {
              set({
                confirmModal: {
                  ...current,
                  loading: false,
                  error:
                    data.error ||
                    `Outbox write failed (HTTP ${res.status}). Review stays pending.`,
                },
              });
            }
            return;
          }

          const outboxId = data.item.id;

          // Queued — close modal; do NOT mark approved until poster ack.
          set({
            reviewQueue: get().reviewQueue.map((r) =>
              r.id === id
                ? {
                    ...r,
                    draftText: trimmed,
                    status: "queued",
                    githubOutboxId: outboxId,
                    githubQueueStatus: "pending",
                  }
                : r
            ),
            confirmModal: null,
          });

          get().pollGithubOutbox(id, outboxId);
        } catch (err) {
          if (!get().confirmModal) return;
          const current = get().confirmModal;
          if (current) {
            set({
              confirmModal: {
                ...current,
                loading: false,
                error:
                  err instanceof Error
                    ? err.message
                    : "Network error writing GitHub outbox. Review stays pending.",
              },
            });
          }
        }
      },

      pollGithubOutbox: (reviewId, outboxId) => {
        let attempts = 0;
        const maxAttempts = 120; // ~4 min at 2s
        const tick = async () => {
          attempts += 1;
          const item = get().reviewQueue.find((r) => r.id === reviewId);
          if (!item || item.githubOutboxId !== outboxId) return;
          if (item.status === "approved" || item.status === "rejected") return;
          if (
            item.githubQueueStatus === "posted" ||
            item.githubQueueStatus === "failed"
          )
            return;

          try {
            const res = await fetch(`/api/github/outbox/${outboxId}`);
            if (res.ok) {
              const data = (await res.json()) as {
                item?: {
                  status?: string;
                  comment_url?: string;
                  comment_id?: number;
                  error?: string;
                };
              };
              const ob = data.item;
              if (ob?.status === "posted") {
                get().applyGithubOutboxPosted(reviewId, {
                  url: ob.comment_url,
                  id: ob.comment_id,
                });
                return;
              }
              if (ob?.status === "failed") {
                get().applyGithubOutboxFailed(reviewId, ob.error);
                return;
              }
            }
          } catch {
            // keep polling
          }

          if (attempts < maxAttempts) {
            window.setTimeout(() => {
              void tick();
            }, 2000);
          }
        };
        window.setTimeout(() => {
          void tick();
        }, 1500);
      },

      applyGithubOutboxPosted: (id, comment) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item) return;
        if (item.status === "approved") return;

        set({
          reviewQueue: get().reviewQueue.map((r) =>
            r.id === id
              ? {
                  ...r,
                  status: "approved",
                  githubQueueStatus: "posted",
                  postedGithubComment: comment.url
                    ? {
                        url: comment.url,
                        id: comment.id,
                      }
                    : r.postedGithubComment,
                }
              : r
          ),
        });

        if (item.workstreamId) {
          const ws = get().workstreams.find((w) => w.id === item.workstreamId);
          if (ws) {
            const target =
              item.repo && item.pr
                ? `${item.repo}#${item.pr}`
                : item.title;
            get().updateCheckpoint(
              item.workstreamId,
              ws.checkpoint +
                ` Posted GitHub comment on ${target}` +
                (comment.url ? ` (${comment.url})` : "") +
                `.`
            );
            set({
              workstreams: get().workstreams.map((w) =>
                w.id === item.workstreamId
                  ? {
                      ...w,
                      changed: [
                        `Posted GitHub PR comment (outbox → gh).`,
                        ...w.changed,
                      ],
                    }
                  : w
              ),
            });
          }
        }

        // BUG-C5-1: keep this item selected so Review shows approved + comment link
        // (list filter includes approved/posted). Do not auto-advance away.
        set({ selectedReviewId: id });
        get().recomputeMode();
      },

      applyGithubOutboxFailed: (id, error) => {
        const item = get().reviewQueue.find((r) => r.id === id);
        if (!item) return;
        // Fail closed: return to pending so the user can retry Post.
        set({
          reviewQueue: get().reviewQueue.map((r) =>
            r.id === id
              ? {
                  ...r,
                  status: "pending",
                  githubQueueStatus: "failed",
                  // keep githubOutboxId for diagnostics
                }
              : r
          ),
        });
        get().openConfirm({
          title: "GitHub outbox failed",
          body: item.draftText ?? "",
          confirmLabel: "Dismiss",
          subtitle:
            error ||
            "Poster reported failure. Review is pending again — nothing was posted.",
          onConfirm: () => get().closeConfirm(),
        });
      },

      approveAgentPermission: (agentId) => {
        set({
          agents: get().agents.map((a) =>
            a.id === agentId
              ? {
                  ...a,
                  status: "Complete",
                  detail: "Permission granted — outline doc created (mocked).",
                  permissionRequest: undefined,
                  completedAt: "just now",
                }
              : a
          ),
        });
      },

      dismissAgentPermission: (agentId) => {
        set({
          agents: get().agents.map((a) =>
            a.id === agentId
              ? {
                  ...a,
                  status: "Failed",
                  detail: "Permission dismissed — agent stopped.",
                  permissionRequest: undefined,
                }
              : a
          ),
        });
      },
    }),
    {
      name: "control-v0",
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (state) => ({
        mode: state.mode,
        focusWorkstreamId: state.focusWorkstreamId,
        workstreams: state.workstreams,
        attention: state.attention,
        // BUG-W4 3rd pass: do not persist agents / reviewQueue /
        // autoKickedReviewKeys — Demo Surface checks + stale auto-kick keys
        // must not survive into Live. Wipe-on-Live-enter is the product fix;
        // excluding these keeps hard refresh from rehydrating pollution.
        usedDelegationIds: state.usedDelegationIds,
        appliedGithubEventIds: state.appliedGithubEventIds,
        appliedSlackEventIds: state.appliedSlackEventIds,
        fyi: state.fyi,
        selectedReviewId: state.selectedReviewId,
        sources: state.sources,
        suggestedDelegations: state.suggestedDelegations,
      }),
    }
  )
);
