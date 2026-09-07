"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useControlStore } from "@/lib/store";

export default function NowPage() {
  const mode = useControlStore((s) => s.mode);
  if (mode === "focus") return <FocusNow />;
  if (mode === "clear") return <ClearNow />;
  return <MorningNow />;
}

function DayStrip() {
  const dayStrip = useControlStore((s) => s.dayStrip);
  const clockLabel = useControlStore((s) => s.clockLabel);

  return (
    <div className="panel px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="text-[13px] font-medium">{clockLabel}</div>
      <div className="h-4 w-px bg-border hidden sm:block" />
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {dayStrip.meetings.map((m) => (
          <Link
            key={m.id}
            href={`/source/calendar/${m.id}`}
            className="chip hover:text-text"
          >
            <span className="font-mono text-[11px]">{m.time}</span>
            {m.title}
          </Link>
        ))}
        <span className="chip border-running/30 text-running">
          {dayStrip.focusBlock}
        </span>
      </div>
      <div className="ml-auto text-[12px] text-muted">
        Standup in 18 min
      </div>
    </div>
  );
}

function MorningNow() {
  const router = useRouter();
  const workstreams = useControlStore((s) => s.workstreams);
  const attention = useControlStore((s) => s.attention);
  const needsYou = useMemo(
    () => attention.filter((a) => a.routing === "now" && !a.resolved),
    [attention]
  );
  const fyi = useControlStore((s) => s.fyi);
  const suggested = useControlStore((s) => s.suggestedDelegations);
  const used = useControlStore((s) => s.usedDelegationIds);
  const delegate = useControlStore((s) => s.delegate);
  const delegateAttention = useControlStore((s) => s.delegateAttention);
  const resolveAttention = useControlStore((s) => s.resolveAttention);
  const startFocus = useControlStore((s) => s.startFocus);
  const [fyiOpen, setFyiOpen] = useState(false);

  const resume = workstreams.find((w) => w.id === "ws-cred") ?? workstreams[0];

  return (
    <div className="mx-auto max-w-4xl px-8 py-8 space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-7">Now</h1>
          <p className="text-[12px] text-muted mt-1">
            Morning · understand the day, resume or decide
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => startFocus()}>
          Start focus
        </button>
      </header>

      <DayStrip />

      {resume && (
        <section className="rounded-xl border border-amber/40 bg-surface p-5 shadow-[inset_3px_0_0_0_#E8A54B]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-amber mb-1">
                Resume
              </div>
              <h2 className="text-[20px] font-semibold leading-7">
                {resume.name}
              </h2>
              <p className="mt-2 text-[13px] text-muted">
                Last active {resume.lastActive} · Phase {resume.phase}
              </p>
              <p className="mt-3 text-[13px] leading-5">
                <span className="text-muted">Next: </span>
                {resume.next}
              </p>
            </div>
            <button
              type="button"
              className="btn-primary shrink-0"
              onClick={() => router.push(`/workstreams/${resume.id}`)}
            >
              Resume
            </button>
          </div>
        </section>
      )}

      <section>
        <h3 className="text-[16px] font-semibold leading-6 mb-3">Needs you</h3>
        {needsYou.length === 0 ? (
          <div className="row px-4 py-3 text-muted">Nothing needs you right now.</div>
        ) : (
          <ul className="space-y-2">
            {needsYou.slice(0, 3).map((item) => (
              <li key={item.id} className="row px-4 py-3 flex items-start gap-3">
                <span className="mt-1.5 h-2 w-0.5 rounded bg-amber shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium">{item.title}</div>
                  <div className="text-[12px] text-muted mt-0.5">
                    Why: {item.why}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.suggestedAction === "delegate" && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => delegateAttention(item.id)}
                      >
                        Delegate
                      </button>
                    )}
                    {item.suggestedAction === "open_review" && (
                      <Link href="/review/rev-pr" className="btn-secondary">
                        Open Review
                      </Link>
                    )}
                    <Link
                      href={
                        item.provenance[0]
                          ? `/source/${item.provenance[0].kind}/${item.provenance[0].sourceId}`
                          : `/workstreams/${item.workstreamId}`
                      }
                      className="btn-ghost"
                    >
                      Open source
                    </Link>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => resolveAttention(item.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[16px] font-semibold leading-6 mb-3">
          Suggested delegations
        </h3>
        <div className="flex flex-wrap gap-2">
          {suggested.map((d) => {
            const usedAlready = used.includes(d.id);
            return (
              <button
                key={d.id}
                type="button"
                disabled={usedAlready}
                className="btn-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => delegate(d.id)}
              >
                {usedAlready ? "Delegated" : d.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] text-muted">
          Canned workers only. Completes into Review — no toast.
        </p>
      </section>

      <section className="panel">
        <button
          type="button"
          className="w-full flex items-center gap-2 px-4 py-3 text-left text-[13px]"
          onClick={() => setFyiOpen((v) => !v)}
        >
          {fyiOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-medium">FYI</span>
          <span className="text-muted">· shape of the day, no action</span>
        </button>
        {fyiOpen && (
          <ul className="border-t border-border px-4 py-3 space-y-1.5 text-[12px] text-muted">
            {fyi.map((line) => (
              <li key={line}>· {line}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FocusNow() {
  const workstreams = useControlStore((s) => s.workstreams);
  const focusId = useControlStore((s) => s.focusWorkstreamId);
  const agents = useControlStore((s) => s.agents);
  const attention = useControlStore((s) => s.attention);
  const reviewQueue = useControlStore((s) => s.reviewQueue);
  const running = useMemo(
    () => agents.filter((a) => a.status === "Running").length,
    [agents]
  );
  const needs = useMemo(
    () => attention.filter((a) => a.routing === "now" && !a.resolved).length,
    [attention]
  );
  const pending = useMemo(
    () => reviewQueue.filter((r) => r.status === "pending").length,
    [reviewQueue]
  );
  const endFocus = useControlStore((s) => s.endFocus);
  const ws =
    workstreams.find((w) => w.id === focusId) ??
    workstreams.find((w) => w.id === "ws-cred");

  return (
    <div className="mx-auto max-w-2xl px-8 py-24 space-y-8">
      <div className="text-[12px] text-muted uppercase tracking-wide">Focus</div>
      <div>
        <h1 className="text-[20px] font-semibold leading-7">
          {ws?.name ?? "Focus"}
        </h1>
        <p className="mt-3 text-[16px] leading-6 text-text/90">
          Next: {ws?.next}
        </p>
      </div>
      <p className="text-[13px] text-muted">
        {running} agents working · {needs} need you
        {pending > 0 ? ` · ${pending} in Review` : ""}
      </p>
      <p className="text-[12px] text-muted max-w-md">
        Agent completion only increments the Review badge. No toasts, banners, or
        pulses while you are here.
      </p>
      <div className="flex gap-2 pt-4">
        <button type="button" className="btn-secondary" onClick={endFocus}>
          End focus
        </button>
        <Link href="/review" className="btn-ghost">
          Open Review
        </Link>
        {ws && (
          <Link href={`/workstreams/${ws.id}`} className="btn-ghost">
            Open workstream
          </Link>
        )}
      </div>
    </div>
  );
}

function ClearNow() {
  const workstreams = useControlStore((s) => s.workstreams);
  const dayStrip = useControlStore((s) => s.dayStrip);
  const startFocus = useControlStore((s) => s.startFocus);
  const resume = workstreams.find((w) => w.id === "ws-cred");
  const nextMeeting = dayStrip.meetings.find((m) => m.time === "2:00");

  return (
    <div className="mx-auto max-w-2xl px-8 py-24 space-y-6">
      <DayStrip />
      <h1 className="text-[28px] font-semibold tracking-tight pt-8">Clear.</h1>
      <p className="text-[16px] text-muted leading-6">
        Next meeting {nextMeeting?.time ?? "2:00"} ·{" "}
        {nextMeeting?.title ?? "Design review"}.
      </p>
      <div className="flex gap-2 pt-2">
        {resume && (
          <Link href={`/workstreams/${resume.id}`} className="btn-primary">
            Resume {resume.name}
          </Link>
        )}
        <button type="button" className="btn-secondary" onClick={() => startFocus()}>
          Start focus
        </button>
      </div>
    </div>
  );
}
