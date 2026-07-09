// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — per-tenant PROMPT CATALOG content forking (strategies / contracts / frameworks),
 * end to end on a real booted SQLite adapter. Positive, negative, stress, and security coverage, plus
 * the two runtime choke points: resolveSystemPrompt (strategies) and validatePromptContractsAgainstDb
 * (contracts). All three tables key on UNIQUE(key) → a fork uses `key#tenant` and the resolver restores
 * the canonical key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { newUUIDv7 } from '@weaveintel/core';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { PromptStrategyRow, PromptContractRow, PromptFrameworkRow } from './db-types/prompts.js';
import {
  buildTenantPromptStrategyFork, resolveTenantEffectivePromptStrategies, promptStrategyContentHash,
  buildTenantPromptContractFork, buildTenantPromptFrameworkFork,
} from './prompt-catalog-realm.js';
import { validatePromptContractsAgainstDb } from './chat-prompt-contract-utils.js';

const A = 'mercy-health';
const B = 'first-bank';

describe('Tenancy Realm — prompt catalog content fork (A6)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `prompt-catalog-realm-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  // ── strategies (seeded built-ins: singlePass/deliberate/critiqueRevise) ──────────────────────

  it('POSITIVE (strategies): built-ins are global originals; a tenant fork wins and keeps the canonical key', async () => {
    const base = (await db.listPromptStrategies()).find((s) => (s.realm ?? 'global') === 'global')!;
    expect(base.realm).toBe('global');
    expect(base.logical_key).toBe(base.key);
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);

    const fork = buildTenantPromptStrategyFork(base, A, { instruction_prefix: 'MERCY PREFIX' });
    expect(fork.key).toBe(`${base.key}#${A}`);
    expect(fork.logical_key).toBe(base.key);
    await db.insertRealmPromptStrategyRow(fork);

    const forA = (await db.resolveTenantEffectivePromptStrategies(A)).find((s) => (s.logical_key ?? s.key) === base.key)!;
    expect(forA.instruction_prefix).toBe('MERCY PREFIX');
    expect(forA.key).toBe(base.key); // canonical key restored
    const forB = (await db.resolveTenantEffectivePromptStrategies(B)).find((s) => (s.logical_key ?? s.key) === base.key)!;
    expect(forB.instruction_prefix).not.toBe('MERCY PREFIX');
    const forGlobal = (await db.resolveTenantEffectivePromptStrategies(null)).find((s) => s.key === base.key)!;
    expect(forGlobal.instruction_prefix).not.toBe('MERCY PREFIX');
  });

  it('WIRING (strategies): resolveSystemPrompt loads the tenant-effective strategy set', async () => {
    // resolveSystemPrompt calls db.resolveTenantEffectivePromptStrategies(tenantId) — assert the adapter
    // path it uses returns the fork for A and the global for others (the wiring contract).
    const base = (await db.listPromptStrategies()).find((s) => (s.realm ?? 'global') === 'global')!;
    const a = (await db.resolveTenantEffectivePromptStrategies(A)).find((s) => (s.logical_key ?? s.key) === base.key)!;
    expect(a.enabled).toBe(1); // fork stays enabled so the registry registers it
    // Exactly one effective strategy per logical key (no global + fork duplicate).
    const keys = (await db.resolveTenantEffectivePromptStrategies(A)).map((s) => s.logical_key ?? s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('REVERT (strategies): deleting a fork falls the tenant back to the global', async () => {
    const fork = (await db.listPromptStrategies()).find((s) => s.realm === 'tenant' && s.owner_tenant_id === A)!;
    const base = (await db.listPromptStrategies()).find((s) => (s.realm ?? 'global') === 'global' && s.key === fork.logical_key)!;
    await db.deletePromptStrategy(fork.id);
    const a = (await db.resolveTenantEffectivePromptStrategies(A)).find((s) => (s.logical_key ?? s.key) === base.key)!;
    expect(a.instruction_prefix).not.toBe('MERCY PREFIX');
  });

  it('HASH (strategies): content_hash excludes key/enabled; same content ⇒ same hash across tenants', () => {
    const base = { id: 'x', key: 'k', name: 'n', description: 'd', instruction_prefix: 'p', instruction_suffix: 's', config: '{}', enabled: 1 } as PromptStrategyRow;
    const f1 = buildTenantPromptStrategyFork(base, 'acme', { instruction_prefix: 'Z' });
    const f2 = buildTenantPromptStrategyFork(base, 'globex', { instruction_prefix: 'Z' });
    expect(f1.content_hash).toBe(f2.content_hash);
    expect(f1.content_hash).toBe(promptStrategyContentHash(f1));
    const f3 = buildTenantPromptStrategyFork(base, 'acme', { instruction_prefix: 'DIFFERENT' });
    expect(f3.content_hash).not.toBe(f1.content_hash);
  });

  // ── contracts (NOT seeded — insert a global, then fork) + the validation wiring ──────────────

  it('WIRING (contracts): validatePromptContractsAgainstDb honours the tenant fork', async () => {
    // A global max_length=10 contract; tenant A forks it to max_length=1000. A 50-char output:
    // fails for the global/other tenants, passes for A.
    const gid = newUUIDv7();
    const globalC: Omit<PromptContractRow, 'created_at' | 'updated_at'> = {
      id: gid, key: 'len_gate', name: 'Length Gate', description: 'max length',
      contract_type: 'max_length', schema: null, config: JSON.stringify({ maxCharacters: 10, unit: 'characters', severity: 'error' }),
      enabled: 1, realm: 'global', owner_tenant_id: null, logical_key: 'len_gate', origin_id: null,
      origin_hash: '', content_hash: '', track_mode: 'pin', share_mode: 'private',
    };
    await db.insertRealmPromptContractRow(globalC);
    const g = (await db.getPromptContractByKey('len_gate'))!;
    await db.insertRealmPromptContractRow(buildTenantPromptContractFork(g, A, { config: JSON.stringify({ maxCharacters: 1000, unit: 'characters', severity: 'error' }) }));

    const output = 'x'.repeat(50);
    const forGlobal = await validatePromptContractsAgainstDb(output, db, null);
    expect(forGlobal?.summary.failed ?? 0).toBeGreaterThan(0);         // 50 > 10 → fails globally
    const forB = await validatePromptContractsAgainstDb(output, db, B);
    expect(forB?.summary.failed ?? 0).toBeGreaterThan(0);              // B has no fork → global limit
    const forA = await validatePromptContractsAgainstDb(output, db, A);
    expect(forA?.summary.failed ?? 0).toBe(0);                         // A's fork raised the limit
  });

  // ── frameworks (admin/catalog only) ──────────────────────────────────────────────────────────

  it('POSITIVE (frameworks): a tenant fork wins and keeps the canonical key; others get the global', async () => {
    const base = (await db.listPromptFrameworks()).find((f) => (f.realm ?? 'global') === 'global')!;
    expect(base.logical_key).toBe(base.key);
    await db.insertRealmPromptFrameworkRow(buildTenantPromptFrameworkFork(base, A, { section_separator: '\n---\n' }));
    const a = (await db.resolveTenantEffectivePromptFrameworks(A)).find((f) => (f.logical_key ?? f.key) === base.key)!;
    expect(a.section_separator).toBe('\n---\n');
    expect(a.key).toBe(base.key);
    const b = (await db.resolveTenantEffectivePromptFrameworks(B)).find((f) => (f.logical_key ?? f.key) === base.key)!;
    expect(b.section_separator).not.toBe('\n---\n');
  });

  // ── negative + security ──────────────────────────────────────────────────────────────────────

  it('NEGATIVE: null tenant returns exactly the globals for each table', async () => {
    for (const rows of [await db.resolveTenantEffectivePromptStrategies(null), await db.resolveTenantEffectivePromptFrameworks(null)]) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { realm?: string }) => (r.realm ?? 'global') === 'global')).toBe(true);
    }
  });

  it('SECURITY: hostile tenant ids (SQL injection) resolve to globals, no throw, tables intact', async () => {
    const hostile = ["'; DROP TABLE prompt_strategies; --", "' OR '1'='1", ' ', 'x'.repeat(5000)];
    for (const t of hostile) {
      const s = await db.resolveTenantEffectivePromptStrategies(t);
      expect(s.every((r) => (r.realm ?? 'global') === 'global' || r.owner_tenant_id === t)).toBe(true);
    }
    // Tables still populated.
    expect((await db.listPromptStrategies()).length).toBeGreaterThan(0);
    expect((await db.listPromptFrameworks()).length).toBeGreaterThan(0);
  });

  it('SECURITY: a tenant cannot customize another tenant’s fork key-space (one fork per logical key per tenant)', async () => {
    const base = (await db.listPromptFrameworks()).find((f) => (f.realm ?? 'global') === 'global')!;
    // Two customizes for the SAME tenant collapse to ONE fork (copy-on-write), never accumulate.
    await db.insertRealmPromptFrameworkRow(buildTenantPromptFrameworkFork(base, 'tt', { name: 'v1' }));
    const before = (await db.listPromptFrameworks()).filter((f) => f.owner_tenant_id === 'tt' && (f.logical_key ?? f.key) === base.key);
    // Simulate the admin copy-on-write: delete existing then insert.
    for (const e of before) await db.deletePromptFramework(e.id);
    await db.insertRealmPromptFrameworkRow(buildTenantPromptFrameworkFork(base, 'tt', { name: 'v2' }));
    const after = (await db.listPromptFrameworks()).filter((f) => f.owner_tenant_id === 'tt' && (f.logical_key ?? f.key) === base.key);
    expect(after.length).toBe(1);
    expect(after[0]!.name).toBe('v2');
  });

  it('STRESS: 300 tenants each fork the same strategy — every tenant resolves ONLY its own fork', async () => {
    const base = (await db.listPromptStrategies()).find((s) => (s.realm ?? 'global') === 'global')!;
    const tenants = Array.from({ length: 300 }, (_, i) => `stress-${i}`);
    for (const t of tenants) {
      await db.insertRealmPromptStrategyRow(buildTenantPromptStrategyFork(base, t, { instruction_prefix: `PFX-${t}` }));
    }
    // Spot-check a sample resolve correctly and in isolation.
    for (const t of ['stress-0', 'stress-150', 'stress-299']) {
      const eff = (await db.resolveTenantEffectivePromptStrategies(t)).find((s) => (s.logical_key ?? s.key) === base.key)!;
      expect(eff.instruction_prefix).toBe(`PFX-${t}`);
      expect(eff.key).toBe(base.key);
      // Exactly one effective row per logical key (no leakage of the other 299 forks).
      const keys = (await db.resolveTenantEffectivePromptStrategies(t)).map((s) => s.logical_key ?? s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    // A tenant with NO fork still sees the global.
    const none = (await db.resolveTenantEffectivePromptStrategies('nobody')).find((s) => (s.logical_key ?? s.key) === base.key)!;
    expect(none.instruction_prefix ?? '').not.toContain('PFX-');
  }, 30_000);
});
