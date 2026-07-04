/**
 * GeneWeave — tool-cache-registry.ts (Cache Phase 6).
 *
 * Wraps a ToolRegistry so each tool's result is cached per the DB-driven
 * `tool_cache_policies` (opt-in, per-tool TTL). Placed as the INNERMOST wrapper
 * in createToolRegistry — beneath policy enforcement and the scope guard — so
 * authorization, rate-limiting and scope checks STILL run on every call while
 * only the expensive `invoke()` (external fetch / computation) is served from
 * cache on a hit.
 *
 * The package primitive `withToolResultCache` does the actual key/get/set; this
 * module just resolves the per-tool policy (cached 60s) and exposes a process
 * holder so the admin "Tool Cache" stats endpoint can report hits/entries.
 */
import type { ToolRegistry, Tool, ExecutionContext, ToolInput, CacheStore, CacheMetrics } from '@weaveintel/core';
import { withToolResultCache } from '@weaveintel/cache';
import type { DatabaseAdapter } from './db.js';

/** Resolved, effective caching decision for a single tool. */
export interface ResolvedToolCachePolicy {
  cacheable: boolean;
  ttlMs: number;
}

/** Callbacks injected from ChatEngine to drive per-tool caching. */
export interface ToolResultCacheCallbacks {
  /** The shared cache store (same underlying store as the response cache). */
  store: CacheStore;
  /** Resolve the effective policy for a tool; null/`cacheable:false` → no caching. */
  getPolicy(toolName: string): Promise<ResolvedToolCachePolicy | null>;
  /** Key prefix folded into every tool key (the global version token → bump busts all). */
  keyPrefix?: string;
  /** Dedicated tool-cache metrics sink (kept separate from response-cache metrics). */
  metrics?: CacheMetrics;
}

/**
 * Returns a ToolRegistry whose tools transparently cache their results when the
 * DB policy marks them cacheable. Non-cacheable tools run untouched.
 */
export function wrapWithToolResultCache(registry: ToolRegistry, opts: ToolResultCacheCallbacks): ToolRegistry {
  function wrapTool(tool: Tool): Tool {
    const original = tool.invoke.bind(tool);
    return {
      schema: tool.schema,
      async invoke(ctx: ExecutionContext, input: ToolInput) {
        let policy: ResolvedToolCachePolicy | null = null;
        try { policy = await opts.getPolicy(tool.schema.name); } catch { policy = null; }
        if (!policy || !policy.cacheable) return original(ctx, input);
        // Delegate to the reusable package primitive for the actual get/set.
        const cached = withToolResultCache(tool, opts.store, {
          cacheable: true,
          ttlMs: policy.ttlMs,
          ...(opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : {}),
          ...(opts.metrics ? { metrics: opts.metrics } : {}),
        });
        return cached.invoke(ctx, input);
      },
    };
  }

  return {
    register(tool: Tool): void { registry.register(tool); },
    unregister(name: string): void { registry.unregister(name); },
    get(name: string): Tool | undefined {
      const t = registry.get(name);
      return t ? wrapTool(t) : undefined;
    },
    list(): Tool[] { return registry.list().map(wrapTool); },
    listByTag(tag: string): Tool[] { return registry.listByTag(tag).map(wrapTool); },
    toDefinitions() { return registry.toDefinitions(); },
  };
}

// ─── DB-backed tool cache policies (60s cache) ───────────────────────────────

let _policyCache: { ts: number; map: Map<string, ResolvedToolCachePolicy> } | null = null;

/**
 * Load `tool_cache_policies` into a `tool_name → {cacheable, ttlMs}` map (60s
 * cache). Only enabled + cacheable rows become `cacheable:true`.
 */
export async function loadToolCachePolicies(db: DatabaseAdapter): Promise<Map<string, ResolvedToolCachePolicy>> {
  const now = Date.now();
  if (_policyCache && now - _policyCache.ts < 60_000) return _policyCache.map;
  const map = new Map<string, ResolvedToolCachePolicy>();
  try {
    const rows = await db.listToolCachePolicies?.();
    for (const r of rows ?? []) {
      map.set(r.tool_name, { cacheable: !!r.enabled && !!r.cacheable, ttlMs: r.ttl_ms ?? 300_000 });
    }
  } catch { /* table may not exist on a brand-new DB — no tool caching */ }
  _policyCache = { ts: now, map };
  return map;
}

export function _resetToolCachePoliciesCache(): void { _policyCache = null; }

/** Build a `getPolicy` resolver backed by the (cached) DB policies. */
export function makeToolCachePolicyResolver(db: DatabaseAdapter): (toolName: string) => Promise<ResolvedToolCachePolicy | null> {
  return async (toolName: string) => {
    const map = await loadToolCachePolicies(db);
    return map.get(toolName) ?? null;
  };
}

// ─── Process-wide stats holder (admin observability) ─────────────────────────

let _active: { store: CacheStore; metrics: CacheMetrics } | undefined;

export function setActiveToolCache(active: { store: CacheStore; metrics: CacheMetrics } | undefined): void { _active = active; }

/** Snapshot of tool-cache hits/misses/sets + live entry count (best-effort). */
export async function getToolCacheStats(): Promise<{ enabled: boolean; hits: number; misses: number; sets: number; hitRate: number; entries: number }> {
  if (!_active) return { enabled: false, hits: 0, misses: 0, sets: 0, hitRate: 0, entries: 0 };
  const rc = _active.metrics.snapshot().responseCache;
  let entries = 0;
  try {
    const store = _active.store as CacheStore & { keys?: (p?: string) => Promise<string[]> };
    if (typeof store.keys === 'function') entries = (await store.keys('tool-result||')).length;
  } catch { /* best-effort */ }
  return { enabled: true, hits: rc.hits, misses: rc.misses, sets: rc.sets, hitRate: rc.hitRate, entries };
}
