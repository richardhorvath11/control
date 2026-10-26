import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}
import { decide, type Candidate, type DecideAction } from "@/lib/backfill";
import { createManualWorkstream } from "@/lib/manual-workstreams";

/** Accepting turns a candidate into a manual workstream (on /now, Resume-eligible). Local only; posts nothing. */
function toWorkstream(c: Candidate) {
  const link = c.sources.find((s) => s.url)?.url;
  const note = [c.why, "", "Found by the backfill scan from:", ...c.sources.map((s) => "- " + s.label + (s.url ? " " + s.url : ""))].join("\n").slice(0, 4000);
  return createManualWorkstream({ title: c.title, note, ...(link ? { link } : {}), ...(c.next_step ? { when: c.next_step.slice(0, 120) } : {}) }, "backfill");
}

/** POST /api/backfill/decide { action: accept|reject|rename|merge|accept_high, key?, keys?, title? } — the user's review. */
export async function POST(req: NextRequest) {
  const b = await body(req);
  const a = b?.action;
  let act: DecideAction | null = null;
  if (a === "accept_high") act = { action: "accept_high" };
  else if ((a === "accept" || a === "reject") && typeof b?.key === "string") act = { action: a, key: b.key, ...(typeof b.title === "string" ? { title: b.title } : {}) } as DecideAction;
  else if (a === "rename" && typeof b?.key === "string" && typeof b.title === "string") act = { action: "rename", key: b.key, title: b.title };
  else if (a === "merge" && Array.isArray(b?.keys) && b.keys.length === 2 && b.keys.every((k) => typeof k === "string"))
    act = { action: "merge", keys: [b.keys[0] as string, b.keys[1] as string], ...(typeof b.title === "string" ? { title: b.title } : {}) };
  if (!act) return NextResponse.json({ ok: false, error: "invalid decision" }, { status: 400 });
  const r = await decide(act, toWorkstream);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
