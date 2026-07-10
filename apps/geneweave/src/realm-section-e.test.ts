// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — Section E (drift extras), end to end on a real booted SQLite adapter.
 *
 *   E18 Diff/merge workbench   a `diverged` record gets a real three-way merge (BASE/LOCAL/REMOTE),
 *                              field by field, refusing to guess at conflicts. Plus a drift report
 *                              generalised from prompts-only to every realm family and tenant forks.
 *   E19 Version tables         `prompt_versions` (authoring) vs `realm_versions` (published defaults)
 *                              are separate concerns — pinned here so the decision can't silently rot.
 *   E20 Guardrail posture      the brittle "seed only when the table is empty" gate is gone; posture is
 *                              a per-tenant state overlay that can only SUBTRACT, never re-enable, and
 *                              never disables a safety control.
 *
 * Positive / negative / security / stress throughout.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createSqlTenantHierarchy } from '@weaveintel/identity';
import { createSqlVersionLog } from '@weaveintel/realm';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { newUUIDv7 } from './lib/uuid.js';
import { realmContentHash } from './migrations/m151-realm-columns.js';
import { realmFamily, REALM_FAMILIES } from './realm-families.js';
import {
  loadThreeWayDiff, applyRealmMerge, autoMerge, threeWayFieldDiff, realmDriftReport,
  versionPayloadByHash, semanticOfRow, type ThreeWayDiff,
} from './realm-diff.js';
import {
  applyLeanGuardrailProfile, clearGuardrailProfile, LEAN_DISABLED_TYPES, LEAN_PROTECTED_TYPES,
} from './realm-guardrail-profile.js';
import { buildTenantPromptFork } from './chat-realm-prompt.js';
import type { PromptRow } from './db-types/prompts.js';

const HOSTILE = "'; DROP TABLE realm_versions; --";

/** The semantic payload of a prompt, matching PROMPT_SEMANTIC_COLS exactly. */
const promptPayload = (o: Partial<Record<string, unknown>> = {}) => ({
  name: 'n', description: 'd', category: 'c', template: 'T',
  variables: null, model_compatibility: null, execution_defaults: null, framework: null, ...o,
});

