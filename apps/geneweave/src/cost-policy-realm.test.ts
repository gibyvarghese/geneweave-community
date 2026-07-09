// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant COST POLICY content forking, end to end on a real booted SQLite adapter.
 * A tenant forks a built-in cost policy (customizes its tier/levers) for itself; the effective set
 * presents it under the canonical key; the DbCostPolicyResolver resolves the tenant's forked tier when a
 * binding points at the global. cost_policies keeps its inline UNIQUE(key), so a fork uses a
 * tenant-scoped key that the resolver restores to the canonical key on read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { CostPolicyRow } from './db-types/cost-governor.js';
import { buildTenantCostPolicyFork, resolveTenantEffectiveCostPolicies, costContentHash } from './cost-policy-realm.js';
import { DbCostPolicyResolver } from './cost/db-cost-policy-resolver.js';

const TENANT_A = 'mercy-health';
const TENANT_B = 'first-bank';

describe('Tenancy Realm — per-tenant cost-policy content fork', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: CostPolicyRow;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `cost-realm-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    // 'balanced' is a seeded global cost policy, backfilled by m158.
    base = (await db.getCostPolicyByKey('balanced'))!;
    expect(base, 'the balanced cost policy is seeded').toBeTruthy();
    expect(base.realm).toBe('global');
    expect(base.logical_key).toBe(base.key);
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: a tenant fork wins for that tenant and keeps the canonical key; others get the global', async () => {
    const fork = buildTenantCostPolicyFork(base, TENANT_A, { tier: 'economy', levers_json: JSON.stringify({ budgetCeilingUsd: 1 }) });
    expect(fork.realm).toBe('tenant');
    expect(fork.key).toBe(`${base.key}#${TENANT_A}`); // tenant-scoped, satisfies UNIQUE(key)
    expect(fork.logical_key).toBe(base.key);
    await db.insertRealmCostPolicyRow(fork); // must not violate UNIQUE(key)

    const forA = (await db.resolveTenantEffectiveCostPolicies(TENANT_A)).find((p) => (p.logical_key ?? p.key) === base.key)!;
    expect(forA.tier).toBe('economy');
    expect(forA.key).toBe(base.key); // canonical key restored on the effective row

    const forB = (await db.resolveTenantEffectiveCostPolicies(TENANT_B)).find((p) => (p.logical_key ?? p.key) === base.key)!;
    expect(forB.tier).toBe(base.tier);
    const forGlobal = (await db.resolveTenantEffectiveCostPolicies(null)).find((p) => p.key === base.key)!;
    expect(forGlobal.tier).toBe(base.tier);
  });

  it('RESOLVER: getEffectiveCostPolicyByKey routes the fork to its tenant, global to everyone else', async () => {
    const a = await db.getEffectiveCostPolicyByKey('balanced', TENANT_A);
    expect(a?.tier).toBe('economy');
    expect(a?.key).toBe('balanced');
    const b = await db.getEffectiveCostPolicyByKey('balanced', TENANT_B);
    expect(b?.tier).toBe(base.tier);
    const g = await db.getEffectiveCostPolicyByKey('balanced', null);
    expect(g?.id).toBe(base.id);
  });

  it('DbCostPolicyResolver: a tenant binding to the global resolves the tenant’s forked tier', async () => {
    // Bind the tenant to the GLOBAL balanced policy; the resolver must upgrade to the tenant's fork.
    await db.createCapabilityPolicyBinding({
      id: 'cpb-cost-a', binding_kind: 'tenant', binding_ref: TENANT_A,
      policy_kind: 'cost_policy', policy_ref: base.id, precedence: 5, enabled: 1,
    });
    const resolver = new DbCostPolicyResolver(db);
    const resolvedA = await resolver.resolve({ tenantId: TENANT_A });
    expect(resolvedA?.policy.tier).toBe('economy');       // the fork's tier, not the global 'balanced'
    // A different tenant bound to the same global gets the global tier (no fork).
    await db.createCapabilityPolicyBinding({
      id: 'cpb-cost-b', binding_kind: 'tenant', binding_ref: TENANT_B,
      policy_kind: 'cost_policy', policy_ref: base.id, precedence: 5, enabled: 1,
    });
    const resolvedB = await resolver.resolve({ tenantId: TENANT_B });
    expect(resolvedB?.policy.tier).toBe(base.tier);
  });

  it('REVERT: deleting a fork falls the tenant back to the global built-in', async () => {
    const fork = (await db.listCostPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === TENANT_A)!;
    await db.deleteCostPolicy(fork.id);
    const a = await db.getEffectiveCostPolicyByKey('balanced', TENANT_A);
    expect(a?.tier).toBe(base.tier);
    expect(a?.id).toBe(base.id);
  });

  it('HASH PARITY: a fork’s content_hash is over the tier/lever fields; same content ⇒ same hash', () => {
    const f1 = buildTenantCostPolicyFork(base, 'acme', { tier: 'max' });
    const f2 = buildTenantCostPolicyFork(base, 'globex', { tier: 'max' });
    expect(f1.content_hash).toBe(f2.content_hash); // key excluded
    expect(f1.content_hash).toBe(costContentHash(f1));
    expect(f1.origin_hash).toBe(base.content_hash);
    const f3 = buildTenantCostPolicyFork(base, 'acme', { tier: 'economy' });
    expect(f3.content_hash).not.toBe(f1.content_hash);
  });

  it('SECURITY: a hostile tenant id resolves to the global, no throw, no leak', async () => {
    const eff = await db.getEffectiveCostPolicyByKey('balanced', "'; DROP TABLE cost_policies; --");
    expect(eff?.id).toBe(base.id);
    expect((await db.listCostPolicies()).length).toBeGreaterThan(0);
  });

  it('PURE RESOLVER: resolveTenantEffectiveCostPolicies(rows, null) returns exactly the globals', () => {
    const rows: CostPolicyRow[] = [
      { ...base, id: 'p1', realm: 'global', logical_key: 'x', key: 'x' },
      { ...base, id: 'p2', realm: 'tenant', owner_tenant_id: 'other', logical_key: 'x', key: 'x#other' },
    ];
    const globals = resolveTenantEffectiveCostPolicies(rows, null);
    expect(globals.map((p) => p.id)).toEqual(['p1']);
  });
});
