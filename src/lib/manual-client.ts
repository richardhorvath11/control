"use client";
/** Browser helpers for manual workstreams (/api/workstreams). Local only — no drafts, no jobs. */
export interface ManualItem {
  id: string;
  title: string;
  note?: string;
  link?: string;
  people?: string[];
  when?: string;
  repo?: string;
  branch?: string;
  cwd?: string;
  source: "cmdk" | "api" | "skill";
  status: "open" | "done";
  created_at: string;
  updated_at: string;
  done_at?: string;
}

export interface ManualDraft {
  title: string;
  note: string;
  link: string;
  people: string;
  when: string;
}

export const EMPTY_MANUAL_DRAFT: ManualDraft = { title: "", note: "", link: "", people: "", when: "" };
export const MANUAL_CHANGED_EVENT = "control:workstreams-changed";

export function draftFromItem(i: ManualItem): ManualDraft {
  return { title: i.title, note: i.note ?? "", link: i.link ?? "", people: (i.people ?? []).join(", "), when: i.when ?? "" };
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MANUAL_CHANGED_EVENT));
}

async function call(url: string, init: RequestInit): Promise<{ ok: true; item?: ManualItem } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { ...init, headers: { "content-type": "application/json" }, cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) return { ok: false, error: d.error || `HTTP ${r.status}` };
    notify();
    return { ok: true, item: d.item };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}

/** Create: empty optional fields are omitted. */
export function createManual(d: ManualDraft, source: "cmdk" | "api" = "cmdk") {
  const body: Record<string, unknown> = { title: d.title, source };
  if (d.note.trim()) body.note = d.note;
  if (d.link.trim()) body.link = d.link.trim();
  if (d.people.trim()) body.people = d.people;
  if (d.when.trim()) body.when = d.when;
  return call("/api/workstreams", { method: "POST", body: JSON.stringify(body) });
}

/** Edit: every field is sent, so clearing a box clears the field. */
export function updateManual(id: string, d: ManualDraft) {
  return call(`/api/workstreams/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: d.title, note: d.note, link: d.link.trim(), people: d.people, when: d.when }),
  });
}

export function setManualStatus(id: string, status: "open" | "done") {
  return call(`/api/workstreams/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
}

export function deleteManual(id: string) {
  return call(`/api/workstreams/${id}`, { method: "DELETE" });
}

export async function listManual(includeDone = false): Promise<ManualItem[] | { error: string }> {
  try {
    const r = await fetch(`/api/workstreams${includeDone ? "?include_done=1" : ""}`, { cache: "no-store" });
    const d = await r.json();
    if (!r.ok || !d.ok) return { error: d.error || `HTTP ${r.status}` };
    return d.items as ManualItem[];
  } catch (e) {
    return { error: e instanceof Error ? e.message : "fetch failed" };
  }
}
