"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RelTime } from "@/components/RelTime";
import { decideBackfill, fetchBackfill, scanActive, startScan, type BackfillView } from "@/lib/backfill-client";
import type { Candidate, SourceProgress } from "@/lib/backfill";

const HIGH = 0.8;
const SRC_LABEL: Record<string, string> = { github: "GitHub", slack: "Slack", sessions: "Claude Code sessions", grouping: "Grouping (claude -p)" };

function bucket(c: number) {
  return c >= HIGH ? { label: "High", cls: "text-running border-running/40" } : c >= 0.5 ? { label: "Medium", cls: "text-amber border-amber/40" } : { label: "Low", cls: "text-muted border-border" };
}

function ProgressRow({ name, p }: { name: string; p: SourceProgress }) {
  const pct = p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : p.status === "done" || p.status === "skipped" ? 100 : p.status === "running" ? 40 : 0;
  const color = p.status === "failed" ? "bg-blocked" : p.status === "skipped" ? "bg-muted" : "bg-running";
  return (
    <div className="space-y-1" data-testid={`backfill-progress-${name}`} data-status={p.status}>
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-text">{SRC_LABEL[name] ?? name}</span>
        <span className="text-muted">
          {p.status}
          {p.total ? ` · ${p.done ?? 0}/${p.total}` : ""}
          {p.items !== undefined ? ` · ${p.items} item(s)` : ""}
        </span>
      </div>
      <div className="h-1.5 rounded bg-border overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {p.note && <div className="text-[11px] text-muted leading-4">{p.note}</div>}
    </div>
  );
}

