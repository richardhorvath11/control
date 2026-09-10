"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useControlStore } from "@/lib/store";
import {
  WatchSetupForm,
  useWatchFormLoader,
  validateWatchForm,
  watchFormToPutBody,
  type WatchResponse,
} from "@/components/WatchSetupForm";

/**
 * V0.9 chip 1 — First-run Get Live wizard.
 * Continue → PUT /api/watch + Switch to Live in one step.
 * Load Monday demo → Demo + seed; does not wipe watch.json.
 * No Slack / GitHub / Anthropic tokens collected.
 */
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
      if (!res.ok || !data.watch?.configured) {
        // Fail closed — no partial save / no mode flip.
        setError(data.error ?? "Watch not saved — fix validation and retry");
        setSaving(false);
        return;
      }
      setStatus(
        `Saved · ${data.watch.slackWatch?.surfaces?.length ?? 0} surface(s)`
      );
      // One step: persist watch + Switch to Live (wipes seed Needs-you).
      setSeedLiveMode("live");
      router.replace("/now");
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
            Point Control at your repo and Slack
          </h1>
          <p className="text-[13px] text-muted mt-2 leading-5">
            Live watches your GitHub repo and Slack surfaces. Reviews use{" "}
            <strong className="text-text">Claude CLI + Pro</strong> (Gastown) —
            no Console API keys, no tokens in this wizard. Worker launch and
            Claude verify are next steps after you&apos;re Live.
          </p>
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
            After Live:{" "}
            <span className="text-text">Next: start workers</span> (chip 2) —
            optional; this wizard does not require dogfood-up.
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
