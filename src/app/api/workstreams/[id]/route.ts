import { NextRequest, NextResponse } from "next/server";
import {
  MANUAL_ID_RE,
  deleteManualWorkstream,
  getManualWorkstream,
  updateManualWorkstream,
  validateManualInput,
} from "@/lib/manual-workstreams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET / PATCH / DELETE /api/workstreams/:id — manual workstreams only (ids mw_…). Local file only. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const item = await getManualWorkstream(id);
  if (!item) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, item });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!MANUAL_ID_RE.test(id)) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const v = validateManualInput(raw, { requireTitle: false });
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  if (!Object.keys(v.fields).length && !v.clear.length && !v.status) {
    return NextResponse.json({ ok: false, error: "nothing to update" }, { status: 400 });
  }
  const item = await updateManualWorkstream(id, { fields: v.fields, clear: v.clear, status: v.status });
  if (!item) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, item });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!MANUAL_ID_RE.test(id) || !(await deleteManualWorkstream(id))) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: id });
}
