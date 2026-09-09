import { NextRequest, NextResponse } from "next/server";
import {
  listGithubOutboxItems,
  newGithubOutboxId,
  normalizeOutboxRepo,
  writeGithubOutboxItem,
  type GithubOutboxItem,
  type GithubOutboxStatus,
} from "@/lib/github-outbox";

export const runtime = "nodejs";

type EnqueueBody = {
  body?: string;
  repo?: string;
  pr?: number | string;
  reviewItemId?: string;
};

/** GET /api/github/outbox?status=pending|posted|failed|all — default pending */
export async function GET(req: NextRequest) {
  const statusParam = req.nextUrl.searchParams.get("status");
  const status: GithubOutboxStatus | "all" =
    statusParam === "all" ||
    statusParam === "posted" ||
    statusParam === "failed" ||
    statusParam === "pending"
      ? statusParam
      : "pending";

  try {
    const items = await listGithubOutboxItems(status);
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list github outbox";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/github/outbox — enqueue a pending PR comment for the local gh/MCP poster.
 * No GITHUB_TOKEN / PAT required in Control.
 */
export async function POST(req: NextRequest) {
  let body: EnqueueBody;
  try {
    body = (await req.json()) as EnqueueBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Missing comment body" }, { status: 400 });
  }

  const review_item_id =
    typeof body.reviewItemId === "string" ? body.reviewItemId.trim() : "";
  if (!review_item_id) {
    return NextResponse.json(
      { error: "Missing reviewItemId" },
      { status: 400 }
    );
  }

  const repo = normalizeOutboxRepo(body.repo);
  if (!repo) {
    return NextResponse.json(
      { error: "Missing or invalid repo (owner/name)" },
      { status: 400 }
    );
  }

  const pr =
    typeof body.pr === "number" && Number.isFinite(body.pr)
      ? Math.trunc(body.pr)
      : typeof body.pr === "string" && /^\d+$/.test(body.pr.trim())
        ? parseInt(body.pr.trim(), 10)
        : NaN;
  if (!Number.isFinite(pr) || pr < 1) {
    return NextResponse.json(
      { error: "Missing or invalid pr number" },
      { status: 400 }
    );
  }

  const item: GithubOutboxItem = {
    id: newGithubOutboxId(),
    status: "pending",
    repo,
    pr,
    body: text,
    created_at: new Date().toISOString(),
    review_item_id,
  };

  try {
    await writeGithubOutboxItem(item);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write github outbox";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, item }, { status: 201 });
}
