// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant SKILL content forking, end to end on a real booted SQLite adapter.
 * A tenant forks a built-in skill (customizes its instructions) for itself; other tenants keep the
 * global; the chat skill-discovery filter serves the fork; disable (Phase 3) still composes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { SkillRow } from './db-types/tools.js';
import { buildTenantSkillFork, resolveTenantEffectiveSkills, skillContentHash } from './skill-realm.js';

const TENANT_A = 'mercy-health';
const TENANT_B = 'first-bank';

describe('Tenancy Realm — per-tenant skill content fork', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: SkillRow;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `skill-realm-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    base = (await db.listSkills()).find((s) => (s.realm ?? 'global') === 'global')!;
    expect(base.realm).toBe('global');
    expect(base.logical_key).toBeTruthy();
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: a tenant that customizes a skill gets ITS fork; others get the global', async () => {
    const fork = buildTenantSkillFork(base, TENANT_A, { instructions: `${base.instructions}\n[Mercy] Always cite clinical guidelines.` });
    expect(fork.realm).toBe('tenant');
    expect(fork.origin_id).toBe(base.id);
    await db.insertRealmSkillRow(fork);

    const all = await db.listSkills();
    const forA = resolveTenantEffectiveSkills(all, TENANT_A).find((s) => (s.logical_key ?? s.id) === base.id)!;
    const forB = resolveTenantEffectiveSkills(all, TENANT_B).find((s) => (s.logical_key ?? s.id) === base.id)!;
    const forGlobal = resolveTenantEffectiveSkills(all, null).find((s) => s.id === base.id)!;
    expect(forA.instructions).toContain('[Mercy]');
    expect(forB.instructions).not.toContain('[Mercy]');  // other tenant → global
    expect(forGlobal.instructions).not.toContain('[Mercy]'); // no tenant → global
  });

  it('ISOLATION: one tenant’s fork is invisible to another', async () => {
    await db.insertRealmSkillRow(buildTenantSkillFork(base, TENANT_B, { instructions: `${base.instructions}\n[Bank] Never expose PII.` }));
    const all = await db.listSkills();
    const a = resolveTenantEffectiveSkills(all, TENANT_A).find((s) => (s.logical_key ?? s.id) === base.id)!;
    const b = resolveTenantEffectiveSkills(all, TENANT_B).find((s) => (s.logical_key ?? s.id) === base.id)!;
    expect(a.instructions).toContain('[Mercy]');
    expect(b.instructions).toContain('[Bank]');
    expect(a.id).not.toBe(b.id);
    expect(a.owner_tenant_id).toBe(TENANT_A);
  });

  it('ONE-PER-KEY: a tenant resolves exactly one effective skill per logical key', async () => {
    const all = await db.listSkills();
    const eff = resolveTenantEffectiveSkills(all, TENANT_A);
    const keys = eff.map((s) => s.logical_key ?? s.id);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate logical keys
    // Every effective skill for A is either A's own fork or a global (never B's fork).
    expect(eff.every((s) => s.realm !== 'tenant' || s.owner_tenant_id === TENANT_A)).toBe(true);
  });

  it('REVERT: deleting a fork falls the tenant back to the global built-in', async () => {
    const fork = (await db.listSkills()).find((s) => s.realm === 'tenant' && s.owner_tenant_id === TENANT_A)!;
    await db.deleteSkill(fork.id);
    const forA = resolveTenantEffectiveSkills(await db.listSkills(), TENANT_A).find((s) => (s.logical_key ?? s.id) === base.id)!;
    expect(forA.instructions).not.toContain('[Mercy]');
  });

  it('HASH PARITY: a fork’s content_hash is recomputed with the m154 algorithm', () => {
    const fork = buildTenantSkillFork(base, 'acme', { instructions: 'X' });
    expect(fork.content_hash).toBe(skillContentHash(fork));
    expect(fork.origin_hash).toBe(base.content_hash);
  });

  it('SECURITY: a hostile tenant id resolves to the global, no throw, no leak', async () => {
    const hostile = "'; DROP TABLE skills; --";
    const eff = resolveTenantEffectiveSkills(await db.listSkills(), hostile).find((s) => (s.logical_key ?? s.id) === base.id)!;
    expect(eff.instructions).not.toContain('[Mercy]'); // hostile tenant → global
    expect((await db.listSkills()).length).toBeGreaterThan(0); // table intact
  });
});
