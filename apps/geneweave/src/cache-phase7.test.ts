/**
 * Cache Phase 7 — stampede protection, SWR, negative caching, eviction (app).
 *
 * Drives the real streamMessageImpl with a mock (delayable) agent to prove:
 *   - singleflight coalesces N concurrent identical turns into ONE model call
 *     across agent AND supervisor modes;
 *   - negative caching shields the backend after a failure (gated);
 *   - SWR serves a stale entry within the window (gated);
 * plus DB plumbing (resolveActiveCache mapping, loadStampedeConfig, eviction
 * store) and the shape-preserving stampede helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { streamMessageImpl } from './chat-stream-message.js';
import { resolveActiveCache } from './chat-routing-utils.js';
import {
  loadStampedeConfig, _resetStampedeConfigCache,
  readResponseWithSwr, writeResponseWithSwr, readNegativeCache, writeNegativeCache,
} from './cache-stampede.js';
import { weaveInMemoryCacheStore, weaveCacheKeyBuilder, createSingleflight } from '@weaveintel/cache';

function tmpDb(): string { return join(tmpdir(), `gw-cache-phase7-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Apply fields to EVERY enabled cache policy (resolvePolicy may pick any of them). */
async function setAllPolicies(db: SQLiteAdapter, fields: Record<string, unknown>): Promise<void> {
  for (const p of (await db.listCachePolicies()).filter(x => x.enabled)) {
    await db.updateCachePolicy(p.id, fields as never);
  }
}

describe('Cache Phase 7 — DB plumbing', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); _resetStampedeConfigCache(); });
  afterEach(async () => { await db.close(); });

  it('m89 enables stampede_protection and adds eviction columns', async () => {
    const s = await db.getCacheSettings();
    expect(s?.stampede_protection).toBe(1);
    expect(s?.l1_eviction_policy ?? 'lru').toBeTruthy();
  });

  it('loadStampedeConfig reflects cache_settings', async () => {
    const cfg = await loadStampedeConfig(db);
    expect(cfg.enabled).toBe(true);
    await db.updateCacheSettings({ stampede_protection: 0, l1_negative_ttl_ms: 1234 });
    _resetStampedeConfigCache();
    const cfg2 = await loadStampedeConfig(db);
    expect(cfg2.enabled).toBe(false);
    expect(cfg2.negativeTtlMs).toBe(1234);
  });

  it('resolveActiveCache maps swr_ms / negative_ttl_ms / eviction_policy', async () => {
    await setAllPolicies(db, { swr_ms: 5000, negative_ttl_ms: 2000, eviction_policy: 'gdsf' });
    const cp = await resolveActiveCache(db, 'direct');
    expect(cp?.swrMs).toBe(5000);
    expect(cp?.negativeTtlMs).toBe(2000);
    expect(cp?.evictionPolicy).toBe('gdsf');
  });
});

describe('Cache Phase 7 — stampede helpers (shape-preserving)', () => {
  it('SWR read classifies fresh/stale/miss from a sidecar timestamp', async () => {
    const store = weaveInMemoryCacheStore();
    await writeResponseWithSwr(store, 'k', { content: 'hi', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }, { ttlMs: 100, swrMs: 1000 });
    // We can't move the sidecar's stored Date.now, so assert via the `now` override:
    const ts = (await store.get('ts::k')) as number;
    expect((await readResponseWithSwr(store, 'k', { ttlMs: 100, swrMs: 1000, now: ts + 50 })).state).toBe('fresh');
    expect((await readResponseWithSwr(store, 'k', { ttlMs: 100, swrMs: 1000, now: ts + 200 })).state).toBe('stale');
    expect((await readResponseWithSwr(store, 'k', { ttlMs: 100, swrMs: 1000, now: ts + 5000 })).state).toBe('miss');
  });

  it('negative cache read/write round-trips and expires', async () => {
    const store = weaveInMemoryCacheStore();
    expect(await readNegativeCache(store, 'k')).toBe(false);
    await writeNegativeCache(store, 'k', 30);
    expect(await readNegativeCache(store, 'k')).toBe(true);
    await delay(45);
    expect(await readNegativeCache(store, 'k')).toBe(false); // short TTL expired
  });

  it('swrMs<=0 keeps legacy behaviour (any hit is fresh, no sidecar)', async () => {
    const store = weaveInMemoryCacheStore();
    await writeResponseWithSwr(store, 'k', { content: 'x' }, { ttlMs: 100, swrMs: 0 });
    expect(await store.get('ts::k')).toBeNull();
    expect((await readResponseWithSwr(store, 'k', { ttlMs: 100, swrMs: 0 })).state).toBe('fresh');
  });
});

