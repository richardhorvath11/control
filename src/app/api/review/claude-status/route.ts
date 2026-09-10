import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import { CLAUDE_VERIFY_HINTS } from "@/lib/review-contracts";

export const runtime = "nodejs";

/**
 * GET /api/review/claude-status — V0.9 chip 3 optional probe.
 * which claude only — no API keys, no worker invoke.
 */
export async function GET() {
  const r = spawnSync("which", ["claude"], { encoding: "utf8" });
  const claudePath =
    r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
  if (!claudePath) {
    return NextResponse.json({
      ok: false,
      claude_on_path: false,
      hint: CLAUDE_VERIFY_HINTS.missing,
    });
  }
  return NextResponse.json({
    ok: true,
    claude_on_path: true,
    hint: "claude on PATH",
  });
}
