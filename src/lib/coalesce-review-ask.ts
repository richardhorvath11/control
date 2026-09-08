/**
 * V0.6 chip 3 — Coalesce dual asks (Slack pr_link + GitHub review.requested)
 * for the same normalize(repo)#pr into one Attention Item with dual provenance.
 * Cap counts the coalesced item once. No fuzzy NLP — URL / structured events only.
 */

export type CoalesceProvenance = {
  kind: "slack" | "github" | "rfc" | "calendar";
  title: string;
  locator: string;
  excerpt: string;
  sourceId: string;
  url?: string;
  timestamp?: string;
};

/** Minimal attention shape for merge (store + inbox effects). */
export type ReviewAskAttentionLike = {
  id: string;
  routing: "now" | "fyi" | "review" | "archive";
  title: string;
  why: string;
  workstreamId?: string;
  suggestedAction: "delegate" | "open_review" | "open" | "resume";
  provenance: CoalesceProvenance[];
  createdAt: string;
  resolved?: boolean;
  origin?: "seed" | "github" | "slack" | "external";
  githubEventId?: string;
  githubDedupeKey?: string;
  slackEventId?: string;
  slackDedupeKey?: string;
  /** normalize(repo)#pr — present on coalesce-class Needs-you */
  coalesceKey?: string;
};

const WHY_CAP = 200;

/** lowercase owner/repo (trim, no trailing .git). */
export function normalizeRepo(repo: string): string {
  return (repo ?? "")
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/** Coalesce key: normalize(repo) + "#" + pr_number */
export function reviewAskCoalesceKey(repo: string, pr: number): string {
  return `${normalizeRepo(repo)}#${Math.trunc(pr)}`;
}

/**
 * Stable Attention id: ext-att-review-{owner}-{repo}-{pr}
 * Example: ext-att-review-richardhorvath11-battle-buddy-32
 */
export function reviewAskAttentionId(repo: string, pr: number): string {
  const norm = normalizeRepo(repo);
  const slash = norm.indexOf("/");
  const owner = slash >= 0 ? norm.slice(0, slash) : norm || "unknown";
  const name = slash >= 0 ? norm.slice(slash + 1) : "unknown";
  const safe = (s: string) =>
    s.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return `ext-att-review-${safe(owner)}-${safe(name)}-${Math.trunc(pr)}`;
}

export function isStableReviewAskId(id: string): boolean {
  return typeof id === "string" && id.startsWith("ext-att-review-");
}

/** Legacy per-event ids for this class only (pre-chip-3). */
export function isLegacyReviewAskId(id: string): boolean {
  return (
    typeof id === "string" &&
    (id.startsWith("gh-att-") || id.startsWith("slack-att-"))
  );
}

export function reviewAskTitle(repo: string, pr: number): string {
  return `Review ask · ${normalizeRepo(repo)}#${Math.trunc(pr)}`;
}

function provenanceDedupeKey(p: CoalesceProvenance): string {
  if (p.url && p.url.trim()) return `url:${p.url.trim()}`;
  return `kl:${p.kind}|${(p.locator ?? "").trim()}`;
}

/** Union provenance arrays; dedupe by url or kind+locator; stable sort kind asc. */
export function unionProvenance(
  a: CoalesceProvenance[],
  b: CoalesceProvenance[]
): CoalesceProvenance[] {
  const seen = new Set<string>();
  const out: CoalesceProvenance[] = [];
  for (const p of [...a, ...b]) {
    if (!p || (p.kind !== "slack" && p.kind !== "github" && p.kind !== "rfc" && p.kind !== "calendar")) {
      continue;
    }
    const key = provenanceDedupeKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p });
  }
  out.sort((x, y) => x.kind.localeCompare(y.kind));
  return out;
}

