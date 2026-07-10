// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm (B8) — fleet-wide run-trace provenance. resolveSystemPrompt returns a `realm`
 * provenance object saying WHICH tenant's prompt fork produced the system prompt for a run; the chat
 * handlers stamp it into messages.metadata + the trace root span. This suite proves the provenance is
 * computed correctly (own_override for a tenant's fork, undefined for the plain global) so the stamp is
 * meaningful. Positive / negative / security.
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
import { buildTenantPromptFork } from './chat-realm-prompt.js';

const A = 'acme-clinic';
const B = 'globex-bank';
const settingsFor = (id: string) => ({ systemPrompt: id } as unknown as ChatSettings);

describe('Tenancy Realm (B8) — run-trace realm provenance', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let base: PromptRow;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-provenance-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    base = (await db.listPrompts()).find((p) => p.enabled && (p.realm ?? 'global') === 'global' && !!p.template)!;
    expect(base, 'a seeded global prompt exists').toBeTruthy();
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: the plain global default carries NO realm provenance (stamp omitted)', async () => {
    const resolved = await resolveSystemPrompt(db, settingsFor(base.id), null);
    expect(resolved.content).toBeDefined();
    expect(resolved.realm).toBeUndefined(); // global → nothing to stamp
  });

  it('POSITIVE: a tenant’s own fork wins and is stamped as own_override with the fork’s content', async () => {
    await db.insertRealmPromptRow(buildTenantPromptFork(base, A, { template: 'ACME SYSTEM PROMPT {{topic}}' }));
    const resolved = await resolveSystemPrompt(db, settingsFor(base.id), A);
    expect(resolved.realm).toBeDefined();
    expect(resolved.realm!.kind).toBe('own_override');
    expect((resolved.realm as { ownerTenantId: string }).ownerTenantId).toBe(A);
    expect(resolved.content).toContain('ACME SYSTEM PROMPT'); // the fork's template rendered
  });

  it('ISOLATION: a different tenant with no fork gets the global (no provenance)', async () => {
    const resolved = await resolveSystemPrompt(db, settingsFor(base.id), B);
    expect(resolved.realm).toBeUndefined();
    expect(resolved.content).not.toContain('ACME SYSTEM PROMPT');
  });

  it('SECURITY: a hostile tenant id resolves to the global, no throw, no leak of another tenant’s fork', async () => {
    const resolved = await resolveSystemPrompt(db, settingsFor(base.id), "'; DROP TABLE prompts; --");
    expect(resolved.content).not.toContain('ACME SYSTEM PROMPT');
    expect(resolved.realm).toBeUndefined();
    expect((await db.listPrompts()).length).toBeGreaterThan(0); // table intact
  });

  it('STAMP SHAPE: the provenance object is a small JSON-serialisable discriminated union', async () => {
    const resolved = await resolveSystemPrompt(db, settingsFor(base.id), A);
    const json = JSON.stringify(resolved.realm);
    const parsed = JSON.parse(json) as { kind: string; ownerTenantId?: string };
    expect(['own_override', 'native', 'inherited']).toContain(parsed.kind);
    expect(json.length).toBeLessThan(300); // tiny — safe to embed in every run's metadata
  });
});