describe('Tenancy Realm — Section E (drift extras)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d;
  const client = () => sqliteSqlClient(raw());
  const log = () => createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });

  /** Create a global prompt with a published BASE version, returning its id + logical key. */
  async function seedGlobal(templ: string, extra: Record<string, unknown> = {}): Promise<{ id: string; key: string; base: Record<string, unknown> }> {
    const id = newUUIDv7();
    const key = `e18.${id.slice(-8)}`;
    const base = promptPayload({ name: key, template: templ, ...extra });
    await db.createPrompt({
      id, key, name: key, description: base['description'] as string, category: base['category'] as string,
      prompt_type: 'template', owner: null, status: 'published', tags: null, template: templ, variables: null,
      version: '1', model_compatibility: null, execution_defaults: null, framework: null, metadata: null,
      is_default: 0, enabled: 1,
    } as never);
    const h = realmContentHash(base);
    raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash=?, origin_hash=? WHERE id=?`).run(key, h, h, id);
    await log().append({ family: 'prompts', logicalKey: key, payload: base, note: 'baseline' });
    return { id, key, base };
  }

  /** Edit a global row's semantic fields in place (an "operator edit"), rehashing LOCAL. */
  function editLocal(id: string, base: Record<string, unknown>, patch: Record<string, unknown>): void {
    const merged = { ...base, ...patch };
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    raw().prepare(`UPDATE prompts SET ${sets}, content_hash = ? WHERE id = ?`).run(...Object.values(patch), realmContentHash(merged), id);
  }

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-section-e-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    const org = createSqlTenantHierarchy({ client: client(), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
    await org.create({ id: 'acme', name: 'Acme' });
    await org.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  // ═════════════════════════ E18 — three-way merge ═════════════════════════
  describe('E18 — three-way diff/merge of a diverged record', () => {
    let g: Awaited<ReturnType<typeof seedGlobal>>;

    beforeEach(async () => {
      g = await seedGlobal('BASE TEMPLATE');
    });

    it('POSITIVE: local-only, remote-only, both-same and conflict are each classified correctly', async () => {
      // upstream changes template + description; operator changes description (differently) + category
      await log().append({ family: 'prompts', logicalKey: g.key, payload: { ...g.base, template: 'UPSTREAM', description: 'up-desc' } });
      editLocal(g.id, g.base, { description: 'op-desc', category: 'op-cat' });

      const diff = await db.realmDiff('prompts', g.id) as ThreeWayDiff;
      expect(diff.drift).toBe('diverged');
      expect(diff.baseAvailable).toBe(true);

      const byField = new Map(diff.fields.map((f) => [f.field, f]));
      expect(byField.get('template')!.status).toBe('remote_only');   // only upstream moved → adopt theirs
      expect(byField.get('category')!.status).toBe('local_only');    // only operator moved → keep ours
      expect(byField.get('description')!.status).toBe('conflict');   // both moved, differently
      expect(byField.get('name')!.status).toBe('unchanged');
      expect(diff.conflicts).toEqual(['description']);
    });

    it('POSITIVE: both sides making the SAME edit is not a conflict', async () => {
      await log().append({ family: 'prompts', logicalKey: g.key, payload: { ...g.base, template: 'SAME NEW' } });
      editLocal(g.id, g.base, { template: 'SAME NEW' });
      const diff = await db.realmDiff('prompts', g.id) as ThreeWayDiff;
      const t = diff.fields.find((f) => f.field === 'template')!;
      expect(t.status).toBe('both_same');
      expect(diff.conflicts).toEqual([]);
    });

    it('POSITIVE: auto-merge takes theirs for remote-only and ours for local-only', async () => {
      await log().append({ family: 'prompts', logicalKey: g.key, payload: { ...g.base, template: 'UPSTREAM' } });
      editLocal(g.id, g.base, { category: 'op-cat' });
      const diff = await db.realmDiff('prompts', g.id) as ThreeWayDiff;
      const { merged, conflicts } = autoMerge(diff);
      expect(conflicts).toEqual([]);
      expect(merged['template']).toBe('UPSTREAM');
      expect(merged['category']).toBe('op-cat');
    });

    it('NEGATIVE: a merge is REFUSED while any conflict is unresolved — never a silent pick', async () => {
      await log().append({ family: 'prompts', logicalKey: g.key, payload: { ...g.base, description: 'up-desc' } });
      editLocal(g.id, g.base, { description: 'op-desc' });
      const refused = await db.realmMerge('prompts', g.id, {});
      expect(refused.ok).toBe(false);
      expect(refused.reason).toMatch(/unresolved conflicts: description/);
      // the row is untouched
      expect((await db.listPrompts()).find((p) => p.id === g.id)!.description).toBe('op-desc');
    });

    it('POSITIVE: resolving the conflict applies the merge and re-baselines (never stays diverged)', async () => {
      await log().append({ family: 'prompts', logicalKey: g.key, payload: { ...g.base, template: 'UPSTREAM', description: 'up-desc' } });
      editLocal(g.id, g.base, { description: 'op-desc', category: 'op-cat' });

      const applied = await db.realmMerge('prompts', g.id, { description: 'MERGED' });
      expect(applied.ok).toBe(true);
      expect(applied.drift).toBe('customized'); // kept our category → customized, not diverged

      const row = (await db.listPrompts()).find((p) => p.id === g.id)!;
      expect(row.template).toBe('UPSTREAM');            // adopted
      expect(row.description).toBe('MERGED');           // human choice
      expect((row as unknown as Record<string, unknown>)['category']).toBe('op-cat'); // kept

      const post = await db.realmDiff('prompts', g.id) as ThreeWayDiff;
      expect(post.drift).not.toBe('diverged');
      expect(post.conflicts).toEqual([]);
    });

    it('POSITIVE: a merge that exactly equals upstream settles to in_sync', async () => {
      await log().append({ family: 'prompts', logicalKey: g.key, payload: { ...g.base, template: 'UPSTREAM', description: 'up-desc' } });
      editLocal(g.id, g.base, { description: 'op-desc' });
      const applied = await db.realmMerge('prompts', g.id, { description: 'up-desc' });
      expect(applied.ok).toBe(true);
      expect(applied.drift).toBe('in_sync');
    });

    it('DEGRADED: with no published BASE, every difference is a conflict (we refuse to guess who moved)', async () => {
      const id = newUUIDv7();
      const key = `nobase.${id.slice(-6)}`;
      await db.createPrompt({
        id, key, name: key, description: 'd', category: 'c', prompt_type: 'template', owner: null, status: 'published',
        tags: null, template: 'LOCAL', variables: null, version: '1', model_compatibility: null,
        execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      } as never);
      // an origin_hash that was NEVER published → BASE unrecoverable
      raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash='sha256:local', origin_hash='sha256:never-published' WHERE id=?`).run(key, id);
      await log().append({ family: 'prompts', logicalKey: key, payload: promptPayload({ name: key, template: 'REMOTE' }) });

      const diff = await db.realmDiff('prompts', id) as ThreeWayDiff;
      expect(diff.baseAvailable).toBe(false);
      expect(diff.conflicts).toContain('template');            // differs → conflict, not a guess
      expect(diff.fields.find((f) => f.field === 'name')!.status).toBe('unchanged'); // identical → fine
    });

    it('NEGATIVE: a record with no upstream at all cannot be merged', async () => {
      const id = newUUIDv7();
      const key = `noremote.${id.slice(-6)}`;
      await db.createPrompt({
        id, key, name: key, description: 'd', category: 'c', prompt_type: 'template', owner: null, status: 'published',
        tags: null, template: 'X', variables: null, version: '1', model_compatibility: null,
        execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      } as never);
      raw().prepare(`UPDATE prompts SET realm='global', logical_key=? WHERE id=?`).run(key, id);
      const res = await db.realmMerge('prompts', id, {});
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/nothing to merge against/);
    });

    it('NEGATIVE: an unknown record id is a clean 404-shaped error', async () => {
      expect(await db.realmDiff('prompts', 'ghost')).toEqual({ error: 'not found' });
      expect((await db.realmMerge('prompts', 'ghost', {})).reason).toBe('not found');
    });

    it('FORK: a tenant fork diffs against the global it forked from, not the version log', async () => {
      const base = (await db.listPrompts()).find((p) => p.id === g.id)!;
      await db.insertRealmPromptRow(buildTenantPromptFork(base as PromptRow, 'emea', { template: 'EMEA EDIT' }));
      const fork = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'emea' && (p.logical_key ?? p.key) === g.key)!;

      // The global moves on (operator edit) → the fork is now stale/diverged relative to its origin.
      editLocal(g.id, g.base, { template: 'GLOBAL MOVED' });
      const diff = await db.realmDiff('prompts', fork.id) as ThreeWayDiff;
      const t = diff.fields.find((f) => f.field === 'template')!;
      expect(t.remote).toBe('GLOBAL MOVED'); // REMOTE = the origin row, not the published version
      expect(t.local).toBe('EMEA EDIT');
      expect(t.status).toBe('conflict');     // both moved off base
      expect(diff.drift).toBe('diverged');
    });

    it('FORK MERGE: merging a fork writes only semantic columns and keeps realm / owner / origin', async () => {
      const base = (await db.listPrompts()).find((p) => p.id === g.id)!;
      await db.insertRealmPromptRow(buildTenantPromptFork(base as PromptRow, 'acme', { template: 'FORK EDIT', description: 'fork-desc' }));
      const fork = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'acme' && (p.logical_key ?? p.key) === g.key)!;

      // the global moves on → the fork diverges from its origin
      editLocal(g.id, g.base, { template: 'GLOBAL MOVED', category: 'gcat' });
      const d = await db.realmDiff('prompts', fork.id) as ThreeWayDiff;
      expect(d.drift).toBe('diverged');
      expect(d.conflicts).toEqual(['template']);      // both moved template, differently
      expect(d.realm).toBe('tenant');
      expect(d.ownerTenantId).toBe('acme');

      const m = await db.realmMerge('prompts', fork.id, { template: 'RESOLVED' });
      expect(m.ok).toBe(true);
      expect(m.drift).toBe('customized');

      const after = (await db.listPrompts()).find((p) => p.id === fork.id)! as unknown as Record<string, unknown>;
      expect(after['template']).toBe('RESOLVED');
      expect(after['description']).toBe('fork-desc');  // local_only, kept
      expect(after['category']).toBe('gcat');          // remote_only, adopted
      expect(after['realm']).toBe('tenant');           // identity untouched
      expect(after['owner_tenant_id']).toBe('acme');
      expect(after['origin_id']).toBe(g.id);
      expect(((await db.realmDiff('prompts', fork.id)) as ThreeWayDiff).drift).not.toBe('diverged');
    });

    it('AUTHZ SHAPE: the diff carries realm + ownerTenantId so callers authorize without a table scan', async () => {
      const globalDiff = await db.realmDiff('prompts', g.id) as ThreeWayDiff;
      expect(globalDiff.realm).toBe('global');
      expect(globalDiff.ownerTenantId).toBeNull(); // a global default belongs to nobody → platform-admin only
    });

    it('SECURITY: a hostile family throws; a hostile id/hash is bound, not interpolated', async () => {
      await expect(db.realmDiff(HOSTILE, g.id)).rejects.toThrow(/unknown realm family/);
      await expect(db.realmMerge('prompts; DROP TABLE prompts', g.id, {})).rejects.toThrow(/unknown realm family/);
      expect(await versionPayloadByHash(client(), 'sqlite', 'prompts', g.key, HOSTILE)).toBeNull();
      expect(await db.realmDiff('prompts', HOSTILE)).toEqual({ error: 'not found' });
      expect((await db.listPrompts()).length).toBeGreaterThan(0); // tables intact
    });

    it('SECURITY: a merge cannot inject fields outside the family’s semantic columns', async () => {
      await log().append({ family: 'prompts', logicalKey: g.key, payload: { ...g.base, template: 'UPSTREAM' } });
      // `enabled` and `id` are NOT semantic columns — a resolved payload must not be able to set them
      const res = await db.realmMerge('prompts', g.id, { enabled: 0, id: 'hijacked', template: 'MINE' });
      expect(res.ok).toBe(true);
      const row = (await db.listPrompts()).find((p) => p.id === g.id)!;
      expect(row.id).toBe(g.id);        // identity untouched
      expect(row.enabled).toBe(1);      // disposition untouched
      expect(row.template).toBe('MINE'); // only semantic columns written
    });

    it('PURE: threeWayFieldDiff is deterministic and order/JSON-shape insensitive', () => {
      const spec = realmFamily('prompts');
      const b = promptPayload({ variables: { b: 1, a: 2 } });
      const l = promptPayload({ variables: { a: 2, b: 1 } }); // same content, different key order
      const r = promptPayload({ variables: { a: 2, b: 1 } });
      const { conflicts, fields } = threeWayFieldDiff(spec, b, l, r);
      expect(conflicts).toEqual([]);
      expect(fields.find((f) => f.field === 'variables')!.status).toBe('unchanged');
    });

    it('STRESS: 300 diverged records each diff + merge cleanly', async () => {
      const ids: Array<{ id: string; key: string; base: Record<string, unknown> }> = [];
      for (let i = 0; i < 300; i++) ids.push(await seedGlobal(`T${i}`));
      for (const s of ids) {
        await log().append({ family: 'prompts', logicalKey: s.key, payload: { ...s.base, template: 'UP', description: 'up' } });
        editLocal(s.id, s.base, { description: 'op' });
      }
      let merged = 0;
      for (const s of ids) {
        const d = await db.realmDiff('prompts', s.id) as ThreeWayDiff;
        expect(d.drift).toBe('diverged');
        const r = await db.realmMerge('prompts', s.id, { description: 'resolved' });
        if (r.ok) merged++;
      }
      expect(merged).toBe(300);
      for (const s of ids.slice(0, 5)) {
        expect(((await db.realmDiff('prompts', s.id)) as ThreeWayDiff).drift).not.toBe('diverged');
      }
    }, 120_000);
  });

  // ═════════════════════════ E18 — generalized drift report ═════════════════════════
  describe('E18 — drift report across families and tenants', () => {
    it('POSITIVE: reports every family, not just prompts', async () => {
      for (const family of Object.keys(REALM_FAMILIES)) {
        const rep = await db.realmDriftReport(family);
        expect(rep.family).toBe(family);
        expect(Array.isArray(rep.entries)).toBe(true);
      }
    });

    it('POSITIVE: a tenant filter returns only that tenant’s forks', async () => {
      const g = await seedGlobal('DR BASE');
      const base = (await db.listPrompts()).find((p) => p.id === g.id)!;
      await db.insertRealmPromptRow(buildTenantPromptFork(base as PromptRow, 'acme', { template: 'ACME' }));

      const acme = await db.realmDriftReport('prompts', { tenantId: 'acme' });
      expect(acme.entries.length).toBeGreaterThan(0);
      expect(acme.entries.every((e) => e.realm === 'tenant' && e.ownerTenantId === 'acme')).toBe(true);

      const other = await db.realmDriftReport('prompts', { tenantId: 'emea' });
      expect(other.entries.every((e) => e.ownerTenantId === 'emea')).toBe(true);
      expect(other.entries.some((e) => e.id === acme.entries[0]!.id)).toBe(false); // no cross-tenant leak
    });

    it('POSITIVE: summary counts sum to the number of entries', async () => {
      const rep = await db.realmDriftReport('prompts');
      const total = Object.values(rep.summary).reduce((a, b) => a + b, 0);
      expect(total).toBe(rep.entries.length);
    });

    it('SECURITY: a hostile family throws; a hostile tenant id yields nothing', async () => {
      await expect(db.realmDriftReport(HOSTILE)).rejects.toThrow(/unknown realm family/);
      expect((await db.realmDriftReport('prompts', { tenantId: HOSTILE })).entries).toEqual([]);
    });
  });

  // ═════════════════════════ E19 — the two version tables ═════════════════════════
  describe('E19 — prompt_versions (authoring) vs realm_versions (published defaults)', () => {
    it('they are different tables with different keys and different purposes', () => {
      const cols = (t: string) => (raw().prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      const pv = cols('prompt_versions');
      const rv = cols('realm_versions');

      // prompt_versions: per-prompt authoring revisions. No hash, no realm identity.
      expect(pv).toContain('prompt_id');
      expect(pv).toContain('is_active');
      expect(pv).not.toContain('content_hash');
      expect(pv).not.toContain('logical_key');
      expect(pv).not.toContain('family');

      // realm_versions: cross-family published-default baselines, content-addressed.
      expect(rv).toEqual(expect.arrayContaining(['family', 'logical_key', 'version', 'content_hash', 'payload']));
      expect(rv).not.toContain('prompt_id');
    });

    it('drift is computed only from realm_versions + the live row — prompt_versions is never consulted', async () => {
      const g = await seedGlobal('DRIFT SRC');
      // Adding an authoring version must not perturb drift at all.
      const before = await db.realmDiff('prompts', g.id) as ThreeWayDiff;
      await db.createPromptVersion({
        id: newUUIDv7(), prompt_id: g.id, version: '2.0.0', status: 'published', template: 'A DIFFERENT TEMPLATE',
        variables: null, model_compatibility: null, execution_defaults: null, framework: null, metadata: null,
        is_active: 1, enabled: 1,
      } as never);
      const after = await db.realmDiff('prompts', g.id) as ThreeWayDiff;
      expect(after.drift).toBe(before.drift);
      expect(after.hashes).toEqual(before.hashes);
      expect((await db.listPromptVersions(g.id)).length).toBeGreaterThan(0); // the authoring row does exist
    });
  });

  // ═════════════════════════ E20 — guardrail posture ═════════════════════════
  describe('E20 — guardrail posture is a per-tenant overlay, not a seeding accident', () => {
    it('POSITIVE: the base guardrail set is installed even though migrations pre-seed the table', async () => {
      // The old `cnt('guardrails') === 0` gate would have skipped these entirely, because m30/m31/m71
      // seed guardrails BEFORE seedDefaultData runs — the table is never empty on a real boot.
      const names = (await db.listGuardrails()).map((g) => g.name);
      for (const n of ['PII Redaction', 'Toxicity Filter', 'Token Budget', 'Hallucination Check']) {
        expect(names, `base guardrail '${n}' must be seeded`).toContain(n);
      }
    });

    it('IDEMPOTENT: re-running the seed does not duplicate guardrails', async () => {
      const before = (await db.listGuardrails()).length;
      await db.seedDefaultData?.();
      expect((await db.listGuardrails()).length).toBe(before);
    });

    it('POSITIVE: the lean profile disables the model-graded checks and reports the protected ones', async () => {
      const res = await applyLeanGuardrailProfile(db, 'acme');
      expect(res.disabled.length).toBeGreaterThan(0);
      expect(res.protected.length).toBeGreaterThan(0);

      const rows = await db.resolveTenantEffectiveGuardrails('acme');
      const states = await db.resolveRealmStates('guardrails', 'acme', rows.map((r) => r.logical_key ?? r.name));
      for (const r of rows) {
        const active = states.get(r.logical_key ?? r.name)?.active !== false;
        if (LEAN_DISABLED_TYPES.includes(r.type) && !LEAN_PROTECTED_TYPES.includes(r.type)) {
          expect(active, `${r.name} (${r.type}) should be disabled by the lean profile`).toBe(false);
        }
      }
    });

    it('SECURITY: the lean profile NEVER disables a safety control', async () => {
      await applyLeanGuardrailProfile(db, 'acme');
      const rows = await db.resolveTenantEffectiveGuardrails('acme');
      const states = await db.resolveRealmStates('guardrails', 'acme', rows.map((r) => r.logical_key ?? r.name));
      const safety = rows.filter((r) => LEAN_PROTECTED_TYPES.includes(r.type));
      expect(safety.length).toBeGreaterThan(0);
      for (const r of safety) {
        expect(states.get(r.logical_key ?? r.name)?.active !== false, `${r.name} (${r.type}) is a safety control`).toBe(true);
      }
      // PII redaction and injection defence specifically survive a lean posture
      const byName = new Map(rows.map((r) => [r.name, r]));
      for (const n of ['PII Redaction', 'Prompt Injection: Prompt Exfiltration']) {
        const r = byName.get(n);
        if (r) expect(states.get(r.logical_key ?? r.name)?.active !== false, `${n} must stay on`).toBe(true);
      }
    });

    it('SECURITY: an overlay can only SUBTRACT — it cannot re-enable a globally disabled guardrail', async () => {
      const target = (await db.listGuardrails()).find((g) => g.type === 'cognitive_check')!;
      await db.updateGuardrail(target.id, { enabled: 0 });               // platform switches it off
      await db.setRealmState('guardrails', target.logical_key ?? target.name, 'emea', { enabled: true }); // tenant tries to switch it on

      const rows = await db.resolveTenantEffectiveGuardrails('emea');
      const row = rows.find((r) => r.id === target.id)!;
      expect(row.enabled).toBe(0);
      // the runtime filter is `r.enabled && overlay.active !== false` — the base column still wins
      const states = await db.resolveRealmStates('guardrails', 'emea', [row.logical_key ?? row.name]);
      const wouldRun = Boolean(row.enabled) && states.get(row.logical_key ?? row.name)?.active !== false;
      expect(wouldRun, 'a tenant overlay must never resurrect a globally disabled guardrail').toBe(false);
      await db.updateGuardrail(target.id, { enabled: 1 }); // restore
    });

    it('ISOLATION: one tenant’s lean posture does not affect another tenant', async () => {
      await applyLeanGuardrailProfile(db, 'acme');
      const emeaStates = await db.listRealmStates('guardrails', 'emea');
      const acmeStates = await db.listRealmStates('guardrails', 'acme');
      expect(acmeStates.length).toBeGreaterThan(0);
      expect(emeaStates.filter((s) => s.enabled === false).length).toBe(0);
    });

    it('REVERT: clearing the profile restores the shared posture', async () => {
      await applyLeanGuardrailProfile(db, 'acme');
      expect((await db.listRealmStates('guardrails', 'acme')).length).toBeGreaterThan(0);
      const cleared = await clearGuardrailProfile(db, 'acme');
      expect(cleared.cleared.length).toBeGreaterThan(0);
      expect((await db.listRealmStates('guardrails', 'acme')).length).toBe(0);
    });

    it('IDEMPOTENT + STRESS: applying the lean profile to 100 tenants is stable and re-appliable', async () => {
      const org = createSqlTenantHierarchy({ client: client(), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
      const tenants: string[] = [];
      for (let i = 0; i < 100; i++) { const t = `lean-${i}`; await org.create({ id: t, name: t }); tenants.push(t); }

      const first = await Promise.all(tenants.map((t) => applyLeanGuardrailProfile(db, t)));
      const again = await Promise.all(tenants.map((t) => applyLeanGuardrailProfile(db, t)));
      for (let i = 0; i < tenants.length; i++) {
        expect(again[i]!.disabled.sort()).toEqual(first[i]!.disabled.sort()); // idempotent
        expect((await db.listRealmStates('guardrails', tenants[i]!)).length).toBe(first[i]!.disabled.length);
      }
    }, 120_000);

    it('NULL TENANT: no tenant → no overlay is consulted (globals resolve unchanged)', async () => {
      const rows = await db.resolveTenantEffectiveGuardrails(null);
      expect(rows.every((r) => (r.realm ?? 'global') === 'global')).toBe(true);
      expect((await db.resolveRealmStates('guardrails', null, ['anything'])).size).toBe(0);
    });
  });

  // ═════════════════════════ pure helpers ═════════════════════════
  describe('helpers', () => {
    it('semanticOfRow projects exactly the family’s semantic columns', async () => {
      const g = await seedGlobal('PROJ');
      const row = (await db.listPrompts()).find((p) => p.id === g.id)! as unknown as Record<string, unknown>;
      const proj = semanticOfRow(realmFamily('prompts'), row);
      expect(Object.keys(proj).sort()).toEqual([...realmFamily('prompts').semanticCols].sort());
      expect(proj['id']).toBeUndefined();
      expect(proj['enabled']).toBeUndefined();
    });

    it('versionPayloadByHash returns the exact forked-from payload, or null when never published', async () => {
      const g = await seedGlobal('BYHASH');
      const found = await versionPayloadByHash(client(), 'sqlite', 'prompts', g.key, realmContentHash(g.base));
      expect(found).toEqual(g.base);
      expect(await versionPayloadByHash(client(), 'sqlite', 'prompts', g.key, 'sha256:nope')).toBeNull();
      expect(await versionPayloadByHash(client(), 'sqlite', 'prompts', g.key, null)).toBeNull();
    });
  });
});
