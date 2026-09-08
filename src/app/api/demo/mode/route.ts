import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR, ensureWatchConfig } from "@/lib/github-inbox";
import { parseSeedLiveMode } from "@/lib/seed-live-mode";
import {
  purgeExpiredFollows,
  readPrFollows,
} from "@/lib/pr-follows";

export const runtime = "nodejs";

const MODE_PATH = path.join(CONTROL_DIR, "demo-mode.json");

async function readServerMode(): Promise<"demo" | "live"> {
  try {
    const raw = await fs.readFile(MODE_PATH, "utf8");
    const data = JSON.parse(raw) as { mode?: unknown };
    return parseSeedLiveMode(data?.mode) ?? "demo";
  } catch {
    return "demo";
  }
}

async function writeServerMode(mode: "demo" | "live"): Promise<void> {
  await fs.mkdir(CONTROL_DIR, { recursive: true });
  const tmp = `${MODE_PATH}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2) +
      "\n",
    "utf8"
  );
  await fs.rename(tmp, MODE_PATH);
}

/**
 * GET /api/demo/mode — optional server echo of last POST (QA/docs).
 * Client source of truth remains localStorage `control-v0-mode`.
 */
export async function GET() {
  const mode = await readServerMode();
  return NextResponse.json({
    ok: true,
    mode,
    clientKey: "control-v0-mode",
    note: "UI mode is client localStorage; this file is optional QA echo.",
  });
}

/**
 * POST /api/demo/mode `{ mode: "demo"|"live" }`
 * Writes `.control/demo-mode.json` for QA/docs. Does not touch inboxes or watchers.
 * Client must also set localStorage `control-v0-mode`.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const mode = parseSeedLiveMode(
    body && typeof body === "object" && "mode" in body
      ? (body as { mode: unknown }).mode
      : null
  );
  if (!mode) {
    return NextResponse.json(
      { error: 'Body must be { mode: "demo" | "live" }' },
      { status: 400 }
    );
  }
  await writeServerMode(mode);
  const watch = await ensureWatchConfig();
  const follows = purgeExpiredFollows((await readPrFollows()).follows);
  return NextResponse.json({
    ok: true,
    mode,
    clientKey: "control-v0-mode",
    watch: { repo: watch.repo, pr: watch.pr },
    activeFollowCount: follows.length,
    instruction:
      mode === "demo"
        ? "Set localStorage control-v0-mode=demo; call resetDemoState() so Now shows Monday seed without deleting inbox files."
        : "Set localStorage control-v0-mode=live; syncExternalInboxes() to apply durable inboxes.",
  });
}
