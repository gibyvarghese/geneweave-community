/**
 * DbResilienceObserver — Phase 4 of `docs/RESILIENCE_PLAN.md`.
 *
 * Subscribes to the process-wide resilience signal bus and aggregates
 * per-endpoint counters into a `Map<endpoint, EndpointHealthDelta>` that
 * is flushed to the `endpoint_health` table on a fixed cadence.
 *
 * Best-effort by design: every DB write is `.catch(() => {})` so a busted
 * SQLite handle can never break a model call or tool call upstream.
 */

import { getDefaultSignalBus, type ResilienceSignal, type ResilienceSignalBus } from '@weaveintel/resilience';
import type { DatabaseAdapter, EndpointHealthDelta } from './db-types.js';

const FLUSH_INTERVAL_MS = 1000;

interface MutableDelta extends EndpointHealthDelta {
  // Identical shape — alias kept for clarity in the accumulator.
}

function ensure(map: Map<string, MutableDelta>, endpoint: string): MutableDelta {
  let d = map.get(endpoint);
  if (!d) { d = { endpoint }; map.set(endpoint, d); }
  return d;
}

function isoFrom(ms: number): string {
  return new Date(ms).toISOString();
}

export interface DbResilienceObserverHandle {
  /** Stop the flush timer and unsubscribe from the bus. Idempotent. */
  stop: () => void;
}

/**
 * @param bus - When supplied, subscribes to this bus directly. When omitted,
 *   falls back to `getDefaultSignalBus()` for backward compatibility.
 *   Pass the same bus that was given to `createRuntimeResilienceAdapter(bus)`
 *   so the observer and the runtime share one event source.
 */
export function applyDbResilienceObserver(db: DatabaseAdapter, bus?: ResilienceSignalBus): DbResilienceObserverHandle {
  const activeBus = bus ?? getDefaultSignalBus();
  const pending = new Map<string, MutableDelta>();

  const off = activeBus.on((sig: ResilienceSignal) => {
    try {
      const d = ensure(pending, sig.endpoint);
      d.last_signal_at = isoFrom(sig.at);
      switch (sig.kind) {
        case 'success':
          d.inc_success = (d.inc_success ?? 0) + 1;
          d.consecutive_failures = 0;
          (d.latency_samples_ms ??= []).push(sig.durationMs);
          break;
        case 'failed':
          d.inc_failed = (d.inc_failed ?? 0) + 1;
          break;
        case 'retrying':
          d.inc_retries = (d.inc_retries ?? 0) + 1;
          break;
        case 'rate_limited':
          d.inc_rate_limited = (d.inc_rate_limited ?? 0) + 1;
          d.last_429_at = isoFrom(sig.at);
          d.last_retry_after_ms = sig.retryAfterMs;
          break;
        case 'circuit_opened':
          d.inc_circuit_opens = (d.inc_circuit_opens ?? 0) + 1;
          d.circuit_state = 'open';
          d.last_circuit_opened_at = isoFrom(sig.at);
          d.consecutive_failures = sig.consecutiveFailures;
          break;
        case 'circuit_half_opened':
          d.circuit_state = 'half_open';
          break;
        case 'circuit_closed':
          d.circuit_state = 'closed';
          d.last_circuit_closed_at = isoFrom(sig.at);
          d.consecutive_failures = 0;
          break;
        case 'shed':
          d.inc_shed = (d.inc_shed ?? 0) + 1;
          break;
      }
    } catch {
      // Never let observer failures bubble up.
    }
  });

  const flush = (): void => {
    if (pending.size === 0) return;
    const drained = Array.from(pending.values());
    pending.clear();
    for (const delta of drained) {
      // Best-effort fire-and-forget. Adapter is sync under the hood (better-sqlite3),
      // but we still swallow any throw to honor the resilience contract.
      Promise.resolve()
        .then(() => db.applyEndpointHealthDelta(delta))
        .catch(() => { /* swallow */ });
    }
  };

  const timer = setInterval(flush, FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      off();
      flush(); // final drain
    },
  };
}
