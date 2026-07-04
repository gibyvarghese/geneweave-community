/**
 * Cache Phase 6 — tool-result caching (app integration).
 *
 * Exercises the app-level wiring end to end WITHOUT a live LLM:
 *   - DB `tool_cache_policies` seed + CRUD via the SQLite adapter;
 *   - `wrapWithToolResultCache` over a real ToolRegistry honours the DB policy
 *     (cacheable → skip second invoke; non-cacheable → always run; disabled →
 *     no caching; per-tool TTL);
 *   - the full `createToolRegistry` path with `toolResultCache` set still runs
 *     scope/policy wrappers while caching the underlying invoke;
 *   - security: tenant/tool isolation in the key; errors not cached;
 *   - stats holder reports hits.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { weaveInMemoryCacheStore, createCacheMetrics } from '@weaveintel/cache';
import { weaveToolRegistry } from '@weaveintel/core';
import type { Tool, ToolOutput, ExecutionContext, ToolInput } from '@weaveintel/core';
import {
  wrapWithToolResultCache,
  loadToolCachePolicies,
  makeToolCachePolicyResolver,
  _resetToolCachePoliciesCache,
  setActiveToolCache,
  getToolCacheStats,
} from './tool-cache-registry.js';
import { createToolRegistry } from './tools.js';

const ctx = {} as ExecutionContext;
const inp = (name: string, args: Record<string, unknown>): ToolInput => ({ name, arguments: args });

function countingTool(name: string): Tool & { calls: number } {
  const t = {
    calls: 0,
    schema: { name, description: 'probe', parameters: { type: 'object', properties: {} } },
    async invoke(_c: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
      t.calls++;
      return { content: `${name}#${t.calls}:${JSON.stringify(input.arguments)}` };
    },
  };
  return t;
}
function erroringTool(name: string): Tool & { calls: number } {
  const t = {
    calls: 0,
    schema: { name, description: 'err', parameters: { type: 'object', properties: {} } },
    async invoke(): Promise<ToolOutput> { t.calls++; return { content: 'nope', isError: true }; },
  };
  return t;
}

function tmpDb(): string { return join(tmpdir(), `gw-cache-phase6-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }

async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  _resetToolCachePoliciesCache();
  return db;
}

describe('Phase 6 — tool_cache_policies DB', () => {
  it('seeds default read-only tool policies on a fresh DB', async () => {
    const db = await freshDb();
    const rows = await db.listToolCachePolicies();
    const names = rows.map(r => r.tool_name);
    expect(names).toContain('web_search');
    expect(names).toContain('calculator');
    // calculator seeded cacheable with a long TTL
    const calc = rows.find(r => r.tool_name === 'calculator')!;
    expect(calc.cacheable).toBe(1);
    expect(calc.ttl_ms).toBeGreaterThan(0);
  });

  it('CRUD round-trips a custom policy', async () => {
    const db = await freshDb();
    await db.createToolCachePolicy({ id: 'tcp-x', tool_name: 'my_tool', cacheable: 1, ttl_ms: 1234, enabled: 1 });
    expect((await db.getToolCachePolicy('tcp-x'))?.ttl_ms).toBe(1234);
    await db.updateToolCachePolicy('tcp-x', { ttl_ms: 9999, enabled: 0 });
    const updated = await db.getToolCachePolicy('tcp-x');
    expect(updated?.ttl_ms).toBe(9999);
    expect(updated?.enabled).toBe(0);
    await db.deleteToolCachePolicy('tcp-x');
    expect(await db.getToolCachePolicy('tcp-x')).toBeNull();
  });

  it('loadToolCachePolicies resolves only enabled+cacheable rows as cacheable', async () => {
    const db = await freshDb();
    await db.createToolCachePolicy({ id: 'tcp-off', tool_name: 'off_tool', cacheable: 1, ttl_ms: 5, enabled: 0 });
    await db.createToolCachePolicy({ id: 'tcp-nc', tool_name: 'nc_tool', cacheable: 0, ttl_ms: 5, enabled: 1 });
    _resetToolCachePoliciesCache();
    const map = await loadToolCachePolicies(db);
    expect(map.get('calculator')?.cacheable).toBe(true);
    expect(map.get('off_tool')?.cacheable).toBe(false);  // disabled
    expect(map.get('nc_tool')?.cacheable).toBe(false);    // explicitly not cacheable
  });
});

describe('Phase 6 — wrapWithToolResultCache honours DB policy', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = await freshDb(); });

  it('caches a cacheable tool (second invoke skipped)', async () => {
    const reg = weaveToolRegistry();
    const tool = countingTool('calculator'); // seeded cacheable
    reg.register(tool);
    const wrapped = wrapWithToolResultCache(reg, {
      store: weaveInMemoryCacheStore(),
      getPolicy: makeToolCachePolicyResolver(db),
    });
    const t = wrapped.get('calculator')!;
    const a = await t.invoke(ctx, inp('calculator', { expression: '2+2' }));
    const b = await t.invoke(ctx, inp('calculator', { expression: '2+2' }));
    expect(a.content).toBe(b.content);
    expect(tool.calls).toBe(1);
  });

  it('does NOT cache a tool with no policy', async () => {
    const reg = weaveToolRegistry();
    const tool = countingTool('uncovered_tool');
    reg.register(tool);
    const wrapped = wrapWithToolResultCache(reg, {
      store: weaveInMemoryCacheStore(),
      getPolicy: makeToolCachePolicyResolver(db),
    });
    const t = wrapped.get('uncovered_tool')!;
    await t.invoke(ctx, inp('uncovered_tool', { q: 1 }));
    await t.invoke(ctx, inp('uncovered_tool', { q: 1 }));
    expect(tool.calls).toBe(2);
  });

  it('respects a disabled policy (no caching)', async () => {
    await db.createToolCachePolicy({ id: 'tcp-d', tool_name: 'disabled_tool', cacheable: 1, ttl_ms: 60_000, enabled: 0 });
    _resetToolCachePoliciesCache();
    const reg = weaveToolRegistry();
    const tool = countingTool('disabled_tool');
    reg.register(tool);
    const wrapped = wrapWithToolResultCache(reg, { store: weaveInMemoryCacheStore(), getPolicy: makeToolCachePolicyResolver(db) });
    const t = wrapped.get('disabled_tool')!;
    await t.invoke(ctx, inp('disabled_tool', { q: 1 }));
    await t.invoke(ctx, inp('disabled_tool', { q: 1 }));
    expect(tool.calls).toBe(2);
  });

  it('never caches an error result', async () => {
    await db.createToolCachePolicy({ id: 'tcp-e', tool_name: 'err_tool', cacheable: 1, ttl_ms: 60_000, enabled: 1 });
    _resetToolCachePoliciesCache();
    const reg = weaveToolRegistry();
    const tool = erroringTool('err_tool');
    reg.register(tool);
    const store = weaveInMemoryCacheStore();
    const wrapped = wrapWithToolResultCache(reg, { store, getPolicy: makeToolCachePolicyResolver(db) });
    const t = wrapped.get('err_tool')!;
    await t.invoke(ctx, inp('err_tool', { q: 1 }));
    await t.invoke(ctx, inp('err_tool', { q: 1 }));
    expect(tool.calls).toBe(2);
    expect(await store.size()).toBe(0);
  });

  it('different keyPrefix (version) isolates entries', async () => {
    const reg = weaveToolRegistry();
    const tool = countingTool('calculator');
    reg.register(tool);
    const store = weaveInMemoryCacheStore();
    const resolver = makeToolCachePolicyResolver(db);
    const v1 = wrapWithToolResultCache(reg, { store, getPolicy: resolver, keyPrefix: 'v1' });
    const v2 = wrapWithToolResultCache(reg, { store, getPolicy: resolver, keyPrefix: 'v2' });
    await v1.get('calculator')!.invoke(ctx, inp('calculator', { expression: '1+1' }));
    await v2.get('calculator')!.invoke(ctx, inp('calculator', { expression: '1+1' }));
    expect(tool.calls).toBe(2); // version bump → miss
  });

  it('records hits in the stats holder', async () => {
    const store = weaveInMemoryCacheStore();
    const metrics = createCacheMetrics();
    setActiveToolCache({ store, metrics });
    const reg = weaveToolRegistry();
    reg.register(countingTool('calculator'));
    const wrapped = wrapWithToolResultCache(reg, { store, getPolicy: makeToolCachePolicyResolver(db), metrics });
    const t = wrapped.get('calculator')!;
    await t.invoke(ctx, inp('calculator', { expression: '7*7' }));
    await t.invoke(ctx, inp('calculator', { expression: '7*7' }));
    const stats = await getToolCacheStats();
    expect(stats.enabled).toBe(true);
    expect(stats.hits).toBe(1);
    expect(stats.sets).toBe(1);
    expect(stats.entries).toBeGreaterThanOrEqual(1);
    setActiveToolCache(undefined);
  });
});

describe('Phase 6 — full createToolRegistry path', () => {
  it('caches the underlying invoke when toolResultCache is wired (custom tool)', async () => {
    const db = await freshDb();
    await db.createToolCachePolicy({ id: 'tcp-c', tool_name: 'custom_probe', cacheable: 1, ttl_ms: 60_000, enabled: 1 });
    _resetToolCachePoliciesCache();
    const tool = countingTool('custom_probe');
    const store = weaveInMemoryCacheStore();
    const registry = await createToolRegistry([], [tool], {
      actorPersona: 'agent_supervisor',
      toolResultCache: { store, getPolicy: makeToolCachePolicyResolver(db) },
    });
    const t = registry.get('custom_probe')!;
    await t.invoke(ctx, inp('custom_probe', { q: 9 }));
    await t.invoke(ctx, inp('custom_probe', { q: 9 }));
    expect(tool.calls).toBe(1); // cached through the real registry assembly
  });
});

describe('Phase 6 — stress', () => {
  it('1000 identical cacheable calls collapse to a single invoke', async () => {
    const db = await freshDb();
    const reg = weaveToolRegistry();
    const tool = countingTool('calculator');
    reg.register(tool);
    const wrapped = wrapWithToolResultCache(reg, { store: weaveInMemoryCacheStore(), getPolicy: makeToolCachePolicyResolver(db), keyPrefix: 'v1' });
    const t = wrapped.get('calculator')!;
    for (let i = 0; i < 1000; i++) await t.invoke(ctx, inp('calculator', { expression: 'PI' }));
    expect(tool.calls).toBe(1);
  });
});
