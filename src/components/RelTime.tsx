"use client";

import { useEffect, useState } from "react";
import { localTitle, relTime, splitIso } from "@/lib/reltime";

/** Re-render every 30 s so "just now" ages. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** "12 min ago", exact local time on hover. */
export function RelTime({ at, className }: { at?: string | null; className?: string }) {
  const now = useNow();
  if (!at) return null;
  const rel = relTime(at, now);
  if (!rel) return null;
  return (
    <time dateTime={at} title={localTitle(at)} className={className} data-testid="reltime" suppressHydrationWarning>
      {rel}
    </time>
  );
}

/** Free text whose embedded ISO date-times render as <RelTime>. */
export function TimeText({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <>
      {splitIso(text).map((p, i) => ("at" in p ? <RelTime key={i} at={p.at} /> : <span key={i}>{p.text}</span>))}
    </>
  );
}
