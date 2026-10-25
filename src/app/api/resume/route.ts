import { NextRequest, NextResponse } from "next/server";
import { getResume } from "@/lib/resume-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resume[?ensure_next=1] — Live Resume card: selected workstream (derived from real
 * inbox/snapshot/job data), what changed since your last action, pick-up context, and Claude's
 * "Next" (resume_next job, cached per workstream + activity hash). ensure_next=1 enqueues the
 * job when the cache is stale. Never posts anything anywhere.
 */
export async function GET(req: NextRequest) {
  try {
    const ensureNext = req.nextUrl.searchParams.get("ensure_next") === "1";
    return NextResponse.json(await getResume({ ensureNext }));
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "resume failed" },
      { status: 500 }
    );
  }
}
