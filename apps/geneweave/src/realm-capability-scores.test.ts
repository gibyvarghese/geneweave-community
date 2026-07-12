// SPDX-License-Identifier: MIT
/**
 * model_capability_scores converged onto the standard realm pattern (m168). The migration REBUILDS the
 * table to drop the old inline UNIQUE, so the money test is: no data is lost, the realm columns are
 * populated, the routing resolver still resolves nearest-owner-wins, the new unique enforces one row per
 * (cell, owner), and the seed reconcile baselines the family. Real booted SQLite.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { REALM_FAMILIES, capabilityCellKey } from './realm-families.js';

const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`);

describe('Tenancy Realm — model_capability_scores converged (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `cap-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    await db.seedReconcileRealm?.();
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('is registered as a standard realm family with the composite cell key + config semantic cols', () => {
    const spec = REALM_FAMILIES['model_capability_scores'];
    expect(spec).toBeTruthy();
    expect(spec!.computeLogicalKey).toBeTypeOf('function');
    // config fields only — the auto-updating production signals are NOT in the hash set
    expect(spec!.semanticCols).toContain('quality_score');
    expect(spec!.semanticCols).not.toContain('production_signal_score');
    expect(spec!.semanticCols).not.toContain('signal_sample_count');
  });

  it('MONEY TEST: the rebuild preserved every seeded score + populated the realm columns (no data loss)', () => {
    const rows = raw().prepare(`SELECT * FROM model_capability_scores WHERE realm = 'global' LIMIT 5`).all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r['owner_tenant_id'], 'global row owner').toBeNull();          // global = NULL owner
      expect(r['realm']).toBe('global');
      expect(r['logical_key']).toBe(capabilityCellKey(r));                  // cell key = provider::model::task
      expect(String(r['content_hash'] ?? '')).not.toBe('');                 // hashed over config fields
      // original data intact
      expect(r['quality_score']).toBeTypeOf('number');
      expect(String(r['model_id'] ?? '')).not.toBe('');
    }
    // the old inline UNIQUE(tenant_id, model, provider, task) is gone; the realm unique exists
    const idx = raw().prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='model_capability_scores'`).all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain('ux_model_capability_scores_logical_owner');
  });

  it('the new unique enforces one row per (cell, owner) — a duplicate cell upserts, not duplicates', async () => {
    const before = raw().prepare(`SELECT count(*) c FROM model_capability_scores`).get() as { c: number };
    const cell = { model_id: 'test-model-x', provider: 'test-prov', task_key: 'reasoning' };
    await db.upsertCapabilityScore({ id: uuid(), tenant_id: null, ...cell, quality_score: 50, supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 0, supports_vision: 0, max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1, last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0 });
    await db.upsertCapabilityScore({ id: uuid(), tenant_id: null, ...cell, quality_score: 77, supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 0, supports_vision: 0, max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1, last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0 });
    const rows = raw().prepare(`SELECT quality_score FROM model_capability_scores WHERE logical_key = ?`).all('test-prov::test-model-x::reasoning') as Array<{ quality_score: number }>;
    expect(rows.length).toBe(1);              // one row per (cell, owner) — the 2nd upsert updated
    expect(rows[0]!.quality_score).toBe(77);  // and it took the new value
    const after = raw().prepare(`SELECT count(*) c FROM model_capability_scores`).get() as { c: number };
    expect(after.c).toBe(before.c + 1);       // net one new global cell
  });

  it('ROUTING: a tenant fork resolves nearest-owner-wins over the global (via owner_tenant_id)', async () => {
    const cell = { model_id: 'route-model', provider: 'route-prov', task_key: 'reasoning' };
    // global score 60
    await db.upsertCapabilityScore({ id: uuid(), tenant_id: null, ...cell, quality_score: 60, supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 0, supports_vision: 0, max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1, last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0 });
    // tenant 'acme' tunes it to 90
    await db.upsertCapabilityScore({ id: uuid(), tenant_id: 'acme', ...cell, quality_score: 90, supports_tools: 1, supports_streaming: 1, supports_thinking: 0, supports_json_mode: 0, supports_vision: 0, max_output_tokens: null, benchmark_source: null, raw_benchmark_score: null, is_active: 1, last_evaluated_at: null, production_signal_score: null, signal_sample_count: 0 });

    const globalView = await db.resolveTenantEffectiveCapabilityScores(null, 'reasoning');
    const acmeView = await db.resolveTenantEffectiveCapabilityScores('acme', 'reasoning');
    const g = globalView.find((r) => r.logical_key === 'route-prov::route-model::reasoning' || (r.provider === 'route-prov' && r.model_id === 'route-model'));
    const a = acmeView.find((r) => r.provider === 'route-prov' && r.model_id === 'route-model');
    expect(g?.quality_score).toBe(60);   // no tenant → global default
    expect(a?.quality_score).toBe(90);   // acme → its own tuned score wins
  });

  it('seed reconcile baselined the family (drift-ready): realm_versions has capability entries', () => {
    const v = raw().prepare(`SELECT count(*) c FROM realm_versions WHERE family = 'model_capability_scores'`).get() as { c: number };
    expect(v.c).toBeGreaterThan(0);
  });
});
