import { NextRequest, NextResponse } from "next/server";
import { claimNextGithubOutboxItem } from "@/lib/github-outbox";

export const runtime = "nodejs";

type Body = { worker_id?: string };

/**
 * POST /api/github/outbox/claim
 * Optional { worker_id? } → 200 { ok, item } or 204 empty.
 * Workers must not scan `.control/github-outbox`.
 */
export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  try {
    const item = await claimNextGithubOutboxItem(
      typeof body.worker_id === "string" ? body.worker_id : undefined
    );
    if (!item) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to claim github outbox";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
