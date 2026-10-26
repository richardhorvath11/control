"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startScan } from "@/lib/backfill-client";
import { useControlStore } from "@/lib/store";
import {
  WatchSetupForm,
  useWatchFormLoader,
  validateWatchForm,
  watchFormToPutBody,
  type WatchResponse,
} from "@/components/WatchSetupForm";

/**
 * BYO Live setup — point Control at your repo/teams and slackWatch surfaces.
 * Persists via PUT /api/watch → `.control/watch.json`. Load demo never wipes this.
 */
export default function SettingsPage() {
  const router = useRouter();
  const setSeedLiveMode = useControlStore((s) => s.setSeedLiveMode);
  const seedLiveMode = useControlStore((s) => s.seedLiveMode);
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

  const save = async () => {
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
        setError(data.error ?? "Save failed");
        return;
      }
      const n = data.watch.slackWatch?.surfaces?.length ?? 0;
      setStatus(`Saved · ${n} surface(s) · Live default when configured`);
      if (data.watch.configured && seedLiveMode !== "live") {
        setSeedLiveMode("live");
      }
      await load();
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 space-y-6">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">
          Live setup
        </h1>
        <p className="text-[13px] text-muted mt-1">
          Point Control at your repo/teams and{" "}
          <code className="text-text">slackWatch</code> surfaces (channels /
          DMs / MPIMs). Persists to{" "}
          <code className="text-text">.control/watch.json</code>. Monday seed
          is only via <strong>Load demo</strong> — not this path. Reviews use{" "}
          <strong className="text-text">Claude CLI + Pro</strong> (Gastown) —
          no Console API keys in Control.
        </p>
      </div>

      {loading ? (
        <div className="text-muted text-[13px]">Loading watch…</div>
      ) : (
        <div className="panel p-4 space-y-4">
          <WatchSetupForm
            values={values}
            onChange={setValues}
            disabled={saving}
          />

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save watch"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid="settings-scan-for-work"
              title="Read-only look back over Slack, GitHub and Claude Code sessions; you review every suggestion"
              onClick={() => void startScan("settings").then(() => router.push("/backfill"))}
            >
              Scan for existing work
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void load()}
              disabled={loading}
            >
              Reload
            </button>
            <Link href="/get-live" className="btn-ghost text-[12px]">
              Open Get Live wizard
            </Link>
            <Link href="/get-live/workers" className="btn-ghost text-[12px]">
              Start workers
            </Link>
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

      <div className="text-[12px] text-muted space-y-1">
        <p>
          Config shape is <code className="text-text">slackWatch</code> only.
          Legacy <code className="text-text">slackPrChannels</code> / scalars
          one-shot migrate on load (old keys deleted).{" "}
With &quot;Treat PR links posted here as review requests&quot; off
          (<code className="text-text">prLinks:false</code>), a channel&apos;s messages are
          still watched, but PR links in it don&apos;t create Review asks.
        </p>
        <p>
          Or edit{" "}
          <code className="text-text">.control/watch.json</code> / copy from{" "}
          <code className="text-text">watch.example.json</code>. No Slack token
          in Control.
        </p>
      </div>
    </div>
  );
}
