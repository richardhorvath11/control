"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchBackfill, scanActive, startScan, type BackfillView } from "@/lib/backfill-client";

/** /now (Live): first-launch prompt to scan for existing work; then progress / "N to review". Read-only scan. */
export function BackfillPrompt() {
  const router = useRouter();
  const [v, setV] = useState<BackfillView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => { const x = await fetchBackfill(); if (alive) setV(x); };
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!v) return null;
  const n = v.candidates.length;
  if (!v.ever_scanned) {
    return (
      <div className="panel p-4 flex flex-wrap items-center gap-3 border-running/40" data-testid="backfill-prompt">
        <div className="flex-1 min-w-[16rem]">
          <div className="text-[13px] font-medium">Find the work you already have in flight</div>
          <div className="text-[12px] text-muted">Control only sees new events. A one-time, read-only scan of the last 30 days of Slack, GitHub and Claude Code sessions suggests workstreams for you to accept.</div>
        </div>
        <button className="btn-primary text-[12px]" data-testid="backfill-prompt-start" onClick={async () => { await startScan("first_live"); router.push("/backfill"); }}>Scan for work</button>
      </div>
    );
  }
  if (scanActive(v.scan)) {
    return <Link href="/backfill" className="block panel p-3 text-[12px] text-muted" data-testid="backfill-prompt">Scanning for existing work… view progress →</Link>;
  }
  if (n > 0) {
    return <Link href="/backfill" className="block panel p-3 text-[12px] border-running/40" data-testid="backfill-prompt"><span className="text-text font-medium">{n} suggested workstream{n === 1 ? "" : "s"}</span> <span className="text-muted">from the backfill scan — review →</span></Link>;
  }
  return null;
}
