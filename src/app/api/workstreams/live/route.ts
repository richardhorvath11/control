import { NextResponse } from "next/server";
import { listLiveWorkstreams } from "@/lib/resume-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workstreams/live → { ok, items, dismissed } — real workstreams only (PR, Slack, Claude session, manual). */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await listLiveWorkstreams()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
