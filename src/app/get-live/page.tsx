"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useControlStore } from "@/lib/store";
import { startScan } from "@/lib/backfill-client";
import {
  WatchSetupForm,
  useWatchFormLoader,
  validateWatchForm,
  watchFormToPutBody,
  type WatchResponse,
} from "@/components/WatchSetupForm";

/**
 * V0.9 chip 1 — First-run Get Live wizard.
 * V0.9 chip 4 — Skip escape when configured; Claude CLI + Pro copy; never wipe watch.json.
 * Continue → PUT /api/watch + Switch to Live in one step.
 * Load Monday demo → Demo + seed; does not wipe watch.json.
 * No Slack / GitHub / Anthropic tokens collected.
 */
function sourcesSummary(w: NonNullable<WatchResponse["watch"]>): string {
  const n = (w.slackWatch?.surfaces?.length ?? 0) + (w.slackWatch?.includeDms || w.slackWatch?.includeMpims ? 1 : 0);
  const gh = w.repo ? `GitHub ${w.repo}` : "GitHub skipped";
  const sl = n ? `Slack ${w.slackWatch?.surfaces?.length ?? 0} surface(s)` : "Slack skipped";
  return `Saved · ${gh} · ${sl} · Claude sessions + manual items`;
}

export default function GetLivePage() {
  const router = useRouter();
  const setSeedLiveMode = useControlStore((s) => s.setSeedLiveMode);
  const {
    values,
    setValues,
    loading,
    error,
    setError,
    status,
    setStatus,
    load,
    configured,
  } = useWatchFormLoader();
  const [saving, setSaving] = useState(false);

  const continueLive = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);

    const clientErr = validateWatchForm(values);
    if (clientErr) {
      setError(clientErr);
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/watch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(watchFormToPutBody(values)),
      });
      const data = (await res.json()) as WatchResponse;
      if (!res.ok || !data.watch) {
        // Fail closed — no partial save / no mode flip.
        setError(data.error ?? "Watch not saved — fix validation and retry");
        setSaving(false);
        return;
      }
      setStatus(sourcesSummary(data.watch));
      // One step: persist watch + Switch to Live (wipes seed Needs-you).
      setSeedLiveMode("live");
      // First launch: queue the read-only backfill scan (existing pending work); review it at /backfill.
      void startScan("first_live");
      router.replace("/get-live/workers");
    } catch {
      setError("Save failed — watch not persisted");
      setSaving(false);
    }
  };

  const loadMondayDemo = () => {
    // Seeds Monday + Demo; does NOT wipe .control/watch.json.
    setSeedLiveMode("demo");
    router.replace("/now");
  };

  const skipWizard = () => {
    if (!configured) return;
    // Escape hatch (chip 4): leave without touching watch.json.
    router.replace("/now");
  };

  return (
    <div
      className="min-h-screen bg-bg text-text flex items-start justify-center px-6 py-12"
      data-testid="get-live-wizard"
    >
      <div className="w-full max-w-xl space-y-6">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-running mb-2">
            Get Live
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            Choose what Control watches
          </h1>
          <p className="text-[13px] text-muted mt-2 leading-5">
            Control can <strong className="text-text">watch</strong> one GitHub repo and
            the Slack channels, DMs and group DMs you choose. What it finds becomes
            items in <strong className="text-text">Needs-you</strong> and{" "}
            <strong className="text-text">Review</strong>.
          </p>
          <p className="text-[13px] mt-2 leading-5 rounded-lg border border-running/30 px-3 py-2" data-testid="get-live-optional">
            <strong>Every source is optional.</strong> Use GitHub only, Slack only, or
            neither — your Claude Code sessions and manual items (⌘K) always feed Live.
            Leave a field empty to skip that source; you can add it later in Settings.
          </p>
          <ul className="text-[12px] text-muted mt-2 leading-5 list-disc pl-5" data-testid="get-live-promises">
            <li>Control never posts notifications to Slack.</li>
            <li>Any reply or PR comment is a draft. Nothing goes out until you approve it.</li>
            <li>Reviews run on your Claude CLI login (Pro). No API keys needed.</li>
          </ul>
        </div>

        {loading ? (
          <div className="text-muted text-[13px]" data-testid="get-live-loading">
            Loading watch…
          </div>
        ) : (
          <div className="panel p-5 space-y-5">
            <WatchSetupForm
              values={values}
              onChange={setValues}
              compact
              disabled={saving}
            />

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void continueLive()}
                disabled={saving}
                data-testid="get-live-continue"
              >
                {saving ? "Saving…" : "Continue → Live"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={loadMondayDemo}
                disabled={saving}
                data-testid="get-live-load-demo"
              >
                Load Monday demo
              </button>
              <button
                type="button"
                className="btn-ghost text-[12px]"
                onClick={skipWizard}
                disabled={saving || !configured || loading}
                title={
                  configured
                    ? "Leave wizard without changing watch.json"
                    : "Nothing saved yet — use Continue → Live (works with no sources)"
                }
                data-testid="get-live-skip"
              >
                Skip → Now
              </button>
            </div>


            {status && (
              <div className="text-[12px] text-running" data-testid="watch-status">
                {status}
              </div>
            )}
            {error && (
              <div className="text-[12px] text-blocked" data-testid="watch-error">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="text-[12px] text-muted space-y-1.5 leading-5">
          <p>
            No Slack bot token, GitHub PAT, or Anthropic API key is collected
            here. Operators keep credentials on the worker host (
            <code className="text-text">claude</code> login / Pro).
          </p>
          <p>
            After Continue:{" "}
            <span className="text-text">start workers</span> checklist is next.
            Slack MCP stays out-of-band.
          </p>
          <p>
            Prefer the seeded Monday walkthrough? Use{" "}
            <button
              type="button"
              className="underline text-text hover:text-running"
              onClick={loadMondayDemo}
            >
              Load Monday demo
            </button>
            . That never wipes{" "}
            <code className="text-text">.control/watch.json</code>.
          </p>
          {!loading && (
            <button
              type="button"
              className="btn-ghost text-[12px] px-0"
              onClick={() => void load()}
            >
              Reload watch from disk
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
