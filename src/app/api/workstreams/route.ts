import { NextRequest, NextResponse } from "next/server";
import { createManualWorkstream, listManualWorkstreams, validateManualInput } from "@/lib/manual-workstreams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual workstreams (things Control can't see). Local file only; never creates jobs, drafts or outbox items.
 * GET  /api/workstreams[?include_done=1] → { ok, items }
 * POST /api/workstreams { title, note?, link?, people?, when?, repo?, branch?, cwd?, source? } → { ok, item }
 */
export async function GET(req: NextRequest) {
  const includeDone = req.nextUrl.searchParams.get("include_done") === "1";
  return NextResponse.json({ ok: true, items: await listManualWorkstreams({ includeDone }) });
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const v = validateManualInput(raw, { requireTitle: true });
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  if (v.status === "done") return NextResponse.json({ ok: false, error: "new workstreams start open" }, { status: 400 });
  try {
    const item = await createManualWorkstream({ ...v.fields, title: v.fields.title! }, v.source ?? "api");
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
