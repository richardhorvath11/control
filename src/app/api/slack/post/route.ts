import { NextRequest, NextResponse } from "next/server";
import { SLACK_E2E, slackPermalink } from "@/lib/slack-e2e";

export const runtime = "nodejs";

type PostBody = {
  text?: string;
  channelId?: string;
  threadTs?: string;
};

export async function POST(req: NextRequest) {
  const token =
    process.env.SLACK_BOT_TOKEN?.trim() ||
    process.env.SLACK_USER_TOKEN?.trim();

  if (!token) {
    return NextResponse.json(
      {
        error:
          "Missing SLACK_BOT_TOKEN or SLACK_USER_TOKEN. Add it to .env.local (gitignored) and restart the dev server.",
      },
      { status: 500 }
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Missing draft text" }, { status: 400 });
  }

  const channel =
    (typeof body.channelId === "string" && body.channelId.trim()) ||
    process.env.SLACK_E2E_CHANNEL_ID?.trim() ||
    SLACK_E2E.channelId;

  const thread_ts =
    (typeof body.threadTs === "string" && body.threadTs.trim()) ||
    process.env.SLACK_E2E_THREAD_TS?.trim() ||
    SLACK_E2E.threadTs;

  let slackRes: Response;
  try {
    slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        thread_ts,
        text,
      }),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Network error calling Slack";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  let data: {
    ok?: boolean;
    error?: string;
    ts?: string;
    channel?: string;
    message?: { ts?: string };
  };
  try {
    data = (await slackRes.json()) as typeof data;
  } catch {
    return NextResponse.json(
      { error: `Slack returned non-JSON (HTTP ${slackRes.status})` },
      { status: 502 }
    );
  }

  if (!data.ok) {
    return NextResponse.json(
      {
        error: data.error
          ? `Slack API: ${data.error}`
          : `Slack API failed (HTTP ${slackRes.status})`,
      },
      { status: 502 }
    );
  }

  const ts = data.ts ?? data.message?.ts;
  const postedChannel = data.channel ?? channel;
  const permalink = ts
    ? slackPermalink(postedChannel, ts)
    : undefined;

  return NextResponse.json({
    ok: true,
    ts,
    channel: postedChannel,
    threadTs: thread_ts,
    permalink,
  });
}
