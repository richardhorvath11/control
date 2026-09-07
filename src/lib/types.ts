export type Mode = "morning" | "focus" | "clear";

export type WorkstreamPhase =
  | "Human review"
  | "Paused"
  | "Draft"
  | "Running"
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
}

export interface Finding {
  id: string;
  title: string;
  body: string;
  evidence: Provenance[];
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
  status: "pending" | "approved" | "rejected" | "edited";
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
  fyi: string[];
  sources: {
    slack: Record<
      string,
      {
        channel: string;
        title: string;
        messages: { author: string; time: string; body: string }[];
      }
    >;
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
