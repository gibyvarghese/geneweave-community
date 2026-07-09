// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant ROUTING POLICY content forking, end to end on a real booted SQLite adapter.
 * A tenant forks a built-in routing policy (customizes its strategy/weights) for itself; the effective
 * set presents it under the same name; other tenants keep the global; routeModel picks the tenant's fork.
 * routing_policies has no UNIQUE(name), so a fork keeps the canonical name (no aliasing).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { RoutingPolicyRow } from './db-types/routing.js';
import { buildTenantRoutingPolicyFork, resolveTenantEffectiveRoutingPolicies, routingContentHash } from './routing-policy-realm.js';

const TENANT_A = 'mercy-health';
const TENANT_B = 'first-bank';

describe('Tenancy Realm — per-tenant routing-policy content fork', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: RoutingPolicyRow;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `routing-realm-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    base = (await db.listRoutingPolicies()).find((p) => (p.realm ?? 'global') === 'global')!;
    expect(base.realm).toBe('global');
    expect(base.logical_key).toBe(base.name);
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: a tenant fork wins for that tenant and keeps the canonical name; others get the global', async () => {
    const fork = buildTenantRoutingPolicyFork(base, TENANT_A, { strategy: 'quality', weights: JSON.stringify({ cost: 0.1, quality: 0.8, latency: 0.1 }) });
    expect(fork.realm).toBe('tenant');
    expect(fork.name).toBe(base.name);          // no UNIQUE(name) → fork keeps the same name
    expect(fork.logical_key).toBe(base.name);
    await db.insertRealmRoutingPolicyRow(fork);

    const forA = (await db.resolveTenantEffectiveRoutingPolicies(TENANT_A)).find((p) => (p.logical_key ?? p.name) === base.name)!;
    expect(forA.strategy).toBe('quality');
    expect(forA.name).toBe(base.name);

    const forB = (await db.resolveTenantEffectiveRoutingPolicies(TENANT_B)).find((p) => (p.logical_key ?? p.name) === base.name)!;
    expect(forB.strategy).toBe(base.strategy);
    const forGlobal = (await db.resolveTenantEffectiveRoutingPolicies(null)).find((p) => p.name === base.name)!;
    expect(forGlobal.strategy).toBe(base.strategy);
  });

  it('ISOLATION + ONE-PER-KEY: another tenant fork is invisible; each tenant resolves one policy per key', async () => {
    await db.insertRealmRoutingPolicyRow(buildTenantRoutingPolicyFork(base, TENANT_B, { strategy: 'cost' }));
    const setA = await db.resolveTenantEffectiveRoutingPolicies(TENANT_A);
    const a = setA.find((p) => (p.logical_key ?? p.name) === base.name)!;
    const b = (await db.resolveTenantEffectiveRoutingPolicies(TENANT_B)).find((p) => (p.logical_key ?? p.name) === base.name)!;
    expect(a.strategy).toBe('quality');
    expect(b.strategy).toBe('cost');
    const keys = setA.map((p) => p.logical_key ?? p.name);
    expect(new Set(keys).size).toBe(keys.length);
    expect(setA.every((p) => p.realm !== 'tenant' || p.owner_tenant_id === TENANT_A)).toBe(true);
  });

  it('REVERT: deleting a fork falls the tenant back to the global built-in', async () => {
    const fork = (await db.listRoutingPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === TENANT_A)!;
    await db.deleteRoutingPolicy(fork.id);
    const a = (await db.resolveTenantEffectiveRoutingPolicies(TENANT_A)).find((p) => (p.logical_key ?? p.name) === base.name)!;
    expect(a.strategy).toBe(base.strategy);
  });

  it('HASH PARITY: a fork’s content_hash is over the rule fields; same content ⇒ same hash across tenants', () => {
    const f1 = buildTenantRoutingPolicyFork(base, 'acme', { strategy: 'balanced' });
    const f2 = buildTenantRoutingPolicyFork(base, 'globex', { strategy: 'balanced' });
    expect(f1.content_hash).toBe(f2.content_hash);
    expect(f1.content_hash).toBe(routingContentHash(f1));
    expect(f1.origin_hash).toBe(base.content_hash);
    const f3 = buildTenantRoutingPolicyFork(base, 'acme', { strategy: 'cost' });
    expect(f3.content_hash).not.toBe(f1.content_hash); // drift detectable
  });

  it('SECURITY: a hostile tenant id resolves to the global, no throw, no leak', async () => {
    const eff = (await db.resolveTenantEffectiveRoutingPolicies("'; DROP TABLE routing_policies; --")).find((p) => (p.logical_key ?? p.name) === base.name)!;
    expect(eff.strategy).toBe(base.strategy);
    expect((await db.listRoutingPolicies()).length).toBeGreaterThan(0);
  });

  it('PURE RESOLVER: resolveTenantEffectiveRoutingPolicies(rows, null) returns exactly the globals', () => {
    const rows: RoutingPolicyRow[] = [
      { ...base, id: 'r1', realm: 'global', logical_key: 'x', name: 'x' },
      { ...base, id: 'r2', realm: 'tenant', owner_tenant_id: 'other', logical_key: 'x', name: 'x' },
    ];
    const globals = resolveTenantEffectiveRoutingPolicies(rows, null);
    expect(globals.map((p) => p.id)).toEqual(['r1']);
  });
});
