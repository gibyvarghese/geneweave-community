// SPDX-License-Identifier: MIT
/**
 * Telemetry opt-out gate — the single place that decides whether this instance records telemetry.
 *
 * geneWeave's telemetry (LLM run traces via `recordTraceSpans`, and upgrade-lifecycle events via
 * `recordUpgradeTelemetry`) is recorded **locally** — into this instance's own database (and, only if the
 * operator sets `OTEL_EXPORTER_OTLP_ENDPOINT`, its own configured collector). Nothing is phoned home. Because
 * nothing leaves the instance by default, there is no cross-border data transfer and no consent banner to
 * manage; an operator who still wants telemetry OFF can opt out globally:
 *
 *   • `GENEWEAVE_TELEMETRY=0` (also `false` / `off` / `no`) → telemetry disabled;
 *   • the cross-vendor `DO_NOT_TRACK=1` (consoledonottrack.com convention) → telemetry disabled;
 *   • unset / any other value → telemetry enabled (the default).
 *
 * This is a pure function of the environment so it can be unit-tested and called from any layer (the trace
 * recorder, the upgrade emitter) without plumbing state around.
 */

/** Values of `GENEWEAVE_TELEMETRY` that mean "off" (case-insensitive). */
const DISABLED_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/**
 * Whether telemetry recording is enabled for this instance.
 * @param env the environment to read (defaults to `process.env`; injectable for tests).
 * @returns false when the operator has opted out via `DO_NOT_TRACK` or `GENEWEAVE_TELEMETRY`; true otherwise.
 */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Honor the cross-vendor Do-Not-Track signal: DO_NOT_TRACK=1 (or 'true') means opt out. Any other value
  // (including '0'/unset) does not force opt-out — it falls through to the geneWeave-specific flag.
  const dnt = (env['DO_NOT_TRACK'] ?? '').trim().toLowerCase();
  if (dnt === '1' || dnt === 'true') return false;

  const flag = env['GENEWEAVE_TELEMETRY'];
  if (flag != null && DISABLED_VALUES.has(flag.trim().toLowerCase())) return false;

  return true;
}
