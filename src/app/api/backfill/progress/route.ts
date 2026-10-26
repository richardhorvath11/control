import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}
import { BACKFILL_SOURCES, reportProgress, type BackfillSource, type SourceStatus } from "@/lib/backfill";
const ST = ["pending", "running", "done", "skipped", "failed"];
/** PUT /api/backfill/progress { scan_id, source, status, done?, total?, items?, note? } — worker progress. */
export async function PUT(req: NextRequest) {
  const b = await body(req);
  if (!b || typeof b.scan_id !== "string" || !BACKFILL_SOURCES.includes(b.source as BackfillSource) || !ST.includes(String(b.status)))
    return NextResponse.json({ ok: false, error: "scan_id, source, status required" }, { status: 400 });
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const scan = await reportProgress(b.scan_id, b.source as BackfillSource, { status: b.status as SourceStatus, done: n(b.done), total: n(b.total), items: n(b.items), note: typeof b.note === "string" ? b.note : undefined });
  if (!scan) return NextResponse.json({ ok: false, error: "no such running scan" }, { status: 409 });
  return NextResponse.json({ ok: true, scan });
}
