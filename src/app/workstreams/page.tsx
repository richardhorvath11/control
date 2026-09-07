"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useControlStore } from "@/lib/store";

export default function WorkstreamsPage() {
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
