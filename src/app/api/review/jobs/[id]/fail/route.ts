import { NextRequest, NextResponse } from "next/server";
import { failReviewJob } from "@/lib/review-jobs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
type Body = { error?: string };

/**
 * POST /api/review/jobs/:id/fail
 * { error? } → Agent Failed; no invented findings.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = (id || "").trim();
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const out = await failReviewJob(
    jobId,
    typeof body.error === "string" ? body.error : undefined
  );
  if (!out.ok) {
    return NextResponse.json({ error: out.error }, { status: out.status });
  }
  return NextResponse.json({ ok: true, error: out.error, status: "failed" });
}
