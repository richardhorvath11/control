import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Soft-disabled: Control no longer posts via Slack bot/user tokens.
 * Approve → confirm now writes a durable outbox record; Grok posts via Slack MCP.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Disabled: Slack bot-token chat.postMessage path removed. Approve writes to /api/slack/outbox; Grok posts via Slack MCP and POSTs /api/slack/outbox/:id/ack.",
      code: "SLACK_BOT_POST_DISABLED",
    },
    { status: 410 }
  );
}
