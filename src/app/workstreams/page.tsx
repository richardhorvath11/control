"use client";

import Link from "next/link";
import { useControlStore } from "@/lib/store";

export default function WorkstreamsPage() {
  const workstreams = useControlStore((s) => s.workstreams);

  return (
    <div className="mx-auto max-w-4xl px-8 py-8 space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold leading-7">Workstreams</h1>
        <p className="text-[12px] text-muted mt-1">
          Threads of intent — not repos, tickets, or agent sessions
        </p>
      </header>
      <ul className="space-y-2">
        {workstreams.map((ws) => (
          <li key={ws.id}>
            <Link
              href={`/workstreams/${ws.id}`}
              className="row block px-4 py-3 hover:border-muted/40 transition"
            >
              <div className="flex items-center gap-2">
                <span className="chip">{ws.phase}</span>
                {ws.waitingOn === "you" && (
                  <span className="chip border-amber/40 text-amber">
                    Waiting on you
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
      </ul>
    </div>
  );
}
