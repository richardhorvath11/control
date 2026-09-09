import type { SeedLiveMode } from "./types";

/** Client persist key — separate from Zustand `control-v0` so Demo reset does not wipe mode unless we set it. */
export const SEED_LIVE_MODE_KEY = "control-v0-mode";

/**
 * Fallback when no preference and watch is NOT configured.
 * When watch IS configured (repo + ≥1 Slack channel) and no preference, first run defaults to Live.
 */
export const DEFAULT_SEED_LIVE_MODE: SeedLiveMode = "demo";

export function parseSeedLiveMode(raw: unknown): SeedLiveMode | null {
  if (raw === "demo" || raw === "live") return raw;
  return null;
}

/** True when the user (or Load demo / Switch) has written control-v0-mode. */
export function hasSeedLiveModePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SEED_LIVE_MODE_KEY) !== null;
  } catch {
    return false;
  }
}

export function readSeedLiveMode(): SeedLiveMode {
  if (typeof window === "undefined") return DEFAULT_SEED_LIVE_MODE;
  try {
    const parsed = parseSeedLiveMode(localStorage.getItem(SEED_LIVE_MODE_KEY));
    return parsed ?? DEFAULT_SEED_LIVE_MODE;
  } catch {
    return DEFAULT_SEED_LIVE_MODE;
  }
}

export function writeSeedLiveMode(mode: SeedLiveMode): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SEED_LIVE_MODE_KEY, mode);
  } catch {
    /* ignore quota / private mode */
  }
}
