"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useControlStore } from "@/lib/store";
import { RelTime, TimeText } from "@/components/RelTime";
import { recordResumeActivity } from "@/lib/resume-client";
import { MANUAL_CHANGED_EVENT, setManualStatus, type ManualItem } from "@/lib/manual-client";
import type {
  ChangeGroup,
  PrContextLike,
  ResumeContext,
  ResumePrimaryAction,
  ResumeEvent,
  ResumeAction,
} from "@/lib/resume-core";

type NextState =
  | { status: "ok"; text: string; why?: string; job_id: string }
  | { status: "pending"; job_id: string; detail: string }
  | { status: "unavailable"; reason: string; job_id?: string };

export interface SessionResumeData {
  session_id: string;
  cwd: string;
  repo: { toplevel: string; remote?: string; slug?: string } | null;
  branch: string | null;
  head: { sha: string; subject: string } | null;
  diff: { files_changed: number; insertions: number; deletions: number; files?: string[]; untracked: number; untracked_files?: string[]; stat?: string } | null;
  last_event: string;
  last_event_at: string;
  ended: boolean;
  resume_command: string;
  summary: {
    status: "ok" | "fallback" | "unavailable" | "pending";
    source: "claude" | "transcript_tail" | null;
    text: string | null;
    tail: { last_user?: string; last_assistant?: string } | null;
    error: string | null;
    running: boolean;
  } | null;
}

export type SessionResume = {
  ok: true;
  empty: false;
  kind: "session";
  selection: { key: string; rule: string; reason: string; at?: string; at_label?: string; others: { key: string; title: string; newCount: number }[] };
  workstream: { key: string; kind: "session"; title: string; repo?: string };
  last_active: ResumeAction | null;
  session: SessionResumeData;
  next: NextState;
};

export type ManualResume = {
  ok: true;
  empty: false;
  kind: "manual";
  selection: { key: string; rule: string; reason: string; at?: string; at_label?: string; others: { key: string; title: string; newCount: number }[] };
  workstream: { key: string; kind: "manual"; title: string; repo?: string };
  last_active: ResumeAction | null;
  manual: ManualItem & { resume_command: string | null };
  next: NextState;
};

export type ResumeResponse =
  | { ok: true; empty: true; emptyReason: string }
  | SessionResume
  | ManualResume
  | {
      ok: true;
      empty: false;
      kind?: undefined;
      selection: { key: string; rule: string; reason: string; at?: string; at_label?: string; others: { key: string; title: string; newCount: number }[] };
      workstream: { key: string; kind: "pr" | "slack"; title: string; url?: string; repo?: string; pr?: number };
      last_active: ResumeAction | null;
      changes: { total: number; groups: ChangeGroup[]; items: ResumeEvent[] };
      context: ResumeContext;
      pr_context: PrContextLike | null;
      next: NextState;
      primary_action: ResumePrimaryAction;
    }
  | { ok: false; error: string };

const KIND_LABEL: Record<string, string> = {
  pr_comment: "PR comment",
  pr_review: "PR review",
  review_request: "Review request",
  pr_event: "PR event",
  pr_updated: "PR update",
  slack_message: "Slack message",
  slack_reply: "Slack reply",
  job_done: "Worker finished",
  job_failed: "Worker failed",
};

/** Polls /api/resume (ensure_next=1); faster while Claude's Next is pending. */
export function useLiveResume(enabled: boolean) {
  const [data, setData] = useState<ResumeResponse | null>(null);
  const timer = useRef<number | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/resume?ensure_next=1", { cache: "no-store" });
      const d = (await r.json()) as ResumeResponse;
      setData(d);
      return d;
    } catch (e) {
      const d = { ok: false as const, error: e instanceof Error ? e.message : "fetch failed" };
      setData(d);
      return d;
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const tick = async () => {
      const d = await load();
      if (stop) return;
      const pending = d.ok && !d.empty && d.next.status === "pending";
      timer.current = window.setTimeout(tick, pending ? 4000 : 30000);
    };
    void tick();
    const onManual = () => void load();
    window.addEventListener(MANUAL_CHANGED_EVENT, onManual);
    return () => {
      window.removeEventListener(MANUAL_CHANGED_EVENT, onManual);
      stop = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [enabled, load]);
  return { data, reload: load };
}

