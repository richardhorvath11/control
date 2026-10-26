"use client";
/** Browser helpers for the read-only backfill scan + candidate review. Local HTTP only; nothing posts anywhere. */
import type { Candidate, ScanState } from "./backfill";
import { MANUAL_CHANGED_EVENT } from "./manual-client";

export type BackfillView = {
  ok: boolean;
  scan: ScanState;
  candidates: Candidate[];
  decided: { accepted: number; rejected: number };
  ever_scanned: boolean;
  worker?: { available: boolean; status: string; updated_at: string | null; last_action: string | null };
};

export async function fetchBackfill(): Promise<BackfillView | null> {
  try {
    const r = await fetch("/api/backfill", { cache: "no-store" });
    return r.ok ? ((await r.json()) as BackfillView) : null;
  } catch {
    return null;
  }
}

export async function startScan(trigger: "first_live" | "settings" | "cmdk" | "manual", lookback_days?: number) {
  try {
    const r = await fetch("/api/backfill/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger, ...(lookback_days ? { lookback_days } : {}) }) });
    const j = await r.json();
    return { ok: r.ok || r.status === 409, error: r.ok || r.status === 409 ? undefined : (j.error as string), already: r.status === 409 };
  } catch {
    return { ok: false, error: "Control unreachable" };
  }
}

export async function decideBackfill(body: Record<string, unknown>) {
  const r = await fetch("/api/backfill/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok && body.action !== "rename" && body.action !== "reject" && body.action !== "merge") {
    window.dispatchEvent(new Event(MANUAL_CHANGED_EVENT));
  }
  return { ok: r.ok, error: (j as { error?: string }).error };
}

export const scanActive = (s?: ScanState | null) => !!s && (s.status === "requested" || s.status === "running");
