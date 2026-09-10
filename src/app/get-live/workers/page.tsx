"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CLAUDE_VERIFY_HINTS,
  CLAUDE_VERIFY_WAIT_MS,
} from "@/lib/review-contracts";

/**
 * V0.9 chip 2 — post-Get Live worker checklist.
 * V0.9 chip 3 — Verify Claude (additive; checklist independent).
 * Polls GET /api/watchers/status every 3-5s.
 * Local required: review-worker, github-outbox, github-watch.
 * Slack rows informational — never block Continue to /now.
 */

type WatcherRow = {
  id: string;
  status: string;
  display_status?: string;
  last_action: string;
  detail?: string;
  updated_at: string;
  stale?: boolean;
};

type VerifyStatus = "idle" | "checking" | "ok" | "failed";

const LOCAL_REQUIRED = ["review-worker", "github-outbox", "github-watch"] as const;
const SLACK_INFO = ["slack-watch", "slack-outbox"] as const;
const LAUNCH_CMD = "./scripts/dogfood-up";
const VERIFY_POLL_MS = 2000;

function isGreen(row: WatcherRow | undefined): boolean {
  if (!row || !row.updated_at) return false;
  if (row.stale) return false;
  const status = row.display_status || row.status;
  if (status === "error" || status === "stale") return false;
  return status === "idle" || status === "ticking" || status === "waiting";
}

function mapVerifyFailHint(raw: string): string {
  const t = (raw || "").toLowerCase();
  if (/not found on path|claude cli missing|claude_on_path|missing/.test(t)) {
    return CLAUDE_VERIFY_HINTS.missing;
  }
  if (/not logged|setup-token|login|oauth|unauthorized|auth/.test(t)) {
    return CLAUDE_VERIFY_HINTS.not_logged_in;
  }
  if (/worker_down|dogfood-up|not running|waiting timed out|control-review-worker/.test(t)) {
    return /timed out|waiting timed/.test(t)
      ? CLAUDE_VERIFY_HINTS.timeout
      : CLAUDE_VERIFY_HINTS.worker_down;
  }
  if (/timed out|timeout/.test(t)) return CLAUDE_VERIFY_HINTS.timeout;
  return raw.trim() || CLAUDE_VERIFY_HINTS.timeout;
}

