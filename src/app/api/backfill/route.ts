import { NextResponse } from "next/server";
import { backfillSummary } from "@/lib/backfill";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** GET /api/backfill — scan status + per-source progress + pending candidates. Read-only. */
export async function GET() {
  return NextResponse.json({ ok: true, ...(await backfillSummary()) });
}
