/** Shared Needs-you cap for external (origin github|slack) items. Ingest unlimited; oldest demote to FYI. User/PM locked at 5. Do NOT set to 2. */
export const NEEDS_YOU_EXTERNAL_CAP = 5;

/** @deprecated Prefer NEEDS_YOU_EXTERNAL_CAP — kept as alias for backwards compat. */
export const GITHUB_NEEDS_YOU_CAP = NEEDS_YOU_EXTERNAL_CAP;
