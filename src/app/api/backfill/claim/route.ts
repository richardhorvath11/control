import { NextResponse } from "next/server";
import { claimScan } from "@/lib/backfill";
import { ensureWatchConfig } from "@/lib/github-inbox";
import { listSlackInboxItems } from "@/lib/slack-inbox";

/**
 * The Slack MCP read tools return ts values but no permalinks. The workspace subdomain is taken from real
 * permalinks Control already stored (never example.slack.com), or CONTROL_SLACK_DOMAIN. Unknown → null, and the
 * worker then keeps no Slack items (fail closed: no invented links).
 */
async function slackTeamDomain(): Promise<string | null> {
  const env = (process.env.CONTROL_SLACK_DOMAIN || "").trim().toLowerCase();
  if (/^[a-z0-9-]+$/.test(env)) return env;
  const counts = new Map<string, number>();
  for (const it of await listSlackInboxItems().catch(() => [])) {
    const u = /^https:\/\/([a-z0-9-]+)\.slack\.com\/archives\//.exec(String((it as { event?: { permalink?: string } }).event?.permalink || ""));
    if (u && u[1] !== "example") counts.set(u[1], (counts.get(u[1]) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** POST /api/backfill/claim — worker takes the requested scan (204 when none). Returns the watch sources to read. */
export async function POST() {
  const scan = await claimScan();
  if (!scan) return new NextResponse(null, { status: 204 });
  const w = await ensureWatchConfig();
  return NextResponse.json({ ok: true, scan, watch: { repo: w.repo || "", slackWatch: w.slackWatch, slack_team_domain: await slackTeamDomain() } });
}
