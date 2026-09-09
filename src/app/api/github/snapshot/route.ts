import { NextRequest, NextResponse } from "next/server";
import { normalizeRepo } from "@/lib/coalesce-review-ask";
import {
  prSnapshotRelPath,
  readPrSnapshot,
} from "@/lib/pr-snapshot";

export const runtime = "nodejs";

/**
 * GET /api/github/snapshot?repo=&pr=
 * Reads gitignored `.control/pr-snapshots/{owner}-{repo}-{pr}.json` written by
 * gh (watcher / github-pr-snapshot.sh). Control holds no GitHub PAT.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const repoRaw = (sp.get("repo") || "").trim();
  const prRaw = (sp.get("pr") || "").trim();
  const pr = parseInt(prRaw, 10);

  if (!repoRaw || !Number.isFinite(pr) || pr <= 0) {
    return NextResponse.json(
      { error: "repo and positive pr required" },
      { status: 400 }
    );
  }

  const repo = normalizeRepo(repoRaw);
  const snapshot = await readPrSnapshot(repo, pr);
  if (!snapshot) {
    return NextResponse.json(
      {
        ok: false,
        error: "Snapshot missing — run watcher",
        detail:
          "No PR snapshot on disk. Operator: ./scripts/github-pr-snapshot.sh --repo " +
          repo +
          " --pr " +
          pr +
          "  (or ./scripts/github-watcher-tick.sh)",
        path: prSnapshotRelPath(repo, pr),
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    snapshot,
    path: prSnapshotRelPath(repo, pr),
  });
}
