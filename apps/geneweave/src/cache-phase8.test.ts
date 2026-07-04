/**
 * Cache Phase 8 — Agentic Plan Caching (app integration).
 *
 * Exercises the DB plumbing (m90 + CRUD + loadPlanCacheConfig) and the
 * holder/helpers that the chat path calls around an agent/supervisor run:
 *   - store a finished run's distilled plan (gated: completed + min_steps);
 *   - look it up for a similar later task and render it as planning guidance;
 *   - mode gating (direct never plans), scope isolation, and negative cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import {
  setActivePlanCache, getPlanCacheStats, loadPlanCacheConfig, _resetPlanCacheConfigCache,
  planScope, planCacheLookupGuidance, planCacheStoreFromResult,
} from './agent-plan-cache.js';
import { createAgentPlanCache, createPlanCacheMetrics } from '@weaveintel/agents';
import type { SemanticCache, SemanticCacheHit, AgentResult, AgentStep } from '@weaveintel/core';

function tmpDb(): string { return join(tmpdir(), `gw-cache-phase8-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }

function fakeSemanticCache(): SemanticCache {
  const entries = new Map<string, { q: string; r: unknown }>();
  const key = (q: string, scope?: string) => `${scope ?? 'g'}::${q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
  return {
    async find(query, opts): Promise<SemanticCacheHit | null> {
      const e = entries.get(key(query, opts?.scope));
      return e ? ({ response: e.r, similarity: 1, query: e.q } as SemanticCacheHit) : null;
    },
    async store(query, response, opts) { entries.set(key(query, opts?.scope), { q: query, r: response }); },
    async invalidate() {}, async clear() { entries.clear(); }, async size() { return entries.size; },
  };
}

const step = (s: Partial<AgentStep>): AgentStep => ({ index: 0, type: 'response', durationMs: 1, ...s } as AgentStep);
function result(over: Partial<AgentResult> & { steps: AgentStep[] }): AgentResult {
  return {
    output: 'an answer', messages: [], usage: { totalSteps: over.steps.length, promptTokens: 1, completionTokens: 1, totalTokens: 2, totalDurationMs: 1, toolCalls: 0, delegations: 0 },
    status: 'completed', ...over,
  } as AgentResult;
}
const STEPS3 = [
  step({ type: 'thinking', content: 'decompose: research then summarize' }),
  step({ type: 'delegation', delegation: { agent: 'researcher', goal: 'find facts' } }),
  step({ type: 'response', content: 'summary' }),
];

describe('Cache Phase 8 — DB config', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); _resetPlanCacheConfigCache(); });
  afterEach(async () => { await db.close(); });

  it('m90 seeds an enabled agent_plan_cache_config', async () => {
    const row = await db.getAgentPlanCacheConfig();
    expect(row?.enabled).toBe(1);
    expect(row?.similarity_threshold).toBeGreaterThan(0);
    expect(row?.min_steps).toBeGreaterThanOrEqual(1);
  });

  it('CRUD round-trip + loadPlanCacheConfig reflects updates', async () => {
    const cfg1 = await loadPlanCacheConfig(db);
    expect(cfg1?.enabled).toBe(true);
    await db.updateAgentPlanCacheConfig({ similarity_threshold: 0.7, min_steps: 5, scope: 'tenant' });
    _resetPlanCacheConfigCache();
    const cfg2 = await loadPlanCacheConfig(db);
    expect(cfg2?.threshold).toBe(0.7);
    expect(cfg2?.minSteps).toBe(5);
    expect(cfg2?.scope).toBe('tenant');
    await db.updateAgentPlanCacheConfig({ enabled: 0 });
    _resetPlanCacheConfigCache();
    expect(await loadPlanCacheConfig(db)).toBeNull(); // disabled → null
  });

  it('planScope isolates by user/tenant', () => {
    expect(planScope('user', null, 'uA')).not.toBe(planScope('user', null, 'uB'));
    expect(planScope('global', 't1', 'uA')).toBe(planScope('global', 't2', 'uB')); // global shares
  });
});

describe('Cache Phase 8 — store + lookup helpers', () => {
  let db: SQLiteAdapter;
  const userId = 'u-p8';
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); _resetPlanCacheConfigCache();
    setActivePlanCache(createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics: createPlanCacheMetrics() }), createPlanCacheMetrics());
  });
  afterEach(async () => { setActivePlanCache(undefined); await db.close(); });

  it('stores a completed multi-step plan and reuses it as guidance (supervisor)', async () => {
    const metrics = createPlanCacheMetrics();
    setActivePlanCache(createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics }), metrics);
    const goal = 'Research the population of Japan and summarize';
    await planCacheStoreFromResult(db, goal, result({ steps: STEPS3 }), 'supervisor', null, userId);
    expect(metrics.snapshot().stores).toBe(1);

    const guidance = await planCacheLookupGuidance(db, goal, 'supervisor', null, userId);
    expect(guidance).toBeTruthy();
    expect(guidance).toMatch(/Reference plan/i);
    expect(guidance).toContain('delegate→researcher');
    expect(metrics.snapshot().hits).toBe(1);
  });

  it('works for agent mode too', async () => {
    const goal = 'Compute the quarterly totals';
    await planCacheStoreFromResult(db, goal, result({ steps: [step({ type: 'tool_call', toolCall: { name: 'calculator', arguments: { expression: '1+1' } } }), step({ type: 'response' })] }), 'agent', null, userId);
    const guidance = await planCacheLookupGuidance(db, goal, 'agent', null, userId);
    expect(guidance).toContain('tool:calculator');
  });

  it('direct mode never stores or reuses a plan', async () => {
    const metrics = createPlanCacheMetrics();
    setActivePlanCache(createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics }), metrics);
    await planCacheStoreFromResult(db, 'g', result({ steps: STEPS3 }), 'direct', null, userId);
    expect(metrics.snapshot().stores).toBe(0);
    expect(await planCacheLookupGuidance(db, 'g', 'direct', null, userId)).toBeNull();
  });

  it('never caches a failed/denied run', async () => {
    const metrics = createPlanCacheMetrics();
    setActivePlanCache(createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics }), metrics);
    await planCacheStoreFromResult(db, 'g', result({ steps: STEPS3, status: 'guardrail_denied' }), 'supervisor', null, userId);
    await planCacheStoreFromResult(db, 'g2', result({ steps: STEPS3, status: 'failed' }), 'supervisor', null, userId);
    expect(metrics.snapshot().stores).toBe(0);
  });

  it('skips trivial runs below min_steps', async () => {
    const metrics = createPlanCacheMetrics();
    setActivePlanCache(createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics }), metrics);
    // default min_steps = 2; a single-step run is trivial.
    await planCacheStoreFromResult(db, 'g', result({ steps: [step({ type: 'response' })] }), 'supervisor', null, userId);
    expect(metrics.snapshot().stores).toBe(0);
  });

  it('scope isolation — user B never sees user A\'s plan', async () => {
    const goal = 'Build the weekly report';
    await planCacheStoreFromResult(db, goal, result({ steps: STEPS3 }), 'supervisor', null, 'userA');
    expect(await planCacheLookupGuidance(db, goal, 'supervisor', null, 'userA')).toBeTruthy();
    expect(await planCacheLookupGuidance(db, goal, 'supervisor', null, 'userB')).toBeNull();
  });

  it('no-op when plan caching is disabled in config', async () => {
    await db.updateAgentPlanCacheConfig({ enabled: 0 });
    _resetPlanCacheConfigCache();
    const metrics = createPlanCacheMetrics();
    setActivePlanCache(createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics }), metrics);
    await planCacheStoreFromResult(db, 'g', result({ steps: STEPS3 }), 'supervisor', null, userId);
    expect(metrics.snapshot().stores).toBe(0);
    expect(await planCacheLookupGuidance(db, 'g', 'supervisor', null, userId)).toBeNull();
  });

  it('getPlanCacheStats reflects the active cache', async () => {
    const metrics = createPlanCacheMetrics();
    setActivePlanCache(createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics }), metrics);
    await planCacheStoreFromResult(db, 'g', result({ steps: STEPS3 }), 'supervisor', null, userId);
    await planCacheLookupGuidance(db, 'g', 'supervisor', null, userId);
    const stats = getPlanCacheStats();
    expect(stats.enabled).toBe(true);
    expect(stats.stores).toBe(1);
    expect(stats.hits).toBe(1);
  });
});
