"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useControlStore } from "@/lib/store";

type WatcherRow = {
  id: string;
  status: string;
  display_status?: string;
  last_action: string;
  detail?: string;
  updated_at: string;
  stale?: boolean;
};

function relativeTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export default function AgentsPage() {
  const agents = useControlStore((s) => s.agents);
  const approve = useControlStore((s) => s.approveAgentPermission);
  const dismiss = useControlStore((s) => s.dismissAgentPermission);
  const running = agents.filter((a) => a.status === "Running");
  const [watchers, setWatchers] = useState<WatcherRow[]>([]);
  const [watchersError, setWatchersError] = useState<string | null>(null);

  const loadWatchers = useCallback(async () => {
    try {
      const res = await fetch("/api/watchers/status");
      const data = (await res.json()) as {
        ok?: boolean;
        watchers?: WatcherRow[];
        error?: string;
      };
      if (!res.ok || !data.watchers) {
        setWatchersError(data.error ?? "Failed to load watchers");
        return;
      }
      setWatchers(data.watchers);
      setWatchersError(null);
    } catch {
      setWatchersError("Failed to load watchers");
    }
  }, []);

  useEffect(() => {
    void loadWatchers();
    const id = window.setInterval(() => {
      void loadWatchers();
    }, 5000);
    return () => window.clearInterval(id);
  }, [loadWatchers]);

  return (
    <div className="mx-auto max-w-4xl px-8 py-8 space-y-8">
      <header>
        <h1 className="text-[20px] font-semibold leading-7">Agents</h1>
        <p className="text-[12px] text-muted mt-1">
          Status board — not a builder. {running.length} running · watchers via
          HTTP status API.
        </p>
      </header>

      <section className="space-y-3" data-testid="watcher-board">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold leading-6">Watchers</h2>
            <p className="text-[12px] text-muted mt-0.5">
              Workers PUT{" "}
              <code className="text-text">/api/watchers/status</code> on each
              tick. Stale after ~3 min → idle/stale. Empty seed OK.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost text-[12px]"
            onClick={() => void loadWatchers()}
          >
            Refresh
          </button>
        </div>
        {watchersError && (
          <div className="text-[12px] text-blocked">{watchersError}</div>
        )}
        <div className="panel overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Last tick</th>
                <th className="px-4 py-2 font-medium">Last action</th>
              </tr>
            </thead>
            <tbody>
              {watchers.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-3 text-muted text-[12px]"
                  >
                    No watchers reported yet.
                  </td>
                </tr>
              ) : (
                watchers.map((w) => {
                  const status = w.display_status || w.status;
                  return (
                    <tr
                      key={w.id}
                      className="border-b border-border/60 last:border-0"
                      data-watcher-id={w.id}
                    >
                      <td className="px-4 py-2.5 font-mono text-[12px]">
                        {w.id}
                      </td>
                      <td className="px-4 py-2.5">
                        <WatcherStatusPill status={status} />
                      </td>
                      <td className="px-4 py-2.5 text-muted tabular-nums text-[12px]">
                        {relativeTime(w.updated_at)}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-text/90 truncate max-w-xs">
                        {w.last_action || "—"}
                        {w.detail ? (
                          <span className="text-muted"> · {w.detail}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[16px] font-semibold leading-6">Delegated agents</h2>
        <ul className="space-y-2">
          {agents.map((a) => (
            <li key={a.id} className="row px-4 py-3">
              <div className="flex items-start gap-3">
                <StatusPill status={a.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium">{a.name}</div>
                  <div className="text-[12px] text-muted mt-0.5">{a.detail}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted">
                    {a.startedAt && <span>Started {a.startedAt}</span>}
                    {a.completedAt && <span>Completed {a.completedAt}</span>}
                    {a.workstreamId && (
                      <Link
                        href={`/workstreams/${a.workstreamId}`}
                        className="text-review hover:underline"
                      >
                        Workstream
                      </Link>
                    )}
                    {a.needsReview && a.reviewItemId && (
                      <Link
                        href={`/review/${a.reviewItemId}`}
                        className="text-review hover:underline"
                      >
                        Open in Review
                      </Link>
                    )}
                  </div>
                  {a.status === "Blocked on permission" && a.permissionRequest && (
                    <div className="mt-3 rounded-lg border border-blocked/30 bg-bg p-3">
                      <div className="text-[12px] text-blocked mb-2">
                        Permission required
                      </div>
                      <div className="text-[13px] mb-3">{a.permissionRequest}</div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => approve(a.id)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => dismiss(a.id)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function WatcherStatusPill({ status }: { status: string }) {
  const cls =
    status === "ticking"
      ? "border-running/40 text-running"
      : status === "waiting"
        ? "border-amber/40 text-amber"
        : status === "error"
          ? "border-blocked/40 text-blocked"
          : status === "stale"
            ? "border-border text-muted"
            : "text-muted";
  return <span className={`chip shrink-0 ${cls}`}>{status}</span>;
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "Running"
      ? "border-running/40 text-running"
      : status === "Complete"
        ? "border-review/40 text-review"
        : status === "Blocked on permission"
          ? "border-blocked/40 text-blocked"
          : status === "Failed"
            ? "border-blocked/40 text-blocked"
            : "text-muted";
  return <span className={`chip shrink-0 ${cls}`}>{status}</span>;
}
