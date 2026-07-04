/**
 * geneWeave — semantic cache helpers (Phase 4).
 *
 * Shared by the send and stream chat paths: load the DB-driven semantic config,
 * compute the scope-isolated partition key, screen time-sensitive prompts, and
 * perform the scoped lookup / store. Kept here so both paths stay identical.
 */
import type { SemanticCache, CachePolicy } from '@weaveintel/core';
import { shouldBypass, cacheScopeKeyString } from '@weaveintel/cache';
import type { DatabaseAdapter } from './db.js';

export interface SemanticConfig {
  enabled: boolean;
  scope: string;          // 'global' | 'tenant' | 'user' | 'session'
  threshold: number;
  bypassPatterns: string[];
}

export interface SemanticCachedResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

let _cfgCache: { ts: number; cfg: SemanticConfig | null } | null = null;

/** Load semantic_cache_config (60s cache). Returns null when disabled/absent. */
export async function loadSemanticConfig(db: DatabaseAdapter): Promise<SemanticConfig | null> {
  const now = Date.now();
  if (_cfgCache && now - _cfgCache.ts < 60_000) return _cfgCache.cfg;
  let cfg: SemanticConfig | null = null;
  try {
    const row = await db.getSemanticCacheConfig?.();
    if (row && row.enabled) {
      cfg = {
        enabled: true,
        scope: row.scope ?? 'user',
        threshold: row.similarity_threshold ?? 0.92,
        bypassPatterns: row.bypass_patterns ? (JSON.parse(row.bypass_patterns) as string[]) : [],
      };
    }
  } catch { cfg = null; }
  _cfgCache = { ts: now, cfg };
  return cfg;
}

/** Reset the cached config (tests). */
export function _resetSemanticConfigCache(): void { _cfgCache = null; }

/**
 * Partition key for the semantic cache. The tenant id is ALWAYS folded in (so a
 * query from tenant B never matches tenant A); `user`/`session` scopes also add
 * the user id (no cross-user answer leakage for personalised content).
 */
export function semanticScope(scope: string, tenantId: string | null | undefined, userId: string): string {
  // Delegate to cacheScopeKeyString so the semantic partition string matches the
  // exact-cache scope prefix — this lets the admin invalidator clear BOTH caches
  // for a user/tenant with one scope key.
  switch (scope) {
    case 'global': return cacheScopeKeyString({ scope: 'global' });
    case 'tenant': return cacheScopeKeyString({ tenantId, scope: 'tenant' });
    case 'session':
    case 'user':
    default: return cacheScopeKeyString({ tenantId, userId, scope: 'user' });
  }
}

/** True when the prompt is time-sensitive (real-time/current/latest) → skip semantic caching. */
export function isSemanticBypassed(cfg: SemanticConfig, input: string): boolean {
  if (!cfg.bypassPatterns.length) return false;
  const policy = { id: 'sem', name: 'sem', enabled: true, scope: 'global', ttlMs: 0, bypassPatterns: cfg.bypassPatterns } as CachePolicy;
  return shouldBypass(policy, input);
}

/** Scoped semantic lookup. Returns the cached response or null. Best-effort. */
export async function semanticLookup(
  semanticCache: SemanticCache | undefined,
  cfg: SemanticConfig | null,
  query: string,
  tenantId: string | null | undefined,
  userId: string,
): Promise<SemanticCachedResponse | null> {
  if (!semanticCache || !cfg?.enabled || isSemanticBypassed(cfg, query)) {
    return null;
  }
  const scope = semanticScope(cfg.scope, tenantId, userId);
  const hit = await semanticCache.find(query, { scope, threshold: cfg.threshold }).catch(() => null);
  const resp = hit?.response as SemanticCachedResponse | undefined;
  return resp && typeof resp.content === 'string' ? { content: resp.content, usage: resp.usage } : null;
}

/** Scoped semantic store. Best-effort — never blocks the turn. */
export async function semanticStore(
  semanticCache: SemanticCache | undefined,
  cfg: SemanticConfig | null,
  query: string,
  response: SemanticCachedResponse,
  tenantId: string | null | undefined,
  userId: string,
): Promise<void> {
  if (!semanticCache || !cfg?.enabled || isSemanticBypassed(cfg, query)) {
    return;
  }
  const scope = semanticScope(cfg.scope, tenantId, userId);
  await semanticCache.store(query, response, { scope }).catch(() => { /* best-effort */ });
}
