import { NextRequest, NextResponse } from "next/server";
import { claimNextReviewJob } from "@/lib/review-jobs";

export const runtime = "nodejs";

type Body = { worker_id?: string };

/**
 * POST /api/review/jobs/claim
 * Optional { worker_id? } → 200 { ok, job } or 204 empty.
 * Atomic claim server-side. No filesystem contract for workers.
 */
export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const workerId =
    typeof body.worker_id === "string" ? body.worker_id : undefined;
  try {
    const job = await claimNextReviewJob(workerId);
    if (!job) {
      return new NextResponse(null, { status: 204 });
    }
    return NextResponse.json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Claim failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
