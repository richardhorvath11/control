import { NextRequest, NextResponse } from "next/server";
import { RESUME_KEY_RE } from "@/lib/resume-core";
import { addDismissal } from "@/lib/dismissals";
import { findDerivedRow } from "@/lib/resume-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workstreams/dismiss { key } — hide a derived (PR / Slack / session) workstream until newer activity.
 * The last-activity timestamp is read server-side. Manual items use DELETE /api/workstreams/:id instead.
 * Local file only (.control/dismissed-workstreams.json); nothing is posted anywhere.
 */
export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const key = (raw as { key?: unknown })?.key;
  if (typeof key !== "string" || !RESUME_KEY_RE.test(key)) return NextResponse.json({ ok: false, error: "key must be a workstream key" }, { status: 400 });
  if (key.startsWith("manual:")) return NextResponse.json({ ok: false, error: "manual workstreams are deleted, not dismissed" }, { status: 400 });
  const row = await findDerivedRow(key);
  if (!row) return NextResponse.json({ ok: false, error: "no such live workstream (already dismissed?)" }, { status: 404 });
  const dismissal = await addDismissal({ key, last_activity_at: row.last_activity_at, title: row.title });
  return NextResponse.json({ ok: true, dismissal });
}
