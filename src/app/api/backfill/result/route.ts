import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}
import { finishScan } from "@/lib/backfill";
/** POST /api/backfill/result { scan_id, status: done|failed, raw[], candidates[], error? } — validated server-side (fail closed). */
export async function POST(req: NextRequest) {
  const b = await body(req);
  if (!b || typeof b.scan_id !== "string" || (b.status !== "done" && b.status !== "failed"))
    return NextResponse.json({ ok: false, error: "scan_id and status done|failed required" }, { status: 400 });
  const r = await finishScan(b.scan_id, { status: b.status, raw: Array.isArray(b.raw) ? b.raw : [], candidates: Array.isArray(b.candidates) ? b.candidates : [], error: typeof b.error === "string" ? b.error : undefined });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, scan: r.scan });
}
