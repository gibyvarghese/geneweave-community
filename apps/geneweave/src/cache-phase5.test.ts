/**
 * geneWeave — Cache Phase 5 invalidation integration tests.
 *
 *  - m87 cache_invalidation_rules seeded + CRUD round-trip + loadInvalidationRules;
 *  - the streaming path builds a SCOPED + VERSIONED key, so invalidating a user's
 *    prefix (GDPR erasure) or bumping the version turns a warm hit back into a miss;
 *  - event-driven: handleEvent('prompt_update') clears the response cache.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { streamMessageImpl } from './chat-stream-message.js';
import { weaveInMemoryCacheStore, weaveCacheKeyBuilder, createCacheInvalidator } from '@weaveintel/cache';
import { loadInvalidationRules, _resetInvalidationRulesCache } from './cache-invalidator.js';

function tmpDb(): string { return join(tmpdir(), `gw-cache-phase5-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }

// ─── DB rules ────────────────────────────────────────────────

describe('Cache Phase 5 — cache_invalidation_rules (m87)', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); _resetInvalidationRulesCache(); });
  afterEach(async () => { await db.close(); });

  it('seeds the default invalidation rules', async () => {
    const rows = await db.listCacheInvalidationRules();
    const triggers = rows.map(r => r.trigger);
    expect(triggers).toContain('prompt_update');
    expect(triggers).toContain('model_change');
    expect(triggers).toContain('session_end');
    const promptRule = rows.find(r => r.trigger === 'prompt_update');
    expect(JSON.parse(promptRule!.config ?? '{}').clearAll).toBe(true);
  });

  it('CRUD round-trips and loadInvalidationRules maps rows', async () => {
    await db.createCacheInvalidationRule({ id: 'r-test', name: 'Test', trigger: 'manual', pattern: null, config: JSON.stringify({ prefix: 't=X|' }), enabled: 1 });
    const rules = await loadInvalidationRules(db);
    const r = rules.find(x => x.id === 'r-test');
    expect(r?.trigger).toBe('manual');
    expect((r?.config as any).prefix).toBe('t=X|');
    expect(r?.enabled).toBe(true);
    await db.updateCacheInvalidationRule('r-test', { enabled: 0 });
    _resetInvalidationRulesCache();
    expect((await loadInvalidationRules(db)).find(x => x.id === 'r-test')?.enabled).toBe(false);
  });
});

// ─── Streaming: scoped/versioned key + invalidation ──────────

describe('Cache Phase 5 — streaming invalidation (scoped + versioned)', () => {
  let db: SQLiteAdapter;
  const userId = 'u-p5';
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData();
    await db.createUser({ id: userId, email: 'p5@t.dev', name: 'P5', passwordHash: 'x' });
  });
  afterEach(async () => { await db.close(); });

  function makeRes() {
    return { socket: { setTimeout() {} }, writableEnded: false, destroyed: false, write() { return true; }, writeHead() { return this; }, end() { this.writableEnded = true; }, on() { return this; }, once() { return this; }, off() { return this; } } as any;
  }

  function makeDeps(store: any, modelId: string, version: { v: string }) {
    return {
      config: { providers: { mock: { mockResponses: ['ANS_1', 'ANS_2', 'ANS_3'] } }, defaultProvider: 'mock', defaultModel: modelId, runtime: undefined } as any,
      db: db as any,
      healthTracker: { listHealth: () => [], getBlockedProviders: () => new Set(), blockProvider: () => {}, recordOutcome: () => {} } as any,
      responseCache: { get: (k: string) => store.get(k), set: (k: string, v: unknown, ttl: number) => store.set(k, v, ttl) },
      cacheKeyBuilder: weaveCacheKeyBuilder({ namespace: 'gw-chat', hash: 'sha256', salt: 't', version: 'v1' }),
      getAvailableModels: async () => [{ id: modelId, provider: 'mock' }],
      withResponseCardFormatPolicy: async (p?: string) => p,
      streamAgent: async () => ({ result: { output: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, steps: [] }, toolCallEvents: [], systemPromptSha256: undefined }),
      writeSseEvent: undefined as any,
      endSse: () => {},
      loadPricing: async () => new Map(),
      recordModelOutcome: () => {},
      safeParseJson: (t: string) => { try { return JSON.parse(t); } catch { return undefined; } },
      consentManager: null,
      loadCacheVersion: async () => version.v,
    };
  }

  async function run(deps: any, chatId: string, content: string) {
    const events: any[] = [];
    deps.writeSseEvent = async (_res: any, p: any) => { events.push(p); return true; };
    await streamMessageImpl(deps, makeRes(), userId, chatId, content);
    const done = events.find(e => e.type === 'done');
    const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
    return { done, text };
  }

  it('invalidating the user prefix turns a warm hit back into a miss (GDPR erasure)', async () => {
    const modelId = 'mock-p5-inv';
    await db.createChat({ id: `c-${modelId}`, userId, title: 'P5', model: modelId, provider: 'mock' });
    const store = weaveInMemoryCacheStore();
    const deps = makeDeps(store, modelId, { v: 'v1' });

    const first = await run(deps, `c-${modelId}`, 'What is the capital of France?');
    expect(first.done?.cached ?? false).toBe(false);
    const warm = await run(deps, `c-${modelId}`, 'What is the capital of France?');
    expect(warm.done?.cached).toBe(true); // warm hit

    // Erase this user's entries (the user has no tenant → prefix `u=<id>||`).
    const inv = createCacheInvalidator({ store });
    const removed = await inv.invalidate({ prefix: `u=${userId}||` });
    expect(removed).toBeGreaterThan(0);

    const afterInv = await run(deps, `c-${modelId}`, 'What is the capital of France?');
    expect(afterInv.done?.cached ?? false).toBe(false); // miss again
  });

  it('bumping the version token turns a warm hit into a miss', async () => {
    const modelId = 'mock-p5-ver';
    await db.createChat({ id: `c-${modelId}`, userId, title: 'P5', model: modelId, provider: 'mock' });
    const store = weaveInMemoryCacheStore();
    const version = { v: 'v1' };
    const deps = makeDeps(store, modelId, version);

    await run(deps, `c-${modelId}`, 'Tell me a fact about the moon.');
    const warm = await run(deps, `c-${modelId}`, 'Tell me a fact about the moon.');
    expect(warm.done?.cached).toBe(true);

    version.v = 'v2'; // admin bumped global_version_token
    const afterBump = await run(deps, `c-${modelId}`, 'Tell me a fact about the moon.');
    expect(afterBump.done?.cached ?? false).toBe(false); // new key → miss
  });

  it('event-driven prompt_update clears the response cache', async () => {
    const modelId = 'mock-p5-evt';
    await db.createChat({ id: `c-${modelId}`, userId, title: 'P5', model: modelId, provider: 'mock' });
    const store = weaveInMemoryCacheStore();
    const deps = makeDeps(store, modelId, { v: 'v1' });

    await run(deps, `c-${modelId}`, 'Explain gravity briefly.');
    const warm = await run(deps, `c-${modelId}`, 'Explain gravity briefly.');
    expect(warm.done?.cached).toBe(true);

    // A prompt-template update fires the seeded clearAll rule.
    const inv = createCacheInvalidator({ store, getRules: () => loadInvalidationRules(db) });
    const { matched } = await inv.handleEvent({ type: 'prompt_update' });
    expect(matched).toBeGreaterThan(0);
    expect(await store.size()).toBe(0);

    const afterEvt = await run(deps, `c-${modelId}`, 'Explain gravity briefly.');
    expect(afterEvt.done?.cached ?? false).toBe(false);
  });
});
