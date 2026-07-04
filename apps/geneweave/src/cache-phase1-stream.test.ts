/**
 * geneWeave — Cache Phase 1 streaming-path integration test (mock model).
 *
 * Exercises streamMessageImpl end-to-end against a real seeded SQLite DB and a
 * deterministic mock model (which cycles responses), proving:
 *   - a cold stream writes the response cache and emits done.cached === false;
 *   - an identical second stream is served from cache (done.cached === true) and
 *     replays the FIRST answer (the mock's response index does not advance),
 *     i.e. the model was not called again;
 *   - a response that leaks a secret is never cached (output-side bypass).
 *
 * Each test uses a unique mock model id so getOrCreateModel never reuses a
 * cached model instance across tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { streamMessageImpl } from './chat-stream-message.js';
import { weaveInMemoryCacheStore, weaveCacheKeyBuilder } from '@weaveintel/cache';

function tmpDb(): string {
  return join(tmpdir(), `gw-cache-stream-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

interface DoneEvent { type: string; cached?: boolean; [k: string]: unknown }

function makeRes() {
  return {
    socket: { setTimeout() {} },
    writableEnded: false,
    destroyed: false,
    write() { return true; },
    writeHead() { return this; },
    end() { this.writableEnded = true; },
    on() { return this; },
    once() { return this; },
    off() { return this; },
  } as any;
}

describe('Cache Phase 1 — streaming cache (mock model)', () => {
  let db: SQLiteAdapter;
  const userId = 'u-stream-1';

  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb());
    await db.initialize();
    await db.seedDefaultData();
    await db.createUser({ id: userId, email: 'stream@test.dev', name: 'Stream', passwordHash: 'x' });
  });
  afterEach(async () => { await db.close(); });

  async function makeChat(modelId: string): Promise<string> {
    const chatId = `c-${modelId}`;
    await db.createChat({ id: chatId, userId, title: 'Stream Cache', model: modelId, provider: 'mock' });
    return chatId;
  }

  function makeDeps(modelId: string, responses: string[], responseCache: { get: any; set: any }) {
    return {
      config: {
        providers: { mock: { mockResponses: responses } as any },
        defaultProvider: 'mock',
        defaultModel: modelId,
        runtime: undefined,
      } as any,
      db: db as any,
      healthTracker: {
        listHealth: () => [],
        getBlockedProviders: () => new Set<string>(),
        blockProvider: () => {},
        recordOutcome: () => {},
      } as any,
      responseCache,
      cacheKeyBuilder: weaveCacheKeyBuilder({ namespace: 'gw-chat', hash: 'sha256', salt: 'test', version: 'v1' }),
      getAvailableModels: async () => [{ id: modelId, provider: 'mock' }],
      withResponseCardFormatPolicy: async (p?: string) => p,
      streamAgent: async () => ({ result: { output: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, steps: [] }, toolCallEvents: [], systemPromptSha256: undefined }) as any,
      writeSseEvent: undefined as any,
      endSse: () => {},
      loadPricing: async () => new Map(),
      recordModelOutcome: () => {},
      safeParseJson: (t: string) => { try { return JSON.parse(t); } catch { return undefined; } },
      consentManager: null,
    };
  }

  async function runStream(deps: any, chatId: string, content: string): Promise<{ done: DoneEvent | undefined; texts: string[] }> {
    const events: any[] = [];
    deps.writeSseEvent = async (_res: any, payload: any) => { events.push(payload); return true; };
    await streamMessageImpl(deps, makeRes(), userId, chatId, content);
    const done = events.find((e) => e.type === 'done') as DoneEvent | undefined;
    const texts = events.filter((e) => e.type === 'text').map((e) => String(e.text));
    return { done, texts };
  }

  it('cold stream writes cache (cached=false); identical stream hits (cached=true) and replays', async () => {
    const modelId = 'mock-hit-model';
    const chatId = await makeChat(modelId);
    const store = weaveInMemoryCacheStore();
    const responseCache = { get: (k: string) => store.get(k), set: (k: string, v: unknown, ttl: number) => store.set(k, v, ttl) };
    const deps = makeDeps(modelId, ['STREAMPONG', 'SECOND_DIFFERENT_ANSWER'], responseCache);

    const first = await runStream(deps, chatId, 'Reply with exactly: STREAMPONG');
    expect(first.done?.cached ?? false).toBe(false);
    expect(first.texts.join('')).toContain('STREAMPONG');

    const second = await runStream(deps, chatId, 'Reply with exactly: STREAMPONG');
    expect(second.done?.cached).toBe(true);
    // The cache replayed the FIRST answer — the mock's response index did not
    // advance to 'SECOND_DIFFERENT_ANSWER', proving the model was not called.
    expect(second.texts.join('')).toContain('STREAMPONG');
    expect(second.texts.join('')).not.toContain('SECOND_DIFFERENT_ANSWER');
  });

  it('does not cache a response that leaks a secret (output-side bypass)', async () => {
    const modelId = 'mock-secret-model';
    const chatId = await makeChat(modelId);
    const store = weaveInMemoryCacheStore();
    const responseCache = { get: (k: string) => store.get(k), set: (k: string, v: unknown, ttl: number) => store.set(k, v, ttl) };
    // First response leaks an API-key-shaped secret (matched by the seeded
    // output_bypass_patterns on every policy); second is benign.
    const deps = makeDeps(modelId, ['Sure, the key is sk-ABCDEF0123456789TOKEN', 'BENIGN_SECOND'], responseCache);

    const first = await runStream(deps, chatId, 'what is the key');
    expect(first.done?.cached ?? false).toBe(false);

    const second = await runStream(deps, chatId, 'what is the key');
    // The secret-laden answer was never cached, so the second call is still a
    // miss and the mock advances to the benign second response.
    expect(second.done?.cached ?? false).toBe(false);
    expect(second.texts.join('')).toContain('BENIGN_SECOND');
  });
});
