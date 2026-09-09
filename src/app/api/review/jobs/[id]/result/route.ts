import { NextRequest, NextResponse } from "next/server";
import { completeReviewJob } from "@/lib/review-jobs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/review/jobs/:id/result
 * Body = control.review_result.v1 → persist for Review / Agent Complete import.
 * Invalid body → 4xx, job not done.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = (id || "").trim();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const workerId =
    raw && typeof raw === "object" && typeof (raw as { worker_id?: unknown }).worker_id === "string"
      ? (raw as { worker_id: string }).worker_id
      : undefined;
  const out = await completeReviewJob(jobId, raw, workerId);
  if (!out.ok) {
    return NextResponse.json({ error: out.error }, { status: out.status });
  }
  return NextResponse.json({ ok: true, result: out.result });
}
