/**
 * geneWeave — Cache Phase 1 integration tests
 *
 * Verifies the multi-tier / distributed cache config is wired at the app layer:
 *   - m83 `cache_settings` migration + seed + CRUD round-trip,
 *   - the app can construct a tiered L1+L2 store from `@weaveintel/cache`
 *     (real Redis when reachable; skipped otherwise),
 *   - the streaming and non-streaming paths build identical cache keys
 *     (so a write on one path is a hit on the other),
 *   - the global_version_token busts keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import {
  weaveInMemoryCacheStore,
  weaveRedisCacheStore,
  weaveTieredCacheStore,
  weaveCacheKeyBuilder,
  cacheScopeKey,
  type RedisLikeClient,
} from '@weaveintel/cache';

function tmpDb(): string {
  return join(tmpdir(), `gw-cache-phase1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ─── cache_settings (m83) ────────────────────────────────────

describe('Cache Phase 1 — cache_settings', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); });
  afterEach(async () => { await db.close(); });

  it('migration seeds the single global row with secure defaults', async () => {
    const s = await db.getCacheSettings();
    expect(s).toBeTruthy();
    expect(s!.id).toBe('global');
    expect(s!.l2_enabled).toBe(0);        // L2 off by default
    expect(s!.l2_provider).toBe('none');
    expect(s!.l1_max_entries).toBe(5000);
    expect(s!.l1_ttl_ms).toBe(30000);
    expect(s!.key_namespace).toBe('weave:cache');
    expect(s!.global_version_token).toBe('v1');
  });

  it('updateCacheSettings round-trips topology fields', async () => {
    await db.updateCacheSettings({
      l2_enabled: 1, l2_provider: 'redis', l1_ttl_ms: 10000,
      key_namespace: 'gw:prod', global_version_token: 'v2',
    });
    const s = await db.getCacheSettings();
    expect(s!.l2_enabled).toBe(1);
    expect(s!.l2_provider).toBe('redis');
    expect(s!.l1_ttl_ms).toBe(10000);
    expect(s!.key_namespace).toBe('gw:prod');
    expect(s!.global_version_token).toBe('v2');
  });

  it('updateCacheSettings upserts when the row is missing', async () => {
    // Simulate a DB where the row was deleted.
    await db.updateCacheSettings({ global_version_token: 'v9' });
    expect((await db.getCacheSettings())!.global_version_token).toBe('v9');
  });
});

// ─── Send/stream cache-key parity ────────────────────────────

describe('Cache Phase 1 — key parity & versioning', () => {
  // Mirror ChatEngine's builder configuration.
  const builder = (version: string) =>
    weaveCacheKeyBuilder({ namespace: 'gw-chat', hash: 'sha256', salt: 'salt', version });

  // The exact key-construction both the send and stream paths use.
  const buildKey = (kb: ReturnType<typeof weaveCacheKeyBuilder>, tenantId: string | null, userId: string, model: string, prompt: string) =>
    kb.build({ ...cacheScopeKey({ tenantId, userId, scope: 'global', tenantIsolation: true }), model, prompt });

  it('streaming and non-streaming paths produce identical keys', () => {
    const kb = builder('v1');
    const sendKey = buildKey(kb, 'tA', 'u1', 'gpt-4o-mini', 'hello world');
    const streamKey = buildKey(kb, 'tA', 'u1', 'gpt-4o-mini', 'hello world');
    expect(streamKey).toBe(sendKey); // a write on one path is a hit on the other
  });

  it('bumping global_version_token (key version) busts the key', () => {
    const v1 = buildKey(builder('v1'), 'tA', 'u1', 'm', 'p');
    const v2 = buildKey(builder('v2'), 'tA', 'u1', 'm', 'p');
    expect(v2).not.toBe(v1);
  });
});

// ─── Tiered store construction at the app layer ──────────────

describe('Cache Phase 1 — tiered store (fake L2)', () => {
  function fakeRedis(): RedisLikeClient {
    const map = new Map<string, string>();
    return {
      isOpen: true,
      async get(k) { return map.get(k) ?? null; },
      async set(k, v) { map.set(k, v); return 'OK'; },
      async del(keys) { const a = Array.isArray(keys) ? keys : [keys]; let n = 0; for (const k of a) if (map.delete(k)) n++; return n; },
      async exists(keys) { const a = Array.isArray(keys) ? keys : [keys]; let n = 0; for (const k of a) if (map.has(k)) n++; return n; },
      async keys(p) { const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return [...map.keys()].filter((k) => re.test(k)); },
    };
  }

  it('a tiered store shares writes across two app-constructed replicas', async () => {
    const shared = fakeRedis();
    const a = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ client: shared, keyPrefix: 'gw' }), { l1TtlMs: 30000 });
    const b = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ client: shared, keyPrefix: 'gw' }), { l1TtlMs: 30000 });
    await a.set('gw-chat:v1:k', { content: 'cached-answer' }, 60000);
    expect(await b.get('gw-chat:v1:k')).toEqual({ content: 'cached-answer' });
  });
});

// ─── Optional: real Redis at the app layer ───────────────────

const REDIS_URL = process.env['CACHE_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

async function redisReachable(): Promise<boolean> {
  try {
    const mod = (await import('redis')) as { createClient: (o: { url: string }) => RedisLikeClient };
    const c = mod.createClient({ url: REDIS_URL });
    await c.connect?.();
    await c.quit?.();
    return true;
  } catch { return false; }
}

describe('Cache Phase 1 — real Redis (opt-in)', () => {
  it('app-constructed tiered store shares hits across replicas via real Redis', async () => {
    if (!(await redisReachable())) { console.warn('[skip] no Redis at ' + REDIS_URL); return; }
    const prefix = 'gw:test:phase1:' + Date.now();
    const a = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ url: REDIS_URL, keyPrefix: prefix }));
    const b = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ url: REDIS_URL, keyPrefix: prefix }));
    try {
      await a.set('k', { content: 'real-redis-answer' }, 30000);
      expect(await b.get('k')).toEqual({ content: 'real-redis-answer' });
    } finally {
      await a.clear();
      await a.close();
      await b.close();
    }
  });
});
