import { NextRequest, NextResponse } from "next/server";
import {
  ensureWatchConfig,
  isWatchConfigured,
  normalizeWatch,
  writeWatchConfig,
  type WatchConfig,
  type WatchConfigInput,
} from "@/lib/github-inbox";

export const runtime = "nodejs";

function watchPayload(watch: WatchConfig) {
  return {
    repo: watch.repo,
    pr: watch.pr,
    workstreamId: watch.workstreamId,
    teams: watch.teams,
    slackPrChannels: watch.slackPrChannels,
    /** Derived first-channel id (back-compat). */
    slackPrChannelId: watch.slackPrChannelId,
    slackPrChannelName: watch.slackPrChannelName,
    slackChannelCount: watch.slackPrChannels.length,
    configured: isWatchConfigured(watch),
  };
}

/**
 * GET /api/watch — current `.control/watch.json` (normalized multi-channel).
 * Legacy scalar slackPrChannelId still loads as a one-element list.
 */
export async function GET() {
  try {
    const watch = await ensureWatchConfig();
    return NextResponse.json({ ok: true, watch: watchPayload(watch) });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read watch config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/watch — persist BYO Live setup (repo, optional pr, teams, channels).
 * Accepts slackPrChannels[{id,name?}] or slackPrChannelIds:string[] or legacy
 * scalar. Demo / Load demo never calls this — channel list on disk is preserved.
 */
export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const input = body as WatchConfigInput;
  const hasChannels =
    (Array.isArray(input.slackPrChannels) && input.slackPrChannels.length > 0) ||
    (Array.isArray(input.slackPrChannelIds) &&
      input.slackPrChannelIds.length > 0) ||
    (typeof input.slackPrChannelId === "string" &&
      !!input.slackPrChannelId.trim());
  if (!hasChannels) {
    return NextResponse.json(
      {
        error:
          "Provide slackPrChannels (or slackPrChannelIds / legacy slackPrChannelId) with ≥1 channel",
      },
      { status: 400 }
    );
  }
  if (typeof input.repo !== "string" || !input.repo.trim()) {
    return NextResponse.json(
      { error: "repo is required (owner/name)" },
      { status: 400 }
    );
  }

  try {
    const existing = await ensureWatchConfig();
    const next = normalizeWatch({
      repo: input.repo,
      pr: typeof input.pr === "number" ? input.pr : existing.pr,
      workstreamId:
        typeof input.workstreamId === "string" && input.workstreamId.trim()
          ? input.workstreamId
          : existing.workstreamId,
      teams: Array.isArray(input.teams) ? input.teams : existing.teams,
      slackPrChannels: input.slackPrChannels,
      slackPrChannelIds: input.slackPrChannelIds,
      slackPrChannelId: input.slackPrChannelId,
      slackPrChannelName: input.slackPrChannelName,
    });
    const watch = await writeWatchConfig(next);
    return NextResponse.json({ ok: true, watch: watchPayload(watch) });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write watch config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
