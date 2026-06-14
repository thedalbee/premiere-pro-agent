// Premiere-launch timeouts, overridable via environment variables.
//
// On slow or cold-launching machines Premiere can take a while to reopen a
// project or for the UXP plugin to reconnect. The cut result is already verified
// at the file level (independent of Premiere), so reopen/reconnect are pure
// convenience steps — waiting longer costs nothing. These env vars let users on
// slow hardware raise the ceiling without editing code. Defaults preserve the
// current behavior exactly.
//
// Resolved at call time (not at module load) so a process/test can change the
// value and have it take effect on the next call.

const DEFAULT_REOPEN_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_PROJECT_INFO_TIMEOUT_MS = 5_000;

// Robustness guard: a missing, empty, non-numeric, or non-positive env value
// falls back to the default so a malformed override can never break a build.
function resolveTimeout(envName: string, fallbackMs: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

/** ms to wait for reopening the project in Premiere after a destructive build. Env: PPRO_REOPEN_TIMEOUT_MS (default 30000). */
export function reopenTimeoutMs(): number {
  return resolveTimeout("PPRO_REOPEN_TIMEOUT_MS", DEFAULT_REOPEN_TIMEOUT_MS);
}

/** ms to wait for the UXP plugin to reconnect after the project reopens. Env: PPRO_RECONNECT_TIMEOUT_MS (default 30000). */
export function reconnectTimeoutMs(): number {
  return resolveTimeout("PPRO_RECONNECT_TIMEOUT_MS", DEFAULT_RECONNECT_TIMEOUT_MS);
}

/** ms for a project.info probe to a possibly still-launching Premiere. Env: PPRO_PROJECT_INFO_TIMEOUT_MS (default 5000). */
export function projectInfoTimeoutMs(): number {
  return resolveTimeout("PPRO_PROJECT_INFO_TIMEOUT_MS", DEFAULT_PROJECT_INFO_TIMEOUT_MS);
}
