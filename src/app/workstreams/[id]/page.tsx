"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useControlStore } from "@/lib/store";

export default function WorkstreamDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const workstreams = useControlStore((s) => s.workstreams);
  const agents = useControlStore((s) => s.agents);
  const startFocus = useControlStore((s) => s.startFocus);
  const ws = workstreams.find((w) => w.id === id);

  if (!ws) {
    return (
      <div className="px-8 py-8 text-muted">
        Workstream not found.{" "}
        <Link href="/workstreams" className="text-review">
          Back
        </Link>
      </div>
    );
  }

  const wsAgents = agents.filter((a) => ws.agentIds.includes(a.id) || a.workstreamId === ws.id);

  return (
    <div className="mx-auto max-w-3xl px-8 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="chip">{ws.phase}</span>
            {ws.waitingOn && (
              <span
                className={`chip ${
                  ws.waitingOn === "you"
                    ? "border-amber/40 text-amber"
                    : ""
                }`}
              >
                Waiting on {ws.waitingOn}
              </span>
            )}
          </div>
          <h1 className="text-[20px] font-semibold leading-7">{ws.name}</h1>
          <p className="mt-2 text-[13px] text-muted">
            Last active {ws.lastActive}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => startFocus(ws.id)}
          >
            Start focus
          </button>
          <Link href="/now" className="btn-ghost">
            Now
          </Link>
        </div>
      </div>

      <section className="panel p-5">
        <h2 className="text-[11px] uppercase tracking-wide text-muted mb-2">
          Where am I
        </h2>
        <p className="text-[13px] leading-5">{ws.objective}</p>
      </section>

      <section className="rounded-xl border border-review/30 bg-surface p-5">
        <h2 className="text-[11px] uppercase tracking-wide text-review mb-2">
          Checkpoint
        </h2>
        <p className="text-[13px] leading-5 whitespace-pre-wrap">
          {ws.checkpoint}
        </p>
      </section>

      <section className="panel p-5 space-y-4">
        <div>
          <h2 className="text-[11px] uppercase tracking-wide text-muted mb-1">
            Next
          </h2>
          <p className="text-[13px]">{ws.next}</p>
        </div>
        <div>
          <h2 className="text-[11px] uppercase tracking-wide text-muted mb-1">
            What changed
          </h2>
          <ul className="space-y-1">
            {ws.changed.map((c) => (
              <li key={c} className="text-[13px] text-text/90">
                · {c}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-3">Artifacts</h2>
        {ws.artifacts.length === 0 ? (
          <div className="text-[12px] text-muted">No artifacts yet.</div>
        ) : (
          <ul className="space-y-2">
            {ws.artifacts.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/source/${a.kind}/${a.sourceId}`}
                  className="row flex items-center gap-3 px-4 py-3 hover:border-muted/40"
                >
                  <span className="chip font-mono text-[11px]">{a.label}</span>
                  <span className="text-[13px]">{a.detail}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-3">Agents</h2>
        <ul className="space-y-2">
          {wsAgents.map((a) => (
            <li key={a.id} className="row px-4 py-3 flex items-center gap-3">
              <StatusDot status={a.status} />
              <div className="flex-1">
                <div className="text-[13px] font-medium">{a.name}</div>
                <div className="text-[12px] text-muted">{a.detail}</div>
              </div>
              <span className="text-[12px] text-muted">{a.status}</span>
            </li>
          ))}
          {wsAgents.length === 0 && (
            <li className="text-[12px] text-muted">No agents on this workstream.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "Running"
      ? "bg-running"
      : status === "Complete"
        ? "bg-review"
        : status === "Blocked on permission"
          ? "bg-blocked"
          : status === "Failed"
            ? "bg-blocked"
            : "bg-muted";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}
