"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * V0.9 chip 2 — post-Get Live worker checklist.
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

const LOCAL_REQUIRED = ["review-worker", "github-outbox", "github-watch"] as const;
const SLACK_INFO = ["slack-watch", "slack-outbox"] as const;
const LAUNCH_CMD = "./scripts/dogfood-up";

function isGreen(row: WatcherRow | undefined): boolean {
  if (!row || !row.updated_at) return false;
  if (row.stale) return false;
  const status = row.display_status || row.status;
  if (status === "error" || status === "stale") return false;
  return status === "idle" || status === "ticking" || status === "waiting";
}

export default function GetLiveWorkersPage() {
  const router = useRouter();
  const [watchers, setWatchers] = useState<WatcherRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
