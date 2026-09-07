import { NextRequest, NextResponse } from "next/server";
import {
  listOutboxItems,
  newOutboxId,
  resolveChannelId,
  resolveThreadTs,
  writeOutboxItem,
  type OutboxStatus,
  type SlackOutboxItem,
} from "@/lib/slack-outbox";

export const runtime = "nodejs";

type EnqueueBody = {
  text?: string;
  channelId?: string;
  threadTs?: string;
  reviewItemId?: string;
  provenance?: SlackOutboxItem["provenance"];
};

/** GET /api/slack/outbox?status=pending|posted|failed|all — default pending */
export async function GET(req: NextRequest) {
  const statusParam = req.nextUrl.searchParams.get("status");
  const status: OutboxStatus | "all" =
    statusParam === "all" ||
    statusParam === "posted" ||
    statusParam === "failed" ||
    statusParam === "pending"
      ? statusParam
      : "pending";

  try {
    const items = await listOutboxItems(status);
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list outbox";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/slack/outbox — enqueue a pending Slack post for the MCP poster.
 * No Slack tokens required.
 */
export async function POST(req: NextRequest) {
  let body: EnqueueBody;
  try {
    body = (await req.json()) as EnqueueBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Missing draft text" }, { status: 400 });
  }

  const review_item_id =
    typeof body.reviewItemId === "string" ? body.reviewItemId.trim() : "";
  if (!review_item_id) {
    return NextResponse.json(
      { error: "Missing reviewItemId" },
      { status: 400 }
    );
  }

  const item: SlackOutboxItem = {
    id: newOutboxId(),
    status: "pending",
    channel_id: resolveChannelId(body.channelId),
    thread_ts: resolveThreadTs(body.threadTs),
    text,
    created_at: new Date().toISOString(),
    review_item_id,
    provenance: body.provenance ?? null,
  };

  try {
    await writeOutboxItem(item);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write outbox";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, item }, { status: 201 });
}
