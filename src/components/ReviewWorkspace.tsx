"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useControlStore } from "@/lib/store";

export function ReviewWorkspace({ itemId }: { itemId: string }) {
  const item = useControlStore((s) =>
    s.reviewQueue.find((r) => r.id === itemId)
  );
  const approveReview = useControlStore((s) => s.approveReview);
  const rejectReview = useControlStore((s) => s.rejectReview);
  const editReviewDraft = useControlStore((s) => s.editReviewDraft);
  const pollSlackOutbox = useControlStore((s) => s.pollSlackOutbox);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item?.draftText ?? "");
  const [selectedFinding, setSelectedFinding] = useState(
    item?.findings[0]?.id ?? null
  );

  // Resume polling if we remount while still queued (e.g. refresh / navigate back).
  useEffect(() => {
    if (
      item?.status === "queued" &&
      item.slackOutboxId &&
      item.slackQueueStatus === "pending"
    ) {
      pollSlackOutbox(item.id, item.slackOutboxId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.status, item?.slackOutboxId, item?.slackQueueStatus]);

  if (!item) return null;

  const finding =
    item.findings.find((f) => f.id === selectedFinding) ?? item.findings[0];
  const isQueued = item.status === "queued";
  const queuePending = isQueued && item.slackQueueStatus !== "failed";

  return (
    <div className="px-8 py-6 max-w-3xl space-y-5">
      <header>
        <div className="chip mb-2">{item.label}</div>
        <h2 className="text-[20px] font-semibold leading-7">{item.title}</h2>
        <p className="mt-2 text-[13px] text-muted">{item.analysisNote}</p>
        {item.kind === "pr_review" && (
          <p className="mt-2 text-[12px] text-amber">
            Analysis, not truth · No findings ≠ approved
          </p>
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
                  onClick={() => approveReview(item.id)}
                >
                  Approve analysis
                </button>
                <button
                  type="button"
                  className="btn-danger"
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
            </section>
          )}
        </>
      )}

      <footer className="text-[12px] text-muted border-t border-border pt-4">
        {item.scopeFooter}
      </footer>
    </div>
  );
}
