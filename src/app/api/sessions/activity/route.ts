import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_ID_RE,
  listSessions,
  maybeStartSummary,
  upsertSession,
  validateSessionEvent,
} from "@/lib/session-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/sessions/activity — one Claude Code hook event (Stop / SessionEnd; "Test" from doctor).
 * Stores git state + event under .control/sessions/ and, when due, starts the detached summarizer.
 * GET  /api/sessions/activity[?session_id=…][&include_test=1] — stored sessions with summaries.
 * Local only; never posts anywhere.
 */
export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const v = validateSessionEvent(raw);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  try {
    const rec = await upsertSession(v.ev);
    const summary = await maybeStartSummary(v.ev);
    return NextResponse.json({ ok: true, session_id: rec.session_id, last_event_at: rec.last_event_at, events: rec.events.length, summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "store failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("session_id");
  const includeTest = req.nextUrl.searchParams.get("include_test") === "1";
  if (id && !SESSION_ID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid session_id" }, { status: 400 });
  const all = await listSessions();
  const sessions = all.filter((s) => (id ? s.session_id === id : includeTest || !s.test));
  return NextResponse.json({ ok: true, sessions: sessions.slice(0, 50) });
}
