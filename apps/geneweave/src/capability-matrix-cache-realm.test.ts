// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm (C11) — the capability-matrix cache is tenant-keyed and reads through the realm
 * resolver (`resolveTenantEffectiveCapabilityScores`): a tenant's scores are its own rows resolved
 * nearest-owner-wins over its ancestors and the globals. Because ANY write — global or a single
 * tenant's — can change the effective set of that tenant AND every descendant that inherits it, the
 * cache clears ALL keys on any capability-score invalidation (the tenant tree isn't held in the cache).
 * Positive / negative / stress / security coverage with a fake adapter that counts DB reads per tenant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityMatrixCache } from './capability-matrix-cache.js';
import type { DatabaseAdapter, ModelCapabilityScoreRow } from './db-types.js';

/** A fake adapter whose resolver returns one tenant-tagged row and counts reads per tenant. */
function fakeDb(): { db: DatabaseAdapter; reads: Map<string, number> } {
  const reads = new Map<string, number>();
  const rowFor = (tenantId: string | null): ModelCapabilityScoreRow => ({
    id: `s-${tenantId ?? '__global__'}`, tenant_id: tenantId, model_id: 'm', provider: 'p', task_key: 'k',
    quality_score: 1, supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 0,
    supports_vision: 0, max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1,
    last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0, created_at: '', updated_at: '' });
  const db = {
    // The cache reads through the realm resolver in C11 (not the flat listCapabilityScores).
    async resolveTenantEffectiveCapabilityScores(tenantId: string | null): Promise<ModelCapabilityScoreRow[]> {
      const t = tenantId ?? '__global__';
      reads.set(t, (reads.get(t) ?? 0) + 1);
      return [rowFor(tenantId)];
    },
  } as unknown as DatabaseAdapter;
  return { db, reads };
}

describe('Tenancy Realm (C11) — capability-matrix cache lineage read + invalidation', () => {
  let cache: CapabilityMatrixCache;
  let f: ReturnType<typeof fakeDb>;
  beforeEach(() => { cache = new CapabilityMatrixCache({ ttlMs: 60_000 }); f = fakeDb(); });

  it('POSITIVE: scores are cached per tenant; a second read is a hit (no extra DB read)', async () => {
    await cache.getCapabilityScores(f.db, 'acme');
    await cache.getCapabilityScores(f.db, 'acme');
    expect(f.reads.get('acme')).toBe(1); // second call served from cache
    await cache.getCapabilityScores(f.db, 'globex');
    await cache.getCapabilityScores(f.db, null);
    expect(f.reads.get('globex')).toBe(1);
    expect(f.reads.get('__global__')).toBe(1); // distinct keys, no collision
  });

  it('READ-THROUGH: the cache resolves via the realm lineage resolver, keyed by tenant', async () => {
    const rows = await cache.getCapabilityScores(f.db, 'acme');
    expect(rows[0]!.tenant_id).toBe('acme'); // resolver output, keyed to the asking tenant
    const globals = await cache.getCapabilityScores(f.db, null);
    expect(globals[0]!.tenant_id).toBeNull();
  });

  it('INVALIDATION: a specific tenant write clears ALL keys (descendants may inherit it)', async () => {
    await cache.getCapabilityScores(f.db, 'acme');
    await cache.getCapabilityScores(f.db, 'globex');
    cache.invalidateCapabilityScores('acme');           // acme's row changed → any descendant is affected
    await cache.getCapabilityScores(f.db, 'acme');       // re-reads
    await cache.getCapabilityScores(f.db, 'globex');     // also re-reads (conservative, correct)
    expect(f.reads.get('acme')).toBe(2);
    expect(f.reads.get('globex')).toBe(2);
  });

  it('INVALIDATION: a GLOBAL write (tenant_id null) clears ALL tenants', async () => {
    await cache.getCapabilityScores(f.db, 'acme');
    await cache.getCapabilityScores(f.db, 'globex');
    await cache.getCapabilityScores(f.db, null);
    cache.invalidateCapabilityScores(null);             // a global score changed → everyone inherits it
    await cache.getCapabilityScores(f.db, 'acme');
    await cache.getCapabilityScores(f.db, 'globex');
    await cache.getCapabilityScores(f.db, null);
    expect(f.reads.get('acme')).toBe(2);
    expect(f.reads.get('globex')).toBe(2);
    expect(f.reads.get('__global__')).toBe(2);
  });

  it('BACKWARD-COMPAT: invalidateCapabilityScores() with no arg clears everything', async () => {
    await cache.getCapabilityScores(f.db, 'acme');
    await cache.getCapabilityScores(f.db, 'globex');
    cache.invalidateCapabilityScores();
    await cache.getCapabilityScores(f.db, 'acme');
    await cache.getCapabilityScores(f.db, 'globex');
    expect(f.reads.get('acme')).toBe(2);
    expect(f.reads.get('globex')).toBe(2);
  });

  it('NEGATIVE: invalidating with an unknown tenant id still just clears (no throw)', async () => {
    await cache.getCapabilityScores(f.db, 'acme');
    expect(() => cache.invalidateCapabilityScores('never-cached')).not.toThrow();
    await cache.getCapabilityScores(f.db, 'acme');
    expect(f.reads.get('acme')).toBe(2); // cleared → re-read
  });

  it('SECURITY: a hostile tenant key is an opaque Map key — no cross-tenant leak or corruption', async () => {
    const hostile = "'; DROP TABLE model_capability_scores; --";
    const rows = await cache.getCapabilityScores(f.db, hostile);
    // the hostile tenant only ever sees a row keyed to ITSELF (resolver output), never another tenant's
    expect(rows[0]!.tenant_id).toBe(hostile);
    await cache.getCapabilityScores(f.db, 'acme');
    expect(() => cache.invalidateCapabilityScores(hostile)).not.toThrow();
  });

  it('STRESS: 500 tenants cached; all hit until an invalidation clears the whole matrix', async () => {
    const tenants = Array.from({ length: 500 }, (_, i) => `t-${i}`);
    for (const t of tenants) await cache.getCapabilityScores(f.db, t);
    for (const t of tenants) await cache.getCapabilityScores(f.db, t); // all hits
    for (const t of tenants) expect(f.reads.get(t)).toBe(1);

    cache.invalidateCapabilityScores('t-250');            // any write clears the whole matrix
    for (const t of tenants) await cache.getCapabilityScores(f.db, t);
    for (const t of tenants) expect(f.reads.get(t)).toBe(2); // every tenant re-read once
    const stats = cache.stats();
    expect(stats.invalidations).toBe(1);
    expect(stats.hits).toBe(500);   // the 500 second-round hits; round 3 all miss after the clear-all
  }, 20_000);
});
