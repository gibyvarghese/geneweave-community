/**
 * geneWeave — Cache Phase 3 observability integration tests.
 *
 *  - m85 migration: cache_metrics table + metrics_enabled flipped on;
 *  - recordCacheMetrics increments the current hourly window; getCacheMetrics
 *    aggregates totals + returns recent windows; negatives are clamped;
 *  - the streaming chat path feeds the recorder (response hit vs miss) — verified
 *    end-to-end against a deterministic mock model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { applySeed } from './seed/index.js';
import { streamMessageImpl } from './chat-stream-message.js';
import { weaveInMemoryCacheStore, weaveCacheKeyBuilder, createCacheMetrics } from '@weaveintel/cache';
import type { CacheTurnMetrics } from './chat-send-message.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-cache-phase3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ─── DB rollup ───────────────────────────────────────────────

describe('Cache Phase 3 — cache_metrics rollup (m85)', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); });
  afterEach(async () => { await db.close(); });

  it('creates the table and enables metrics by default', async () => {
    const settings = await db.getCacheSettings();
    expect(settings?.metrics_enabled).toBe(1);
    const m = await db.getCacheMetrics();
    expect(m.totals.responseHits).toBe(0);
    expect(m.windows).toEqual([]);
  });

  it('increments the current window and aggregates totals', async () => {
    await db.recordCacheMetrics({ responseHits: 1, promptCacheReadTokens: 1000, costSavedUsd: 0.003 });
    await db.recordCacheMetrics({ responseMisses: 1, promptCacheReadTokens: 2000, costSavedUsd: 0.006 });
    const m = await db.getCacheMetrics();
    expect(m.totals.responseHits).toBe(1);
    expect(m.totals.responseMisses).toBe(1);
    expect(m.totals.hitRate).toBeCloseTo(0.5, 5);
    expect(m.totals.promptCacheReadTokens).toBe(3000);
    expect(m.totals.costSavedUsd).toBeCloseTo(0.009, 6);
    expect(m.windows.length).toBe(1); // same hourly bucket
    expect(m.windows[0]!.response_hits).toBe(1);
  });

  it('is a no-op for an all-zero delta and clamps negatives', async () => {
    await db.recordCacheMetrics({});
    await db.recordCacheMetrics({ responseHits: -5, promptCacheReadTokens: -100, costSavedUsd: -1 });
    const m = await db.getCacheMetrics();
    expect(m.windows.length).toBe(0); // nothing written
    expect(m.totals.responseHits).toBe(0);
  });

  it('hit rate is 0 with no lookups', async () => {
    expect((await db.getCacheMetrics()).totals.hitRate).toBe(0);
  });
});

// ─── Seeded state ────────────────────────────────────────────

describe('Cache Phase 3 — seeded metrics state', () => {
  it('full app seed leaves metrics enabled and the table empty', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await applySeed(db);
    try {
      expect((await db.getCacheSettings())?.metrics_enabled).toBe(1);
      const m = await db.getCacheMetrics();
      expect(m.totals.responseHits).toBe(0);
    } finally { await db.close(); }
  });
});

// ─── Streaming path feeds the recorder ───────────────────────

describe('Cache Phase 3 — streaming path records cache metrics', () => {
  let db: SQLiteAdapter;
  const userId = 'u-p3-stream';
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();
    await db.createUser({ id: userId, email: 'p3@test.dev', name: 'P3', passwordHash: 'x' });
  });
  afterEach(async () => { await db.close(); });

  function makeRes() {
    return { socket: { setTimeout() {} }, writableEnded: false, destroyed: false, write() { return true; }, writeHead() { return this; }, end() { this.writableEnded = true; }, on() { return this; }, once() { return this; }, off() { return this; } } as any;
  }

  it('records a miss on the cold turn and a hit on the warm turn', async () => {
    const modelId = 'mock-p3-model';
    const chatId = `c-${modelId}`;
    await db.createChat({ id: chatId, userId, title: 'P3', model: modelId, provider: 'mock' });

    const store = weaveInMemoryCacheStore();
    const responseCache = { get: (k: string) => store.get(k), set: (k: string, v: unknown, ttl: number) => store.set(k, v, ttl) };
    const recorded: CacheTurnMetrics[] = [];
    const metrics = createCacheMetrics();

    const deps: any = {
      config: { providers: { mock: { mockResponses: ['ANSWER_ONE', 'ANSWER_TWO'] } }, defaultProvider: 'mock', defaultModel: modelId, runtime: { cache: { metrics } } },
      db,
      healthTracker: { listHealth: () => [], getBlockedProviders: () => new Set(), blockProvider: () => {}, recordOutcome: () => {} },
      responseCache,
      cacheKeyBuilder: weaveCacheKeyBuilder({ namespace: 'gw-chat', hash: 'sha256', salt: 't', version: 'v1' }),
      getAvailableModels: async () => [{ id: modelId, provider: 'mock' }],
      withResponseCardFormatPolicy: async (p?: string) => p,
      streamAgent: async () => ({ result: { output: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, steps: [] }, toolCallEvents: [], systemPromptSha256: undefined }),
      writeSseEvent: async () => true,
      endSse: () => {},
      loadPricing: async () => new Map(),
      recordModelOutcome: () => {},
      safeParseJson: (t: string) => { try { return JSON.parse(t); } catch { return undefined; } },
      consentManager: null,
      recordCacheMetrics: (turn: CacheTurnMetrics) => recorded.push(turn),
    };

    await streamMessageImpl(deps, makeRes(), userId, chatId, 'What is the capital of France?');
    await streamMessageImpl(deps, makeRes(), userId, chatId, 'What is the capital of France?');

    expect(recorded.length).toBe(2);
    expect(recorded[0]!.responseHit).toBe(false); // cold miss
    expect(recorded[1]!.responseHit).toBe(true);  // warm hit (served from cache)
    expect(recorded.every(r => r.responseEligible)).toBe(true);
  });
});
