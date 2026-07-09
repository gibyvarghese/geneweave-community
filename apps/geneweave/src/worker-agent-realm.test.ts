// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant WORKER AGENT content forking, end to end on a real booted SQLite adapter.
 * A tenant forks a built-in worker (customizes its system_prompt) for itself; the effective roster
 * presents it under the canonical name; other tenants keep the global; UNIQUE(name) is never violated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { WorkerAgentRow } from './db-types/agents.js';
import { buildTenantWorkerAgentFork, resolveTenantEffectiveWorkerAgents, workerContentHash } from './worker-agent-realm.js';

const TENANT_A = 'mercy-health';
const TENANT_B = 'first-bank';

describe('Tenancy Realm — per-tenant worker-agent content fork', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: WorkerAgentRow;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `worker-realm-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    base = (await db.listWorkerAgents()).find((w) => (w.realm ?? 'global') === 'global')!;
    expect(base.realm).toBe('global');
    expect(base.logical_key).toBe(base.name);
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: a tenant fork wins for that tenant and keeps the canonical name; others get the global', async () => {
    const fork = buildTenantWorkerAgentFork(base, TENANT_A, { system_prompt: `${base.system_prompt}\n[Mercy] Cite clinical guidelines.` });
    expect(fork.realm).toBe('tenant');
    expect(fork.name).toBe(`${base.name}#${TENANT_A}`); // tenant-scoped, satisfies UNIQUE(name)
    expect(fork.logical_key).toBe(base.name);
    await db.insertRealmWorkerAgentRow(fork); // must not violate UNIQUE(name)

    const forA = (await db.resolveTenantEffectiveWorkerAgents(TENANT_A)).find((w) => (w.logical_key ?? w.name) === base.name)!;
    expect(forA.system_prompt).toContain('[Mercy]');
    expect(forA.name).toBe(base.name); // canonical name restored on the effective row

    const forB = (await db.resolveTenantEffectiveWorkerAgents(TENANT_B)).find((w) => (w.logical_key ?? w.name) === base.name)!;
    expect(forB.system_prompt).not.toContain('[Mercy]');
    const forGlobal = (await db.resolveTenantEffectiveWorkerAgents(null)).find((w) => w.name === base.name)!;
    expect(forGlobal.system_prompt).not.toContain('[Mercy]');
  });

  it('ISOLATION + ONE-PER-KEY: another tenant fork is invisible; each tenant resolves one worker per name', async () => {
    await db.insertRealmWorkerAgentRow(buildTenantWorkerAgentFork(base, TENANT_B, { system_prompt: `${base.system_prompt}\n[Bank] No PII.` }));
    const rosterA = await db.resolveTenantEffectiveWorkerAgents(TENANT_A);
    const a = rosterA.find((w) => (w.logical_key ?? w.name) === base.name)!;
    const b = (await db.resolveTenantEffectiveWorkerAgents(TENANT_B)).find((w) => (w.logical_key ?? w.name) === base.name)!;
    expect(a.system_prompt).toContain('[Mercy]');
    expect(b.system_prompt).toContain('[Bank]');
    // No duplicate logical keys in a tenant's roster.
    const keys = rosterA.map((w) => w.logical_key ?? w.name);
    expect(new Set(keys).size).toBe(keys.length);
    // A's roster never contains B's fork.
    expect(rosterA.every((w) => w.realm !== 'tenant' || w.owner_tenant_id === TENANT_A)).toBe(true);
  });

  it('REVERT: deleting a fork falls the tenant back to the global built-in', async () => {
    const fork = (await db.listWorkerAgents()).find((w) => w.realm === 'tenant' && w.owner_tenant_id === TENANT_A)!;
    await db.deleteWorkerAgent(fork.id);
    const a = (await db.resolveTenantEffectiveWorkerAgents(TENANT_A)).find((w) => (w.logical_key ?? w.name) === base.name)!;
    expect(a.system_prompt).not.toContain('[Mercy]');
  });

  it('HASH PARITY: a fork’s content_hash is over the semantic fields (excludes the suffixed name)', () => {
    const f1 = buildTenantWorkerAgentFork(base, 'acme', { system_prompt: 'X' });
    const f2 = buildTenantWorkerAgentFork(base, 'globex', { system_prompt: 'X' });
    // Same content, different tenant-scoped names → SAME hash (name excluded).
    expect(f1.content_hash).toBe(f2.content_hash);
    expect(f1.content_hash).toBe(workerContentHash(f1));
    expect(f1.origin_hash).toBe(base.content_hash);
  });

  it('SECURITY: a hostile tenant id resolves to the global, no throw, no leak', async () => {
    const eff = (await db.resolveTenantEffectiveWorkerAgents("'; DROP TABLE worker_agents; --")).find((w) => (w.logical_key ?? w.name) === base.name)!;
    expect(eff.system_prompt).not.toContain('[Mercy]');
    expect((await db.listWorkerAgents()).length).toBeGreaterThan(0);
  });
});