/** `by` names who wrote Next: Claude by default; "you" for a manual item's own `when`. */
/** Why this card is Resume, with its time relative ("12 min ago"; exact local time on hover). */
function SelectionReason({ sel }: { sel: { reason: string; at?: string; at_label?: string } }) {
  return (
    <span data-testid="resume-why">
      <TimeText text={sel.reason} />
      {sel.at ? (
        <>
          {" · "}
          {sel.at_label ? `${sel.at_label} ` : ""}
          <RelTime at={sel.at} />
        </>
      ) : null}
    </span>
  );
}

export function NextLine({ next, by = "Claude" }: { next: NextState; by?: string }) {
  if (next.status === "ok") {
    return (
      <p className="mt-3 text-[14px] leading-5" data-testid="resume-next">
        <span className="text-muted">Next: </span>
        <TimeText text={next.text} />
        {next.why ? <span className="block text-[11px] text-muted mt-1">Why: <TimeText text={next.why} /> · {by}</span> : null}
      </p>
    );
  }
  if (next.status === "pending") {
    return (
      <p className="mt-3 text-[13px] text-muted" data-testid="resume-next">
        Next: {next.detail}
      </p>
    );
  }
  return (
    <p className="mt-3 text-[13px] text-amber" data-testid="resume-next">
      Next unavailable — <TimeText text={next.reason} />
    </p>
  );
}

