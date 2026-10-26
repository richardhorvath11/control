"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useControlStore } from "@/lib/store";
import { MANUAL_CHANGED_EVENT } from "@/lib/manual-client";
import { RelTime } from "@/components/RelTime";
import { RemoveWorkstreamButton, type RemovableRow } from "@/components/RemoveWorkstream";

type LiveRow = RemovableRow & { url?: string; last_activity_at: string };
const KIND_LABEL: Record<LiveRow["kind"], string> = { pr: "Pull request", slack: "Slack thread", session: "Claude Code session", manual: "Manual" };

export default function WorkstreamsPage() {
  const live = useControlStore((s) => s.seedLiveMode) === "live";
  return live ? <LiveWorkstreams /> : <DemoWorkstreams />;
}

/** Live: only real workstreams (GitHub / Slack / Claude sessions / manual) from the server. */
function LiveWorkstreams() {
  const [rows, setRows] = useState<LiveRow[] | null>(null);
  const [dismissed, setDismissed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/workstreams/live", { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRows(d.items);
      setDismissed(d.dismissed ?? 0);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, []);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(MANUAL_CHANGED_EVENT, on);
    const id = window.setInterval(on, 30000);
    return () => {
      window.removeEventListener(MANUAL_CHANGED_EVENT, on);
      window.clearInterval(id);
    };
  }, [load]);
  const query = q.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !query || r.title.toLowerCase().includes(query));
  return (
    <div className="mx-auto max-w-4xl px-8 py-8 space-y-6" data-testid="workstreams-live">
      <header>
        <h1 className="text-[20px] font-semibold leading-7">Workstreams</h1>
        <p className="text-[12px] text-muted mt-1">
          Live · pull requests, Slack threads, Claude Code sessions and your manual items
          {dismissed ? ` · ${dismissed} dismissed (hidden until new activity)` : ""}
        </p>
      </header>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search workstreams…"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-review"
      />
      {err && <div className="text-[12px] text-blocked">Couldn&apos;t load: {err}</div>}
      <ul className="space-y-2">
        {shown.map((r) => (
          <li key={r.key} className="row px-4 py-3 flex items-start gap-3" data-testid="ws-live-row" data-ws-key={r.key}>
            <div className="flex-1 min-w-0">
              <span className="chip">{KIND_LABEL[r.kind]}</span>
              <div className="mt-2 text-[15px] font-medium">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{r.title}</a>
                ) : (
                  r.title
                )}
              </div>
              <div className="mt-1 text-[11px] text-muted">Last activity <RelTime at={r.last_activity_at} /></div>
            </div>
            <RemoveWorkstreamButton row={r} onDone={() => void load()} />
          </li>
        ))}
        {rows && shown.length === 0 && (
          <li className="text-[13px] text-muted px-1">{query ? "No matching workstreams." : "No live workstreams yet."}</li>
        )}
      </ul>
    </div>
  );
}

function DemoWorkstreams() {
  const workstreams = useControlStore((s) => s.workstreams);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return workstreams;
    return workstreams.filter(
      (w) =>
        w.name.toLowerCase().includes(query) ||
        w.objective.toLowerCase().includes(query) ||
        w.next.toLowerCase().includes(query)
    );
  }, [workstreams, q]);

  return (
    <div className="mx-auto max-w-4xl px-8 py-8 space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold leading-7">Workstreams</h1>
        <p className="text-[12px] text-muted mt-1">
          Threads of intent — not repos, tickets, or agent sessions
        </p>
      </header>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search workstreams…"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-review"
      />
      <ul className="space-y-2">
        {filtered.map((ws) => (
          <li key={ws.id}>
            <Link
              href={`/workstreams/${ws.id}`}
              className="row block px-4 py-3 hover:border-muted/40 transition"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="chip">{ws.phase}</span>
                {ws.waitingOn === "you" && (
                  <span className="chip border-amber/40 text-amber">
                    Waiting on you
                  </span>
                )}
                {ws.ephemeral && (
                  <span className="chip text-muted">
                    {ws.active === false ? "Completed · ephemeral" : "Ephemeral"}
                  </span>
                )}
              </div>
              <div className="mt-2 text-[15px] font-medium">{ws.name}</div>
              <div className="mt-1 text-[12px] text-muted">
                Next: {ws.next}
              </div>
              <div className="mt-1 text-[11px] text-muted font-mono">
                Last active {ws.lastActive}
              </div>
            </Link>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="text-[13px] text-muted px-1">No matching workstreams.</li>
        )}
      </ul>
    </div>
  );
}
