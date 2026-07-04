/**
 * geneWeave — Cache Phase 4 semantic cache integration tests.
 *
 *  - m86 migration: semantic_cache_config seeded + get/update round-trip;
 *  - helpers: scope isolation + time-sensitive bypass;
 *  - streaming path: a paraphrase of a cached query is served from the semantic
 *    cache (cached + semantic), and a DIFFERENT user never gets another user's
 *    answer — all verified against a deterministic embedding (no model needed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { streamMessageImpl } from './chat-stream-message.js';
import { weaveCacheKeyBuilder, weaveInMemoryCacheStore, weaveSemanticCache } from '@weaveintel/cache';
import { semanticScope, isSemanticBypassed, _resetSemanticConfigCache, type SemanticConfig } from './chat-semantic-utils.js';

function tmpDb(): string { return join(tmpdir(), `gw-cache-phase4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); }

function bowEmbed(text: string): number[] {
  const dim = 96; const v = new Array(dim).fill(0);
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0; for (const c of tok) h = (h * 31 + c.charCodeAt(0)) % dim;
    v[h] += 1;
  }
  return v;
}

// ─── DB config ───────────────────────────────────────────────

describe('Cache Phase 4 — semantic_cache_config (m86)', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); });
  afterEach(async () => { await db.close(); });

  it('seeds an enabled global config with conservative defaults', async () => {
    const cfg = await db.getSemanticCacheConfig();
    expect(cfg?.id).toBe('global');
    expect(cfg?.enabled).toBe(1);
    expect(cfg?.similarity_threshold).toBe(0.92);
    expect(cfg?.scope).toBe('user');
    expect(JSON.parse(cfg!.bypass_patterns ?? '[]')).toContain('real-time');
  });

  it('updateSemanticCacheConfig round-trips fields', async () => {
    await db.updateSemanticCacheConfig({ enabled: 0, similarity_threshold: 0.8, scope: 'tenant', max_entries: 50 });
    const cfg = await db.getSemanticCacheConfig();
    expect(cfg?.enabled).toBe(0);
    expect(cfg?.similarity_threshold).toBe(0.8);
    expect(cfg?.scope).toBe('tenant');
    expect(cfg?.max_entries).toBe(50);
  });
});

// ─── Helpers ─────────────────────────────────────────────────

describe('Cache Phase 4 — scope & bypass helpers', () => {
  it('always folds tenant into the scope; user scope adds the user', () => {
    expect(semanticScope('global', 'tA', 'u1')).toBe('');
    expect(semanticScope('tenant', 'tA', 'u1')).toBe('t=tA');
    expect(semanticScope('user', 'tA', 'u1')).toBe('t=tA|u=u1');
    // Different tenants never collide.
    expect(semanticScope('user', 'tA', 'u1')).not.toBe(semanticScope('user', 'tB', 'u1'));
    // Different users never collide.
    expect(semanticScope('user', 'tA', 'u1')).not.toBe(semanticScope('user', 'tA', 'u2'));
  });

  it('bypasses time-sensitive prompts', () => {
    const cfg: SemanticConfig = { enabled: true, scope: 'user', threshold: 0.9, bypassPatterns: ['real-time', 'current time', 'latest'] };
    expect(isSemanticBypassed(cfg, 'what is the latest news?')).toBe(true);
    expect(isSemanticBypassed(cfg, 'what is the current time')).toBe(true);
    expect(isSemanticBypassed(cfg, 'what is the capital of France?')).toBe(false);
  });
});

// ─── Streaming path semantic hit + isolation ─────────────────

describe('Cache Phase 4 — streaming semantic cache (deterministic embedding)', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();
    _resetSemanticConfigCache();
  });
  afterEach(async () => { await db.close(); });

  function makeRes() {
    return { socket: { setTimeout() {} }, writableEnded: false, destroyed: false, write() { return true; }, writeHead() { return this; }, end() { this.writableEnded = true; }, on() { return this; }, once() { return this; }, off() { return this; } } as any;
  }

  const cfg: SemanticConfig = { enabled: true, scope: 'user', threshold: 0.6, bypassPatterns: ['real-time'] };

  // A semantic cache (scoped internally) shared between runs WITHIN a test; a
  // mock model whose responses cycle — a semantic HIT does not advance the index.
  function makeDeps(semanticCache: any, modelId: string) {
    const store = weaveInMemoryCacheStore();
    return {
      config: { providers: { mock: { mockResponses: ['ANSWER_FOR_FIRST', 'ANSWER_FOR_SECOND'] } }, defaultProvider: 'mock', defaultModel: modelId, runtime: undefined } as any,
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
      semanticCache,
      loadSemanticConfig: async () => cfg,
    };
  }

  async function run(deps: any, chatId: string, userId: string, content: string) {
    const events: any[] = [];
    deps.writeSseEvent = async (_res: any, p: any) => { events.push(p); return true; };
    await streamMessageImpl(deps, makeRes(), userId, chatId, content);
    const done = events.find((e) => e.type === 'done');
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    return { done, text };
  }

  it('serves a paraphrase from the semantic cache for the same user', async () => {
    const userId = 'u-sem-A'; const modelId = 'mock-sem-a';
    await db.createUser({ id: userId, email: 'a@t.dev', name: 'A', passwordHash: 'x' });
    await db.createChat({ id: `c-${modelId}`, userId, title: 'P4', model: modelId, provider: 'mock' });
    const semanticCache = weaveSemanticCache({ embed: async (t: string) => bowEmbed(t), defaultThreshold: 0.6 });
    const deps = makeDeps(semanticCache, modelId);

    // Cold miss → LLM → stored semantically.
    const first = await run(deps, `c-${modelId}`, userId, 'What is the capital of France?');
    expect(first.done?.semantic ?? false).toBe(false);
    expect(first.text).toContain('ANSWER_FOR_FIRST');

    // Paraphrase → semantic HIT → replays the FIRST answer (model not called).
    const second = await run(deps, `c-${modelId}`, userId, 'Tell me the capital city of France');
    expect(second.done?.semantic).toBe(true);
    expect(second.done?.cached).toBe(true);
    expect(second.text).toContain('ANSWER_FOR_FIRST');
    expect(second.text).not.toContain('ANSWER_FOR_SECOND');
  });

  it('does NOT serve one user\'s cached answer to a different user (scope isolation)', async () => {
    const modelId = 'mock-sem-iso';
    await db.createUser({ id: 'u-iso-A', email: 'a@iso.dev', name: 'A', passwordHash: 'x' });
    await db.createUser({ id: 'u-iso-B', email: 'b@iso.dev', name: 'B', passwordHash: 'x' });
    await db.createChat({ id: 'c-iso-A', userId: 'u-iso-A', title: 'P4', model: modelId, provider: 'mock' });
    // ONE shared semantic cache (as in production) — scope must isolate users.
    const semanticCache = weaveSemanticCache({ embed: async (t: string) => bowEmbed(t), defaultThreshold: 0.6 });
    const depsA = makeDeps(semanticCache, modelId);
    // User B uses a distinct model id so its mock model is fresh (independent of A).
    const depsB = makeDeps(semanticCache, modelId + '-B');
    await db.createChat({ id: 'c-iso-B', userId: 'u-iso-B', title: 'P4', model: modelId + '-B', provider: 'mock' });
    depsB.getAvailableModels = async () => [{ id: modelId + '-B', provider: 'mock' }];

    // User A caches an answer for the query.
    await run(depsA, 'c-iso-A', 'u-iso-A', 'What is the capital of France?');
    // User B asks the SAME query — must NOT get a semantic hit from A's entry.
    const resB = await run(depsB, 'c-iso-B', 'u-iso-B', 'What is the capital of France?');
    expect(resB.done?.semantic ?? false).toBe(false); // isolation: no cross-user hit
    expect(resB.text).toContain('ANSWER_FOR_FIRST');   // B's OWN fresh model response
  });
});
