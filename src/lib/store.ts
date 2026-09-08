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
  parseRepoPrFromCoalesceKey,
  prReviewSimDelayMs,
  type StartPrReviewWorkerArgs,
} from "./pr-review-worker";

const initial = seed as SeedData;

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

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
   * Cleared on Demo reset so a later Live session can kick again.
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
   * Enqueue canned independent PR review worker (Running → Complete → Review).
   * Auto: Live only, once per auto-review:{coalesceKey}; does not resolve Needs-you.
   * Manual: existing Delegate path; may resolve attention when attentionId set.
   */
  startPrReviewWorker: (args: StartPrReviewWorkerArgs) => void;
  /** Live: auto-kick once per coalesce-class Needs-you not yet in autoKickedReviewKeys. */
  maybeAutoKickReviewAsks: () => void;

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
        set({ seedLiveMode: readSeedLiveMode() });
      },

      setSeedLiveMode: (mode) => {
        writeSeedLiveMode(mode);
        set({ seedLiveMode: mode });
        // Optional QA echo — ignore failures (offline / no server).
        void fetch("/api/demo/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        }).catch(() => {});
        if (mode === "demo") {
          get().resetDemoState();
          return;
        }
        // Demo→Live: kick once for review-asks already present, then apply inboxes.
        get().maybeAutoKickReviewAsks();
        void get().syncExternalInboxes().then(() => {
          get().maybeAutoKickReviewAsks();
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

        if (args.source === "auto") {
          if (get().seedLiveMode !== "live") return;
          if (get().autoKickedReviewKeys.includes(idemKey)) return;
          set({
            autoKickedReviewKeys: [...get().autoKickedReviewKeys, idemKey],
          });
        }

        const agentId = uid("agent");
        const delay = prReviewSimDelayMs();
        const newAgent = buildPrReviewAgent({
          id: agentId,
          repo,
          pr,
          workstreamId: args.workstreamId,
          source: args.source,
        });

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

        window.setTimeout(() => {
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

      delegate: (delegationId) => {
        const del = get().suggestedDelegations.find(
          (d) => d.id === delegationId
        );
        if (!del || get().usedDelegationIds.includes(delegationId)) return;

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
          } else if (del.kind === "pr_review") {
            reviewItem = {
              id: reviewId,
              kind: "pr_review",
              title: "Independent review of fix/staging-cred-rotation (fresh)",
              workstreamId: wsId,
              label: "Analysis, not truth",
              analysisNote:
                "Second-pass review. Findings are claims with evidence.",
              findings: [
                {
                  id: uid("f"),
                  title: "Retry constant still diverges from RFC §4.2",
                  body: "MAX_RETRIES remains 5. Same conflict as the Sunday review.",
                  evidence: [
                    {
                      kind: "rfc",
                      title: "RFC §4.2",
                      locator: "§4.2",
                      excerpt: "MUST NOT exceed three retries",
                      sourceId: "rfc-cred",
                    },
                    {
                      kind: "github",
                      title: "retry.ts:48",
                      locator: "packages/creds/src/retry.ts:48",
                      excerpt: "const MAX_RETRIES = 5",
                      sourceId: "pr-cred",
                    },
                  ],
                },
              ],
              scopeFooter:
                "Examined 8 files · 2 callers · 1 RFC. Absence of findings is not approval.",
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
        const matching = get().suggestedDelegations.find(
          (d) => d.attentionId === attentionId
        );
        if (matching) {
          get().delegate(matching.id);
          return;
        }
        // Generic investigate for attention without canned delegation
        const att = get().attention.find((a) => a.id === attentionId);
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
        const channelId = item.slackTarget?.channelId ?? "C0BVCSA4T2P";
        const threadTs = item.slackTarget?.threadTs ?? "1788808933.776429";

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

        const remaining = get().reviewQueue.filter(
          (r) =>
            (r.status === "pending" || r.status === "queued") && r.id !== id
        );
        set({ selectedReviewId: remaining[0]?.id ?? null });
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
        reviewQueue: state.reviewQueue,
        agents: state.agents,
        usedDelegationIds: state.usedDelegationIds,
        appliedGithubEventIds: state.appliedGithubEventIds,
        appliedSlackEventIds: state.appliedSlackEventIds,
        autoKickedReviewKeys: state.autoKickedReviewKeys,
        fyi: state.fyi,
        selectedReviewId: state.selectedReviewId,
        sources: state.sources,
        suggestedDelegations: state.suggestedDelegations,
      }),
    }
  )
);
