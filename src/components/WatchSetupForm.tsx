"use client";

import { useCallback, useEffect, useState } from "react";

export type SurfaceKind = "channel" | "im" | "mpim";

export type SurfaceRow = {
  id: string;
  name: string;
  kind: SurfaceKind;
  prLinks: boolean;
};

export type WatchResponse = {
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

export type WatchFormValues = {
  repo: string;
  pr: string;
  workstreamId: string;
  teamsText: string;
  surfaces: SurfaceRow[];
  includeDms: boolean;
  includeMpims: boolean;
  myUserId: string;
};

const EMPTY_SURFACE: SurfaceRow = {
  id: "",
  name: "",
  kind: "channel",
  prLinks: true,
};

export function blankWatchForm(): WatchFormValues {
  return {
    repo: "",
    pr: "",
    workstreamId: "ws-live",
    teamsText: "",
    surfaces: [{ ...EMPTY_SURFACE }],
    includeDms: false,
    includeMpims: false,
    myUserId: "",
  };
}

export function watchResponseToForm(w: NonNullable<WatchResponse["watch"]>): WatchFormValues {
  const rows = (w.slackWatch?.surfaces ?? []).map((c) => ({
    id: c.id,
    name: c.name ?? "",
    kind: c.kind ?? ("channel" as SurfaceKind),
    prLinks: c.prLinks !== false,
  }));
  while (rows.length < 1) {
    rows.push({ ...EMPTY_SURFACE });
  }
  return {
    repo: w.repo ?? "",
    pr: w.pr ? String(w.pr) : "",
    workstreamId: w.workstreamId || "ws-live",
    teamsText: (w.teams ?? []).join(", "),
    surfaces: rows,
    includeDms: w.slackWatch?.includeDms === true,
    includeMpims: w.slackWatch?.includeMpims === true,
    myUserId: w.slackWatch?.myUserId ?? "",
  };
}

/** Client-side validation mirroring PUT /api/watch + isWatchConfigured. */
export function validateWatchForm(v: WatchFormValues): string | null {
  if (!v.repo.trim()) return "GitHub repo is required (owner/name)";
  const surfaceList = v.surfaces
    .map((c) => c.id.trim())
    .filter(Boolean);
  if (surfaceList.length < 1 && !v.includeDms && !v.includeMpims) {
    return "Add at least one Slack surface, or enable include DMs/MPIMs";
  }
  if ((v.includeDms || v.includeMpims) && !v.myUserId.trim()) {
    return "myUserId is required when include DMs or MPIMs is enabled";
  }
  return null;
}

export function watchFormToPutBody(v: WatchFormValues) {
  const surfaceList = v.surfaces
    .map((c) => ({
      id: c.id.trim(),
      name: c.name.trim() || undefined,
      kind: c.kind,
      prLinks: c.prLinks,
    }))
    .filter((c) => c.id);
  const teams = v.teamsText
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const prNum = Number.parseInt(v.pr, 10);
  return {
    repo: v.repo.trim(),
    pr: Number.isFinite(prNum) && prNum > 0 ? prNum : undefined,
    workstreamId: v.workstreamId.trim() || undefined,
    teams,
    slackWatch: {
      surfaces: surfaceList,
      includeDms: v.includeDms,
      includeMpims: v.includeMpims,
      ...(v.myUserId.trim() ? { myUserId: v.myUserId.trim() } : {}),
    },
  };
}

type Props = {
  values: WatchFormValues;
  onChange: (next: WatchFormValues) => void;
  /** Hide workstream / teams (wizard keeps the form tight). */
  compact?: boolean;
  disabled?: boolean;
};

/**
 * Shared BYO watch fields — Settings + Get Live wizard.
 * No tokens (Slack / GitHub / Anthropic) collected here.
 */
export function WatchSetupForm({ values, onChange, compact, disabled }: Props) {
  const patch = (partial: Partial<WatchFormValues>) =>
    onChange({ ...values, ...partial });

  const updateSurface = (index: number, p: Partial<SurfaceRow>) => {
    patch({
      surfaces: values.surfaces.map((c, i) =>
        i === index ? { ...c, ...p } : c
      ),
    });
  };

  const addSurface = () => {
    patch({ surfaces: [...values.surfaces, { ...EMPTY_SURFACE }] });
  };

  const removeSurface = (index: number) => {
    if (values.surfaces.length <= 1) return;
    patch({ surfaces: values.surfaces.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          GitHub repo (owner/name) *
        </span>
        <input
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
          value={values.repo}
          onChange={(e) => patch({ repo: e.target.value })}
          placeholder="owner/name"
          disabled={disabled}
          data-testid="watch-repo"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Primary PR (optional)
        </span>
        <input
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
          value={values.pr}
          onChange={(e) => patch({ pr: e.target.value })}
          placeholder="32"
          disabled={disabled}
          data-testid="watch-pr"
        />
      </label>

      {!compact && (
        <>
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              Workstream id
            </span>
            <input
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
              value={values.workstreamId}
              onChange={(e) => patch({ workstreamId: e.target.value })}
              disabled={disabled}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              Teams (comma-separated; empty = no team review.requested)
            </span>
            <input
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
              value={values.teamsText}
              onChange={(e) => patch({ teamsText: e.target.value })}
              placeholder="org/team"
              disabled={disabled}
            />
          </label>
        </>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            Slack surfaces
          </span>
          <button
            type="button"
            className="btn-ghost text-[12px]"
            onClick={addSurface}
            disabled={disabled}
          >
            Add
          </button>
        </div>
        {values.surfaces.map((ch, i) => (
          <div key={i} className="flex flex-wrap gap-2 items-center">
            <input
              className="flex-1 min-w-[7rem] rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50 font-mono"
              value={ch.id}
              onChange={(e) => updateSurface(i, { id: e.target.value })}
              placeholder="C… / D…"
              disabled={disabled}
              data-testid={`watch-surface-id-${i}`}
            />
            <input
              className="flex-1 min-w-[7rem] rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50"
              value={ch.name}
              onChange={(e) => updateSurface(i, { name: e.target.value })}
              placeholder="#eng"
              disabled={disabled}
            />
            <select
              className="rounded-lg border border-border bg-bg px-2 py-2 text-[12px]"
              value={ch.kind}
              onChange={(e) =>
                updateSurface(i, { kind: e.target.value as SurfaceKind })
              }
              disabled={disabled}
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
                disabled={disabled}
              />
              prLinks
            </label>
            <button
              type="button"
              className="btn-ghost text-[12px] text-blocked"
              onClick={() => removeSurface(i)}
              disabled={disabled || values.surfaces.length <= 1}
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
            checked={values.includeDms}
            onChange={(e) => patch({ includeDms: e.target.checked })}
            disabled={disabled}
            data-testid="watch-include-dms"
          />
          DMs
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={values.includeMpims}
            onChange={(e) => patch({ includeMpims: e.target.checked })}
            disabled={disabled}
            data-testid="watch-include-mpims"
          />
          MPIMs
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          myUserId (required if DMs or MPIMs checked)
        </span>
        <input
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-running/50 font-mono"
          value={values.myUserId}
          onChange={(e) => patch({ myUserId: e.target.value })}
          placeholder="U…"
          disabled={disabled}
          data-testid="watch-my-user-id"
        />
      </label>
    </div>
  );
}

/** Load current watch into form state (shared by Settings + Get Live). */
export function useWatchFormLoader() {
  const [values, setValues] = useState<WatchFormValues>(blankWatchForm);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/watch");
      const data = (await res.json()) as WatchResponse;
      if (!res.ok || !data.watch) {
        setError(data.error ?? "Failed to load watch");
        setValues(blankWatchForm());
        setConfigured(false);
        return;
      }
      setValues(watchResponseToForm(data.watch));
      setConfigured(data.watch.configured === true);
      const n = data.watch.slackWatch?.surfaces?.length ?? 0;
      const sw = data.watch.slackWatch;
      setStatus(
        data.watch.configured
          ? `Configured · ${n} surface(s)${sw?.includeDms ? " · DMs" : ""}${sw?.includeMpims ? " · MPIMs" : ""}`
          : "Not configured (need repo + ≥1 surface or include DMs/MPIMs)"
      );
    } catch {
      setError("Failed to load watch (is Control running?)");
      setConfigured(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    values,
    setValues,
    loading,
    error,
    setError,
    status,
    setStatus,
    configured,
    load,
  };
}
