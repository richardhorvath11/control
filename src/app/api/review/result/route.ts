import { NextRequest, NextResponse } from "next/server";
import { readReviewResultFile } from "@/lib/review-runner";

export const runtime = "nodejs";

/**
 * GET /api/review/result?job_id=… — server-side read of .control/review-results/
 * (BUG-RR1: client must not import fs; poll via this API).
 */
export async function GET(req: NextRequest) {
  const jobId = (req.nextUrl.searchParams.get("job_id") || "").trim();
  if (!jobId) {
    return NextResponse.json(
      { ok: false, error: "job_id query required" },
      { status: 400 }
    );
  }

  const outcome = await readReviewResultFile(jobId);
  if (outcome.ok) {
    return NextResponse.json({
      ok: true,
      pending: false,
      result: outcome.result,
      path: outcome.path,
    });
  }
  if (outcome.pending) {
    return NextResponse.json({
      ok: true,
      pending: true,
      job_id: jobId,
    });
  }
  return NextResponse.json(
    { ok: false, pending: false, error: outcome.error, job_id: jobId },
    { status: 400 }
  );
}
