/**
 * geneWeave — Agentic Plan Cache wiring (Phase 8).
 *
 * Holds the process-wide `AgentPlanCache` (built in index.ts over a dedicated
 * plan semantic cache), exposes the DB-driven config (60s cached), the
 * scope-isolation key, and the lookup/store helpers the chat path calls around
 * an agent/supervisor run. Plan caching only engages for `agent`/`supervisor`
 * turns — a `direct` turn has no plan to reuse.
 */
import type { AgentPlanCache, AgentPlanCacheMetrics } from '@weaveintel/agents';
import type { AgentResult } from '@weaveintel/core';
import { cacheScopeKeyString } from '@weaveintel/cache';
import type { DatabaseAdapter } from './db.js';

let _planCache: AgentPlanCache | undefined;
let _metrics: AgentPlanCacheMetrics | undefined;

export function setActivePlanCache(pc: AgentPlanCache | undefined, metrics?: AgentPlanCacheMetrics): void {
  _planCache = pc; _metrics = metrics;
}
export function getActivePlanCache(): AgentPlanCache | undefined { return _planCache; }

export function getPlanCacheStats(): { enabled: boolean; hits: number; misses: number; stores: number; hitRate: number } {
  if (!_planCache || !_metrics) return { enabled: false, hits: 0, misses: 0, stores: 0, hitRate: 0 };
  return { enabled: true, ..._metrics.snapshot() };
}

// ─── DB-driven config (60s cache) ────────────────────────────

export interface PlanCacheConfig {
  enabled: boolean;
  scope: string;        // 'global' | 'tenant' | 'user' | 'session'
  threshold: number;    // similarity a past plan must clear to be reused
  minSteps: number;     // min executed steps before a run's plan is cached
  ttlMs: number;
}

let _cfgCache: { ts: number; cfg: PlanCacheConfig | null } | null = null;

export async function loadPlanCacheConfig(db: DatabaseAdapter): Promise<PlanCacheConfig | null> {
  const now = Date.now();
  if (_cfgCache && now - _cfgCache.ts < 60_000) return _cfgCache.cfg;
  let cfg: PlanCacheConfig | null = null;
  try {
    const row = await db.getAgentPlanCacheConfig?.();
    if (row && row.enabled) {
      cfg = {
        enabled: true,
        scope: row.scope ?? 'user',
        threshold: row.similarity_threshold ?? 0.86,
        minSteps: row.min_steps ?? 2,
        ttlMs: row.ttl_ms ?? 86_400_000,
      };
    }
  } catch { cfg = null; }
  _cfgCache = { ts: now, cfg };
  return cfg;
}

export function _resetPlanCacheConfigCache(): void { _cfgCache = null; }

/** Scope-isolation key — a plan from tenant/user A is never offered to B. */
export function planScope(scope: string, tenantId: string | null | undefined, userId: string): string {
  switch (scope) {
    case 'global': return cacheScopeKeyString({ scope: 'global' });
    case 'tenant': return cacheScopeKeyString({ tenantId, scope: 'tenant' });
    case 'session':
    case 'user':
    default: return cacheScopeKeyString({ tenantId, userId, scope: 'user' });
  }
}

/** Only agent/supervisor turns produce a reusable plan. */
function isPlanningMode(mode: string): boolean { return mode === 'agent' || mode === 'supervisor'; }

/**
 * Look up a reusable plan for a semantically-similar past goal and render it as
 * a planning-guidance block to inject ahead of the agent's goal. Null when plan
 * caching is off, the mode isn't agent/supervisor, or there's no match.
 */
export async function planCacheLookupGuidance(
  db: DatabaseAdapter,
  goal: string,
  mode: string,
  tenantId: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!isPlanningMode(mode)) return null;
  const pc = getActivePlanCache();
  if (!pc) return null;
  const cfg = await loadPlanCacheConfig(db);
  if (!cfg?.enabled) return null;
  try {
    const scope = planScope(cfg.scope, tenantId, userId);
    const plan = await pc.lookup(goal, { scope, threshold: cfg.threshold });
    return plan ? pc.renderGuidance(plan) : null;
  } catch { return null; }
}

/**
 * Distill a finished run into a plan template and store it (scoped). Skips
 * failed/denied runs and trivial runs below the `min_steps` gate — so a cached
 * plan is always a *successful, non-trivial* template. Best-effort.
 */
export async function planCacheStoreFromResult(
  db: DatabaseAdapter,
  goal: string,
  result: AgentResult,
  mode: string,
  tenantId: string | null | undefined,
  userId: string,
): Promise<void> {
  if (!isPlanningMode(mode)) return;
  const pc = getActivePlanCache();
  if (!pc) return;
  const cfg = await loadPlanCacheConfig(db);
  if (!cfg?.enabled) return;
  if (result.status !== 'completed') return;                 // never cache a failed/denied plan
  if (!result.output || !result.output.trim()) return;
  if ((result.steps?.length ?? 0) < cfg.minSteps) return;     // skip trivial single-shot runs
  try {
    const scope = planScope(cfg.scope, tenantId, userId);
    const plan = pc.distill({ output: result.output, steps: result.steps }, goal);
    plan.createdAt = new Date().toISOString();
    await pc.store(goal, plan, { scope, ttlMs: cfg.ttlMs });
  } catch { /* best-effort */ }
}
