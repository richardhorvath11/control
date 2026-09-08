/**
 * Live checkpoint merge (V0.6 chip 2): preserve pre-Latest seed body,
 * replace any trailing `\n\nLatest:…` with a single templated Latest line.
 * No LLM.
 */

/** Cap for workstream.changed prepends from inbox apply. */
export const CHANGED_ENTRY_CAP = 8;

const LATEST_BLOCK = /\n\nLatest:[\s\S]*$/;

/**
 * Strip a trailing `\n\nLatest:…` block (if any), then append
 * `\n\nLatest: {checkpointLine}`. Preserves the pre-Latest body.
 */
export function mergeCheckpoint(
  prev: string,
  checkpointLine: string
): string {
  const body = (prev ?? "").replace(LATEST_BLOCK, "").replace(/\s+$/, "");
  const line = checkpointLine.trim();
  if (!line) return body;
  if (!body) return `Latest: ${line}`;
  return `${body}\n\nLatest: ${line}`;
}

/** Trim event summary for checkpoint templates (≤120 chars). */
export function trimCheckpointSummary(summary: string, max = 120): string {
  const t = (summary ?? "").trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/**
 * Prepend a changed entry if it is not already first; cap length.
 */
export function prependChangedEntry(
  changed: string[],
  entry: string,
  cap: number = CHANGED_ENTRY_CAP
): string[] {
  if (changed[0] === entry) return changed.slice(0, cap);
  return [entry, ...changed].slice(0, cap);
}
