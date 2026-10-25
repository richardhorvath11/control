import { NextRequest, NextResponse } from "next/server";
import { readActivity, recordActivity, validateActivityInput } from "@/lib/resume-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/resume/activity — the user's recorded last actions per derived workstream. */
export async function GET() {
  return NextResponse.json({ ok: true, activity: await readActivity() });
}

/**
 * POST /api/resume/activity {key, kind, label, detail?} — record a user action
 * (opened | approved | rejected | edited_draft | requested_review | requested_draft | resumed).
 * Server-side store (.control/resume-activity.json) so "last active" survives browsers.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = validateActivityInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const r = await recordActivity(v.key, v.action);
  return NextResponse.json({ ok: true, recorded: r.recorded, record: r.record });
}
