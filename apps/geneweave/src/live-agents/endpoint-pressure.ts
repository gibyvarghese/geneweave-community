/**
 * Shared endpoint-pressure helper for live-agent schedulers.
 *
 * Both the kaggle heartbeat (`heartbeat-runner.ts`) and the generic
 * supervisor (`generic-supervisor-boot.ts`) consult `endpoint_health` to
 * defer ticks when upstream LLM providers are circuit-open or
 * rate-limited. This module owns the read + classification logic so the
 * two schedulers stay in sync.
 *
 * The set of endpoint ids tracked here mirrors the `endpoint:` field
 * passed to `createResilientCallable` inside each `@weaveintel/provider-*`
 * package. Add new providers as they ship.
 */

import type { DatabaseAdapter } from '../db.js';

/** Provider endpoint ids the resilience-wrapped LLM clients register. */
export const LLM_ENDPOINT_IDS = ['openai:rest', 'anthropic:rest', 'google:rest'];

export interface EndpointPressure {
  /** Endpoint ids whose circuit is currently open. */
  openEndpoints: string[];
  /** Latest "do not call again until" deadline derived from a 429. */
  rateLimitedUntil: Date | null;
  /** Endpoint id that drove `rateLimitedUntil`. */
  rateLimitedEndpoint: string | null;
}

/**
 * Read `endpoint_health` and return the current pressure snapshot for
 * the LLM provider endpoints. Best-effort — never throws; on any DB
 * failure returns an "all clear" snapshot so scheduling proceeds.
 */
export async function getLlmEndpointPressure(
  db: DatabaseAdapter,
): Promise<EndpointPressure> {
  let rows: Awaited<ReturnType<DatabaseAdapter['listEndpointHealth']>> = [];
  try {
    rows = await db.listEndpointHealth({ limit: 50 });
  } catch (err) {
    // DB failure: assume ALL tracked endpoints may be pressured rather than
    // returning "all clear" — failing open would let schedulers hammer a
    // potentially-degraded provider. Callers should treat this as "unknown".
    console.error('[endpoint-pressure] DB lookup failed, assuming full endpoint pressure', err);
    return {
      openEndpoints: LLM_ENDPOINT_IDS,
      rateLimitedUntil: new Date(Date.now() + 60_000),
      rateLimitedEndpoint: null,
    };
  }
  const open: string[] = [];
  let rlUntil: Date | null = null;
  let rlEndpoint: string | null = null;
  const now = Date.now();
  for (const r of rows) {
    if (!LLM_ENDPOINT_IDS.includes(r.endpoint)) continue;
    if (r.circuit_state === 'open') open.push(r.endpoint);
    if (r.last_429_at && r.last_retry_after_ms && r.last_retry_after_ms > 0) {
      const until = new Date(new Date(r.last_429_at).getTime() + r.last_retry_after_ms);
      if (until.getTime() > now && (!rlUntil || until > rlUntil)) {
        rlUntil = until;
        rlEndpoint = r.endpoint;
      }
    }
  }
  return { openEndpoints: open, rateLimitedUntil: rlUntil, rateLimitedEndpoint: rlEndpoint };
}

/** Returns true when the snapshot indicates ticks should be deferred. */
export function isPressureBlocking(p: EndpointPressure): boolean {
  return (
    p.openEndpoints.length > 0 ||
    (p.rateLimitedUntil !== null && p.rateLimitedUntil.getTime() > Date.now())
  );
}

/** Build a stable dedupe key for an endpoint-pressure state. Empty when clear. */
export function pressureStateKey(p: EndpointPressure): string {
  if (p.openEndpoints.length > 0) {
    return `circuit:${[...p.openEndpoints].sort().join(',')}`;
  }
  if (p.rateLimitedEndpoint) {
    return `rate_limited:${p.rateLimitedEndpoint}:${p.rateLimitedUntil?.toISOString() ?? ''}`;
  }
  return '';
}

/** Format a human-friendly deferral reason for a given role. */
export function formatPressureReason(roleSlug: string, p: EndpointPressure): string {
  if (p.openEndpoints.length > 0) {
    return `${roleSlug} deferred — provider circuit open: ${p.openEndpoints.join(', ')}. No ticks scheduled until upstream recovers.`;
  }
  if (p.rateLimitedEndpoint) {
    return `${roleSlug} deferred — provider rate-limited (${p.rateLimitedEndpoint}). Next attempt after ${p.rateLimitedUntil?.toISOString() ?? 'unknown'}.`;
  }
  return `${roleSlug} deferred — upstream pressure.`;
}
