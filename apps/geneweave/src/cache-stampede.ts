/**
 * geneWeave — cache stampede wiring (Phase 7).
 *
 * Holds the process-wide `Singleflight` (built in index.ts) so the send and
 * stream chat paths coalesce concurrent identical response-cache misses into a
 * single model call. Also provides the (DB-driven) stampede config and small,
 * shape-preserving helpers for negative caching and stale-while-revalidate so
 * the chat paths keep storing the SAME raw `{content, usage}` value (no envelope
 * change) while reusing the package's SWR algorithm (`shouldServeStale`).
 */
import { shouldServeStale, type Singleflight } from '@weaveintel/cache';
import type { DatabaseAdapter } from './db.js';

/** Minimal store shape the chat path's `responseCache` exposes (get + set). */
export interface CacheGetSet {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

let _singleflight: Singleflight | undefined;

export function setActiveSingleflight(sf: Singleflight | undefined): void { _singleflight = sf; }
export function getActiveSingleflight(): Singleflight | undefined { return _singleflight; }
export function getSingleflightStats(): { enabled: boolean; flights: number; coalesced: number; inFlight: number } {
  if (!_singleflight) return { enabled: false, flights: 0, coalesced: 0, inFlight: 0 };
  return { enabled: true, ..._singleflight.stats() };
}

// ─── DB-driven stampede config (60s cache) ───────────────────

export interface StampedeConfig {
  /** Coalesce concurrent identical requests (cache_settings.stampede_protection). */
  enabled: boolean;
  /** Global negative-cache TTL fallback (cache_settings.l1_negative_ttl_ms). */
  negativeTtlMs: number;
}

let _cfgCache: { ts: number; cfg: StampedeConfig } | null = null;

export async function loadStampedeConfig(db: DatabaseAdapter): Promise<StampedeConfig> {
  const now = Date.now();
  if (_cfgCache && now - _cfgCache.ts < 60_000) return _cfgCache.cfg;
  let cfg: StampedeConfig = { enabled: false, negativeTtlMs: 0 };
  try {
    const s = await db.getCacheSettings?.();
    if (s) cfg = { enabled: s.stampede_protection !== 0, negativeTtlMs: s.l1_negative_ttl_ms ?? 0 };
  } catch { /* table may be absent on a brand-new DB */ }
  _cfgCache = { ts: now, cfg };
  return cfg;
}

export function _resetStampedeConfigCache(): void { _cfgCache = null; }

// ─── Negative caching (shape-isolated under a neg:: prefix) ───

const NEG_PREFIX = 'neg::';

/** True when an identical request failed within the negative-cache window. */
export async function readNegativeCache(store: CacheGetSet, key: string): Promise<boolean> {
  try { return (await store.get(NEG_PREFIX + key)) != null; } catch { return false; }
}
/** Remember a failed/blocked turn so an immediate retry storm is shielded. */
export async function writeNegativeCache(store: CacheGetSet, key: string, ttlMs: number): Promise<void> {
  if (ttlMs <= 0) return;
  try { await store.set(NEG_PREFIX + key, { neg: 1, at: Date.now() }, ttlMs); } catch { /* best-effort */ }
}

// ─── Stale-while-revalidate (sidecar timestamp, shape-preserving) ───

const TS_PREFIX = 'ts::';

export interface SwrRead {
  value: { content: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } } | null;
  state: 'fresh' | 'stale' | 'miss';
}

/**
 * Read the response cache honouring SWR. With `swrMs <= 0` any hit is `fresh`
 * (legacy behaviour). With `swrMs > 0` the entry's age (from a sidecar
 * timestamp) decides fresh/stale/expired via the package algorithm; an expired
 * entry is reported as `miss` so the caller recomputes.
 */
export async function readResponseWithSwr(
  store: CacheGetSet,
  key: string,
  opts: { ttlMs: number; swrMs: number; now?: number },
): Promise<SwrRead> {
  const raw = await store.get(key).catch(() => null);
  if (raw == null || typeof (raw as { content?: unknown }).content !== 'string') return { value: null, state: 'miss' };
  const value = raw as SwrRead['value'];
  if (!opts.swrMs || opts.swrMs <= 0) return { value, state: 'fresh' };
  const now = opts.now ?? Date.now();
  const ts = (await store.get(TS_PREFIX + key).catch(() => null)) as number | null;
  if (ts == null) return { value, state: 'fresh' }; // no sidecar → treat as fresh
  const state = shouldServeStale({ ageMs: now - ts, ttlMs: opts.ttlMs, swrMs: opts.swrMs });
  if (state === 'expired') return { value: null, state: 'miss' };
  return { value, state };
}

/**
 * Write the response cache honouring SWR: when `swrMs > 0` the entry lives for
 * `ttlMs + swrMs` (so it survives into the stale window) and a sidecar
 * timestamp records the write time. With `swrMs <= 0` this is exactly the legacy
 * `set(key, value, ttlMs)`.
 */
export async function writeResponseWithSwr(
  store: CacheGetSet,
  key: string,
  value: unknown,
  opts: { ttlMs: number; swrMs: number },
): Promise<void> {
  const swr = opts.swrMs && opts.swrMs > 0 ? opts.swrMs : 0;
  await store.set(key, value, opts.ttlMs + swr);
  if (swr > 0) { try { await store.set(TS_PREFIX + key, Date.now(), opts.ttlMs + swr); } catch { /* best-effort */ } }
}
