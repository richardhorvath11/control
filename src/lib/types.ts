export type Mode = "morning" | "focus" | "clear";

export type WorkstreamPhase =
  | "Human review"
  | "Paused"
  | "Draft"
  | "Running"
  | "Delegated"
  | "Blocked";

export type AgentStatus =
  | "Running"
  | "Waiting"
  | "Failed"
  | "Blocked on permission"
  | "Complete";

export type ReviewKind = "pr_review" | "slack_draft" | "investigation";

export type ProvenanceKind = "slack" | "github" | "rfc" | "calendar";

export interface Provenance {
  kind: ProvenanceKind;
  title: string;
  locator: string;
  excerpt: string;
  sourceId: string;
  timestamp?: string;
  /** Live GitHub https URL — Open source opens externally when set */
  url?: string;
}

export interface Artifact {
  id: string;
  kind: ProvenanceKind;
  label: string;
  detail: string;
  sourceId: string;
}

export interface Workstream {
  id: string;
  name: string;
  phase: WorkstreamPhase;
  objective: string;
  next: string;
  changed: string[];
  waitingOn: string;
  lastActive: string;
  checkpoint: string;
  artifacts: Artifact[];
  agentIds: string[];
  status: "default" | "idle" | "running" | "blocked-on-you";
  /** Short-lived delegate job; hidden from Active when active===false */
  ephemeral?: boolean;
  /** false = leave Active sidebar; remains in workstreams list (searchable) */
  active?: boolean;
}

export interface AttentionItem {
  id: string;
  routing: "now" | "review" | "fyi" | "archive";
  title: string;
  why: string;
  workstreamId?: string;
  suggestedAction: "delegate" | "open_review" | "open" | "resume";
  provenance: Provenance[];
  createdAt: string;
  resolved?: boolean;
  /** Seed vs live external inbox — external (github|slack|external) Needs-you capped at NEEDS_YOU_EXTERNAL_CAP; seed Monday items are not demoted. Coalesced review-asks use origin "external". */
  origin?: "seed" | "github" | "slack" | "external";
  /** Present on coalesced Slack↔GitHub review-ask Needs-you (normalize(repo)#pr) */
  coalesceKey?: string;
  githubEventId?: string;
  githubDedupeKey?: string;
  slackEventId?: string;
  slackDedupeKey?: string;
}

export interface Finding {
  id: string;
  title: string;
  body: string;
  evidence: Provenance[];
}

/** Real Slack E2E harness target for slack_draft posts. */
export interface SlackTarget {
  workspace: string;
  channelId: string;
  threadTs: string;
  permalink: string;
  channelName?: string;
}

export interface PostedSlackReply {
  ts: string;
  channel?: string;
  permalink?: string;
}

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  title: string;
  workstreamId?: string;
  label: string;
  analysisNote: string;
  findings: Finding[];
  scopeFooter: string;
  draftText?: string;
  targetLabel?: string;
  /** Real Slack thread to post into (E2E harness). */
  slackTarget?: SlackTarget;
  /** Optional provenance pointing at the harness / mock source. */
  provenance?: Provenance[];
  /** Filled after MCP poster acks the outbox item. */
  postedReply?: PostedSlackReply;
  /** Durable outbox id while awaiting Slack MCP poster. */
  slackOutboxId?: string;
  /** Queue status mirrored from outbox until ack/fail. */
  slackQueueStatus?: "pending" | "posted" | "failed";
  status: "pending" | "queued" | "approved" | "rejected" | "edited";
  agentId?: string;
}

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  workstreamId?: string;
  detail: string;
  startedAt?: string;
  completedAt?: string;
  needsReview?: boolean;
  reviewItemId?: string;
  permissionRequest?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  location?: string;
  notes?: string;
}

export interface SlackThreadSource {
  channel: string;
  title: string;
  messages: { author: string; time: string; body: string }[];
  harness?: {
    workspace: string;
    channelId: string;
    threadTs: string;
    permalink: string;
    fixtureText: string;
  };
}

export interface SeedData {
  clock: string;
  clockLabel: string;
  mode: Mode;
  focusWorkstreamId: string | null;
  dayStrip: {
    meetings: { time: string; title: string; id: string }[];
    focusBlock: string;
  };
  workstreams: Workstream[];
  attention: AttentionItem[];
  reviewQueue: ReviewItem[];
  agents: Agent[];
  suggestedDelegations: {
    id: string;
    label: string;
    kind: "investigate" | "pr_review" | "draft_reply";
    attentionId?: string;
    workstreamId?: string;
  }[];
  /**
   * Seed shape-of-day FYI lines (plain strings).
   * Actionable external FYI (incl. cap-demoted Needs-you) live as AttentionItem
   * with routing="fyi" so provenance / Open source survive demotion.
   */
  fyi: string[];
  sources: {
    slack: Record<string, SlackThreadSource>;
    github: Record<
      string,
      {
        repo: string;
        title: string;
        branch: string;
        status: string;
        ci: { name: string; status: string }[];
        files: { path: string; patch: string }[];
        description: string;
      }
    >;
    rfc: Record<
      string,
      {
        title: string;
        section: string;
        body: string;
      }
    >;
    calendar: Record<string, CalendarEvent>;
  };
}