/** Join distinct why clauses with ` · `; cap ~200 chars. */
export function joinWhyClauses(...clauses: (string | undefined | null)[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const c of clauses) {
    if (!c || !c.trim()) continue;
    // Split prior joins so re-merge stays idempotent
    for (const piece of c.split(/\s·\s/)) {
      const t = piece.trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      // Skip demotion suffixes when re-joining (demotion re-applied by cap)
      if (/\(older Needs-you demoted/i.test(t)) continue;
      seen.add(k);
      parts.push(t);
    }
  }
  let joined = parts.join(" · ");
  if (joined.length > WHY_CAP) {
    joined = joined.slice(0, WHY_CAP - 1).trimEnd() + "…";
  }
  return joined;
}

/**
 * Extract coalesce key from an attention item (coalesceKey field, stable id,
 * or github locator / title patterns).
 */
export function coalesceKeyFromAttention(
  a: Pick<ReviewAskAttentionLike, "id" | "title" | "provenance" | "coalesceKey">
): string | null {
  if (a.coalesceKey && /^\S+#\d+$/.test(a.coalesceKey)) {
    return a.coalesceKey.toLowerCase();
  }
  for (const p of a.provenance ?? []) {
    if (p.kind === "github" && p.locator) {
      const m = p.locator.trim().match(/^([^#\s]+)#(\d+)$/);
      if (m) return reviewAskCoalesceKey(m[1], parseInt(m[2], 10));
    }
    if (p.url) {
      const m = p.url.match(
        /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/i
      );
      if (m) return reviewAskCoalesceKey(m[1], parseInt(m[2], 10));
    }
  }
  const tm = (a.title ?? "").match(
    /(?:Review ask|Review requested)\s·\s([^#\s]+)#(\d+)/i
  );
  if (tm) return reviewAskCoalesceKey(tm[1], parseInt(tm[2], 10));
  return null;
}

/**
 * True when this unresolved Needs-you is a coalesce-class review-ask
 * (stable id, or legacy gh/slack att with review-ask title / coalesceKey).
 */
export function isReviewAskNeedsYou(
  a: ReviewAskAttentionLike | null | undefined
): boolean {
  if (!a || a.resolved) return false;
  // Stable / keyed rows stay in the coalesce class even after cap demotion (fyi).
  if (a.coalesceKey || isStableReviewAskId(a.id)) {
    return a.routing === "now" || a.routing === "fyi";
  }
  // Legacy gh-att-* / slack-att-* migration: only open Needs-you review-asks.
  // FYI review.requested (action_on_user:false) must NOT enter coalesce.
  if (a.routing !== "now") return false;
  if (
    isLegacyReviewAskId(a.id) &&
    /^(Review ask|Review requested)\s·/i.test(a.title ?? "")
  ) {
    return true;
  }
  return false;
}

/**
 * Find an existing unresolved attention row to merge into for this coalesce key.
 * Prefers stable id match, then same key + routing now + external origins.
 */
export function findReviewAskMergeTarget(
  attention: ReviewAskAttentionLike[],
  coalesceKey: string,
  stableId: string
): number {
  const key = coalesceKey.toLowerCase();
  // 1. Stable id (even if already coalesced / demoted fyi — reconcile in place)
  const byId = attention.findIndex((a) => a.id === stableId && !a.resolved);
  if (byId >= 0) return byId;

  // 2. Same coalesce key + open (now) + external origin (incl. legacy ids)
  return attention.findIndex((a) => {
    if (a.resolved) return false;
    if (a.routing !== "now") return false;
    const origin = a.origin;
    if (
      origin !== "slack" &&
      origin !== "github" &&
      origin !== "external"
    ) {
      return false;
    }
    if (!isReviewAskNeedsYou(a) && !isLegacyReviewAskId(a.id)) return false;
    const k = coalesceKeyFromAttention(a);
    return k === key;
  });
}

/**
 * Merge incoming review-ask into prev (order-independent).
 * Second writer does not create a second Needs-you — in-place union.
 */
export function mergeReviewAskAttention<T extends ReviewAskAttentionLike>(
  prev: T,
  incoming: T,
  opts?: { watchWorkstreamId?: string; coalesceKey?: string }
): T {
  const key =
    opts?.coalesceKey ||
    prev.coalesceKey ||
    incoming.coalesceKey ||
    coalesceKeyFromAttention(prev) ||
    coalesceKeyFromAttention(incoming) ||
    "";

  let repo = "unknown/unknown";
  let pr = 0;
  const km = key.match(/^(.+)#(\d+)$/);
  if (km) {
    repo = km[1];
    pr = parseInt(km[2], 10);
  }

  const provenance = unionProvenance(
    prev.provenance ?? [],
    incoming.provenance ?? []
  );

  const why = joinWhyClauses(prev.why, incoming.why);

  // workstreamId: prefer watch.workstreamId when provided and either side uses it;
  // else keep existing ephemeral id if already set.
  let workstreamId = prev.workstreamId ?? incoming.workstreamId;
  const watchWs = opts?.watchWorkstreamId;
  if (watchWs) {
    if (prev.workstreamId === watchWs || incoming.workstreamId === watchWs) {
      workstreamId = watchWs;
    } else if (prev.workstreamId) {
      workstreamId = prev.workstreamId;
    } else {
      workstreamId = incoming.workstreamId;
    }
  } else if (prev.workstreamId) {
    workstreamId = prev.workstreamId;
  }

  const createdAt =
    prev.createdAt && incoming.createdAt
      ? prev.createdAt <= incoming.createdAt
        ? prev.createdAt
        : incoming.createdAt
      : prev.createdAt || incoming.createdAt;

  // Prefer "now" unless both are fyi (cap demotion reconcile)
  const routing: ReviewAskAttentionLike["routing"] =
    prev.routing === "now" || incoming.routing === "now" ? "now" : incoming.routing;

  return {
    ...prev,
    ...incoming,
    id: reviewAskAttentionId(repo, pr) || prev.id || incoming.id,
    routing,
    title: reviewAskTitle(repo, pr),
    why,
    workstreamId,
    suggestedAction: "open",
    provenance,
    createdAt,
    resolved: prev.resolved || incoming.resolved,
    origin: "external",
    coalesceKey: key || undefined,
    githubEventId: incoming.githubEventId ?? prev.githubEventId,
    githubDedupeKey: incoming.githubDedupeKey ?? prev.githubDedupeKey,
    slackEventId: incoming.slackEventId ?? prev.slackEventId,
    slackDedupeKey: incoming.slackDedupeKey ?? prev.slackDedupeKey,
  };
}

/**
 * Apply / migrate a coalesce-class attention into the list.
 * Returns { attention, merged: true } when folded into an existing row
 * (caller must NOT unshift a second Needs-you).
 */
export function upsertReviewAskAttention<T extends ReviewAskAttentionLike>(
  attention: T[],
  incoming: T,
  opts?: { watchWorkstreamId?: string }
): { attention: T[]; merged: boolean; index: number } {
  const key =
    incoming.coalesceKey ||
    coalesceKeyFromAttention(incoming) ||
    "";
  if (!key) {
    return { attention, merged: false, index: -1 };
  }
  const stableId =
    isStableReviewAskId(incoming.id)
      ? incoming.id
      : (() => {
          const m = key.match(/^(.+)#(\d+)$/);
          return m
            ? reviewAskAttentionId(m[1], parseInt(m[2], 10))
            : incoming.id;
        })();

  const normalizedIncoming: T = {
    ...incoming,
    id: stableId,
    coalesceKey: key,
    origin: "external",
    title: (() => {
      const m = key.match(/^(.+)#(\d+)$/);
      return m ? reviewAskTitle(m[1], parseInt(m[2], 10)) : incoming.title;
    })(),
  };

  const idx = findReviewAskMergeTarget(attention, key, stableId);
  if (idx < 0) {
    // First writer — insert with stable id
    const next =
      normalizedIncoming.routing === "now"
        ? [normalizedIncoming, ...attention]
        : [...attention, normalizedIncoming];
    return { attention: next, merged: false, index: 0 };
  }

  const prev = attention[idx];
  const merged = mergeReviewAskAttention(prev, normalizedIncoming, {
    watchWorkstreamId: opts?.watchWorkstreamId,
    coalesceKey: key,
  });

  // One-time fold: if prev had legacy id, replace with stable id in place
  const next = attention.map((a, i) => (i === idx ? merged : a));
  // Drop any other legacy duplicates for same key (rare)
  const deduped = next.filter((a, i) => {
    if (i === idx) return true;
    if (a.resolved) return true;
    const k = coalesceKeyFromAttention(a);
    if (k !== key) return true;
    if (!isReviewAskNeedsYou(a) && !isLegacyReviewAskId(a.id)) return true;
    // same key review-ask — drop duplicate row
    return false;
  });

  const newIdx = deduped.findIndex((a) => a.id === merged.id);
  return { attention: deduped, merged: true, index: newIdx };
}
