import { NextRequest, NextResponse } from "next/server";
import {
  isWatcherStatusValue,
  listWatcherStatusRows,
  putWatcherStatus,
  type WatcherStatusValue,
} from "@/lib/watcher-status";

export const runtime = "nodejs";

/**
 * GET /api/watchers/status — Agents board rows.
 * Seeds known watcher ids as idle when never reported.
 * Stale (updated_at > ~3 min) → display_status "stale".
 * Never exposes filesystem paths.
 */
export async function GET() {
  try {
    const watchers = await listWatcherStatusRows();
    return NextResponse.json({ ok: true, watchers });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list watcher status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/watchers/status — worker/watcher heartbeat.
 * Body: { id, status, last_action, detail? }
 * Watchers should PUT on each tick.
 */
export async function PUT(req: NextRequest) {
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
    id?: unknown;
    status?: unknown;
    last_action?: unknown;
    detail?: unknown;
  };
  if (typeof b.id !== "string" || !b.id.trim()) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (!isWatcherStatusValue(b.status)) {
    return NextResponse.json(
      { error: "status must be idle|ticking|waiting|error" },
      { status: 400 }
    );
  }
  if (typeof b.last_action !== "string" || !b.last_action.trim()) {
    return NextResponse.json(
      { error: "last_action is required" },
      { status: 400 }
    );
  }
  try {
    const watcher = await putWatcherStatus({
      id: b.id,
      status: b.status as WatcherStatusValue,
      last_action: b.last_action,
      detail: typeof b.detail === "string" ? b.detail : undefined,
    });
    return NextResponse.json({ ok: true, watcher });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update watcher status";
    const status = /required|status must/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
