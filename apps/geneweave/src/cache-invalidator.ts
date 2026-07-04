/**
 * geneWeave — cache invalidator wiring (Phase 5).
 *
 * Holds the process-wide active `CacheInvalidator` (built in index.ts from the
 * shared store + semantic cache), loads invalidation rules from the DB (cached),
 * and exposes `emitCacheEvent` so real triggers (prompt-template update,
 * model-pricing change, knowledge update, session end, preference change) clear
 * the right cache entries. Also exposes the dynamic cache-key version token
 * (admin-tunable; bumping it invalidates every key without a restart).
 */
import type { CacheInvalidator, InvalidationEvent } from '@weaveintel/cache';
import type { CacheInvalidationRule } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';

let _invalidator: CacheInvalidator | undefined;

export function setActiveCacheInvalidator(inv: CacheInvalidator | undefined): void { _invalidator = inv; }
export function getActiveCacheInvalidator(): CacheInvalidator | undefined { return _invalidator; }

/** Emit a domain event to the active invalidator (best-effort, never throws). */
export async function emitCacheEvent(type: string, payload?: Record<string, unknown>): Promise<void> {
  try { await _invalidator?.handleEvent({ type, payload } as InvalidationEvent); } catch { /* best-effort */ }
}

// ─── Rules (DB-backed, 60s cache) ────────────────────────────

let _rulesCache: { ts: number; rules: CacheInvalidationRule[] } | null = null;

export async function loadInvalidationRules(db: DatabaseAdapter): Promise<CacheInvalidationRule[]> {
  const now = Date.now();
  if (_rulesCache && now - _rulesCache.ts < 60_000) return _rulesCache.rules;
  let rules: CacheInvalidationRule[] = [];
  try {
    const rows = await db.listCacheInvalidationRules?.();
    rules = (rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      trigger: r.trigger,
      pattern: r.pattern ?? undefined,
      config: r.config ? (JSON.parse(r.config) as Record<string, unknown>) : undefined,
      enabled: !!r.enabled,
    }));
  } catch { rules = []; }
  _rulesCache = { ts: now, rules };
  return rules;
}

export function _resetInvalidationRulesCache(): void { _rulesCache = null; }

// ─── Dynamic cache-key version (admin-tunable) ───────────────

let _versionCache: { ts: number; version: string } | null = null;

/** The global cache-key version token (cache_settings.global_version_token, 60s cache). */
export async function loadCacheKeyVersion(db: DatabaseAdapter): Promise<string> {
  const now = Date.now();
  if (_versionCache && now - _versionCache.ts < 60_000) return _versionCache.version;
  let version = 'v1';
  try {
    const s = await db.getCacheSettings?.();
    if (s?.global_version_token) version = s.global_version_token;
  } catch { /* default */ }
  _versionCache = { ts: now, version };
  return version;
}

export function _resetCacheKeyVersionCache(): void { _versionCache = null; }
