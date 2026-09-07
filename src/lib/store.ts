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
  Workstream,
} from "./types";

const initial = seed as SeedData;

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

interface ControlState {
  clockLabel: string;
  mode: Mode;
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
  startFocus: (workstreamId?: string) => void;
  endFocus: () => void;
  setSelectedReview: (id: string | null) => void;
  setLauncherOpen: (open: boolean) => void;
  openConfirm: (modal: ControlState["confirmModal"]) => void;
  closeConfirm: () => void;

  resolveAttention: (id: string) => void;
  updateCheckpoint: (workstreamId: string, text: string) => void;

  delegate: (delegationId: string) => void;
  delegateAttention: (attentionId: string) => void;

  approveReview: (id: string) => void;
  applyApproveReview: (id: string) => void;
  rejectReview: (id: string) => void;
  editReviewDraft: (id: string, text: string) => void;
  confirmPostSlack: (id: string) => Promise<void>;

  approveAgentPermission: (agentId: string) => void;
  dismissAgentPermission: (agentId: string) => void;

  recomputeMode: () => void;
}

export const useControlStore = create<ControlState>()(
  persist(
    (set, get) => ({
      clockLabel: initial.clockLabel,
      mode: initial.mode,
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

      recomputeMode: () => {
        const { mode, needsYou } = get();
        if (mode === "focus") return;
        const open = needsYou();
        set({ mode: open.length === 0 ? "clear" : "morning" });
      },

      delegate: (delegationId) => {
        const del = get().suggestedDelegations.find(
          (d) => d.id === delegationId
        );
        if (!del || get().usedDelegationIds.includes(delegationId)) return;

        const agentId = uid("agent");
        const delay = 3000 + Math.floor(Math.random() * 5000);

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
              "Real Slack write to the E2E harness thread — nothing posts until you confirm. Cancel leaves Review unchanged.",
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
          (r) => r.status === "pending" && r.id !== id
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
          (r) => r.status === "pending" && r.id !== id
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
        if (!item || item.status !== "pending") return;

        const textBody = item.draftText ?? "";
        const channelId =
          item.slackTarget?.channelId ?? "C0BVCSA4T2P";
        const threadTs =
          item.slackTarget?.threadTs ?? "1788808933.776429";

        const modal = get().confirmModal;
        if (modal) {
          set({
            confirmModal: { ...modal, loading: true, error: undefined },
          });
        }

        try {
          const res = await fetch("/api/slack/post", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: textBody,
              channelId,
              threadTs,
            }),
          });

          let data: {
            error?: string;
            ts?: string;
            channel?: string;
            permalink?: string;
          } = {};
          try {
            data = (await res.json()) as typeof data;
          } catch {
            data = {};
          }

          // User cancelled while in flight — do not apply success or reopen.
          if (!get().confirmModal) return;

          if (!res.ok) {
            const current = get().confirmModal;
            if (current) {
              set({
                confirmModal: {
                  ...current,
                  loading: false,
                  error:
                    data.error ||
                    `Slack post failed (HTTP ${res.status}). Nothing was marked approved.`,
                },
              });
            }
            return;
          }

          // Success — only now approve + update local mock UI.
          set({
            reviewQueue: get().reviewQueue.map((r) =>
              r.id === id
                ? {
                    ...r,
                    status: "approved",
                    postedReply: data.ts
                      ? {
                          ts: data.ts,
                          channel: data.channel,
                          permalink: data.permalink,
                        }
                      : r.postedReply,
                  }
                : r
            ),
            confirmModal: null,
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
            const ws = get().workstreams.find(
              (w) => w.id === item.workstreamId
            );
            if (ws) {
              get().updateCheckpoint(
                item.workstreamId,
                ws.checkpoint +
                  ` Posted Slack reply to Priya` +
                  (data.ts ? ` (ts ${data.ts})` : "") +
                  `.`
              );
              set({
                workstreams: get().workstreams.map((w) =>
                  w.id === item.workstreamId
                    ? {
                        ...w,
                        changed: [
                          "Replied to Priya in #control-e2e (E2E harness).",
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
            (r) => r.status === "pending" && r.id !== id
          );
          set({ selectedReviewId: remaining[0]?.id ?? null });
          get().recomputeMode();
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
                    : "Network error posting to Slack. Nothing was marked approved.",
              },
            });
          }
        }
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
        selectedReviewId: state.selectedReviewId,
        sources: state.sources,
        suggestedDelegations: state.suggestedDelegations,
      }),
    }
  )
);