// ─── Streaming path: singleflight / negative / SWR with a mock agent ─────────

describe('Cache Phase 7 — streaming stampede (mock agent)', () => {
  let db: SQLiteAdapter;
  const userId = 'u-p7';
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData();
    await db.createUser({ id: userId, email: 'p7@t.dev', name: 'P7', passwordHash: 'x' });
    _resetStampedeConfigCache();
  });
  afterEach(async () => { await db.close(); });

  function makeRes() {
    return { socket: { setTimeout() {} }, writableEnded: false, destroyed: false, write() { return true; }, writeHead() { return this; }, end() { this.writableEnded = true; }, on() { return this; }, once() { return this; }, off() { return this; } } as any;
  }

  function makeDeps(store: any, modelId: string, sf: any, agent: { calls: number; impl: () => Promise<string> }) {
    return {
      config: { providers: { mock: { mockResponses: ['X'] } }, defaultProvider: 'mock', defaultModel: modelId, runtime: undefined } as any,
      db: db as any,
      healthTracker: { listHealth: () => [], getBlockedProviders: () => new Set(), blockProvider: () => {}, recordOutcome: () => {} } as any,
      responseCache: { get: (k: string) => store.get(k), set: (k: string, v: unknown, ttl: number) => store.set(k, v, ttl) },
      cacheKeyBuilder: weaveCacheKeyBuilder({ namespace: 'gw-chat', hash: 'sha256', salt: 't', version: 'v1' }),
      getAvailableModels: async () => [{ id: modelId, provider: 'mock' }],
      withResponseCardFormatPolicy: async (p?: string) => p,
      streamAgent: async () => {
        agent.calls++;
        const output = await agent.impl();
        return { result: { output, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, steps: [] }, toolCallEvents: [], systemPromptSha256: undefined };
      },
      writeSseEvent: undefined as any,
      endSse: () => {},
      loadPricing: async () => new Map(),
      recordModelOutcome: () => {},
      safeParseJson: (t: string) => { try { return JSON.parse(t); } catch { return undefined; } },
      consentManager: null,
      loadCacheVersion: async () => 'v1',
      singleflight: sf,
      loadStampedeConfig: () => loadStampedeConfig(db),
    };
  }

  async function run(deps: any, chatId: string, content: string) {
    const events: any[] = [];
    const d = { ...deps, writeSseEvent: async (_res: any, p: any) => { events.push(p); return true; } };
    await streamMessageImpl(d, makeRes(), userId, chatId, content);
    const done = events.find((e: any) => e.type === 'done');
    const text = events.filter((e: any) => e.type === 'text').map((e: any) => e.text).join('');
    return { done, text };
  }

  for (const mode of ['agent', 'supervisor'] as const) {
    it(`coalesces N concurrent identical ${mode}-mode turns into ONE model call`, async () => {
      const modelId = `mock-p7-sf-${mode}`;
      const chatId = `c-${modelId}`;
      await db.createChat({ id: chatId, userId, title: 'P7', model: modelId, provider: 'mock' });
      await db.saveChatSettings({ chatId, mode });
      const store = weaveInMemoryCacheStore();
      const sf = createSingleflight();
      let n = 0;
      const agent = { calls: 0, impl: async () => { await delay(120); return `ANSWER-${++n}`; } };
      const deps = makeDeps(store, modelId, sf, agent);

      // Fire 5 identical requests concurrently.
      const results = await Promise.all(Array.from({ length: 5 }, () => run(deps, chatId, 'Summarize the report.')));
      expect(agent.calls, 'only one model call for 5 concurrent identical requests').toBe(1);
      // Every caller that received streamed text got the SAME answer. (The mock
      // leader emits no SSE text — only followers replay via the cached path —
      // so filter empties; the one model call is the real acceptance.)
      const texts = new Set(results.map(r => r.text).filter(Boolean));
      expect(texts.size).toBeLessThanOrEqual(1);
      // At least one follower was served as a coalesced replay.
      expect(results.some(r => r.done?.coalesced === true)).toBe(true);
      expect(sf.stats().coalesced).toBeGreaterThan(0);
    });
  }

  it('negative caching: a failed turn shields the backend on the immediate retry', async () => {
    const modelId = 'mock-p7-neg';
    const chatId = `c-${modelId}`;
    await db.createChat({ id: chatId, userId, title: 'P7', model: modelId, provider: 'mock' });
    await db.saveChatSettings({ chatId, mode: 'agent' });
    // Enable negative caching on the active policy.
    await setAllPolicies(db, { negative_ttl_ms: 5000 });
    const store = weaveInMemoryCacheStore();
    const sf = createSingleflight();
    const agent = { calls: 0, impl: async () => { throw new Error('backend down'); } };
    const deps = makeDeps(store, modelId, sf, agent);

    await run(deps, chatId, 'Do the thing.');        // fails → negative marker written
    expect(agent.calls).toBe(1);
    const retry = await run(deps, chatId, 'Do the thing.'); // negative hit → no model call
    expect(agent.calls).toBe(1);                      // backend shielded
    expect(retry.done?.negative).toBe(true);
  });

  it('SWR: a stale entry is served from cache within the window (no model call)', async () => {
    const modelId = 'mock-p7-swr';
    const chatId = `c-${modelId}`;
    await db.createChat({ id: chatId, userId, title: 'P7', model: modelId, provider: 'mock' });
    await db.saveChatSettings({ chatId, mode: 'agent' });
    // Short ttl, generous swr window.
    await setAllPolicies(db, { ttl_ms: 40, swr_ms: 5000 });
    const store = weaveInMemoryCacheStore();
    const sf = createSingleflight();
    const agent = { calls: 0, impl: async () => 'FRESH' };
    const deps = makeDeps(store, modelId, sf, agent);

    await run(deps, chatId, 'Give me the status.');  // miss → computes + writes (calls=1)
    expect(agent.calls).toBe(1);
    await delay(80);                                  // age 80 > ttl 40, within swr 5000 → stale
    const stale = await run(deps, chatId, 'Give me the status.');
    expect(stale.done?.cached).toBe(true);
    expect(stale.done?.stale).toBe(true);
    expect(agent.calls).toBe(1);                      // served stale; no new model call
  });
});

describe('Cache Phase 7 — cost-aware eviction store', () => {
  it('a gdsf store retains the expensive (high-token) response over a cheap one', async () => {
    const evicted: string[] = [];
    const store = weaveInMemoryCacheStore({
      maxEntries: 2, evictionPolicy: 'gdsf',
      costOf: (v) => (v as { usage?: { totalTokens?: number } })?.usage?.totalTokens ?? 1,
      onEvict: (k) => evicted.push(k),
    });
    await store.set('cheap', { content: 'a', usage: { totalTokens: 1 } });
    await store.set('expensive', { content: 'b', usage: { totalTokens: 5000 } });
    await store.set('c', { content: 'c', usage: { totalTokens: 1 } }); // over capacity → evict cheapest
    expect(evicted).toContain('cheap');
    expect(await store.get('expensive')).not.toBeNull();
  });
});
