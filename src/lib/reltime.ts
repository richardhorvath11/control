/**
 * Relative times for user-facing text ("12 min ago"), with the exact local time kept for a tooltip.
 * Pure (no React) so smokes can test it. Use <RelTime>/<TimeText> (src/components/RelTime.tsx) to render.
 */

/** ISO-8601 date-times as they appear in our stores/payloads (2026-10-26T14:47:58.385Z, …+00:00, no-ms variants). */
export const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

export function hasIso(text: string): boolean {
  return new RegExp(ISO_RE.source).test(text);
}

/** "just now" · "12 min ago" · "3 h ago" · "2 d ago" · "in 5 min"; "" for missing/unparseable. */
export function relTime(at: string | undefined | null, now: number = Date.now()): string {
  if (!at) return "";
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const d = (now - t) / 1000;
  const s = Math.abs(d);
  let v: string;
  if (s < 90) return "just now";
  if (s < 3600) v = `${Math.round(s / 60)} min`;
  else if (s < 86400) v = `${Math.round(s / 3600)} h`;
  else v = `${Math.round(s / 86400)} d`;
  return d >= 0 ? `${v} ago` : `in ${v}`;
}

/** Exact local time for a tooltip, e.g. "Mon, Oct 26, 2026, 9:47:58 AM CDT". */
export function localTitle(at: string | undefined | null, timeZone?: string): string {
  if (!at) return "";
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString("en-US", {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}),
  });
}

/** Split free text into plain parts and ISO time parts (so labels from any source never show raw ISO). */
export type TimePart = { text: string } | { at: string };
export function splitIso(text: string): TimePart[] {
  const out: TimePart[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(ISO_RE.source, "g"))) {
    if (!Number.isFinite(Date.parse(m[0]))) continue;
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ at: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Plain-string rendering (no tooltip) — for places that can't hold markup, e.g. a title attribute. */
export function humanizeIso(text: string, now: number = Date.now()): string {
  return splitIso(text).map((p) => ("at" in p ? relTime(p.at, now) : p.text)).join("");
}
