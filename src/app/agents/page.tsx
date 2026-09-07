"use client";

import Link from "next/link";
import { useControlStore } from "@/lib/store";

export default function AgentsPage() {
  const agents = useControlStore((s) => s.agents);
  const approve = useControlStore((s) => s.approveAgentPermission);
  const dismiss = useControlStore((s) => s.dismissAgentPermission);
  const running = agents.filter((a) => a.status === "Running");

  return (
    <div className="mx-auto max-w-4xl px-8 py-8 space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold leading-7">Agents</h1>
        <p className="text-[12px] text-muted mt-1">
          Status board — not a builder. {running.length} running.
        </p>
      </header>

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
    </div>
  );
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
