import type { SeedLiveMode } from "./types";

/** Client persist key — separate from Zustand `control-v0` so Demo reset does not wipe mode unless we set it. */
export const SEED_LIVE_MODE_KEY = "control-v0-mode";

export const DEFAULT_SEED_LIVE_MODE: SeedLiveMode = "demo";

export function parseSeedLiveMode(raw: unknown): SeedLiveMode | null {
  if (raw === "demo" || raw === "live") return raw;
  return null;
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
