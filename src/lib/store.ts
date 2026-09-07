"use client";

import { create } from "zustand";
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
    onConfirm: () => void;
  };
  launcherOpen: boolean;

  pendingReviewCount: () => number;
  runningAgentCount: () => number;
  needsYou: () => AttentionItem[];
  activeWorkstreams: () => Workstream[];

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
  rejectReview: (id: string) => void;
  editReviewDraft: (id: string, text: string) => void;
  confirmPostSlack: (id: string) => void;

  approveAgentPermission: (agentId: string) => void;
  dismissAgentPermission: (agentId: string) => void;

  recomputeMode: () => void;
}

export const useControlStore = create<ControlState>((set, get) => ({
  clockLabel: initial.clockLabel,
  mode: initial.mode,
  focusWorkstreamId: initial.focusWorkstreamId,
  dayStrip: initial.dayStrip,
  workstreams: initial.workstreams as Workstream[],
  attention: initial.attention as AttentionItem[],
  reviewQueue: initial.reviewQueue as ReviewItem[],
  agents: initial.agents as Agent[],
  suggestedDelegations: initial.suggestedDelegations as SeedData["suggestedDelegations"],
  fyi: initial.fyi,
  sources: initial.sources as SeedData["sources"],
  usedDelegationIds: [],
  selectedReviewId: initial.reviewQueue[0]?.id ?? null,
  confirmModal: null,
  launcherOpen: false,

  pendingReviewCount: () =>
    get().reviewQueue.filter((r) => r.status === "pending").length,

  runningAgentCount: () =>
    get().agents.filter((a) => a.status === "Running").length,

  needsYou: () =>
    get().attention.filter((a) => a.routing === "now" && !a.resolved),

  activeWorkstreams: () => get().workstreams,

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
    const del = get().suggestedDelegations.find((d) => d.id === delegationId);
    if (!del || get().usedDelegationIds.includes(delegationId)) return;

    const agentId = uid("agent");
    const delay = 3000 + Math.floor(Math.random() * 5000);

    const newAgent: Agent = {
      id: agentId,
      name: del.label,
      status: "Running",
      workstreamId: del.workstreamId,
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
      let reviewItem: ReviewItem;

      if (del.kind === "investigate") {
        reviewItem = {
          id: reviewId,
          kind: "investigation",
          title: "Investigation: deploy impact of staging rotation",
          workstreamId: del.workstreamId,
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
          workstreamId: del.workstreamId,
          label: "Analysis, not truth",
          analysisNote: "Second-pass review. Findings are claims with evidence.",
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
          workstreamId: del.workstreamId,
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
      });

      // Focus mode: badge only, no UI interrupt. Morning/clear: still no toast.
      get().updateCheckpoint(
        del.workstreamId ?? "ws-cred",
        get().workstreams.find((w) => w.id === (del.workstreamId ?? "ws-cred"))
          ?.checkpoint +
          ` Delegated “${del.label}” completed and landed in Review.`
      );
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
      get().openConfirm({
        title: "Post to mocked Slack?",
        body: item.draftText ?? "",
        confirmLabel: "Post to #infra",
        onConfirm: () => get().confirmPostSlack(id),
      });
      return;
    }

    set({
      reviewQueue: get().reviewQueue.map((r) =>
        r.id === id ? { ...r, status: "approved" } : r
      ),
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

    // Advance queue
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
        get().workstreams.find((w) => w.id === item.workstreamId)!.checkpoint +
          ` You rejected “${item.title}”.`
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

  confirmPostSlack: (id) => {
    const item = get().reviewQueue.find((r) => r.id === id);
    set({
      reviewQueue: get().reviewQueue.map((r) =>
        r.id === id ? { ...r, status: "approved" } : r
      ),
      confirmModal: null,
    });

    // Append to mocked slack
    if (item?.draftText) {
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
                time: "9:12 AM",
                body: item.draftText,
              },
            ],
          },
        };
        set({ sources });
      }
    }

    if (item?.workstreamId) {
      get().updateCheckpoint(
        item.workstreamId,
        get().workstreams.find((w) => w.id === item.workstreamId)!.checkpoint +
          ` Posted Slack reply to Priya.`
      );
      set({
        workstreams: get().workstreams.map((w) =>
          w.id === item.workstreamId
            ? {
                ...w,
                changed: [
                  "Replied to Priya in #infra about deploy impact.",
                  ...w.changed,
                ],
              }
            : w
        ),
      });
    }

    get().resolveAttention("att-priya");

    const remaining = get().reviewQueue.filter(
      (r) => r.status === "pending" && r.id !== id
    );
    set({ selectedReviewId: remaining[0]?.id ?? null });
    get().recomputeMode();
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
}));
