import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}
import { requestScan } from "@/lib/backfill";
/** POST /api/backfill/scan { lookback_days?, trigger? } — queue a read-only scan for the backfill worker. */
export async function POST(req: NextRequest) {
  const b = (await body(req)) ?? {};
  const trig = ["first_live", "settings", "cmdk", "manual"].includes(String(b.trigger)) ? (b.trigger as "manual") : "manual";
  const r = await requestScan({ lookback_days: b.lookback_days === undefined ? undefined : Number(b.lookback_days), trigger: trig });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, scan: r.scan }, { status: r.status });
  return NextResponse.json({ ok: true, scan: r.scan });
}
