import { NextRequest, NextResponse } from "next/server";
import { NEEDS_YOU_EXTERNAL_CAP } from "@/lib/github-constants";
import { ensureWatchConfig } from "@/lib/github-inbox";
import {
  acceptSlackInboxEvent,
  countSlackNeedsYou,
  listSlackInboxItems,
  validateSlackInboxEvent,
} from "@/lib/slack-inbox";
import { countExternalNeedsYouFromInboxes } from "@/lib/needs-you-cap";
import { listInboxItems } from "@/lib/github-inbox";

export const runtime = "nodejs";

/** GET /api/slack/inbox — debug list of durable Slack inbox events + watch */
export async function GET() {
  try {
    const watch = await ensureWatchConfig();
    const items = await listSlackInboxItems();
    const githubItems = await listInboxItems();
    return NextResponse.json({
      ok: true,
      watch: {
        repo: watch.repo,
        pr: watch.pr,
        workstreamId: watch.workstreamId,
        slackPrChannels: watch.slackPrChannels,
        slackPrChannelId: watch.slackPrChannelId,
        slackPrChannelName: watch.slackPrChannelName,
        teams: watch.teams,
      },
      needsYouCap: NEEDS_YOU_EXTERNAL_CAP,
      slackNeedsYou: countSlackNeedsYou(items),
      externalNeedsYou: countExternalNeedsYouFromInboxes(githubItems, items),
      items,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list Slack inbox";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/slack/inbox — accept a SlackInboxEvent (pr_link).
 * Control holds NO Slack token. Idempotent on id (channel_ts).
 * Wrong channel / non-watched-repo URL → applied=false (ignored).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validateSlackInboxEvent(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    await ensureWatchConfig();
    const result = await acceptSlackInboxEvent(validated.event);
    return NextResponse.json({
      ok: true,
      event: result.item.event,
      applied: result.applied,
      duplicate: result.duplicate,
      item: result.item,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to accept Slack inbox event";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