/** Resume does the next step: open the pending review / draft, else Focus with context. Never sends. */
export function useResumeAction() {
  const router = useRouter();
  const openReviewFromJob = useControlStore((s) => s.openReviewFromJob);
  const focusResume = useControlStore((s) => s.focusResume);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (d: Exclude<Extract<ResumeResponse, { empty: false }>, SessionResume | ManualResume>) => {
    setBusy(true);
    setErr(null);
    try {
      const a = d.primary_action;
      recordResumeActivity(d.workstream.key, "resumed", `Resumed: ${a.label}`, "job_id" in a ? { job_id: a.job_id } : undefined);
      if (a.kind === "open_review" || a.kind === "open_draft") {
        const id = await openReviewFromJob(a.job_id);
        if (id) {
          router.push(`/review/${id}`);
          return;
        }
        setErr("Could not load that job's result — starting Focus instead.");
      }
      focusResume({
        key: d.workstream.key,
        title: d.workstream.title,
        url: d.workstream.url,
        next: d.next.status === "ok" ? d.next.text : undefined,
        open: d.context.open.map((o) => o.label),
        leftOff: d.last_active ? `${d.last_active.label} (${d.last_active.at})` : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, err };
}

export function LiveResumeCard() {
  const { data } = useLiveResume(true);
  const { run, busy, err } = useResumeAction();

  if (!data) {
    return <section className="rounded-xl border border-border bg-surface p-5 text-[13px] text-muted">Loading Resume…</section>;
  }
  if (!data.ok) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5 text-[13px] text-amber">
        Resume unavailable — {data.error}
      </section>
    );
  }
  if (data.empty) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5" data-testid="resume-empty">
        <div className="text-[11px] uppercase tracking-wide text-muted mb-1">Resume</div>
        <p className="text-[13px]">{data.emptyReason}</p>
        <Link href="/get-live" className="btn-ghost mt-3 inline-flex">Open Get Live</Link>
      </section>
    );
  }
  if (data.kind === "session") return <SessionResumeCard data={data} />;
  if (data.kind === "manual") return <ManualResumeCard data={data} />;
  const { workstream: w, context: ctx, changes, pr_context: pc } = data;
  const hunks = pc?.hunks ?? [];
  const lr = ctx.left_off.latest_review;
  return (
    <section className="rounded-xl border border-amber/40 bg-surface p-5 shadow-[inset_3px_0_0_0_#E8A54B]" data-testid="resume-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-amber mb-1">Resume · Live</div>
          <h2 className="text-[18px] font-semibold leading-6">
            {w.url ? (
              <a href={w.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{w.title}</a>
            ) : (
              w.title
            )}
          </h2>
          <p className="mt-1 text-[12px] text-muted">
            {w.kind === "pr" ? "Pull request" : "Slack thread"} · <SelectionReason sel={data.selection} />
            {data.last_active ? <> · last active <RelTime at={data.last_active.at} /></> : null}
          </p>
          <NextLine next={data.next} />
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(data)} data-testid="resume-button">
            {busy ? "Opening…" : "Resume"}
          </button>
          <span className="text-[11px] text-muted">{data.primary_action.label}</span>
        </div>
      </div>
      {err ? <p className="mt-2 text-[12px] text-amber">{err}</p> : null}

      <div className="mt-4 grid gap-4 md:grid-cols-2 text-[12px]">
        <div>
          <h4 className="font-medium mb-1">
            {data.last_active ? "Since you were last active" : "Activity (you haven't acted here yet)"} · {changes.total}
          </h4>
          {changes.groups.length === 0 ? (
            <p className="text-muted">Nothing new since your last action.</p>
          ) : (
            <ul className="space-y-1">
              {changes.groups.map((g) => (
                <li key={g.kind} className="text-text/90">
                  <span className="text-muted">{KIND_LABEL[g.kind] ?? g.kind}{g.count > 1 ? ` ×${g.count}` : ""}:</span>{" "}
                  {g.latest.url ? (
                    <a href={g.latest.url} target="_blank" rel="noopener noreferrer" className="hover:underline"><TimeText text={g.latest.label} /></a>
                  ) : (
                    g.latest.label
                  )}{" "}
                  <span className="text-muted">· <RelTime at={g.latest.at} /></span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="font-medium mb-1">Where you left off</h4>
          <ul className="space-y-1 text-text/90">
            <li>{data.last_active ? <><TimeText text={data.last_active.label} /> · <RelTime at={data.last_active.at} /></> : "No action recorded yet."}</li>
            {ctx.left_off.user_draft ? <li className="text-muted">Your draft: “{ctx.left_off.user_draft.slice(0, 160)}”</li> : null}
            {lr ? (
              <li>
                Review (<RelTime at={lr.at} />): {lr.findings.length} finding(s)
                {lr.findings.length ? ` — ${lr.findings.slice(0, 4).map((f) => f.title).join("; ")}` : ""}
              </li>
            ) : null}
            {ctx.left_off.latest_draft_reply ? <li>Draft reply ready: “{ctx.left_off.latest_draft_reply.draft_text.slice(0, 140)}”</li> : null}
          </ul>
          <h4 className="font-medium mt-3 mb-1">Open &amp; blocking</h4>
          <ul className="space-y-1">
            {[...ctx.open, ...(pc && !pc.error ? livePrOpen(pc) : [])].map((o, i) => (
              <li key={i} className={o.severity === "blocking" ? "text-amber" : o.severity === "open" ? "text-text/90" : "text-muted"}>
                {o.severity === "blocking" ? "■ " : o.severity === "open" ? "● " : "· "}
                {o.url ? <a href={o.url} target="_blank" rel="noopener noreferrer" className="hover:underline"><TimeText text={o.label} /></a> : <TimeText text={o.label} />}
              </li>
            ))}
            {pc?.error ? <li className="text-muted">Live PR state unavailable — {pc.error}</li> : null}
          </ul>
        </div>
      </div>

      {(hunks.length > 0 || ctx.slack.length > 0 || (pc?.comments?.length ?? 0) > 0) && (
        <details className="mt-4 text-[12px]" open>
          <summary className="cursor-pointer font-medium">Snippets</summary>
          <div className="mt-2 space-y-3">
            {hunks.map((h, i) => (
              <div key={i}>
                <div className="text-muted mb-1">
                  {h.finding ? `${h.finding} · ` : ""}
                  <span className="font-mono">{h.file}:{h.line}</span>
                </div>
                <pre className="overflow-x-auto rounded border border-border bg-bg p-2 font-mono text-[11px] leading-4">{h.header}{"\n"}{h.text}</pre>
              </div>
            ))}
            {(pc?.comments ?? []).slice(-3).map((c, i) => (
              <div key={`c${i}`} className="text-text/90">
                <span className="text-muted">PR comment · {c.author} · <RelTime at={c.created_at} />:</span> {c.body.slice(0, 240)}
              </div>
            ))}
            {ctx.slack.slice(0, 3).map((s, i) => (
              <div key={`s${i}`} className="text-text/90">
                <span className="text-muted">Slack{s.channel_label ? ` · ${s.channel_label}` : ""} · <RelTime at={s.at} />:</span>{" "}
                {s.permalink ? <a href={s.permalink} target="_blank" rel="noopener noreferrer" className="hover:underline">“{s.text.slice(0, 200)}”</a> : `“${s.text.slice(0, 200)}”`}
              </div>
            ))}
          </div>
        </details>
      )}

      {data.selection.others.length > 0 && (
        <p className="mt-4 text-[11px] text-muted">
          Also active: <TimeText text={data.selection.others.map((o) => `${o.title} (${o.newCount})`).join(" · ")} />
        </p>
      )}
    </section>
  );
}

function livePrOpen(pc: PrContextLike): { label: string; severity: "blocking" | "open" | "info"; url?: string }[] {
  const out: { label: string; severity: "blocking" | "open" | "info"; url?: string }[] = [];
  if (pc.review_decision === "CHANGES_REQUESTED") out.push({ label: "Changes requested on the PR", severity: "blocking" });
  const failing = (pc.checks || []).filter((c) => /FAIL|ERROR|CANCEL|TIMED_OUT/i.test(c.state));
  for (const c of failing.slice(0, 3)) out.push({ label: `Check failing (live): ${c.name}`, severity: "blocking", url: c.url });
  if ((pc.review_requests || []).length) out.push({ label: `Reviewers requested (live): ${pc.review_requests!.join(", ")}`, severity: "open" });
  if (pc.state && pc.state !== "OPEN") out.push({ label: `PR is ${pc.state.toLowerCase()} (live)`, severity: "info" });
  return out;
}

/** Resume for a Claude Code session reported by the Control hook (Stop / SessionEnd). */
export function SessionResumeCard({ data }: { data: SessionResume }) {
  const s = data.session;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.resume_command);
      setCopied(true);
      recordResumeActivity(data.workstream.key, "resumed", "Copied claude --resume command");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  const sm = s.summary;
  return (
    <section className="rounded-xl border border-amber/40 bg-surface p-5 shadow-[inset_3px_0_0_0_#E8A54B]" data-testid="resume-card" data-resume-kind="session">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-amber mb-1">Resume · Claude Code session</div>
          <h2 className="text-[18px] font-semibold leading-6">{data.workstream.title}</h2>
          <p className="mt-1 text-[12px] text-muted">
            Session <span className="font-mono">{s.session_id}</span> · {s.ended ? "ended" : "last turn"} <RelTime at={s.last_event_at} />
            {s.head ? <> · HEAD <span className="font-mono">{s.head.sha.slice(0, 7)}</span> {s.head.subject}</> : null}
          </p>
          <div className="mt-3 text-[13px] leading-5" data-testid="session-summary">
            {sm?.status === "ok" && sm.text ? (
              <p>
                {sm.text}
                <span className="block text-[11px] text-muted mt-1">Summary · Claude, from the session transcript</span>
              </p>
            ) : sm?.tail ? (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted">Transcript tail — not summarized{sm.running ? " (Claude summary running…)" : ""}</div>
                {sm.tail.last_user ? <p className="mt-1"><span className="text-muted">You: </span>“{sm.tail.last_user}”</p> : null}
                {sm.tail.last_assistant ? <p className="mt-1"><span className="text-muted">Claude: </span>“{sm.tail.last_assistant}”</p> : null}
              </div>
            ) : (
              <p className="text-muted">No session summary yet{sm?.error ? ` — ${sm.error}` : ""}.</p>
            )}
          </div>
          <NextLine next={data.next} />
        </div>
      </div>

      <div className="mt-4 text-[12px]">
        <h4 className="font-medium mb-1">Pick up in your terminal</h4>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded border border-border bg-bg px-2 py-1 font-mono text-[12px]" data-testid="session-resume-command">{s.resume_command}</code>
          <button type="button" className="btn-primary" onClick={() => void copy()} data-testid="session-copy">{copied ? "Copied" : "Copy"}</button>
        </div>
      </div>

      <div className="mt-4 text-[12px]" data-testid="session-diff">
        <h4 className="font-medium mb-1">
          Uncommitted changes{s.branch ? ` on ${s.branch}` : ""}
          {s.diff ? ` · ${s.diff.files_changed} file(s) +${s.diff.insertions}/−${s.diff.deletions}${s.diff.untracked ? ` · ${s.diff.untracked} untracked` : ""}` : ""}
        </h4>
        {!s.diff ? (
          <p className="text-muted">Not a git repo (cwd {s.cwd}).</p>
        ) : s.diff.files_changed === 0 && s.diff.untracked === 0 ? (
          <p className="text-muted">Working tree clean at the last hook event.</p>
        ) : (
          <pre className="overflow-x-auto rounded border border-border bg-bg p-2 font-mono text-[11px] leading-4">
            {[s.diff.stat || "", ...(s.diff.untracked_files ?? []).map((f) => `?? ${f}`)].filter(Boolean).join("\n")}
          </pre>
        )}
      </div>

      <p className="mt-3 text-[11px] text-muted" data-testid="resume-reason"><SelectionReason sel={data.selection} /></p>
      {data.selection.others.length > 0 && (
        <p className="mt-1 text-[11px] text-muted">Also active: <TimeText text={data.selection.others.map((o) => o.title).join(" · ")} /></p>
      )}
    </section>
  );
}

/** Resume for a manual workstream (added via ⌘K → New workstream, POST /api/workstreams, or /control-add). */
export function ManualResumeCard({ data }: { data: ManualResume }) {
  const m = data.manual;
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const copy = async () => {
    if (!m.resume_command) return;
    try {
      await navigator.clipboard.writeText(m.resume_command);
      setCopied(true);
      recordResumeActivity(data.workstream.key, "resumed", "Copied cd command");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="rounded-xl border border-amber/40 bg-surface p-5 shadow-[inset_3px_0_0_0_#E8A54B]" data-testid="resume-card" data-resume-kind="manual">
      <div className="text-[11px] uppercase tracking-wide text-amber mb-1">Resume · Manual</div>
      <h2 className="text-[18px] font-semibold leading-6">{m.title}</h2>
      <p className="mt-1 text-[12px] text-muted">
        {m.created_at === m.updated_at ? "Added" : "Updated"} <RelTime at={m.updated_at} />
        {m.repo ? <> · {m.repo}{m.branch ? ` · ${m.branch}` : ""}</> : null}
        {m.people?.length ? <> · with {m.people.join(", ")}</> : null}
      </p>
      {m.note ? <p className="mt-3 text-[13px] leading-5 whitespace-pre-wrap" data-testid="manual-resume-note">{m.note}</p> : null}
      <NextLine next={data.next} by="you" />
      {m.link ? (
        <a href={m.link} target="_blank" rel="noreferrer" className="mt-3 block truncate text-[12px] text-amber hover:underline" data-testid="manual-resume-link">{m.link}</a>
      ) : null}
      {m.resume_command ? (
        <div className="mt-4 text-[12px]">
          <h4 className="font-medium mb-1">Pick up in your terminal</h4>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded border border-border bg-bg px-2 py-1 font-mono text-[12px]">{m.resume_command}</code>
            <button type="button" className="btn-primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn-ghost"
          data-testid="manual-resume-done"
          onClick={async () => {
            const r = await setManualStatus(m.id, "done");
            setErr(r.ok ? null : r.error);
          }}
        >
          Mark done
        </button>
      </div>
      {err && <p className="mt-2 text-[12px] text-amber">{err}</p>}
      <p className="mt-3 text-[11px] text-muted" data-testid="resume-reason"><SelectionReason sel={data.selection} /></p>
      {data.selection.others.length > 0 && (
        <p className="mt-1 text-[11px] text-muted">Also active: <TimeText text={data.selection.others.map((o) => o.title).join(" · ")} /></p>
      )}
    </section>
  );
}
