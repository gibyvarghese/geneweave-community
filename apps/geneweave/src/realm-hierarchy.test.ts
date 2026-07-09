// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm Phase 4 (app) — the tenant TREE drives resolution, end to end on a real booted SQLite
 * adapter. A parent org shares a prompt fork down its subtree and a child inherits it; a sibling branch
 * gets the global; blast radius is computed from the real tree; a fork is promoted to the global default.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createSqlTenantHierarchy } from '@weaveintel/identity';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import type { ChatSettings } from './chat-runtime.js';
import { resolveSystemPrompt } from './chat-system-prompt-utils.js';
import { buildTenantPromptFork } from './chat-realm-prompt.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';

const settingsFor = (systemPrompt: string): ChatSettings => ({ systemPrompt } as unknown as ChatSettings);

describe('Tenancy Realm Phase 4 — tenant-tree resolution, share, blast radius, promote', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: Awaited<ReturnType<DatabaseAdapter['getPrompt']>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-p4-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    const prompts = await db.listPrompts();
    base = prompts.find((p) => p.enabled && p.logical_key === 'assistant.general') ?? prompts.find((p) => p.enabled)!;

    // Build a real org tree in the tenants table:  acme → emea → uk;  acme → apac
    const org = createSqlTenantHierarchy({ client: sqliteSqlClient(raw()), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
    await org.create({ id: 'acme', name: 'Acme' });
    await org.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await org.create({ id: 'uk', name: 'UK', parentTenantId: 'emea' });
    await org.create({ id: 'apac', name: 'APAC', parentTenantId: 'acme' });
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('SUBTREE AT DEPTH: EMEA shares a fork; UK (a grandchild of acme) inherits it; APAC gets the global', async () => {
    // EMEA customizes the prompt and shares it to its whole subtree.
    const fork = buildTenantPromptFork(base!, 'emea', { template: 'You are a GDPR-aware EMEA assistant.', share_mode: 'subtree' });
    await db.insertRealmPromptRow(fork);

    // UK inherits EMEA's shared fork (UK has no fork of its own).
    const forUk = await resolveSystemPrompt(db, settingsFor(base!.name), 'uk');
    expect(forUk.content).toContain('EMEA assistant');
    expect(forUk.realm?.kind).toBe('inherited');

    // APAC is a different branch → the global default.
    const forApac = await resolveSystemPrompt(db, settingsFor(base!.name), 'apac');
    expect(forApac.content).not.toContain('EMEA assistant');
    expect(forApac.realm).toBeUndefined();

    // EMEA itself gets its own fork (own_override, not inherited).
    const forEmea = await resolveSystemPrompt(db, settingsFor(base!.name), 'emea');
    expect(forEmea.realm?.kind).toBe('own_override');
  });

  it('PRIVATE stays private: a parent’s un-shared fork is invisible to children', async () => {
    // acme forks privately (default share_mode). uk should NOT see it (it sees EMEA's subtree share instead,
    // but acme's private fork must never win over that or leak).
    const acmeFork = buildTenantPromptFork(base!, 'acme', { template: 'ACME PRIVATE' }); // private by default
    await db.insertRealmPromptRow(acmeFork);
    const forUk = await resolveSystemPrompt(db, settingsFor(base!.name), 'uk');
    expect(forUk.content).not.toContain('ACME PRIVATE'); // acme's private fork is invisible to uk
    expect(forUk.content).toContain('EMEA assistant');   // uk still inherits EMEA's subtree share
  });

  it('BLAST RADIUS: sharing EMEA’s fork to the subtree reaches UK', async () => {
    const rows = await db.listPrompts();
    const emeaFork = rows.find((r) => r.realm === 'tenant' && r.owner_tenant_id === 'emea')!;
    const radius = await db.promptShareBlastRadius(emeaFork.id, 'subtree');
    expect('error' in radius).toBe(false);
    if (!('error' in radius)) {
      expect(radius.inheriting).toContain('uk');
      expect(radius.shareMode).toBe('subtree');
    }
    // A share to 'children' only would NOT reach uk (uk is a grandchild of acme, but a child of emea →
    // actually uk IS a direct child of emea, so children reaches it). Check a non-fork prompt gives 404.
    const bad = await db.promptShareBlastRadius('not-a-real-id', 'subtree');
    expect('error' in bad).toBe(true);
  });

  it('PROMOTE: EMEA’s fork is promoted to the shared global; an unrelated tenant now gets it', async () => {
    const rows = await db.listPrompts();
    const emeaFork = rows.find((r) => r.realm === 'tenant' && r.owner_tenant_id === 'emea')!;
    const result = await db.promotePromptToGlobal(emeaFork.id);
    expect(result.ok).toBe(true);

    // A brand-new tenant with no fork now gets EMEA's (now global) content.
    const org = createSqlTenantHierarchy({ client: sqliteSqlClient(raw()), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
    await org.create({ id: 'globex', name: 'Globex' });
    const forGlobex = await resolveSystemPrompt(db, settingsFor(base!.name), 'globex');
    expect(forGlobex.content).toContain('EMEA assistant');
    expect(forGlobex.realm).toBeUndefined(); // it's the global now, not an override
  });
});
