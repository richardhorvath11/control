import { NextRequest, NextResponse } from "next/server";
import {
  readGithubOutboxItem,
  updateGithubOutboxItem,
} from "@/lib/github-outbox";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type AckBody = {
  comment_url?: string;
  comment_id?: number | string;
  /** Alias accepted from workers that use permalink naming. */
  permalink?: string;
};

/**
 * POST /api/github/outbox/:id/ack
 * body: { comment_url?, comment_id? }
 * Marks the outbox item posted after local gh / MCP successfully wrote a
 * comment-only PR comment (not APPROVE / REQUEST_CHANGES).
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
    const existing = await readGithubOutboxItem(id);
    if (!existing) {
      return NextResponse.json(
        { error: "Outbox item not found" },
        { status: 404 }
      );
    }

    const commentUrlRaw =
      (typeof body.comment_url === "string" && body.comment_url.trim()) ||
      (typeof body.permalink === "string" && body.permalink.trim()) ||
      "";
    let commentId: number | undefined = existing.comment_id;
    if (typeof body.comment_id === "number" && Number.isFinite(body.comment_id)) {
      commentId = Math.trunc(body.comment_id);
    } else if (
      typeof body.comment_id === "string" &&
      /^\d+$/.test(body.comment_id.trim())
    ) {
      commentId = parseInt(body.comment_id.trim(), 10);
    }

    const item = await updateGithubOutboxItem(id, {
      status: "posted",
      comment_url: commentUrlRaw || existing.comment_url,
      comment_id: commentId,
      error: undefined,
    });

    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to ack github outbox item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
