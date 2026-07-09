// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant GUARDRAIL content forking, end to end on a real booted SQLite adapter.
 * A tenant forks a built-in guardrail (customizes its config) for itself; the effective set presents it
 * under the same name; other tenants keep the global. Unlike worker_agents there's no UNIQUE(name), so a
 * fork keeps the canonical name and no aliasing is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { GuardrailRow } from './db-types/routing.js';
import { buildTenantGuardrailFork, resolveTenantEffectiveGuardrails, guardrailContentHash } from './guardrail-realm.js';

const TENANT_A = 'mercy-health';
const TENANT_B = 'first-bank';

/** A guardrail's config JSON with a `strictness` field bumped — the kind of thing a Customize changes. */
const withConfig = (base: GuardrailRow, marker: string): string =>
  JSON.stringify({ ...(base.config ? JSON.parse(base.config) : {}), tenantMarker: marker });

describe('Tenancy Realm — per-tenant guardrail content fork', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: GuardrailRow;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `guardrail-realm-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    base = (await db.listGuardrails()).find((g) => (g.realm ?? 'global') === 'global')!;
    expect(base.realm).toBe('global');
    expect(base.logical_key).toBe(base.name);
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: a tenant fork wins for that tenant and keeps the canonical name; others get the global', async () => {
    const fork = buildTenantGuardrailFork(base, TENANT_A, { config: withConfig(base, 'MERCY') });
    expect(fork.realm).toBe('tenant');
    expect(fork.name).toBe(base.name);          // no UNIQUE(name) → fork keeps the same name
    expect(fork.logical_key).toBe(base.name);
    await db.insertRealmGuardrailRow(fork);

    const forA = (await db.resolveTenantEffectiveGuardrails(TENANT_A)).find((g) => (g.logical_key ?? g.name) === base.name)!;
    expect(forA.config).toContain('MERCY');
    expect(forA.name).toBe(base.name);

    const forB = (await db.resolveTenantEffectiveGuardrails(TENANT_B)).find((g) => (g.logical_key ?? g.name) === base.name)!;
    expect(forB.config ?? '').not.toContain('MERCY');
    const forGlobal = (await db.resolveTenantEffectiveGuardrails(null)).find((g) => g.name === base.name)!;
    expect(forGlobal.config ?? '').not.toContain('MERCY');
  });

  it('ISOLATION + ONE-PER-KEY: another tenant fork is invisible; each tenant resolves one guardrail per key', async () => {
    await db.insertRealmGuardrailRow(buildTenantGuardrailFork(base, TENANT_B, { config: withConfig(base, 'BANK') }));
    const setA = await db.resolveTenantEffectiveGuardrails(TENANT_A);
    const a = setA.find((g) => (g.logical_key ?? g.name) === base.name)!;
    const b = (await db.resolveTenantEffectiveGuardrails(TENANT_B)).find((g) => (g.logical_key ?? g.name) === base.name)!;
    expect(a.config).toContain('MERCY');
    expect(b.config).toContain('BANK');
    // No duplicate logical keys in a tenant's effective set.
    const keys = setA.map((g) => g.logical_key ?? g.name);
    expect(new Set(keys).size).toBe(keys.length);
    // A's set never contains B's fork.
    expect(setA.every((g) => g.realm !== 'tenant' || g.owner_tenant_id === TENANT_A)).toBe(true);
  });

  it('REVERT: deleting a fork falls the tenant back to the global built-in', async () => {
    const fork = (await db.listGuardrails()).find((g) => g.realm === 'tenant' && g.owner_tenant_id === TENANT_A)!;
    await db.deleteGuardrail(fork.id);
    const a = (await db.resolveTenantEffectiveGuardrails(TENANT_A)).find((g) => (g.logical_key ?? g.name) === base.name)!;
    expect(a.config ?? '').not.toContain('MERCY');
  });

  it('HASH PARITY: a fork’s content_hash is over the policy fields; same content ⇒ same hash across tenants', () => {
    const cfg = withConfig(base, 'SHARED');
    const f1 = buildTenantGuardrailFork(base, 'acme', { config: cfg });
    const f2 = buildTenantGuardrailFork(base, 'globex', { config: cfg });
    // Same policy content, different tenant → SAME hash (owner/name are not part of the semantic hash).
    expect(f1.content_hash).toBe(f2.content_hash);
    expect(f1.content_hash).toBe(guardrailContentHash(f1));
    expect(f1.origin_hash).toBe(base.content_hash);
    // A different config ⇒ a different hash (drift is detectable).
    const f3 = buildTenantGuardrailFork(base, 'acme', { config: withConfig(base, 'DIFFERENT') });
    expect(f3.content_hash).not.toBe(f1.content_hash);
  });

  it('SECURITY: a hostile tenant id resolves to the global, no throw, no leak', async () => {
    const eff = (await db.resolveTenantEffectiveGuardrails("'; DROP TABLE guardrails; --")).find((g) => (g.logical_key ?? g.name) === base.name)!;
    expect(eff.config ?? '').not.toContain('MERCY');
    expect((await db.listGuardrails()).length).toBeGreaterThan(0);
  });

  it('PURE RESOLVER: resolveTenantEffectiveGuardrails(rows, null) returns exactly the globals', () => {
    const rows: GuardrailRow[] = [
      { ...base, id: 'g1', realm: 'global', logical_key: 'x', name: 'x' },
      { ...base, id: 'g2', realm: 'tenant', owner_tenant_id: 'other', logical_key: 'x', name: 'x' },
    ];
    const globals = resolveTenantEffectiveGuardrails(rows, null);
    expect(globals.map((g) => g.id)).toEqual(['g1']);
  });
});