export default function GetLiveWorkersPage() {
  const router = useRouter();
  const [watchers, setWatchers] = useState<WatcherRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus>("idle");
  const [verifyHint, setVerifyHint] = useState<string | null>(null);
  const verifyInFlight = useRef(false);
  const verifyAbort = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/watchers/status");
      const data = (await res.json()) as {
        ok?: boolean;
        watchers?: WatcherRow[];
        error?: string;
      };
      if (!res.ok || !data.watchers) {
        setError(data.error ?? "Failed to load watcher status");
        return;
      }
      setWatchers(data.watchers);
      setError(null);
    } catch {
      setError("Failed to load watcher status");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 4000);
    return () => window.clearInterval(id);
  }, [load]);

  const byId = new Map(watchers.map((w) => [w.id, w]));

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(LAUNCH_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const runVerifyClaude = async () => {
    // Safe double-click: ignore while checking.
    if (verifyInFlight.current || verifyStatus === "checking") return;
    verifyInFlight.current = true;
    const gen = ++verifyAbort.current;
    setVerifyStatus("checking");
    setVerifyHint(null);

    const still = () => gen === verifyAbort.current;

    try {
      // 1) Optional which-claude probe
      try {
        const st = await fetch("/api/review/claude-status");
        const sdata = (await st.json().catch(() => ({}))) as {
          ok?: boolean;
          claude_on_path?: boolean;
          hint?: string;
        };
        if (!still()) return;
        if (st.ok && sdata.claude_on_path === false) {
          setVerifyStatus("failed");
          setVerifyHint(sdata.hint || CLAUDE_VERIFY_HINTS.missing);
          return;
        }
      } catch {
        // Probe optional — continue to worker path.
      }

      // 2) Require review-worker heartbeat (fresh checklist row)
      const rw = byId.get("review-worker");
      if (!isGreen(rw)) {
        // Refresh once in case poll is stale
        await load();
        if (!still()) return;
        const res2 = await fetch("/api/watchers/status");
        const data2 = (await res2.json().catch(() => ({}))) as {
          watchers?: WatcherRow[];
        };
        const row = (data2.watchers || []).find((w) => w.id === "review-worker");
        if (!isGreen(row)) {
          setVerifyStatus("failed");
          setVerifyHint(CLAUDE_VERIFY_HINTS.worker_down);
          return;
        }
      }

      // 3) Enqueue verify smoke (idempotent server-side)
      const res = await fetch("/api/review/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "verify", smoke: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        pending?: boolean;
        code?: string;
        error?: string;
        hint?: string;
        job?: { job_id?: string } | null;
        job_id?: string;
      };
      if (!still()) return;

      if (!res.ok || data.ok === false) {
        setVerifyStatus("failed");
        setVerifyHint(
          mapVerifyFailHint(data.hint || data.error || CLAUDE_VERIFY_HINTS.worker_down)
        );
        return;
      }

      const jobId =
        (typeof data.job?.job_id === "string" && data.job.job_id.trim()) ||
        (typeof data.job_id === "string" && data.job_id.trim()) ||
        "";
      if (!jobId) {
        setVerifyStatus("failed");
        setVerifyHint(CLAUDE_VERIFY_HINTS.timeout);
        return;
      }

      // 4) Poll ≤90s — fail closed; never invent Review findings
      const started = Date.now();
      while (Date.now() - started < CLAUDE_VERIFY_WAIT_MS) {
        if (!still()) return;
        await new Promise((r) => window.setTimeout(r, VERIFY_POLL_MS));
        if (!still()) return;
        try {
          const poll = await fetch(
            `/api/review/jobs/${encodeURIComponent(jobId)}`
          );
          const pdata = (await poll.json().catch(() => ({}))) as {
            ok?: boolean;
            status?: string;
            error?: string | null;
            result?: {
              status?: string;
              summary?: string;
              findings?: unknown[];
            } | null;
          };
          if (pdata.status === "done" && pdata.result) {
            const findings = Array.isArray(pdata.result.findings)
              ? pdata.result.findings
              : [];
            const okShape =
              pdata.result.status === "ok" &&
              /claude ok/i.test(pdata.result.summary || "") &&
              findings.length === 0;
            if (okShape) {
              setVerifyStatus("ok");
              setVerifyHint(CLAUDE_VERIFY_HINTS.ok);
            } else if (pdata.result.status === "error") {
              setVerifyStatus("failed");
              setVerifyHint(mapVerifyFailHint(pdata.result.summary || ""));
            } else {
              // Unexpected shape — fail closed (no fake Review)
              setVerifyStatus("failed");
              setVerifyHint(
                mapVerifyFailHint(pdata.result.summary || "unexpected verify result")
              );
            }
            return;
          }
          if (pdata.status === "failed") {
            setVerifyStatus("failed");
            setVerifyHint(mapVerifyFailHint(pdata.error || ""));
            return;
          }
        } catch {
          // transient poll errors — keep waiting
        }
      }
      if (!still()) return;
      setVerifyStatus("failed");
      setVerifyHint(CLAUDE_VERIFY_HINTS.timeout);
    } catch (err) {
      if (!still()) return;
      setVerifyStatus("failed");
      setVerifyHint(
        mapVerifyFailHint(err instanceof Error ? err.message : "verify failed")
      );
    } finally {
      verifyInFlight.current = false;
    }
  };

  const verifyChipClass =
    verifyStatus === "ok"
      ? "text-running"
      : verifyStatus === "failed"
        ? "text-blocked"
        : verifyStatus === "checking"
          ? "text-review"
          : "text-muted";

  return (
    <div
      className="min-h-screen bg-bg text-text flex items-start justify-center px-6 py-12"
      data-testid="get-live-workers"
    >
      <div className="w-full max-w-xl space-y-6">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-running mb-2">
            Get Live · Workers
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            Start local dogfood workers
          </h1>
          <p className="text-[13px] text-muted mt-2 leading-5">
            One host command starts opaque HTTP workers. Reviews use{" "}
            <strong className="text-text">Claude CLI + Pro</strong> via{" "}
            <code className="text-text">control-review-worker</code> — no Console
            API keys, no fake Live. Slack MCP stays copy-paste / out-of-band.
          </p>
        </div>

        <div className="panel p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="flex-1 min-w-0 rounded-md border border-border bg-raised px-3 py-2 text-[13px] font-mono"
              data-testid="dogfood-up-cmd"
            >
              {LAUNCH_CMD}
            </code>
            <button
              type="button"
              className="btn-secondary text-[12px]"
              onClick={() => void copyCmd()}
              data-testid="copy-dogfood-up"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[12px] text-muted leading-5">
            Default{" "}
            <code className="text-text">CONTROL_BASE_URL=http://localhost:3000</code>
            . Ctrl-C or{" "}
            <code className="text-text">./scripts/dogfood-up --stop</code> stops
            children. Prints Slack MCP copy from{" "}
            <code className="text-text">scripts/slack-watch.md</code> — no Slack
            token required.
          </p>
        </div>

        <div className="panel p-5 space-y-3" data-testid="worker-checklist">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-semibold leading-6">Checklist</h2>
              <p className="text-[12px] text-muted mt-0.5">
                Polls <code className="text-text">GET /api/watchers/status</code>{" "}
                every ~4s. Ids align with Agents board.
              </p>
            </div>
            <button
              type="button"
              className="btn-ghost text-[12px]"
              onClick={() => void load()}
            >
              Refresh
            </button>
          </div>
          {error && (
            <div className="text-[12px] text-blocked">{error}</div>
          )}
          <ul className="space-y-2">
            {LOCAL_REQUIRED.map((id) => {
              const row = byId.get(id);
              const green = isGreen(row);
              return (
                <li
                  key={id}
                  className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5"
                  data-watcher-id={id}
                  data-checklist="required"
                >
                  <span
                    className={
                      green
                        ? "text-running text-[14px]"
                        : "text-muted text-[14px]"
                    }
                    aria-label={green ? "green" : "pending"}
                  >
                    {green ? "●" : "○"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[12px]">{id}</div>
                    <div className="text-[11px] text-muted truncate">
                      {row?.last_action || "waiting for heartbeat…"}
                    </div>
                  </div>
                  <span className="chip text-[11px] shrink-0">
                    {green
                      ? row?.display_status || row?.status || "ok"
                      : "pending"}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="pt-2 border-t border-border/60 space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">
              Slack (informational — never blocks)
            </div>
            {SLACK_INFO.map((id) => {
              const row = byId.get(id);
              const green = isGreen(row);
              return (
                <div
                  key={id}
                  className="flex items-center gap-3 px-3 py-1.5"
                  data-watcher-id={id}
                  data-checklist="informational"
                >
                  <span
                    className={
                      green ? "text-running text-[12px]" : "text-muted text-[12px]"
                    }
                  >
                    {green ? "●" : "○"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[12px]">{id}</div>
                    <div className="text-[11px] text-muted">
                      Out-of-band Slack MCP — optional
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* V0.9 chip 3 — Verify Claude (additive; no API key fields) */}
        <div
          className="panel p-5 space-y-3"
          data-testid="verify-claude"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold leading-5">
                Claude CLI (Pro)
              </div>
              <p className="text-[12px] text-muted mt-0.5 leading-5">
                Checks Claude CLI + Pro can serve the Gastown review worker.
                Pass = green. Fail = next step — never invents Review findings.
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary text-[12px] shrink-0"
              onClick={() => void runVerifyClaude()}
              disabled={verifyStatus === "checking"}
              data-testid="verify-claude-btn"
              aria-busy={verifyStatus === "checking"}
            >
              {verifyStatus === "checking" ? "Checking…" : "Verify Claude"}
            </button>
          </div>
          <div
            className="flex items-start gap-2"
            data-verify-status={verifyStatus}
          >
            <span className={`${verifyChipClass} text-[14px] leading-5`} aria-hidden>
              {verifyStatus === "ok"
                ? "●"
                : verifyStatus === "failed"
                  ? "●"
                  : verifyStatus === "checking"
                    ? "◉"
                    : "○"}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-[12px] font-mono ${verifyChipClass}`}>
                status: {verifyStatus}
              </div>
              {verifyHint && (
                <div
                  className={`text-[12px] mt-1 leading-5 ${
                    verifyStatus === "failed" ? "text-blocked" : "text-muted"
                  }`}
                  data-testid="verify-claude-hint"
                >
                  {verifyHint}
                </div>
              )}
              {verifyStatus === "idle" && (
                <div className="text-[11px] text-muted mt-1">
                  Requires <code className="text-text">./scripts/dogfood-up</code>{" "}
                  (review-worker heartbeat) · no ANTHROPIC_API_KEY
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            onClick={() => router.push("/now")}
            data-testid="workers-continue-now"
          >
            I&apos;ve started them → Now
          </button>
          <Link
            href="/agents"
            className="btn-secondary"
            data-testid="workers-open-agents"
          >
            Open Agents
          </Link>
        </div>

        <p className="text-[12px] text-muted leading-5">
          Slack rows never block navigation to Now. Happy path: Claude CLI + Pro
          via control-review-worker — no API keys, no fake Live.
        </p>
      </div>
    </div>
  );
}
