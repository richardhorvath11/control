import { NextRequest, NextResponse } from "next/server";
import {
  ensureWatchConfig,
  hasGithubSource,
  hasSlackSource,
  isWatchConfigured,
  normalizeWatch,
  validateRepo,
  validateSlackWatch,
  writeWatchConfig,
  type WatchConfig,
  type WatchConfigInput,
} from "@/lib/github-inbox";

export const runtime = "nodejs";

function watchPayload(watch: WatchConfig) {
  return {
    repo: watch.repo,
    workstreamId: watch.workstreamId,
    teams: watch.teams,
    slackWatch: watch.slackWatch,
    surfaceCount: watch.slackWatch.surfaces.length,
    configured: isWatchConfigured(watch),
    sources: { github: hasGithubSource(watch), slack: hasSlackSource(watch) },
  };
}

/**
 * GET /api/watch — current `.control/watch.json` (slackWatch only).
 * Legacy slackPrChannels / scalars one-shot migrate on ensureWatchConfig.
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
 * PUT /api/watch — persist BYO Live setup. Every source is optional: repo may be empty
 * (GitHub skipped), slackWatch may have no surfaces (Slack skipped), or both (Live runs on
 * Claude sessions + manual items). A legacy `pr` in the body is ignored.
 * Demo / Load demo never calls this — watch on disk is preserved.
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
  if (input.repo !== undefined && typeof input.repo !== "string") {
    return NextResponse.json({ error: "repo must be a string (owner/name) or empty" }, { status: 400 });
  }
  const repoErr = validateRepo(typeof input.repo === "string" ? input.repo : "");
  if (repoErr) return NextResponse.json({ error: repoErr }, { status: 400 });

  try {
    const existing = await ensureWatchConfig();
    const next = normalizeWatch({
      repo: typeof input.repo === "string" ? input.repo : existing.repo,
      workstreamId:
        typeof input.workstreamId === "string" && input.workstreamId.trim()
          ? input.workstreamId
          : existing.workstreamId,
      teams: Array.isArray(input.teams) ? input.teams : existing.teams,
      slackWatch: input.slackWatch ?? existing.slackWatch,
      // Allow one-shot migrate body forms on PUT too (then persist clean).
      slackPrChannels: input.slackPrChannels,
      slackPrChannelIds: input.slackPrChannelIds,
      slackPrChannelId: input.slackPrChannelId,
      slackPrChannelName: input.slackPrChannelName,
    });

    const swErr = validateSlackWatch(next.slackWatch);
    if (swErr) {
      return NextResponse.json({ error: swErr }, { status: 400 });
    }

    const watch = await writeWatchConfig(next);
    return NextResponse.json({ ok: true, watch: watchPayload(watch) });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write watch config";
    const status = /myUserId|slackWatch/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
