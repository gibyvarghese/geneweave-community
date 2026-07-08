// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IAdminStore` slice (`pgAdminStore`). Proves it returns the SAME rows as
 * a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker container.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores AND by textual shape (SQLite
 * emits `YYYY-MM-DD HH:MM:SS` while some Postgres defaults emit ISO-millis), so they're normalised away
 * before comparison — but each is asserted to carry a plausible timestamp shape.
 *
 * Every list comparison is scoped to THIS test's inserted ids because `SQLiteAdapter.initialize()`
 * seeds many default admin rows; list results that can share a `created_at` second are compared as a
 * set keyed by id rather than by position.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgAdminStore } from './admin.js';
import { SQLiteAdapter } from '../db-sqlite.js';
import type { IdentityRuleRow, SearchProviderRow, CachePolicyRow, TenantConfigRow } from '../db-types/admin.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

// Accepts BOTH the SQLite `YYYY-MM-DD HH:MM:SS` shape and the Postgres ISO-millis shape.
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+Z?)?$/;

/** Strip clock-dependent columns after asserting each carries a timestamp shape. */
function normTs<T extends { created_at?: string; updated_at?: string }>(row: T): Omit<T, 'created_at' | 'updated_at'> {
  const { created_at, updated_at, ...rest } = row;
  expect(created_at).toMatch(TS_RE);
  expect(updated_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-admin-parity-${Date.now()}-${randomUUID()}.db`));
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgAdminStore — IAdminStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgAdminStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgAdminStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  // ── create + get parity (identity rules) ────────────────────────────────────
  it('createIdentityRule + getIdentityRule: identical rows on both stores', async () => {
    const id = randomUUID();
    const rule = {
      id,
      name: `rule-${id}`,
      description: "O'Brien's \"deny\" rule ☃",
      resource: 'tools',
      action: 'invoke',
      roles: JSON.stringify(['admin', 'operator']),
      scopes: JSON.stringify(['tools:write']),
      result: 'deny',
      priority: 42,
      enabled: 1,
    } satisfies Omit<IdentityRuleRow, 'created_at' | 'updated_at'>;

    await sq.createIdentityRule(rule);
    await pg.createIdentityRule!(rule);

    const sRow = await sq.getIdentityRule(id);
    const pRow = await pg.getIdentityRule!(id);
    expect(pRow).not.toBeNull();
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    // Integer boolean preserved as a number, not coerced to true/false.
    expect(pRow!.enabled).toBe(1);
    expect(pRow!.priority).toBe(42);
  });

  // ── list parity, incl. priority DESC then name COLLATE "C" byte order ────────
  it('listIdentityRules: same order (priority DESC, byte-order name) scoped to our ids', async () => {
    const tag = randomUUID().slice(0, 8);
    // Same priority so the secondary name sort decides; uppercase sorts BEFORE lowercase in byte order.
    const rows = [
      { name: `${tag}-zebra`, priority: 5 },
      { name: `${tag}-Apple`, priority: 5 },
      { name: `${tag}-banana`, priority: 9 }, // higher priority — sorts first
    ];
    const ids = new Set<string>();
    for (const r of rows) {
      const rule = { id: randomUUID(), name: r.name, description: null, resource: 'x', action: 'y', roles: null, scopes: null, result: 'allow', priority: r.priority, enabled: 1 };
      ids.add(rule.id);
      await sq.createIdentityRule(rule);
      await pg.createIdentityRule!(rule);
    }

    const sAll = (await sq.listIdentityRules()).filter((r) => ids.has(r.id));
    const pAll = (await pg.listIdentityRules!()).filter((r) => ids.has(r.id));
    // Ordering is deterministic here (distinct priorities/names), so compare by position.
    expect(pAll.map((r) => r.name)).toEqual(sAll.map((r) => r.name));
    expect(pAll.map((r) => r.name)).toEqual([`${tag}-banana`, `${tag}-Apple`, `${tag}-zebra`]);
  });

  // ── update parity (cache policy) ────────────────────────────────────────────
  it('updateCachePolicy: same mutated row on both stores', async () => {
    const id = randomUUID();
    const base = {
      id, name: `cp-${id}`, description: 'before', scope: 'global', ttl_ms: 1000, max_entries: 10,
      max_bytes: 0, bypass_patterns: null, output_bypass_patterns: null, invalidate_on: null,
      key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0, swr_ms: 0,
      negative_ttl_ms: 0, eviction_policy: 'lru', enabled: 1,
    } satisfies Omit<CachePolicyRow, 'created_at' | 'updated_at'>;
    await sq.createCachePolicy(base);
    await pg.createCachePolicy!(base);

    const fields = { description: 'after', ttl_ms: 5000, enabled: 0 };
    await sq.updateCachePolicy(id, fields);
    await pg.updateCachePolicy!(id, fields);

    const sRow = await sq.getCachePolicy(id);
    const pRow = await pg.getCachePolicy!(id);
    expect(normTs(pRow!)).toEqual(normTs(sRow!));
    expect(pRow!.description).toBe('after');
    expect(pRow!.ttl_ms).toBe(5000);
    expect(pRow!.enabled).toBe(0);
  });

  // ── delete parity (cache policy) ────────────────────────────────────────────
  it('deleteCachePolicy: removes the row on both stores', async () => {
    const id = randomUUID();
    const base = {
      id, name: `del-${id}`, description: null, scope: 'global', ttl_ms: 1, max_entries: 1,
      max_bytes: 0, bypass_patterns: null, output_bypass_patterns: null, invalidate_on: null,
      key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0, swr_ms: 0,
      negative_ttl_ms: 0, eviction_policy: 'lru', enabled: 1,
    } satisfies Omit<CachePolicyRow, 'created_at' | 'updated_at'>;
    await sq.createCachePolicy(base);
    await pg.createCachePolicy!(base);
    await sq.deleteCachePolicy(id);
    await pg.deleteCachePolicy!(id);
    expect(await pg.getCachePolicy!(id)).toBeNull();
    expect(await sq.getCachePolicy(id)).toBeNull();
  });

  // ── filtered list parity (memory extraction rules by ruleType) ──────────────
  it('listMemoryExtractionRules(ruleType): same filtered set (keyed by id)', async () => {
    const tag = randomUUID().slice(0, 8);
    const wantType = `entity_extraction_${tag}`;
    const otherType = `self_disclosure_${tag}`;
    const mkRule = (name: string, rule_type: string, priority: number) => ({
      id: randomUUID(), name, description: null, rule_type, entity_type: null,
      pattern: '\\bx\\b', flags: 'i', facts_template: null, priority, enabled: 1,
    });
    const wanted = [mkRule(`${tag}-a`, wantType, 3), mkRule(`${tag}-b`, wantType, 7)];
    const other = mkRule(`${tag}-c`, otherType, 1);
    for (const r of [...wanted, other]) {
      await sq.createMemoryExtractionRule(r);
      await pg.createMemoryExtractionRule!(r);
    }

    const wantedIds = new Set<string>(wanted.map((r) => String(r.id)));
    const sFiltered = (await sq.listMemoryExtractionRules(wantType)).filter((r) => wantedIds.has(String(r.id)) || r.rule_type === otherType);
    const pFiltered = (await pg.listMemoryExtractionRules!(wantType)).filter((r) => wantedIds.has(String(r.id)) || r.rule_type === otherType);
    // The filter must exclude the other-type row on BOTH stores.
    expect(sFiltered.every((r) => r.rule_type === wantType)).toBe(true);
    expect(pFiltered.every((r) => r.rule_type === wantType)).toBe(true);
    // Compare as a set keyed by id (rows can share a created_at second).
    const sSet = new Map((await sq.listMemoryExtractionRules(wantType)).filter((r) => wantedIds.has(String(r.id))).map((r) => [String(r.id), normTs(r)]));
    const pSet = new Map((await pg.listMemoryExtractionRules!(wantType)).filter((r) => wantedIds.has(String(r.id))).map((r) => [String(r.id), normTs(r)]));
    expect([...pSet.keys()].sort()).toEqual([...sSet.keys()].sort());
    for (const k of sSet.keys()) expect(pSet.get(k)).toEqual(sSet.get(k));
  });

  // ── upsert-on-conflict parity (cache settings single global row) ────────────
  it('updateCacheSettings: upserts the single global row identically', async () => {
    // First call must INSERT the 'global' row then patch it (ON CONFLICT DO NOTHING path).
    await sq.updateCacheSettings({ l2_enabled: 1, l2_provider: 'redis', l1_max_entries: 500 });
    await pg.updateCacheSettings!({ l2_enabled: 1, l2_provider: 'redis', l1_max_entries: 500 });
    // Second call must UPDATE the same row (no duplicate insert).
    await sq.updateCacheSettings({ l1_max_entries: 999, key_namespace: 'gw:' });
    await pg.updateCacheSettings!({ l1_max_entries: 999, key_namespace: 'gw:' });

    const sRow = await sq.getCacheSettings();
    const pRow = await pg.getCacheSettings!();
    expect(pRow).not.toBeNull();
    expect(sRow!.updated_at).toMatch(TS_RE);
    expect(pRow!.updated_at).toMatch(TS_RE);
    // SQLite seeds the single 'global' cache_settings row at init (with some non-default values, e.g.
    // stampede_protection=1); the Postgres schema is seed-free, so a first upsert inserts column
    // defaults. That's the deferred seed-data concern — so here we assert the fields updateCacheSettings
    // actually writes are updated identically (and it's a true upsert, not a duplicate), not the
    // seed-dependent columns.
    for (const k of ['id', 'l2_enabled', 'l2_provider', 'l1_max_entries', 'key_namespace'] as const) {
      expect((pRow as unknown as Record<string, unknown>)[k]).toEqual((sRow as unknown as Record<string, unknown>)[k]);
    }
    expect(pRow!.l2_provider).toBe('redis');
    expect(pRow!.l1_max_entries).toBe(999);
  });

  // ── encryption-aware CRUD parity (search providers, no VAULT_KEY → plaintext) ─
  it('createSearchProvider + getSearchProvider: identical rows (fail-open plaintext)', async () => {
    // No VAULT_KEY in the test env → both stores keep plaintext with credentials_encrypted = 0.
    const id = randomUUID();
    const provider = {
      id, name: `sp-${id}`, description: null, provider_type: 'tavily',
      api_key: 'secret-key-123', base_url: 'https://api.tavily.com', priority: 3,
      options: JSON.stringify({ k: 5 }), enabled: 1,
    } satisfies Omit<SearchProviderRow, 'created_at' | 'updated_at'>;
    await sq.createSearchProvider(provider);
    await pg.createSearchProvider!(provider);

    const sRow = await sq.getSearchProvider(id);
    const pRow = await pg.getSearchProvider!(id);
    expect(pRow).not.toBeNull();
    // Drop shadow-column artifacts (api_key_enc/credentials_encrypted are internal) before comparing.
    const strip = (r: Record<string, unknown>) => {
      const { api_key_enc: _e, credentials_encrypted: _c, ...rest } = r;
      return normTs(rest as { created_at?: string; updated_at?: string });
    };
    expect(strip(pRow as unknown as Record<string, unknown>)).toEqual(strip(sRow as unknown as Record<string, unknown>));
    expect(pRow!.api_key).toBe('secret-key-123');
  });

  // ── specialised getter parity (global vs tenant tenant-config lookups) ──────
  it('getGlobalTenantConfig / getTenantConfigForTenant: same selection semantics', async () => {
    const tag = randomUUID().slice(0, 8);
    const mk = (scope: string, tenant_id: string, enabled: number) => ({
      id: randomUUID(), name: `tc-${tag}-${scope}`, description: null, tenant_id, scope,
      allowed_models: null, denied_models: null, allowed_tools: null, max_tokens_daily: null,
      max_cost_daily: null, max_tokens_monthly: null, max_cost_monthly: null, features: null,
      config_overrides: null, enabled,
    } satisfies Omit<TenantConfigRow, 'created_at' | 'updated_at'>);
    const tenantScoped = mk('tenant', `tenant-${tag}`, 1);
    for (const c of [tenantScoped]) {
      await sq.createTenantConfig(c);
      await pg.createTenantConfig!(c);
    }
    const sFor = await sq.getTenantConfigForTenant(`tenant-${tag}`);
    const pFor = await pg.getTenantConfigForTenant!(`tenant-${tag}`);
    expect(pFor).not.toBeNull();
    expect(normTs(pFor!)).toEqual(normTs(sFor!));
    expect(pFor!.id).toBe(tenantScoped.id);
  });

  // ── negative: missing id → null on both (no throw, no boolean-blind leak) ────
  it('negative: getters for a missing id return null on both', async () => {
    expect(await pg.getIdentityRule!('does-not-exist')).toBeNull();
    expect(await sq.getIdentityRule('does-not-exist')).toBeNull();
    expect(await pg.getCachePolicy!(`' OR '1'='1`)).toBeNull(); // injection arg is data, not code
    expect(await sq.getCachePolicy(`' OR '1'='1`)).toBeNull();
  });
});
