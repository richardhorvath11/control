import { NextRequest, NextResponse } from "next/server";
import { readOutboxItem, updateOutboxItem } from "@/lib/slack-outbox";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type FailBody = {
  error?: string;
};

/**
 * POST /api/slack/outbox/:id/fail
 * body: { error? }
 * Marks the outbox item failed after Slack MCP poster could not send.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  let body: FailBody = {};
  try {
    body = (await req.json()) as FailBody;
  } catch {
    body = {};
  }

  try {
    const existing = await readOutboxItem(id);
    if (!existing) {
      return NextResponse.json({ error: "Outbox item not found" }, { status: 404 });
    }

    const item = await updateOutboxItem(id, {
      status: "failed",
      error:
        typeof body.error === "string" && body.error.trim()
          ? body.error.trim()
          : "Slack MCP poster failed",
    });

    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to mark outbox item failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
