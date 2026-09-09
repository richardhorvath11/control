"use client";

import { useCallback, useEffect, useState } from "react";
import { useControlStore } from "@/lib/store";

type SurfaceKind = "channel" | "im" | "mpim";
type SurfaceRow = {
  id: string;
  name: string;
  kind: SurfaceKind;
  prLinks: boolean;
};

type WatchResponse = {
  ok?: boolean;
  watch?: {
    repo: string;
    pr: number;
    workstreamId: string;
    teams: string[];
    slackWatch: {
      surfaces: {
        id: string;
        name?: string;
        kind: SurfaceKind;
        prLinks: boolean;
      }[];
      includeDms: boolean;
      includeMpims: boolean;
      myUserId?: string;
    };
    configured?: boolean;
  };
  error?: string;
};

/**
 * BYO Live setup — point Control at your repo/teams and slackWatch surfaces.
 * Persists via PUT /api/watch → `.control/watch.json`. Load demo never wipes this.
 */
export default function SettingsPage() {
  const setSeedLiveMode = useControlStore((s) => s.setSeedLiveMode);
  const seedLiveMode = useControlStore((s) => s.seedLiveMode);
  const [repo, setRepo] = useState("");
  const [pr, setPr] = useState("32");
  const [workstreamId, setWorkstreamId] = useState("ws-cred");
  const [teamsText, setTeamsText] = useState("");
  const [surfaces, setSurfaces] = useState<SurfaceRow[]>([
    { id: "", name: "", kind: "channel", prLinks: true },
    { id: "", name: "", kind: "channel", prLinks: true },
  ]);
  const [includeDms, setIncludeDms] = useState(false);
  const [includeMpims, setIncludeMpims] = useState(false);
  const [myUserId, setMyUserId] = useState("");
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
      const sw = w.slackWatch;
      const rows = (sw?.surfaces ?? []).map((c) => ({
        id: c.id,
        name: c.name ?? "",
        kind: c.kind ?? "channel",
        prLinks: c.prLinks !== false,
      }));
      while (rows.length < 2) {
        rows.push({ id: "", name: "", kind: "channel", prLinks: true });
      }
      setSurfaces(rows);
      setIncludeDms(sw?.includeDms === true);
      setIncludeMpims(sw?.includeMpims === true);
      setMyUserId(sw?.myUserId ?? "");
      const n = sw?.surfaces?.length ?? 0;
      setStatus(
        w.configured
          ? `Configured · ${n} surface(s)${sw?.includeDms ? " · DMs" : ""}${sw?.includeMpims ? " · MPIMs" : ""}`
          : "Not configured (need repo + ≥1 surface or include DMs/MPIMs)"
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

  const updateSurface = (index: number, patch: Partial<SurfaceRow>) => {
    setSurfaces((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c))
    );
  };

  const addSurface = () => {
    setSurfaces((prev) => [
      ...prev,
      { id: "", name: "", kind: "channel", prLinks: true },
    ]);
  };

  const removeSurface = (index: number) => {
    setSurfaces((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    const surfaceList = surfaces
      .map((c) => ({
        id: c.id.trim(),
        name: c.name.trim() || undefined,
        kind: c.kind,
        prLinks: c.prLinks,
      }))
      .filter((c) => c.id);
    if (surfaceList.length < 1 && !includeDms && !includeMpims) {
      setError("Add at least one Slack surface, or enable include DMs/MPIMs");
      setSaving(false);
      return;
    }
    if ((includeDms || includeMpims) && !myUserId.trim()) {
      setError("myUserId is required when include DMs or MPIMs is enabled");
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
          slackWatch: {
            surfaces: surfaceList,
            includeDms,
            includeMpims,
            ...(myUserId.trim() ? { myUserId: myUserId.trim() } : {}),
          },
        }),
      });
      const data = (await res.json()) as WatchResponse;
      if (!res.ok || !data.watch) {
        setError(data.error ?? "Save failed");
        return;
      }
      const n = data.watch.slackWatch?.surfaces?.length ?? 0;
      setStatus(
        `Saved · ${n} surface(s) · Live default when configured`
      );
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
                slackWatch surfaces
              </span>
              <button
                type="button"
                className="btn-ghost text-[12px]"
                onClick={addSurface}
              >
                Add surface
              </button>
            </div>
            {surfaces.map((ch, i) => (
              <div key={i} className="flex flex-wrap gap-2 items-center">
                <input
                  className="flex-1 min-w-[7rem] rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50 font-mono"
                  value={ch.id}
                  onChange={(e) => updateSurface(i, { id: e.target.value })}
                  placeholder="C… / D…"
                />
                <input
                  className="flex-1 min-w-[7rem] rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
                  value={ch.name}
                  onChange={(e) => updateSurface(i, { name: e.target.value })}
                  placeholder="#eng"
                />
                <select
                  className="rounded-lg border border-border bg-bg px-2 py-2 text-[12px]"
                  value={ch.kind}
                  onChange={(e) =>
                    updateSurface(i, {
                      kind: e.target.value as SurfaceKind,
                    })
                  }
                >
                  <option value="channel">channel</option>
                  <option value="im">im</option>
                  <option value="mpim">mpim</option>
                </select>
                <label className="flex items-center gap-1 text-[12px] text-muted whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={ch.prLinks}
                    onChange={(e) =>
                      updateSurface(i, { prLinks: e.target.checked })
                    }
                  />
                  prLinks
                </label>
                <button
                  type="button"
                  className="btn-ghost text-[12px] text-blocked"
                  onClick={() => removeSurface(i)}
                  disabled={surfaces.length <= 1}
                  title="Remove surface"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={includeDms}
                onChange={(e) => setIncludeDms(e.target.checked)}
              />
              includeDms
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={includeMpims}
                onChange={(e) => setIncludeMpims(e.target.checked)}
              />
              includeMpims
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              myUserId (required when include DMs/MPIMs)
            </span>
            <input
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50 font-mono"
              value={myUserId}
              onChange={(e) => setMyUserId(e.target.value)}
              placeholder="U…"
            />
          </label>

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
          Config shape is <code className="text-text">slackWatch</code> only.
          Legacy <code className="text-text">slackPrChannels</code> / scalars
          one-shot migrate on load (old keys deleted).{" "}
          <code className="text-text">prLinks:false</code> surfaces accept{" "}
          <code className="text-text">message</code> events but ignore{" "}
          <code className="text-text">pr_link</code> routing.
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
