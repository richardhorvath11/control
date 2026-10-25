"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useControlStore } from "@/lib/store";
import { recordResumeActivity } from "@/lib/resume-client";
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

export type ResumeResponse =
  | { ok: true; empty: true; emptyReason: string }
  | {
      ok: true;
      empty: false;
      selection: { key: string; rule: string; reason: string; others: { key: string; title: string; newCount: number }[] };
      workstream: { key: string; kind: "pr" | "slack"; title: string; url?: string; repo?: string; pr?: number };
      last_active: ResumeAction | null;
      changes: { total: number; groups: ChangeGroup[]; items: ResumeEvent[] };
      context: ResumeContext;
      pr_context: PrContextLike | null;
      next: NextState;
      primary_action: ResumePrimaryAction;
    }
  | { ok: false; error: string };

function ago(at?: string): string {
  if (!at) return "";
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

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
    return () => {
      stop = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [enabled, load]);
  return { data, reload: load };
}

export function NextLine({ next }: { next: NextState }) {
  if (next.status === "ok") {
    return (
      <p className="mt-3 text-[14px] leading-5" data-testid="resume-next">
        <span className="text-muted">Next: </span>
        {next.text}
        {next.why ? <span className="block text-[11px] text-muted mt-1">Why: {next.why} · Claude</span> : null}
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
      Next unavailable — {next.reason}
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
  const run = async (d: Extract<ResumeResponse, { empty: false }>) => {
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
        leftOff: d.last_active ? `${d.last_active.label} (${ago(d.last_active.at)})` : undefined,
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
            {w.kind === "pr" ? "Pull request" : "Slack thread"} · {data.selection.reason}
            {data.last_active ? ` · last active ${ago(data.last_active.at)}` : ""}
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
                    <a href={g.latest.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{g.latest.label}</a>
                  ) : (
                    g.latest.label
                  )}{" "}
                  <span className="text-muted">· {ago(g.latest.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="font-medium mb-1">Where you left off</h4>
          <ul className="space-y-1 text-text/90">
            <li>{data.last_active ? `${data.last_active.label} · ${ago(data.last_active.at)}` : "No action recorded yet."}</li>
            {ctx.left_off.user_draft ? <li className="text-muted">Your draft: “{ctx.left_off.user_draft.slice(0, 160)}”</li> : null}
            {lr ? (
              <li>
                Review ({ago(lr.at)}): {lr.findings.length} finding(s)
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
                {o.url ? <a href={o.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{o.label}</a> : o.label}
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
                <span className="text-muted">PR comment · {c.author} · {ago(c.created_at)}:</span> {c.body.slice(0, 240)}
              </div>
            ))}
            {ctx.slack.slice(0, 3).map((s, i) => (
              <div key={`s${i}`} className="text-text/90">
                <span className="text-muted">Slack{s.channel_label ? ` · ${s.channel_label}` : ""} · {ago(s.at)}:</span>{" "}
                {s.permalink ? <a href={s.permalink} target="_blank" rel="noopener noreferrer" className="hover:underline">“{s.text.slice(0, 200)}”</a> : `“${s.text.slice(0, 200)}”`}
              </div>
            ))}
          </div>
        </details>
      )}

      {data.selection.others.length > 0 && (
        <p className="mt-4 text-[11px] text-muted">
          Also active: {data.selection.others.map((o) => `${o.title} (${o.newCount})`).join(" · ")}
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
