// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm (B7) — the capability-matrix cache is tenant-keyed and its invalidation fans out by
 * family: a SPECIFIC tenant's write clears only that tenant's cache entry; a GLOBAL write (tenant_id
 * null) or an unspecified flush clears ALL tenants (they all inherit the globals that changed).
 * Positive / negative / stress / security coverage with a fake adapter that counts DB reads.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityMatrixCache } from './capability-matrix-cache.js';
import type { DatabaseAdapter, ModelCapabilityScoreRow } from './db-types.js';

/** A fake adapter whose listCapabilityScores returns one tenant-tagged row and counts reads per tenant. */
function fakeDb(): { db: DatabaseAdapter; reads: Map<string, number> } {
  const reads = new Map<string, number>();
  const db = {
    async listCapabilityScores(opts?: { tenantId?: string | null }): Promise<ModelCapabilityScoreRow[]> {
      const t = opts?.tenantId ?? '__global__';
      reads.set(t, (reads.get(t) ?? 0) + 1);
      return [{ id: `s-${t}`, tenant_id: opts?.tenantId ?? null, model_id: 'm', provider: 'p', task_key: 'k',
        quality_score: 1, supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 0,
        supports_vision: 0, max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1,
        last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0, created_at: '', updated_at: '' }];
    },
  } as unknown as DatabaseAdapter;
  return { db, reads };
}

describe('Tenancy Realm (B7) — capability-matrix cache tenant fan-out', () => {
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

  it('FAN-OUT: a specific tenant write clears ONLY that tenant; others stay cached', async () => {
    await cache.getCapabilityScores(f.db, 'acme');
    await cache.getCapabilityScores(f.db, 'globex');
    cache.invalidateCapabilityScores('acme');           // acme's row changed
    await cache.getCapabilityScores(f.db, 'acme');       // re-reads
    await cache.getCapabilityScores(f.db, 'globex');     // still cached
    expect(f.reads.get('acme')).toBe(2);
    expect(f.reads.get('globex')).toBe(1);
  });

  it('FAN-OUT: a GLOBAL write (tenant_id null) clears ALL tenants', async () => {
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

  it('NEGATIVE: invalidating a tenant that was never cached is a no-op (no throw, others intact)', async () => {
    await cache.getCapabilityScores(f.db, 'acme');
    expect(() => cache.invalidateCapabilityScores('never-cached')).not.toThrow();
    await cache.getCapabilityScores(f.db, 'acme');
    expect(f.reads.get('acme')).toBe(1); // untouched
  });

  it('SECURITY: a hostile tenant key is an opaque Map key — no cross-tenant leak or corruption', async () => {
    const hostile = "'; DROP TABLE model_capability_scores; --";
    await cache.getCapabilityScores(f.db, hostile);
    await cache.getCapabilityScores(f.db, 'acme');
    cache.invalidateCapabilityScores(hostile);          // clearing the hostile key must not touch acme
    await cache.getCapabilityScores(f.db, 'acme');
    expect(f.reads.get('acme')).toBe(1);
    // the hostile tenant only ever saw its OWN row
    const rows = await cache.getCapabilityScores(f.db, hostile);
    expect(rows[0]!.tenant_id).toBe(hostile);
  });

  it('STRESS: 500 tenants cached; invalidating one re-reads exactly one, all others stay hit', async () => {
    const tenants = Array.from({ length: 500 }, (_, i) => `t-${i}`);
    for (const t of tenants) await cache.getCapabilityScores(f.db, t);
    for (const t of tenants) await cache.getCapabilityScores(f.db, t); // all hits
    for (const t of tenants) expect(f.reads.get(t)).toBe(1);

    cache.invalidateCapabilityScores('t-250');
    for (const t of tenants) await cache.getCapabilityScores(f.db, t);
    expect(f.reads.get('t-250')).toBe(2);               // only this one re-read
    expect(f.reads.get('t-0')).toBe(1);
    expect(f.reads.get('t-499')).toBe(1);
    const stats = cache.stats();
    expect(stats.invalidations).toBe(1);
    expect(stats.hits).toBeGreaterThan(900);
  }, 20_000);
});
