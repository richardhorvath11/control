import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_NEEDS_YOU_CAP,
  NEEDS_YOU_EXTERNAL_CAP,
} from "@/lib/github-constants";
import {
  acceptGithubInboxEvent,
  countGithubNeedsYou,
  ensureWatchConfig,
  listInboxItems,
  validateGithubInboxEvent,
} from "@/lib/github-inbox";
import { listSlackInboxItems } from "@/lib/slack-inbox";
import { countExternalNeedsYouFromInboxes } from "@/lib/needs-you-cap";

export const runtime = "nodejs";

/** GET /api/github/inbox — debug list of durable inbox events + watch config */
export async function GET() {
  try {
    const watch = await ensureWatchConfig();
    const items = await listInboxItems();
    const slackItems = await listSlackInboxItems();
    return NextResponse.json({
      ok: true,
      watch,
      needsYouCap: NEEDS_YOU_EXTERNAL_CAP,
      /** @deprecated alias of needsYouCap */
      githubNeedsYouCap: GITHUB_NEEDS_YOU_CAP,
      githubNeedsYou: countGithubNeedsYou(items),
      externalNeedsYou: countExternalNeedsYouFromInboxes(items, slackItems),
      items,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list GitHub inbox";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/github/inbox — accept a canonical GitHubInboxEvent.
 * Control holds NO GitHub token. Idempotent on id; dedupes by dedupeKey.
 * review.requested supports requested_via=user|team + team_slug.
 * Personal path default: when requested_via is "user" (or omitted) and
 * action_on_user is omitted, treat as Needs-you (action_on_user defaults true).
 * Explicit action_on_user:false → FYI. Team path: watch.teams gate only.
 * Unknown team → applied=false (ignored). Malformed bodies → 4xx, no write.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validateGithubInboxEvent(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    await ensureWatchConfig();
    const result = await acceptGithubInboxEvent(validated.event);
    return NextResponse.json({
      ok: true,
      event: result.item.event,
      applied: result.applied,
      duplicate: result.duplicate,
      item: result.item,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to accept GitHub inbox event";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
