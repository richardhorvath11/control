"use client";

import { useEffect, useState } from "react";
import { useControlStore } from "@/lib/store";

type StatusPayload = {
  ok?: boolean;
  watch?: { repo: string; pr: number };
  activeFollowCount?: number;
};

/**
 * Visible chip: Demo · seeded Monday | Live · watching {repo}#{pr} (+ follows).
 */
export function ModeBanner() {
  const seedLiveMode = useControlStore((s) => s.seedLiveMode);
  const hydrated = useControlStore((s) => s._hasHydrated);
  const [watchLabel, setWatchLabel] = useState<string | null>(null);
  const [followCount, setFollowCount] = useState(0);

  useEffect(() => {
    if (!hydrated || seedLiveMode !== "live") {
      setWatchLabel(null);
      setFollowCount(0);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/demo/status");
        if (!res.ok) return;
        const data = (await res.json()) as StatusPayload;
        if (cancelled || !data.watch) return;
        setWatchLabel(`${data.watch.repo}#${data.watch.pr}`);
        setFollowCount(
          typeof data.activeFollowCount === "number" ? data.activeFollowCount : 0
        );
      } catch {
        /* offline */
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [hydrated, seedLiveMode]);

  if (!hydrated) return null;

  if (seedLiveMode === "demo") {
    return (
      <div
        className="border-b border-border bg-raised/80 px-4 py-1.5 flex items-center gap-2 text-[12px]"
        data-mode="demo"
      >
        <span className="chip border-amber/40 text-amber">Demo · seeded Monday</span>
        <span className="text-muted">
          Inbox watchers still POST; UI stays on Monday seed until you switch to Live.
        </span>
      </div>
    );
  }

  return (
    <div
      className="border-b border-border bg-raised/80 px-4 py-1.5 flex items-center gap-2 text-[12px]"
      data-mode="live"
    >
      <span className="chip border-running/40 text-running">
        Live · watching {watchLabel ?? "…"}
      </span>
      <span className="text-muted tabular-nums">
        {followCount} follow{followCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}
