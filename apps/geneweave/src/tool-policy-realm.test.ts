// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant TOOL POLICY content forking, end to end on a real booted SQLite adapter.
 * A tenant forks a built-in tool policy (customizes its gates) for itself; the effective set presents it
 * under the canonical key; other tenants keep the global; the DbToolPolicyResolver honours the fork.
 * tool_policies keeps its inline UNIQUE(key), so a fork uses a tenant-scoped key that the resolver
 * restores to the canonical key on read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { ToolPolicyRow } from './db-types/tools.js';
import { buildTenantToolPolicyFork, resolveTenantEffectiveToolPolicies, toolPolicyContentHash } from './tool-policy-realm.js';
import { DbToolPolicyResolver } from './tool-policy-resolver.js';

const TENANT_A = 'mercy-health';
const TENANT_B = 'first-bank';

describe('Tenancy Realm — per-tenant tool-policy content fork', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: ToolPolicyRow;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `tool-policy-realm-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    // The 'default' policy is seeded by the bootstrap migrations and backfilled by m157.
    base = (await db.getToolPolicyByKey('default'))!;
    expect(base, 'the default tool policy is seeded').toBeTruthy();
    expect(base.realm).toBe('global');
    expect(base.logical_key).toBe(base.key);
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: a tenant fork wins for that tenant and keeps the canonical key; others get the global', async () => {
    const fork = buildTenantToolPolicyFork(base, TENANT_A, { approval_required: base.approval_required ? 0 : 1, max_execution_ms: 12345 });
    expect(fork.realm).toBe('tenant');
    expect(fork.key).toBe(`${base.key}#${TENANT_A}`); // tenant-scoped, satisfies UNIQUE(key)
    expect(fork.logical_key).toBe(base.key);
    await db.insertRealmToolPolicyRow(fork); // must not violate UNIQUE(key)

    const forA = (await db.resolveTenantEffectiveToolPolicies(TENANT_A)).find((p) => (p.logical_key ?? p.key) === base.key)!;
    expect(forA.max_execution_ms).toBe(12345);
    expect(forA.key).toBe(base.key); // canonical key restored on the effective row

    const forB = (await db.resolveTenantEffectiveToolPolicies(TENANT_B)).find((p) => (p.logical_key ?? p.key) === base.key)!;
    expect(forB.max_execution_ms).not.toBe(12345);
    const forGlobal = (await db.resolveTenantEffectiveToolPolicies(null)).find((p) => p.key === base.key)!;
    expect(forGlobal.max_execution_ms).not.toBe(12345);
  });

  it('RESOLVER: getEffectiveToolPolicyByKey routes the fork to its tenant and the global to everyone else', async () => {
    // Tenant A sees the fork...
    const a = await db.getEffectiveToolPolicyByKey('default', TENANT_A);
    expect(a?.max_execution_ms).toBe(12345);
    expect(a?.key).toBe('default');
    // ...tenant B and the no-tenant path see the global.
    const b = await db.getEffectiveToolPolicyByKey('default', TENANT_B);
    expect(b?.max_execution_ms).not.toBe(12345);
    const g = await db.getEffectiveToolPolicyByKey('default', null);
    expect(g?.id).toBe(base.id);

    // The DbToolPolicyResolver bound to tenant A resolves the fork's gates for a tool call.
    const resolverA = new DbToolPolicyResolver(db, TENANT_A);
    const effA = await resolverA.resolve('some_tool', { skillPolicyKey: 'default' } as never);
    expect(effA.timeoutMs).toBe(12345);          // maps from max_execution_ms
    expect(effA.policyId).toBe(a?.id);            // audit attributes to the tenant fork
    // The default (no-tenant) resolver still sees the global.
    const resolverGlobal = new DbToolPolicyResolver(db);
    const effG = await resolverGlobal.resolve('some_tool', { skillPolicyKey: 'default' } as never);
    expect(effG.policyId).toBe(base.id);
  });

  it('ISOLATION + ONE-PER-KEY: another tenant fork is invisible; each tenant resolves one policy per key', async () => {
    await db.insertRealmToolPolicyRow(buildTenantToolPolicyFork(base, TENANT_B, { max_execution_ms: 999 }));
    const setA = await db.resolveTenantEffectiveToolPolicies(TENANT_A);
    const a = setA.find((p) => (p.logical_key ?? p.key) === base.key)!;
    const b = (await db.resolveTenantEffectiveToolPolicies(TENANT_B)).find((p) => (p.logical_key ?? p.key) === base.key)!;
    expect(a.max_execution_ms).toBe(12345);
    expect(b.max_execution_ms).toBe(999);
    const keys = setA.map((p) => p.logical_key ?? p.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate logical keys
    expect(setA.every((p) => p.realm !== 'tenant' || p.owner_tenant_id === TENANT_A)).toBe(true);
  });

  it('REVERT: deleting a fork falls the tenant back to the global built-in', async () => {
    const fork = (await db.listToolPolicies()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === TENANT_A)!;
    await db.deleteToolPolicy(fork.id);
    const a = await db.getEffectiveToolPolicyByKey('default', TENANT_A);
    expect(a?.max_execution_ms).not.toBe(12345);
    expect(a?.id).toBe(base.id);
  });

  it('HASH PARITY: a fork’s content_hash is over the gate fields; same content ⇒ same hash across tenants', () => {
    const f1 = buildTenantToolPolicyFork(base, 'acme', { max_execution_ms: 7000 });
    const f2 = buildTenantToolPolicyFork(base, 'globex', { max_execution_ms: 7000 });
    // Same gate content, different tenant-scoped keys → SAME hash (key excluded).
    expect(f1.content_hash).toBe(f2.content_hash);
    expect(f1.content_hash).toBe(toolPolicyContentHash(f1));
    expect(f1.origin_hash).toBe(base.content_hash);
    const f3 = buildTenantToolPolicyFork(base, 'acme', { max_execution_ms: 8000 });
    expect(f3.content_hash).not.toBe(f1.content_hash); // drift detectable
  });

  it('SECURITY: a hostile tenant id resolves to the global, no throw, no leak', async () => {
    const eff = await db.getEffectiveToolPolicyByKey('default', "'; DROP TABLE tool_policies; --");
    expect(eff?.id).toBe(base.id);
    expect((await db.listToolPolicies()).length).toBeGreaterThan(0);
  });

  it('PURE RESOLVER: resolveTenantEffectiveToolPolicies(rows, null) returns exactly the globals', () => {
    const rows: ToolPolicyRow[] = [
      { ...base, id: 'p1', realm: 'global', logical_key: 'x', key: 'x' },
      { ...base, id: 'p2', realm: 'tenant', owner_tenant_id: 'other', logical_key: 'x', key: 'x#other' },
    ];
    const globals = resolveTenantEffectiveToolPolicies(rows, null);
    expect(globals.map((p) => p.id)).toEqual(['p1']);
  });
});
