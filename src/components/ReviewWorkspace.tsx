"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useControlStore } from "@/lib/store";
import {
  repoPrFromReviewTitle,
  type PrSnapshot,
} from "@/lib/pr-snapshot-client";

const FILE_CAP = 20;

type SnapshotState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; snapshot: PrSnapshot; path: string }
  | { status: "missing"; detail: string; path?: string }
  | { status: "error"; detail: string };

function ciChipClass(conclusion: string): string {
  const c = conclusion.toUpperCase();
  if (c === "FAILURE") return "border-blocked/50 text-blocked";
  if (c === "PENDING") return "border-amber/50 text-amber";
  if (c === "SUCCESS") return "border-border text-muted"; // not "approved"
  return "border-border text-muted";
}

export function ReviewWorkspace({ itemId }: { itemId: string }) {
  const item = useControlStore((s) =>
    s.reviewQueue.find((r) => r.id === itemId)
  );
  const approveReview = useControlStore((s) => s.approveReview);
  const rejectReview = useControlStore((s) => s.rejectReview);
  const editReviewDraft = useControlStore((s) => s.editReviewDraft);
  const pollSlackOutbox = useControlStore((s) => s.pollSlackOutbox);
  const pollGithubOutbox = useControlStore((s) => s.pollGithubOutbox);
  const openConfirm = useControlStore((s) => s.openConfirm);
  const confirmPostGithub = useControlStore((s) => s.confirmPostGithub);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item?.draftText ?? "");
  const [commentDraft, setCommentDraft] = useState(item?.draftText ?? "");
  const [selectedFinding, setSelectedFinding] = useState(
    item?.findings[0]?.id ?? null
  );
  const [snapState, setSnapState] = useState<SnapshotState>({ status: "idle" });

  const repoPr = useMemo(() => {
    if (!item || item.kind !== "pr_review") return null;
    if (item.repo && item.pr && item.pr > 0) {
      return { repo: item.repo, pr: item.pr };
    }
    return repoPrFromReviewTitle(item.title);
  }, [item]);

  // Resume polling if we remount while still queued (e.g. refresh / navigate back).
  useEffect(() => {
    if (
      item?.status === "queued" &&
      item.slackOutboxId &&
      item.slackQueueStatus === "pending"
    ) {
      pollSlackOutbox(item.id, item.slackOutboxId);
    }
    if (
      item?.status === "queued" &&
      item.githubOutboxId &&
      item.githubQueueStatus === "pending"
    ) {
      pollGithubOutbox(item.id, item.githubOutboxId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    item?.id,
    item?.status,
    item?.slackOutboxId,
    item?.slackQueueStatus,
    item?.githubOutboxId,
    item?.githubQueueStatus,
  ]);

  // Chip 4: load gh snapshot for Live pr_review (Control reads disk via API).
  useEffect(() => {
    if (!item || item.kind !== "pr_review") {
      setSnapState({ status: "idle" });
      return;
    }
    if (!repoPr) {
      // Seed / Demo narrative reviews may lack repo#pr — empty state, no crash.
      setSnapState({
        status: "missing",
        detail: "Snapshot missing — run watcher",
      });
      return;
    }
    let cancelled = false;
    setSnapState({ status: "loading" });
    const q = new URLSearchParams({
      repo: repoPr.repo,
      pr: String(repoPr.pr),
    });
    void (async () => {
      try {
        const res = await fetch(`/api/github/snapshot?${q.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          snapshot?: PrSnapshot;
          path?: string;
          error?: string;
          detail?: string;
        };
        if (cancelled) return;
        if (res.status === 404) {
          setSnapState({
            status: "missing",
            detail:
              data.error ||
              data.detail ||
              "Snapshot missing — run watcher",
            path: data.path,
          });
          return;
        }
        if (!res.ok || !data.snapshot) {
          setSnapState({
            status: "error",
            detail: data.error || data.detail || "Failed to load snapshot",
          });
          return;
        }
        setSnapState({
          status: "ok",
          snapshot: data.snapshot,
          path: data.path || "",
        });
      } catch (err) {
        if (cancelled) return;
        setSnapState({
          status: "error",
          detail:
            err instanceof Error ? err.message : "Failed to load snapshot",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.kind, repoPr?.repo, repoPr?.pr]);

  useEffect(() => {
    setDraft(item?.draftText ?? "");
    setCommentDraft(item?.draftText ?? "");
    setSelectedFinding(item?.findings[0]?.id ?? null);
  }, [item?.id, item?.draftText, item?.findings]);

  if (!item) return null;

  const finding =
    item.findings.find((f) => f.id === selectedFinding) ?? item.findings[0];
  const isQueued = item.status === "queued";
  const queuePending = isQueued && item.slackQueueStatus !== "failed";
  const githubQueuePending =
    isQueued &&
    Boolean(item.githubOutboxId) &&
    item.githubQueueStatus !== "failed";
  const githubTargetLabel = repoPr
    ? `${repoPr.repo}#${repoPr.pr}`
    : item.repo && item.pr
      ? `${item.repo}#${item.pr}`
      : "GitHub";

  const reviewId = item.id;
  const requestPostGithubComment = () => {
    const body = commentDraft;
    openConfirm({
      title: "Post to GitHub?",
      body,
      confirmLabel: `Post comment to ${githubTargetLabel}`,
      subtitle:
        "Queues a durable outbox record for the local gh/MCP poster — comment-only (no approve/merge). Cancel leaves Review unchanged.",
      onConfirm: () => confirmPostGithub(reviewId, body),
    });
  };

  const snapshot = snapState.status === "ok" ? snapState.snapshot : null;
  const headerTitle = snapshot?.title?.trim() || item.title;
  const openPrUrl =
    snapshot?.url ||
    item.prUrl ||
    (repoPr
      ? `https://github.com/${repoPr.repo}/pull/${repoPr.pr}`
      : null);
  const files = (snapshot?.files ?? []).slice(0, FILE_CAP);
  const filesMore = Math.max(0, (snapshot?.files?.length ?? 0) - FILE_CAP);

  return (
    <div className="px-8 py-6 max-w-3xl space-y-5">
      <header>
        <div className="chip mb-2">{item.label}</div>
        <h2 className="text-[20px] font-semibold leading-7">{headerTitle}</h2>
        <p className="mt-2 text-[13px] text-muted">{item.analysisNote}</p>
        {item.kind === "pr_review" && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="text-[12px] text-amber">
              Analysis, not truth · No findings ≠ approved
            </p>
            {openPrUrl ? (
              <a
                href={openPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-review hover:underline"
              >
                Open PR ↗
              </a>
            ) : null}
          </div>
        )}
      </header>

      {item.kind === "slack_draft" ? (
        <section className="panel p-5 space-y-4">
          <div className="text-[12px] text-muted space-y-1">
            <div>Target: {item.targetLabel}</div>
            {item.slackTarget ? (
              <div className="font-mono text-[11px]">
                {item.slackTarget.channelId} · thread_ts{" "}
                {item.slackTarget.threadTs}
                {" · "}
                <a
                  href={item.slackTarget.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-review hover:underline"
                >
                  open harness thread
                </a>
              </div>
            ) : null}
            {queuePending ? (
              <div className="rounded-lg border border-review/40 bg-[#161b28] px-3 py-2 text-[12px] leading-5 text-review">
                Queued for Slack (awaiting MCP poster)
                {item.slackOutboxId ? (
                  <span className="ml-2 font-mono text-[11px] text-muted">
                    {item.slackOutboxId}
                  </span>
                ) : null}
              </div>
            ) : null}
            {item.slackQueueStatus === "failed" && item.status === "pending" ? (
              <div className="rounded-lg border border-blocked/40 bg-[#2a1816] px-3 py-2 text-[12px] leading-5 text-blocked">
                Outbox failed — review is pending again. Retry Approve when ready.
              </div>
            ) : null}
            {item.postedReply?.permalink ? (
              <div className="text-[11px] text-running">
                Posted{" "}
                <a
                  href={item.postedReply.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  reply {item.postedReply.ts}
                </a>
              </div>
            ) : null}
          </div>
          {editing ? (
            <textarea
              className="w-full min-h-[140px] rounded-lg border border-border bg-bg p-3 text-[13px] leading-5 outline-none focus:border-review"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <pre className="whitespace-pre-wrap rounded-lg border border-border bg-bg p-3 text-[13px] leading-5 font-sans">
              {item.draftText}
            </pre>
          )}
          <div className="flex flex-wrap gap-2">
            {editing ? (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    editReviewDraft(item.id, draft);
                    setEditing(false);
                  }}
                >
                  Save edit
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setDraft(item.draftText ?? "");
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                {!isQueued ? (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => approveReview(item.id)}
                  >
                    Approve…
                  </button>
                ) : (
                  <button type="button" className="btn-primary" disabled>
                    Queued…
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={isQueued}
                  onClick={() => {
                    setDraft(item.draftText ?? "");
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => rejectReview(item.id)}
                >
                  Reject
                </button>
                <Link
                  href="/source/slack/slack-infra"
                  className="btn-ghost"
                >
                  Open source
                </Link>
              </>
            )}
          </div>
        </section>
      ) : (
        <>
          {/* Chip 4 — PR snapshot panel (title/CI/files from gh; not seed lorem) */}
          {item.kind === "pr_review" && (
            <section className="panel p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[12px] uppercase tracking-wide text-muted">
                  PR snapshot
                </h3>
                <span className="text-[11px] text-muted">
                  Analysis overlay · not an approval
                </span>
              </div>

              {snapState.status === "loading" ? (
                <div className="text-[13px] text-muted">Loading snapshot…</div>
              ) : null}

              {snapState.status === "missing" || snapState.status === "error" ? (
                <div className="rounded-lg border border-amber/40 bg-[#241c10] px-3 py-3 text-[13px] leading-5 space-y-2">
                  <div className="text-amber font-medium">
                    {snapState.status === "missing"
                      ? "Snapshot missing — run watcher"
                      : snapState.detail}
                  </div>
                  <p className="text-muted text-[12px]">
                    Findings below still render. Refresh the snapshot with:
                  </p>
                  <pre className="whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 font-mono text-[11px] text-muted">
                    {repoPr
                      ? `./scripts/github-pr-snapshot.sh --repo ${repoPr.repo} --pr ${repoPr.pr}\n# or: ./scripts/github-watcher-tick.sh`
                      : `./scripts/github-watcher-tick.sh`}
                  </pre>
                </div>
              ) : null}

              {snapshot ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span
                      className={`chip ${ciChipClass(snapshot.ci.conclusion)}`}
                    >
                      CI · {snapshot.ci.conclusion}
                    </span>
                    {snapshot.ci.url ? (
                      <a
                        href={snapshot.ci.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-review hover:underline"
                      >
                        Open checks ↗
                      </a>
                    ) : null}
                    <span className="font-mono text-muted">
                      head {snapshot.head_sha.slice(0, 7) || "—"}
                    </span>
                    <span className="text-muted">
                      {snapshot.repo}#{snapshot.pr}
                    </span>
                  </div>

                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted mb-2">
                      Changed files
                      {snapshot.files.length
                        ? ` · ${snapshot.files.length}`
                        : ""}
                    </div>
                    {files.length === 0 ? (
                      <div className="text-[13px] text-muted">
                        No files in snapshot.
                      </div>
                    ) : (
                      <ul className="space-y-1">
                        {files.map((f) => (
                          <li
                            key={`${f.status}:${f.path}`}
                            className="row flex items-center gap-2 px-3 py-1.5"
                          >
                            <span className="chip font-mono text-[10px] shrink-0">
                              {f.status}
                            </span>
                            <span className="font-mono text-[12px] truncate">
                              {f.path}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {filesMore > 0 ? (
                      <div className="mt-1 text-[11px] text-muted">
                        +{filesMore} more (showing {FILE_CAP})
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-[12px] uppercase tracking-wide text-muted">
              Findings
            </h3>
            {item.findings.length === 0 ? (
              <div className="row px-4 py-3 text-[13px] text-muted">
                No findings in this analysis. That is not an approval.
              </div>
            ) : (
              <ul className="space-y-2">
                {item.findings.map((f, idx) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedFinding(f.id)}
                      className={`w-full text-left row px-4 py-3 transition ${
                        finding?.id === f.id
                          ? "border-review/50"
                          : "hover:border-muted/40"
                      }`}
                    >
                      <div className="text-[11px] text-muted mb-1">
                        Finding {idx + 1}
                      </div>
                      <div className="text-[13px] font-medium">{f.title}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {finding && (
            <section className="panel p-5 space-y-4">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted mb-1">
                  Why
                </div>
                <p className="text-[13px] leading-5">{finding.body}</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted mb-2">
                  Evidence
                </div>
                <ul className="space-y-2">
                  {finding.evidence.map((e, i) => {
                    const external =
                      e.url && /^https:\/\//i.test(e.url) ? e.url : null;
                    const body = (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="chip font-mono text-[10px]">
                            {e.kind}
                          </span>
                          <span className="text-[13px] font-medium">
                            {e.title}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] font-mono text-muted">
                          {e.locator}
                        </div>
                        <div className="mt-1 text-[12px] text-muted italic">
                          “{e.excerpt}”
                        </div>
                      </>
                    );
                    return (
                      <li key={`${e.locator}-${i}`}>
                        {external ? (
                          <a
                            href={external}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="row block px-3 py-2.5 hover:border-muted/40"
                          >
                            {body}
                          </a>
                        ) : (
                          <Link
                            href={`/source/${e.kind}/${e.sourceId}`}
                            className="row block px-3 py-2.5 hover:border-muted/40"
                          >
                            {body}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={githubQueuePending}
                  onClick={() => approveReview(item.id)}
                >
                  Approve analysis
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={githubQueuePending}
                  onClick={() => rejectReview(item.id)}
                >
                  Reject
                </button>
                {finding.evidence[0] &&
                  (finding.evidence[0].url &&
                  /^https:\/\//i.test(finding.evidence[0].url) ? (
                    <a
                      href={finding.evidence[0].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost"
                    >
                      Open source
                    </a>
                  ) : (
                    <Link
                      href={`/source/${finding.evidence[0].kind}/${finding.evidence[0].sourceId}`}
                      className="btn-ghost"
                    >
                      Open source
                    </Link>
                  ))}
              </div>


              {/* Chip 5 — GitHub comment outbox (confirm-gated; no PAT in Control) */}
              {item.kind === "pr_review" ? (
                <div className="border-t border-border pt-4 space-y-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted">
                    Draft comment
                  </div>
                  {githubQueuePending ? (
                    <div className="rounded-lg border border-review/40 bg-[#161b28] px-3 py-2 text-[12px] leading-5 text-review">
                      Queued for GitHub (awaiting poster)
                      {item.githubOutboxId ? (
                        <span className="ml-2 font-mono text-[11px] text-muted">
                          {item.githubOutboxId}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {item.githubQueueStatus === "failed" &&
                  item.status === "pending" ? (
                    <div className="rounded-lg border border-blocked/40 bg-[#2a1816] px-3 py-2 text-[12px] leading-5 text-blocked">
                      Outbox failed — review is pending again. Retry Post when
                      ready.
                    </div>
                  ) : null}
                  {item.postedGithubComment?.url ? (
                    <div className="text-[11px] text-running">
                      Posted{" "}
                      <a
                        href={item.postedGithubComment.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        comment on GitHub ↗
                      </a>
                    </div>
                  ) : null}
                  <textarea
                    className="w-full min-h-[96px] rounded-lg border border-border bg-bg p-3 text-[13px] leading-5 outline-none focus:border-review disabled:opacity-60 disabled:cursor-not-allowed"
                    disabled={githubQueuePending || item.status === "approved"}
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    placeholder="Draft a PR comment (markdown) — posts only after confirm"
                    aria-label="Draft GitHub comment"
                  />
                  <div className="flex flex-wrap gap-2">
                    {githubQueuePending ? (
                      <button type="button" className="btn-secondary" disabled>
                        Queued…
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={
                          item.status === "approved" ||
                          item.status === "rejected" ||
                          !commentDraft.trim() ||
                          !repoPr
                        }
                        title={
                          !repoPr
                            ? "Need repo#pr to post"
                            : "Confirm, then local gh posts comment-only"
                        }
                        onClick={requestPostGithubComment}
                      >
                        Post comment…
                      </button>
                    )}
                  </div>
                </div>
              ) : null}
            </section>
          )}

          {/* Actions when no findings but still pr_review */}
          {!finding && item.kind === "pr_review" ? (
            <section className="panel p-5 space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={githubQueuePending}
                  onClick={() => approveReview(item.id)}
                >
                  Approve analysis
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={githubQueuePending}
                  onClick={() => rejectReview(item.id)}
                >
                  Reject
                </button>
              </div>

              {/* Chip 5 — GitHub comment outbox (confirm-gated; no PAT in Control) */}
              {item.kind === "pr_review" ? (
                <div className="border-t border-border pt-4 space-y-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted">
                    Draft comment
                  </div>
                  {githubQueuePending ? (
                    <div className="rounded-lg border border-review/40 bg-[#161b28] px-3 py-2 text-[12px] leading-5 text-review">
                      Queued for GitHub (awaiting poster)
                      {item.githubOutboxId ? (
                        <span className="ml-2 font-mono text-[11px] text-muted">
                          {item.githubOutboxId}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {item.githubQueueStatus === "failed" &&
                  item.status === "pending" ? (
                    <div className="rounded-lg border border-blocked/40 bg-[#2a1816] px-3 py-2 text-[12px] leading-5 text-blocked">
                      Outbox failed — review is pending again. Retry Post when
                      ready.
                    </div>
                  ) : null}
                  {item.postedGithubComment?.url ? (
                    <div className="text-[11px] text-running">
                      Posted{" "}
                      <a
                        href={item.postedGithubComment.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        comment on GitHub ↗
                      </a>
                    </div>
                  ) : null}
                  <textarea
                    className="w-full min-h-[96px] rounded-lg border border-border bg-bg p-3 text-[13px] leading-5 outline-none focus:border-review disabled:opacity-60 disabled:cursor-not-allowed"
                    disabled={githubQueuePending || item.status === "approved"}
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    placeholder="Draft a PR comment (markdown) — posts only after confirm"
                    aria-label="Draft GitHub comment"
                  />
                  <div className="flex flex-wrap gap-2">
                    {githubQueuePending ? (
                      <button type="button" className="btn-secondary" disabled>
                        Queued…
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={
                          item.status === "approved" ||
                          item.status === "rejected" ||
                          !commentDraft.trim() ||
                          !repoPr
                        }
                        title={
                          !repoPr
                            ? "Need repo#pr to post"
                            : "Confirm, then local gh posts comment-only"
                        }
                        onClick={requestPostGithubComment}
                      >
                        Post comment…
                      </button>
                    )}
                  </div>
                </div>
              ) : null}

            </section>
          ) : null}
        </>
      )}

      <footer className="text-[12px] text-muted border-t border-border pt-4">
        {item.scopeFooter}
      </footer>
    </div>
  );
}
