import { NextRequest, NextResponse } from "next/server";
import {
  readGithubOutboxItem,
  updateGithubOutboxItem,
} from "@/lib/github-outbox";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type FailBody = {
  error?: string;
};

/**
 * POST /api/github/outbox/:id/fail
 * body: { error? }
 * Marks the outbox item failed after local gh / MCP poster could not send.
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
    const existing = await readGithubOutboxItem(id);
    if (!existing) {
      return NextResponse.json(
        { error: "Outbox item not found" },
        { status: 404 }
      );
    }

    const item = await updateGithubOutboxItem(id, {
      status: "failed",
      error:
        typeof body.error === "string" && body.error.trim()
          ? body.error.trim()
          : "GitHub outbox poster failed",
    });

    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to mark github outbox item failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
