import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  CONTROL_DIR,
  ensureWatchConfig,
  isWatchConfigured,
} from "@/lib/github-inbox";
import { NEEDS_YOU_EXTERNAL_CAP } from "@/lib/github-constants";
import { parseSeedLiveMode } from "@/lib/seed-live-mode";
import {
  purgeExpiredFollows,
  readPrFollows,
} from "@/lib/pr-follows";

export const runtime = "nodejs";

const MODE_PATH = path.join(CONTROL_DIR, "demo-mode.json");

/**
 * GET /api/demo/status — lightweight Live header data (watch + active follows).
 * Does not apply inboxes; watchers unchanged.
 */
export async function GET() {
  try {
    let serverMode: "demo" | "live" = "demo";
    try {
      const raw = await fs.readFile(MODE_PATH, "utf8");
      const data = JSON.parse(raw) as { mode?: unknown };
      serverMode = parseSeedLiveMode(data?.mode) ?? "demo";
    } catch {
      /* default demo */
    }
    const watch = await ensureWatchConfig();
    const follows = purgeExpiredFollows((await readPrFollows()).follows);
    return NextResponse.json({
      ok: true,
      mode: serverMode,
      clientKey: "control-v0-mode",
      watch: {
        repo: watch.repo,
        pr: watch.pr,
        workstreamId: watch.workstreamId,
        slackWatch: watch.slackWatch,
        slackChannelCount: watch.slackWatch.surfaces.length,
        surfaceCount: watch.slackWatch.surfaces.length,
        configured: isWatchConfigured(watch),
      },
      activeFollowCount: follows.length,
      needsYouCap: NEEDS_YOU_EXTERNAL_CAP,
      label:
        serverMode === "live"
          ? `Live · ${watch.repo} · ${watch.slackWatch.surfaces.length} Slack surfaces`
          : "Demo · seeded Monday",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read demo status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
