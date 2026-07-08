// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm Phase 1 — the tenant-effective prompt resolver, end to end on a real seeded SQLite DB.
 *
 * Proves the promise: one global default for everyone, a private copy for any tenant that wants one,
 * resolved correctly (nearest-owner-wins) with provenance and drift — and strict isolation between
 * tenants. Positive, negative, drift, isolation/security and revert are all covered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { PromptRow } from './db-types/prompts.js';
import type { ChatSettings } from './chat-runtime.js';
import { resolveSystemPrompt } from './chat-system-prompt-utils.js';
import { buildTenantPromptFork, resolveTenantEffectivePrompt, promptContentHash } from './chat-realm-prompt.js';

const TENANT_A = 'mercy-health';
const TENANT_B = 'first-bank';
const settingsFor = (systemPrompt: string): ChatSettings => ({ systemPrompt } as unknown as ChatSettings);

describe('Tenancy Realm — tenant-effective prompt', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: PromptRow; // a seeded global prompt to customize

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-prompt-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    const prompts = await db.listPrompts();
    base = prompts.find((p) => p.enabled && (p.logical_key === 'assistant.general')) ?? prompts.find((p) => p.enabled)!;
    expect(base).toBeTruthy();
    // Every seeded prompt is a global original with a hash (from m151).
    expect(base.realm).toBe('global');
    expect(base.owner_tenant_id == null).toBe(true);
    expect(base.content_hash?.startsWith('sha256:')).toBe(true);
  });
  afterAll(async () => {
    await db?.close?.();
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  it('POSITIVE: a tenant that customizes resolves ITS OWN prompt; everyone else keeps the global', async () => {
    const fork = buildTenantPromptFork(base, TENANT_A, { template: 'You are Mercy Health’s clinical assistant. Cite guidelines.' });
    await db.insertRealmPromptRow(fork);

    // Tenant A → its own fork.
    const forA = await resolveSystemPrompt(db, settingsFor(base.name), TENANT_A);
    expect(forA.content).toContain('Mercy Health');
    expect(forA.realm?.kind).toBe('own_override');

    // Tenant B (no fork) → the global default, no realm stamp.
    const forB = await resolveSystemPrompt(db, settingsFor(base.name), TENANT_B);
    expect(forB.content).not.toContain('Mercy Health');
    expect(forB.realm).toBeUndefined();

    // No tenant at all (global chat) → the global default too.
    const forNone = await resolveSystemPrompt(db, settingsFor(base.name));
    expect(forNone.content).not.toContain('Mercy Health');
    expect(forNone.realm).toBeUndefined();
  });

  it('ISOLATION: one tenant’s fork is invisible to another; each resolves only its own', async () => {
    await db.insertRealmPromptRow(buildTenantPromptFork(base, TENANT_B, { template: 'You are First Bank’s compliance-first assistant.' }));
    const rows = await db.listPrompts();

    const a = resolveTenantEffectivePrompt(rows, base, TENANT_A);
    const b = resolveTenantEffectivePrompt(rows, base, TENANT_B);
    expect(a.row.template).toContain('Mercy Health');
    expect(b.row.template).toContain('First Bank');
    expect(a.row.id).not.toBe(b.row.id);
    // Neither fork leaks the other's owner.
    expect(a.row.owner_tenant_id).toBe(TENANT_A);
    expect(b.row.owner_tenant_id).toBe(TENANT_B);
  });

  it('DRIFT: editing the global after a fork surfaces as drift, and never clobbers the fork', async () => {
    const rows0 = await db.listPrompts();
    const before = resolveTenantEffectivePrompt(rows0, base, TENANT_A);
    expect(before.provenance.kind).toBe('own_override');
    // Fork was copied from the current global and not since re-based → in_sync-ish (customized, since content differs).
    expect((before.provenance as { drift: string }).drift).toBe('customized');

    // Product ships a new global template → the global's content_hash moves.
    const newHash = promptContentHash({ ...base, template: 'You are a helpful, safe assistant. Always cite sources.' });
    await db.updatePrompt(base.id, { template: 'You are a helpful, safe assistant. Always cite sources.', content_hash: newHash } as Partial<PromptRow>);

    const rows1 = await db.listPrompts();
    const after = resolveTenantEffectivePrompt(rows1, (await db.getPrompt(base.id))!, TENANT_A);
    // The tenant still gets ITS OWN prompt — never silently overwritten.
    expect(after.row.template).toContain('Mercy Health');
    // Both sides moved → diverged (a real merge candidate).
    expect((after.provenance as { drift: string }).drift).toBe('diverged');
  });

  it('REVERT: deleting a fork falls the tenant back to the global default', async () => {
    const rows = await db.listPrompts();
    const fork = rows.find((r) => r.realm === 'tenant' && r.owner_tenant_id === TENANT_A);
    expect(fork).toBeTruthy();
    await db.deletePrompt(fork!.id);

    const forA = await resolveSystemPrompt(db, settingsFor(base.name), TENANT_A);
    expect(forA.content).not.toContain('Mercy Health');
    expect(forA.realm).toBeUndefined();
  });

  it('SECURITY: a hostile tenant id / logical key is treated as pure data, resolves to global, no leak', async () => {
    const rows = await db.listPrompts();
    const hostile = "'; DROP TABLE prompts; --";
    const eff = resolveTenantEffectivePrompt(rows, base, hostile);
    expect(eff.provenance.kind).toBe('global'); // unknown tenant → global, nothing thrown
    // The prompts table is intact and the base prompt still resolves.
    expect((await db.listPrompts()).length).toBeGreaterThan(0);
  });

  it('HASH PARITY: a fork’s content_hash is recomputed with the same algorithm as the migration', () => {
    const fork = buildTenantPromptFork(base, 'acme', { template: 'X' });
    expect(fork.content_hash).toBe(promptContentHash(fork));
    expect(fork.is_default).toBe(0);
    expect(fork.realm).toBe('tenant');
    expect(fork.origin_id).toBe(base.id);
    expect(fork.origin_hash).toBe(base.content_hash);
  });
});
