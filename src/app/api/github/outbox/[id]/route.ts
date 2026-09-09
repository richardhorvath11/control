import { NextRequest, NextResponse } from "next/server";
import { readGithubOutboxItem } from "@/lib/github-outbox";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/github/outbox/:id */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const item = await readGithubOutboxItem(id);
    if (!item) {
      return NextResponse.json(
        { error: "Outbox item not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, item });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read github outbox item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
