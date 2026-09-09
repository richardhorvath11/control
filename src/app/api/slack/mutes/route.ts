import { NextRequest, NextResponse } from "next/server";
import {
  listActiveSlackMutes,
  removeSlackMute,
  upsertSlackMute,
} from "@/lib/slack-mutes";

export const runtime = "nodejs";

/**
 * GET /api/slack/mutes — active (non-expired) thread mutes.
 * Opaque API; `.control/slack-mutes.json` is server-private.
 */
export async function GET() {
  try {
    const mutes = await listActiveSlackMutes();
    return NextResponse.json({ ok: true, mutes });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list mutes";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/slack/mutes — mute / snooze a Slack thread.
 * Body: { channel_id, thread_ts?, message_ts?, expires_at? }
 * Default expires_at = now + 7d.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  const b = body as {
    channel_id?: unknown;
    thread_ts?: unknown;
    message_ts?: unknown;
    expires_at?: unknown;
  };
  try {
    const mute = await upsertSlackMute({
      channel_id: typeof b.channel_id === "string" ? b.channel_id : "",
      thread_ts: typeof b.thread_ts === "string" ? b.thread_ts : null,
      message_ts: typeof b.message_ts === "string" ? b.message_ts : null,
      expires_at: typeof b.expires_at === "string" ? b.expires_at : null,
    });
    return NextResponse.json({ ok: true, mute }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to mute";
    const status = /required|expires_at/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * DELETE /api/slack/mutes — unmute.
 * Body or query: { key } / ?key=
 */
export async function DELETE(req: NextRequest) {
  let key = req.nextUrl.searchParams.get("key")?.trim() ?? "";
  if (!key) {
    try {
      const body = (await req.json()) as { key?: unknown };
      if (typeof body?.key === "string") key = body.key.trim();
    } catch {
      /* query-only */
    }
  }
  if (!key) {
    return NextResponse.json(
      { error: "key is required (channel_id|thread_ts)" },
      { status: 400 }
    );
  }
  try {
    const removed = await removeSlackMute(key);
    if (!removed) {
      return NextResponse.json({ error: "Mute not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, removed: key });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to unmute";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