function CandidateCard({ c, selected, onSelect, onChanged }: { c: Candidate; selected: boolean; onSelect: () => void; onChanged: (err?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [busy, setBusy] = useState(false);
  const b = bucket(c.confidence);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await decideBackfill({ key: c.key, ...body });
    setBusy(false);
    onChanged(r.ok ? undefined : r.error ?? "failed");
  };
  return (
    <div className={`panel p-4 space-y-2 ${selected ? "border-running/60" : ""}`} data-testid="backfill-candidate" data-key={c.key} data-confidence={c.confidence}>
      <div className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={selected} onChange={onSelect} aria-label="Select to merge" data-testid="backfill-select" />
        <div className="flex-1 min-w-0 space-y-1">
          {editing ? (
            <div className="flex gap-2">
              <input className="flex-1 rounded-lg border border-border bg-bg px-2 py-1 text-[13px]" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="backfill-title-input" />
              <button className="btn-secondary text-[12px]" disabled={busy} onClick={async () => { await act({ action: "rename", title }); setEditing(false); }}>Save</button>
              <button className="btn-ghost text-[12px]" onClick={() => { setTitle(c.title); setEditing(false); }}>Cancel</button>
            </div>
          ) : (
            <div className="text-[14px] font-medium text-text" data-testid="backfill-title">{c.title}</div>
          )}
          <div className="text-[12px] text-muted">{c.why}</div>
          {c.next_step && <div className="text-[12px]"><span className="text-muted">Next: </span>{c.next_step}</div>}
          <ul className="text-[11px] space-y-0.5 pt-1">
            {c.sources.map((s) => (
              <li key={s.id} className="flex gap-2 items-baseline">
                <span className="text-muted shrink-0">{s.source === "slack" ? "Slack" : s.source === "github" ? "GitHub" : "Session"}</span>
                {s.url ? <a className="text-running hover:underline truncate" href={s.url} target="_blank" rel="noreferrer">{s.label}</a> : <span className="truncate">{s.label}</span>}
                <RelTime at={s.at} className="text-muted shrink-0" />
              </li>
            ))}
          </ul>
        </div>
        <span className={`text-[11px] border rounded px-1.5 py-0.5 shrink-0 ${b.cls}`} title={`confidence ${c.confidence}`} data-testid="backfill-confidence">{b.label} · {Math.round(c.confidence * 100)}%</span>
      </div>
      <div className="flex gap-2 pl-7">
        <button className="btn-primary text-[12px]" disabled={busy} onClick={() => act({ action: "accept", title })} data-testid="backfill-accept">Accept</button>
        <button className="btn-ghost text-[12px]" disabled={busy} onClick={() => setEditing(true)} data-testid="backfill-edit">Edit title</button>
        <button className="btn-ghost text-[12px]" disabled={busy} onClick={() => act({ action: "reject" })} data-testid="backfill-reject">Reject</button>
      </div>
    </div>
  );
}

export default function BackfillPage() {
  const [v, setV] = useState<BackfillView | null>(null);
  const [days, setDays] = useState(30);
  const [sel, setSel] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => setV(await fetchBackfill()), []);
  useEffect(() => {
    void load();
  }, [load]);
  const active = scanActive(v?.scan);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [active, load]);

  const scan = v?.scan;
  const cands = v?.candidates ?? [];
  const high = cands.filter((c) => c.confidence >= HIGH);
  const changed = (err?: string) => { setMsg(err ?? null); void load(); };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 space-y-6" data-testid="backfill-page">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Scan for existing work</h1>
        <p className="text-[13px] text-muted mt-1 leading-5">
          A <strong className="text-text">read-only</strong> look back over your configured Slack channels and DMs, your GitHub repo&apos;s open PRs and issues,
          and recent Claude Code sessions. Claude groups what is still pending into candidates. <strong className="text-text">Nothing becomes a workstream until you accept it</strong>,
          and nothing is ever posted, sent, reacted to or drafted.
        </p>
      </div>

      <div className="panel p-5 space-y-4" data-testid="backfill-progress">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-[12px] text-muted flex items-center gap-2">
            Look back
            <input type="number" min={1} max={180} value={days} onChange={(e) => setDays(Number(e.target.value) || 30)} className="w-16 rounded border border-border bg-bg px-2 py-1 text-[13px]" data-testid="backfill-days" />
            days
          </label>
          <button className="btn-primary" disabled={active} data-testid="backfill-start" onClick={async () => { const r = await startScan("manual", days); setMsg(r.ok ? null : r.error ?? "failed"); void load(); }}>
            {active ? "Scanning…" : v?.ever_scanned ? "Re-scan" : "Scan now"}
          </button>
          {scan?.scan_id && (
            <span className="text-[12px] text-muted" data-testid="backfill-status">
              {scan.status === "requested" ? "Waiting for the backfill worker…" : scan.status === "running" ? `Scanning ${scan.lookback_days} days…` : scan.status === "done" ? <>Last scan <RelTime at={scan.finished_at} /> · {scan.lookback_days} days</> : scan.status === "failed" ? `Scan failed: ${scan.error}` : ""}
            </span>
          )}
        </div>
        {scan?.scan_id ? (
          <div className="space-y-3">
            {(["github", "slack", "sessions", "grouping"] as const).map((k) => <ProgressRow key={k} name={k} p={scan.progress[k]} />)}
          </div>
        ) : (
          <p className="text-[12px] text-muted">No scan yet.</p>
        )}
        {scan?.status === "requested" && (
          <p className="text-[11px] text-muted">The scan runs in <code className="text-text">scripts/control-backfill-worker.mjs</code> (started by <code className="text-text">dogfood-up</code>).</p>
        )}
        {scan?.counts && (
          <p className="text-[11px] text-muted" data-testid="backfill-counts">
            {scan.counts.raw} item(s) read · {scan.counts.candidates} candidate(s) · {scan.counts.hidden_by_decisions} hidden by earlier decisions · {scan.counts.dropped_invalid} dropped (no valid source)
          </p>
        )}
      </div>

      <div className="space-y-3" data-testid="backfill-review">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold">Candidates <span className="text-muted font-normal">· {cands.length} to review</span></h2>
          <div className="flex gap-2">
            <button className="btn-secondary text-[12px]" disabled={sel.length !== 2} data-testid="backfill-merge"
              onClick={async () => { const r = await decideBackfill({ action: "merge", keys: sel }); setSel([]); changed(r.ok ? undefined : r.error); }}>
              Merge selected ({sel.length}/2)
            </button>
            <button className="btn-primary text-[12px]" disabled={!high.length} data-testid="backfill-accept-high"
              onClick={async () => { const r = await decideBackfill({ action: "accept_high" }); changed(r.ok ? undefined : r.error); }}>
              Accept all high-confidence ({high.length})
            </button>
          </div>
        </div>
        {msg && <div className="text-[12px] text-blocked">{msg}</div>}
        {!cands.length && <p className="text-[12px] text-muted">{active ? "Candidates appear when the scan finishes." : "Nothing to review."} Accepted items live on <Link className="underline" href="/now">Now</Link>.</p>}
        {cands.map((c) => (
          <CandidateCard key={c.key + c.title} c={c} selected={sel.includes(c.key)}
            onSelect={() => setSel((s) => (s.includes(c.key) ? s.filter((x) => x !== c.key) : [...s, c.key].slice(-2)))}
            onChanged={changed} />
        ))}
        {v && (v.decided.accepted > 0 || v.decided.rejected > 0) && (
          <p className="text-[11px] text-muted">{v.decided.accepted} accepted · {v.decided.rejected} rejected so far (rejections stay hidden on re-scan unless there is newer activity).</p>
        )}
      </div>
    </div>
  );
}
