import { NextRequest, NextResponse } from "next/server";
import { heartbeatReviewJob } from "@/lib/review-jobs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
type Body = { worker_id?: string };

/** POST /api/review/jobs/:id/heartbeat — refresh claim lease (~60s). */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = (id || "").trim();
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const workerId =
    typeof body.worker_id === "string" ? body.worker_id : undefined;
  const out = await heartbeatReviewJob(jobId, workerId);
  if (!out.ok) {
    return NextResponse.json({ error: out.error }, { status: out.status });
  }
  return NextResponse.json({ ok: true, claim: out.claim });
}
