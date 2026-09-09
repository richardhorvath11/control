"use client";

import { useCallback, useEffect, useState } from "react";
import { useControlStore } from "@/lib/store";

type ChannelRow = { id: string; name: string };

type WatchResponse = {
  ok?: boolean;
  watch?: {
    repo: string;
    pr: number;
    workstreamId: string;
    teams: string[];
    slackPrChannels: { id: string; name?: string }[];
    configured?: boolean;
  };
  error?: string;
};

/**
 * BYO Live setup — point Control at your repo/teams and ≥2 Slack PR channels.
 * Persists via PUT /api/watch → `.control/watch.json`. Load demo never wipes this.
 */
export default function SettingsPage() {
  const setSeedLiveMode = useControlStore((s) => s.setSeedLiveMode);
  const seedLiveMode = useControlStore((s) => s.seedLiveMode);
  const [repo, setRepo] = useState("");
  const [pr, setPr] = useState("32");
  const [workstreamId, setWorkstreamId] = useState("ws-cred");
  const [teamsText, setTeamsText] = useState("");
  const [channels, setChannels] = useState<ChannelRow[]>([
    { id: "", name: "" },
    { id: "", name: "" },
  ]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/watch");
      const data = (await res.json()) as WatchResponse;
      if (!res.ok || !data.watch) {
        setError(data.error ?? "Failed to load watch");
        return;
      }
      const w = data.watch;
      setRepo(w.repo);
      setPr(String(w.pr));
      setWorkstreamId(w.workstreamId);
      setTeamsText((w.teams ?? []).join(", "));
      const ch = (w.slackPrChannels ?? []).map((c) => ({
        id: c.id,
        name: c.name ?? "",
      }));
      while (ch.length < 2) ch.push({ id: "", name: "" });
      setChannels(ch);
      setStatus(
        w.configured
          ? `Configured · ${w.slackPrChannels.length} Slack channel(s)`
          : "Not configured (need repo + ≥1 Slack channel)"
      );
    } catch {
      setError("Failed to load watch (is Control running?)");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateChannel = (index: number, patch: Partial<ChannelRow>) => {
    setChannels((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c))
    );
  };

  const addChannel = () => {
    setChannels((prev) => [...prev, { id: "", name: "" }]);
  };

  const removeChannel = (index: number) => {
    setChannels((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    const slackPrChannels = channels
      .map((c) => ({
        id: c.id.trim(),
        name: c.name.trim() || undefined,
      }))
      .filter((c) => c.id);
    if (slackPrChannels.length < 1) {
      setError("Add at least one Slack channel id");
      setSaving(false);
      return;
    }
    const teams = teamsText
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const prNum = Number.parseInt(pr, 10);
    try {
      const res = await fetch("/api/watch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: repo.trim(),
          pr: Number.isFinite(prNum) ? prNum : undefined,
          workstreamId: workstreamId.trim() || undefined,
          teams,
          slackPrChannels,
        }),
      });
      const data = (await res.json()) as WatchResponse;
      if (!res.ok || !data.watch) {
        setError(data.error ?? "Save failed");
        return;
      }
      setStatus(
        `Saved · ${data.watch.slackPrChannels.length} Slack channels · Live default when configured`
      );
      // Dogfood path: after saving a configured watch, switch to Live (not seed).
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
          Point Control at your repo/teams and multiple Slack PR channels.
          Persists to{" "}
          <code className="text-text">.control/watch.json</code>. Monday seed
          is only via <strong>Load demo</strong> — not this path.
        </p>
      </div>

      {loading ? (
        <div className="text-muted text-[13px]">Loading watch…</div>
      ) : (
        <div className="panel p-4 space-y-4">
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              Repo (owner/name)
            </span>
            <input
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-muted">
                Primary PR (optional)
              </span>
              <input
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
                value={pr}
                onChange={(e) => setPr(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-muted">
                Workstream id
              </span>
              <input
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
                value={workstreamId}
                onChange={(e) => setWorkstreamId(e.target.value)}
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              Teams (comma-separated; empty = no team review.requested)
            </span>
            <input
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
              value={teamsText}
              onChange={(e) => setTeamsText(e.target.value)}
              placeholder="org/team"
            />
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-muted">
                Slack PR channels (≥2 recommended)
              </span>
              <button
                type="button"
                className="btn-ghost text-[12px]"
                onClick={addChannel}
              >
                Add channel
              </button>
            </div>
            {channels.map((ch, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50 font-mono"
                  value={ch.id}
                  onChange={(e) => updateChannel(i, { id: e.target.value })}
                  placeholder="C…"
                />
                <input
                  className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
                  value={ch.name}
                  onChange={(e) => updateChannel(i, { name: e.target.value })}
                  placeholder="#pr-reviews"
                />
                <button
                  type="button"
                  className="btn-ghost text-[12px] text-blocked"
                  onClick={() => removeChannel(i)}
                  disabled={channels.length <= 1}
                  title="Remove channel"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 pt-2">
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
              onClick={() => void load()}
              disabled={loading}
            >
              Reload
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

      <div className="text-[12px] text-muted space-y-1">
        <p>
          Legacy <code className="text-text">slackPrChannelId</code> /{" "}
          <code className="text-text">slackPrChannelName</code> still load as a
          one-element list. Prefer{" "}
          <code className="text-text">slackPrChannels</code>.
        </p>
        <p>
          Or edit{" "}
          <code className="text-text">.control/watch.json</code> / copy from{" "}
          <code className="text-text">watch.example.json</code>.
        </p>
      </div>
    </div>
  );
}
