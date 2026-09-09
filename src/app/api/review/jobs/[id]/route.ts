import { NextRequest, NextResponse } from "next/server";
import { getReviewJobView } from "@/lib/review-jobs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/review/jobs/:id → { ok, job, status } (+ result|error). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = (id || "").trim();
  if (!jobId) {
    return NextResponse.json({ error: "job id required" }, { status: 400 });
  }
  try {
    const view = await getReviewJobView(jobId);
    if (!view) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      job: view.job,
      status: view.status,
      result: view.result ?? null,
      error: view.error ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read job";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
