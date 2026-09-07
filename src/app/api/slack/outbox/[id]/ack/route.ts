import { NextRequest, NextResponse } from "next/server";
import { readOutboxItem, updateOutboxItem } from "@/lib/slack-outbox";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type AckBody = {
  reply_ts?: string;
  permalink?: string;
};

/**
 * POST /api/slack/outbox/:id/ack
 * body: { reply_ts?, permalink? }
 * Marks the outbox item posted after Slack MCP successfully sent the message.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  let body: AckBody = {};
  try {
    body = (await req.json()) as AckBody;
  } catch {
    body = {};
  }

  try {
    const existing = await readOutboxItem(id);
    if (!existing) {
      return NextResponse.json({ error: "Outbox item not found" }, { status: 404 });
    }

    const item = await updateOutboxItem(id, {
      status: "posted",
      reply_ts:
        typeof body.reply_ts === "string" && body.reply_ts.trim()
          ? body.reply_ts.trim()
          : existing.reply_ts,
      permalink:
        typeof body.permalink === "string" && body.permalink.trim()
          ? body.permalink.trim()
          : existing.permalink,
      error: undefined,
    });

    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to ack outbox item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
