import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { CONTROL_DIR, INBOX_DIR } from "@/lib/github-inbox";
import { SLACK_INBOX_DIR } from "@/lib/slack-inbox";

export const runtime = "nodejs";

async function clearInboxDir(dir: string): Promise<number> {
  let removed = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // Never touch watch.json (lives in .control/, not inbox dirs)
    await fs.unlink(path.join(dir, name));
    removed += 1;
  }
  return removed;
}

/**
 * POST /api/demo/reset
 * Instructs the client to clear persisted Zustand (`control-v0`) and return to
 * Monday seed. Clears applied-id tracking on the client (soft-ignore) so Demo
 * does not re-merge inbox files. Does NOT delete inbox files by default and
 * never touches watch.json / pr-follows / watchers.
 *
 * Body/query: clearInboxes=true → optional wipe of `.control/github-inbox` +
 * `.control/slack-inbox` JSON only. Prefer leaving inboxes on disk for Live.
 */
export async function POST(req: NextRequest) {
  let clearInboxes = false;
  try {
    const urlFlag = req.nextUrl.searchParams.get("clearInboxes");
    if (urlFlag === "true" || urlFlag === "1") clearInboxes = true;
    const body = (await req.json().catch(() => null)) as {
      clearInboxes?: boolean | string;
    } | null;
    if (body) {
      if (body.clearInboxes === true || body.clearInboxes === "true") {
        clearInboxes = true;
      }
    }
  } catch {
    // empty body ok
  }

  let githubCleared = 0;
  let slackCleared = 0;
  if (clearInboxes) {
    // Ensure .control exists but do not create/modify watch.json
    try {
      await fs.mkdir(CONTROL_DIR, { recursive: true });
    } catch {
      /* ignore */
    }
    githubCleared = await clearInboxDir(INBOX_DIR);
    slackCleared = await clearInboxDir(SLACK_INBOX_DIR);
  }

  return NextResponse.json({
    ok: true,
    clearInboxes,
    githubCleared,
    slackCleared,
    watchPreserved: true,
    followsPreserved: true,
    /** Client must clear localStorage key control-v0 and rehydrate from seed */
    client: {
      localStorageKey: "control-v0",
      modeKey: "control-v0-mode",
      instruction:
        "Call useControlStore.getState().resetDemoState() (sets mode=demo, clears applied ids, keeps inbox files) or localStorage.removeItem('control-v0') then reload. ⌘K → Reset demo state. Watchers keep POSTing regardless of mode.",
    },
  });
}
