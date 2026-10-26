"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EMPTY_MANUAL_DRAFT,
  MANUAL_CHANGED_EVENT,
  deleteManual,
  draftFromItem,
  listManual,
  setManualStatus,
  updateManual,
  type ManualDraft,
  type ManualItem,
} from "@/lib/manual-client";

/** Title / note / link / people / when — shared by the ⌘K quick-add and inline edit. */
export function ManualWorkstreamForm({
  initial = EMPTY_MANUAL_DRAFT,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  initial?: ManualDraft;
  submitLabel: string;
  onSubmit: (d: ManualDraft) => Promise<string | null>;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [d, setD] = useState<ManualDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof ManualDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const submit = async () => {
    if (!d.title.trim()) {
      setErr("Title is required");
      return;
    }
    setBusy(true);
    setErr(await onSubmit(d));
    setBusy(false);
  };
  const field = "w-full rounded border border-border bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-amber/60 placeholder:text-muted";
  return (
    <form
      className="space-y-2"
      data-testid="manual-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <input autoFocus={autoFocus} className={field} placeholder="Title — what are you working on?" value={d.title} onChange={set("title")} data-testid="manual-title" />
      <textarea className={`${field} min-h-[56px]`} placeholder="Note (optional) — where you left off" value={d.note} onChange={set("note")} data-testid="manual-note" />
      <input className={field} placeholder="Repo / PR link (optional) — https://github.com/…" value={d.link} onChange={set("link")} data-testid="manual-link" />
      <div className="flex gap-2">
        <input className={field} placeholder="People (optional) — Sam, Priya" value={d.people} onChange={set("people")} data-testid="manual-people" />
        <input className={field} placeholder="When (optional) — Fri, after standup" value={d.when} onChange={set("when")} data-testid="manual-when" />
      </div>
      {err && <p className="text-[12px] text-amber">{err}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" className="btn-primary" disabled={busy} data-testid="manual-submit">{busy ? "Saving…" : submitLabel}</button>
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <span className="ml-auto text-[11px] text-muted">Saved locally in Control — nothing is posted or drafted.</span>
      </div>
    </form>
  );
}

function ManualRow({ item }: { item: ManualItem }) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const done = item.status === "done";
  if (editing) {
    return (
      <li className="rounded-lg border border-border bg-surface p-3" data-testid="manual-item" data-manual-id={item.id}>
        <ManualWorkstreamForm
          initial={draftFromItem(item)}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (d) => {
            const r = await updateManual(item.id, d);
            if (!r.ok) return r.error;
            setEditing(false);
            return null;
          }}
        />
      </li>
    );
  }
  const meta = [item.when && `When: ${item.when}`, item.people?.length && `With: ${item.people.join(", ")}`, item.repo && `${item.repo}${item.branch ? ` · ${item.branch}` : ""}`].filter(Boolean);
  return (
    <li className={`rounded-lg border border-border bg-surface p-3 ${done ? "opacity-60" : ""}`} data-testid="manual-item" data-manual-id={item.id} data-manual-status={item.status}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted" data-testid="manual-label">Manual</span>
        <div className="min-w-0 flex-1">
          <div className={`text-[14px] font-medium ${done ? "line-through" : ""}`}>{item.title}</div>
          {item.note && <p className="mt-0.5 text-[12px] text-muted whitespace-pre-wrap">{item.note}</p>}
          {meta.length > 0 && <p className="mt-1 text-[11px] text-muted">{meta.join(" · ")}</p>}
          {item.link && (
            <a href={item.link} target="_blank" rel="noreferrer" className="mt-1 block truncate text-[11px] text-amber hover:underline">{item.link}</a>
          )}
          {err && <p className="mt-1 text-[12px] text-amber">{err}</p>}
        </div>
      </div>
      <div className="mt-2 flex gap-1 pl-[52px]">
        <button type="button" className="btn-ghost" onClick={() => setEditing(true)} data-testid="manual-edit">Edit</button>
        <button
          type="button"
          className="btn-ghost"
          data-testid="manual-done"
          onClick={async () => {
            const r = await setManualStatus(item.id, done ? "open" : "done");
            setErr(r.ok ? null : r.error);
          }}
        >
          {done ? "Reopen" : "Mark done"}
        </button>
        {confirmDel ? (
          <>
            <button
              type="button"
              className="btn-ghost text-amber"
              data-testid="manual-delete-confirm"
              onClick={async () => {
                const r = await deleteManual(item.id);
                setErr(r.ok ? null : r.error);
                setConfirmDel(false);
              }}
            >
              Confirm delete
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirmDel(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="btn-ghost" onClick={() => setConfirmDel(true)} data-testid="manual-delete">Delete</button>
        )}
      </div>
    </li>
  );
}

/** /now section: your manual workstreams (open first; done ones collapsed behind a toggle). */
export function ManualWorkstreamsSection() {
  const [items, setItems] = useState<ManualItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const load = useCallback(async () => {
    const r = await listManual(true);
    if ("error" in r) setErr(r.error);
    else {
      setErr(null);
      setItems(r);
    }
  }, []);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(MANUAL_CHANGED_EVENT, on);
    return () => window.removeEventListener(MANUAL_CHANGED_EVENT, on);
  }, [load]);
  if (err) return <section className="text-[12px] text-amber">Manual workstreams unavailable — {err}</section>;
  if (!items || items.length === 0) return null;
  const open = items.filter((i) => i.status === "open");
  const done = items.filter((i) => i.status === "done");
  return (
    <section data-testid="manual-list">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold">Manual workstreams</h3>
        <span className="text-[11px] text-muted">Added by you (⌘K → New workstream or /control-add)</span>
      </div>
      <ul className="space-y-2">
        {open.map((i) => <ManualRow key={i.id} item={i} />)}
      </ul>
      {done.length > 0 && (
        <div className="mt-2">
          <button type="button" className="btn-ghost text-[12px]" onClick={() => setShowDone(!showDone)}>
            {showDone ? "Hide" : "Show"} done ({done.length})
          </button>
          {showDone && <ul className="mt-2 space-y-2">{done.map((i) => <ManualRow key={i.id} item={i} />)}</ul>}
        </div>
      )}
    </section>
  );
}
