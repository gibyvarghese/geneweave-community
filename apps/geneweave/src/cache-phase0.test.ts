/**
 * geneWeave — Cache Phase 0 integration tests
 *
 * Verifies that the Phase 0 cache hardening is wired end-to-end at the app
 * layer: the m82 migration columns exist and seed securely, the admin DB CRUD
 * round-trips the new fields, `resolveActiveCache` maps DB rows → CachePolicy,
 * and the chat key builder + cacheScopeKey isolate tenants/users and keep raw
 * prompts out of keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { resolveActiveCache } from './chat-routing-utils.js';
import {
  weaveCacheKeyBuilder,
  cacheScopeKey,
  isCacheableTemperature,
  shouldBypassResponse,
} from '@weaveintel/cache';

function makeTempDbPath(): string {
  return join(tmpdir(), `gw-cache-phase0-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('Cache Phase 0 — migration & seed', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();
  });
  afterEach(async () => { await db.close(); });

  it('cache_policies has the new Phase 0 columns populated', async () => {
    const rows = await db.listCachePolicies();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toHaveProperty('max_bytes');
      expect(r).toHaveProperty('key_hashing');
      expect(r).toHaveProperty('tenant_isolation');
      expect(r).toHaveProperty('cache_temperature_gate');
      expect(r).toHaveProperty('output_bypass_patterns');
      // Secure defaults
      expect(r.key_hashing).toBe('sha256');
      expect(r.tenant_isolation).toBe(1);
      expect(r.cache_temperature_gate).toBe(0);
    }
  });

  it('Global Default policy seeds response-side secret bypass patterns', async () => {
    const global = (await db.listCachePolicies()).find(p => p.name === 'Global Default Cache');
    expect(global).toBeDefined();
    const patterns = JSON.parse(global!.output_bypass_patterns ?? '[]') as string[];
    expect(patterns.some(p => p.includes('PRIVATE KEY'))).toBe(true);
    expect(patterns.some(p => p.startsWith('sk-'))).toBe(true);
  });
});

describe('Cache Phase 0 — admin CRUD round-trip', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
  });
  afterEach(async () => { await db.close(); });

  it('createCachePolicy persists and getCachePolicy returns the new fields', async () => {
    await db.createCachePolicy({
      id: 'test-policy-1', name: 'Test Policy', description: null,
      scope: 'tenant', ttl_ms: 1000, max_entries: 50, max_bytes: 4096,
      bypass_patterns: JSON.stringify(['password']),
      output_bypass_patterns: JSON.stringify(['sk-[A-Za-z0-9]{16,}']),
      invalidate_on: JSON.stringify(['model_change']),
      key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0.5,
      enabled: 1,
    });
    const got = await db.getCachePolicy('test-policy-1');
    expect(got).toBeTruthy();
    expect(got!.max_bytes).toBe(4096);
    expect(got!.key_hashing).toBe('sha256');
    expect(got!.tenant_isolation).toBe(1);
    expect(got!.cache_temperature_gate).toBe(0.5);
    expect(JSON.parse(got!.output_bypass_patterns!)).toContain('sk-[A-Za-z0-9]{16,}');
  });

  it('updateCachePolicy mutates the new fields', async () => {
    await db.createCachePolicy({
      id: 'test-policy-2', name: 'P2', description: null, scope: 'global',
      ttl_ms: 1000, max_entries: 10, max_bytes: 0, bypass_patterns: null,
      output_bypass_patterns: null, invalidate_on: null,
      key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0, enabled: 1,
    });
    await db.updateCachePolicy('test-policy-2', {
      tenant_isolation: 0, cache_temperature_gate: 1, key_hashing: 'none', max_bytes: 8192,
    });
    const got = await db.getCachePolicy('test-policy-2');
    expect(got!.tenant_isolation).toBe(0);
    expect(got!.cache_temperature_gate).toBe(1);
    expect(got!.key_hashing).toBe('none');
    expect(got!.max_bytes).toBe(8192);
  });
});

describe('Cache Phase 0 — resolveActiveCache mapping', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();
  });
  afterEach(async () => { await db.close(); });

  it('maps DB columns into the CachePolicy hardening fields', async () => {
    const policy = await resolveActiveCache(db, 'direct');
    expect(policy).toBeTruthy();
    expect(policy!.keyHashing).toBe('sha256');
    expect(policy!.tenantIsolation).toBe(true);
    expect(policy!.temperatureGate).toBe(0);
    expect(Array.isArray(policy!.outputBypassPatterns)).toBe(true);
  });

  it('a disabled-only policy set resolves to null', async () => {
    for (const p of await db.listCachePolicies()) {
      await db.updateCachePolicy(p.id, { enabled: 0 });
    }
    expect(await resolveActiveCache(db, 'direct')).toBeNull();
  });
});

describe('Cache Phase 0 — chat key isolation (wired config)', () => {
  // Mirrors the builder configured in ChatEngine.
  const kb = weaveCacheKeyBuilder({ namespace: 'gw-chat', hash: 'sha256', salt: 'test-salt', version: 'v1' });

  const buildKey = (tenantId: string | null, userId: string, prompt: string) =>
    kb.build({ ...cacheScopeKey({ tenantId, userId, scope: 'global', tenantIsolation: true }), model: 'gpt-4o-mini', prompt });

  it('different tenants never share a cache key for the same prompt', () => {
    expect(buildKey('tenant-A', 'user-1', 'what is 2+2')).not.toBe(buildKey('tenant-B', 'user-1', 'what is 2+2'));
  });

  it('different users in the same tenant never share a cache key', () => {
    expect(buildKey('tenant-A', 'user-1', 'recall my name')).not.toBe(buildKey('tenant-A', 'user-2', 'recall my name'));
  });

  it('same tenant+user+prompt yields a stable (hittable) key', () => {
    expect(buildKey('tenant-A', 'user-1', 'capital of france')).toBe(buildKey('tenant-A', 'user-1', 'capital of france'));
  });

  it('the raw prompt is never present in the key', () => {
    const key = buildKey('tenant-A', 'user-1', 'my password is hunter2');
    expect(key).not.toContain('hunter2');
    expect(key).not.toContain('password');
  });
});

describe('Cache Phase 0 — write-gating decisions', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => {
    db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();
  });
  afterEach(async () => { await db.close(); });

  it('temperature gate: deterministic cached, temperature>0 not', async () => {
    const policy = (await resolveActiveCache(db, 'direct'))!;
    expect(isCacheableTemperature(policy, 0)).toBe(true);
    expect(isCacheableTemperature(policy, undefined)).toBe(true);
    expect(isCacheableTemperature(policy, 0.7)).toBe(false);
  });

  it('output bypass: a response leaking a secret key is not cached', async () => {
    const policy = (await resolveActiveCache(db, 'direct'))!;
    expect(shouldBypassResponse(policy, 'Sure, here is the key sk-ABCDEF0123456789xyz')).toBe(true);
    expect(shouldBypassResponse(policy, 'The capital of France is Paris.')).toBe(false);
  });
});
