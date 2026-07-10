// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — Section D (write path & governance), end to end on a real booted SQLite adapter over
 * a real org tree (acme → emea → uk; acme → apac).
 *
 *   D12 ProposeToRealm      propose → pending queue → platform-admin approve (promotes) / reject
 *   D13 RevertToInherited   prompt_fragments finally gets the fork stack every other family has
 *   D14 pinnedVersion       a pin now actually SERVES the pinned historical content
 *   D15 Deprecation         a retired default keeps resolving but can gain no new forks
 *   D16 Reparent            moving a tenant reports whose inherited config moved; cycle-safe
 *   D17 Key collision       "visible key ⇒ Customize it, never create a twin"
 *
 * Positive / negative / security / stress for each, plus the generic promote that D12 rides on.
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
import { buildTenantPromptFork } from './chat-realm-prompt.js';
import { buildTenantPromptFragmentFork, fragmentContentHash } from './prompt-fragment-realm.js';
import { resolveSystemPrompt } from './chat-system-prompt-utils.js';
import { newUUIDv7 } from './lib/uuid.js';
import {
  promoteRealmForkToGlobal, proposeRealmFork, listRealmProposals, approveRealmProposal, rejectRealmProposal,
  deprecateRealmRecord, undeprecateRealmRecord, assertCustomizable, isDeprecated,
  checkVisibleKeyCollision, reparentTenant,
} from './realm-governance.js';
import { realmFamily, isRealmFamily, REALM_FAMILIES, logicalKeyOfRow } from './realm-families.js';
import type { PromptRow, PromptFragmentRow } from './db-types/prompts.js';
import type { ChatSettings } from './chat-runtime.js';

const HOSTILE = "'; DROP TABLE realm_proposals; --";

describe('Tenancy Realm — Section D (write path & governance)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d;
  const client = () => sqliteSqlClient(raw());
  const globalPrompts = async () => (await db.listPrompts()).filter((p) => (p.realm ?? 'global') === 'global');
  /** The fork a tenant owns FOR A SPECIFIC logical key — never "the first fork this tenant has". */
  const forkOf = async (tenant: string, logicalKey: string): Promise<PromptRow> =>
    (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === tenant && (p.logical_key ?? p.key) === logicalKey)!;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-section-d-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    const org = createSqlTenantHierarchy({ client: client(), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
    await org.create({ id: 'acme', name: 'Acme' });
    await org.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await org.create({ id: 'uk', name: 'UK', parentTenantId: 'emea' });
    await org.create({ id: 'apac', name: 'APAC', parentTenantId: 'acme' });
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  // ═══════════════════════ family registry ═══════════════════════
  describe('family registry', () => {
    it('POSITIVE: every family names a real table and non-empty semantic columns', () => {
      for (const [name, spec] of Object.entries(REALM_FAMILIES)) {
        expect(spec.family).toBe(name);
        expect(spec.table).toBeTruthy();
        expect(spec.semanticCols.length).toBeGreaterThan(0);
        // identity + disposition never belong in the content hash
        expect(spec.semanticCols).not.toContain('enabled');
        expect(spec.semanticCols).not.toContain('id');
      }
    });

    it('CORRECTNESS: fragments hash `content`, not `template` (they have no template column)', () => {
      expect(realmFamily('prompt_fragments').semanticCols).toContain('content');
      expect(realmFamily('prompt_fragments').semanticCols).not.toContain('template');
      expect(realmFamily('prompts').semanticCols).toContain('template');
    });

    it('SECURITY: inherited Object.prototype keys are not families (no prototype-chain lookup)', () => {
      for (const evil of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
        expect(isRealmFamily(evil)).toBe(false);
        expect(() => realmFamily(evil)).toThrow(/unknown realm family/);
      }
      expect(() => realmFamily(HOSTILE)).toThrow(/unknown realm family/);
    });

    it('logicalKeyOfRow: stored logical_key wins; else the family fallback; else the id', () => {
      const spec = realmFamily('guardrails'); // fallback = name
      expect(logicalKeyOfRow(spec, { logical_key: 'stored', name: 'n', id: 'i' })).toBe('stored');
      expect(logicalKeyOfRow(spec, { logical_key: '', name: 'n', id: 'i' })).toBe('n');
      expect(logicalKeyOfRow(spec, { id: 'i' })).toBe('i');
    });
  });

  // ═══════════════════════ D12 — ProposeToRealm ═══════════════════════
  describe('D12 — ProposeToRealm review queue', () => {
    let base: PromptRow;
    let baseKey: string;

    beforeEach(async () => {
      // a fresh global + a fresh emea fork per test, so tests don't fight over one row
      const id = newUUIDv7();
      const key = `d12.${id.slice(-8)}`;
      await db.createPrompt({
        id, key, name: `D12 ${key}`, description: 'x', category: null, prompt_type: 'template', owner: null,
        status: 'published', tags: null, template: 'ORIGINAL {{topic}}', variables: null, version: '1',
        model_compatibility: null, execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      });
      // classify as a global realm original (createPrompt doesn't set realm columns)
      raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash='seed' WHERE id=?`).run(key, id);
      base = (await db.listPrompts()).find((p) => p.id === id)!;
      baseKey = key;
      await db.insertRealmPromptRow(buildTenantPromptFork(base, 'emea', { template: 'EMEA IMPROVED {{topic}}' }));
    });

    it('POSITIVE: propose lands pending, changes nothing; approve promotes and closes it', async () => {
      const fork = await forkOf('emea', baseKey);
      const proposed = await proposeRealmFork(client(), 'sqlite', 'prompts', fork.id, { proposedBy: 'emea-admin', note: 'better' });
      expect(proposed.ok).toBe(true);
      expect(proposed.proposal!.status).toBe('pending');
      expect(proposed.proposal!.tenant_id).toBe('emea');
      // nothing promoted yet
      expect((await db.listPrompts()).find((p) => p.id === base.id)!.template).toBe('ORIGINAL {{topic}}');

      const approved = await approveRealmProposal(client(), 'sqlite', proposed.proposal!.id, { reviewer: 'platform' });
      expect(approved.ok).toBe(true);
      expect((await db.listPrompts()).find((p) => p.id === base.id)!.template).toBe('EMEA IMPROVED {{topic}}');
      const closed = (await listRealmProposals(client(), 'sqlite', { status: 'approved' })).find((p) => p.id === proposed.proposal!.id)!;
      expect(closed.reviewed_by).toBe('platform');
    });

    it('POSITIVE: reject closes the proposal and changes nothing', async () => {
      const fork = await forkOf('emea', baseKey);
      const p = await proposeRealmFork(client(), 'sqlite', 'prompts', fork.id, {});
      const rejected = await rejectRealmProposal(client(), 'sqlite', p.proposal!.id, { reviewer: 'platform', reviewNote: 'no' });
      expect(rejected.ok).toBe(true);
      expect((await db.listPrompts()).find((x) => x.id === base.id)!.template).toBe('ORIGINAL {{topic}}');
    });

    it('IDEMPOTENT: re-proposing the same fork updates the open proposal instead of duplicating it', async () => {
      const fork = await forkOf('emea', baseKey);
      const first = await proposeRealmFork(client(), 'sqlite', 'prompts', fork.id, { note: 'v1' });
      const second = await proposeRealmFork(client(), 'sqlite', 'prompts', fork.id, { note: 'v2' });
      expect(second.ok).toBe(true);
      expect(second.proposal!.id).toBe(first.proposal!.id);
      const pending = (await listRealmProposals(client(), 'sqlite', { status: 'pending' })).filter((p) => p.fork_id === fork.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.note).toBe('v2');
    });

    it('NEGATIVE: cannot propose a global, a missing row, or double-review a closed proposal', async () => {
      expect((await proposeRealmFork(client(), 'sqlite', 'prompts', base.id)).reason).toMatch(/only a tenant fork/);
      expect((await proposeRealmFork(client(), 'sqlite', 'prompts', 'no-such-id')).reason).toBe('not found');

      const fork = await forkOf('emea', baseKey);
      const p = await proposeRealmFork(client(), 'sqlite', 'prompts', fork.id, {});
      await approveRealmProposal(client(), 'sqlite', p.proposal!.id, {});
      expect((await approveRealmProposal(client(), 'sqlite', p.proposal!.id, {})).reason).toMatch(/already approved/);
      expect((await rejectRealmProposal(client(), 'sqlite', p.proposal!.id, {})).reason).toMatch(/already approved/);
      expect((await approveRealmProposal(client(), 'sqlite', 'ghost', {})).reason).toBe('proposal not found');
    });

    it('ATOMICITY: if the promote fails, the proposal stays pending (no false "approved")', async () => {
      const fork = await forkOf('emea', baseKey);
      const p = await proposeRealmFork(client(), 'sqlite', 'prompts', fork.id, {});
      // delete the global out from under it → promote must fail
      raw().prepare('DELETE FROM prompts WHERE id = ?').run(base.id);
      const approved = await approveRealmProposal(client(), 'sqlite', p.proposal!.id, {});
      expect(approved.ok).toBe(false);
      expect(approved.reason).toMatch(/no global default/);
      const still = (await listRealmProposals(client(), 'sqlite', { status: 'pending' })).find((x) => x.id === p.proposal!.id);
      expect(still, 'proposal must remain pending after a failed promote').toBeTruthy();
    });

    it('SECURITY: a hostile family string is rejected before any SQL is built', async () => {
      await expect(proposeRealmFork(client(), 'sqlite', HOSTILE, 'x')).rejects.toThrow(/unknown realm family/);
      await expect(promoteRealmForkToGlobal(client(), 'sqlite', 'prompts; DROP TABLE prompts', 'x')).rejects.toThrow(/unknown realm family/);
      expect((await db.listPrompts()).length).toBeGreaterThan(0); // tables intact
    });

    it('STRESS: 200 forks proposed across tenants → one pending row each, all approvable', async () => {
      const created: string[] = [];
      for (let i = 0; i < 200; i++) {
        const id = newUUIDv7();
        const key = `stress.${i}.${id.slice(-6)}`;
        await db.createPrompt({
          id, key, name: key, description: 'x', category: null, prompt_type: 'template', owner: null,
          status: 'published', tags: null, template: `G${i}`, variables: null, version: '1',
          model_compatibility: null, execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
        });
        raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash='s' WHERE id=?`).run(key, id);
        const g = (await db.listPrompts()).find((p) => p.id === id)!;
        const f = buildTenantPromptFork(g, 'apac', { template: `T${i}` });
        await db.insertRealmPromptRow(f);
        created.push(f.id);
      }
      for (const forkId of created) expect((await proposeRealmFork(client(), 'sqlite', 'prompts', forkId, {})).ok).toBe(true);
      const pending = await listRealmProposals(client(), 'sqlite', { status: 'pending', family: 'prompts' });
      expect(pending.filter((p) => created.includes(p.fork_id))).toHaveLength(200);
      // approving them all promotes each global, and leaves no pending rows for these forks
      for (const forkId of created) {
        const p = pending.find((x) => x.fork_id === forkId)!;
        expect((await approveRealmProposal(client(), 'sqlite', p.id, {})).ok).toBe(true);
      }
      const after = await listRealmProposals(client(), 'sqlite', { status: 'pending' });
      expect(after.filter((p) => created.includes(p.fork_id))).toHaveLength(0);
    }, 60_000);
  });

  // ═══════════════════════ generic promote ═══════════════════════
  describe('generic promote (what approve rides on)', () => {
    it('POSITIVE: promoting re-baselines the global so drift reports it in_sync, not diverged', async () => {
      const drift = await db.promptDriftReport();
      expect(drift.summary.diverged).toBe(0);
      expect(drift.summary.stale).toBe(0);
    });

    it('POSITIVE: promote appends a realm_versions entry so the version log grows', async () => {
      const id = newUUIDv7();
      const key = `promo.${id.slice(-8)}`;
      await db.createPrompt({
        id, key, name: key, description: 'x', category: null, prompt_type: 'template', owner: null,
        status: 'published', tags: null, template: 'V1', variables: null, version: '1',
        model_compatibility: null, execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      });
      raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash='s' WHERE id=?`).run(key, id);
      const g = (await db.listPrompts()).find((p) => p.id === id)!;
      await db.insertRealmPromptRow(buildTenantPromptFork(g, 'uk', { template: 'V2' }));
      const fork = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'uk' && (p.logical_key ?? p.key) === key)!;

      const log = createSqlVersionLog({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
      const before = (await log.history('prompts', key)).length;
      const res = await promoteRealmForkToGlobal(client(), 'sqlite', 'prompts', fork.id);
      expect(res.ok).toBe(true);
      expect(res.globalId).toBe(id);
      expect((await log.history('prompts', key)).length).toBe(before + 1);
      expect((await db.listPrompts()).find((p) => p.id === id)!.template).toBe('V2');
    });

    it('NEGATIVE: a fork with no global to promote into is refused', async () => {
      const g = (await globalPrompts())[0]!;
      const fork = buildTenantPromptFork(g, 'orphan-tenant', { template: 'O' });
      await db.insertRealmPromptRow(fork);
      raw().prepare(`UPDATE prompts SET logical_key='orphan-key' WHERE id=?`).run(fork.id);
      expect((await promoteRealmForkToGlobal(client(), 'sqlite', 'prompts', fork.id)).reason).toMatch(/no global default/);
    });
  });

  // ═══════════════════════ D13 — prompt_fragments fork stack ═══════════════════════
  describe('D13 — prompt_fragments customization + revert', () => {
    let gf: PromptFragmentRow;

    beforeAll(async () => {
      const id = newUUIDv7();
      await db.createPromptFragment({
        id, key: 'safety.disclaimer', name: 'Disclaimer', description: null, category: 'safety',
        content: 'GLOBAL DISCLAIMER', variables: null, tags: null, version: '1', enabled: 1,
      });
      raw().prepare(`UPDATE prompt_fragments SET realm='global', logical_key='safety.disclaimer', content_hash=? WHERE id=?`)
        .run(fragmentContentHash({ name: 'Disclaimer', description: null, category: 'safety', content: 'GLOBAL DISCLAIMER', variables: null }), id);
      gf = (await db.listPromptFragments()).find((f) => f.id === id)!;
    });

    it('POSITIVE: a tenant forks a fragment; the fork aliases key#tenant but resolves under the canonical key', async () => {
      const fork = buildTenantPromptFragmentFork(gf, 'emea', { content: 'EMEA DISCLAIMER' });
      expect(fork.key).toBe('safety.disclaimer#emea'); // UNIQUE(key) → aliased
      expect(fork.logical_key).toBe('safety.disclaimer');
      expect(fork.origin_id).toBe(gf.id);
      await db.insertRealmPromptFragmentRow(fork);

      const forEmea = (await db.resolveTenantEffectivePromptFragments('emea')).find((f) => (f.logical_key ?? f.key) === 'safety.disclaimer')!;
      expect(forEmea.content).toBe('EMEA DISCLAIMER');
      expect(forEmea.key).toBe('safety.disclaimer'); // canonical key restored for {{>key}} inclusion
    });

    it('INHERITANCE: uk inherits emea only when the fork is shared; apac (sibling) keeps the global', async () => {
      // emea's fork is private by default → uk must NOT see it
      const ukPrivate = (await db.resolveTenantEffectivePromptFragments('uk')).find((f) => (f.logical_key ?? f.key) === 'safety.disclaimer')!;
      expect(ukPrivate.content).toBe('GLOBAL DISCLAIMER');

      raw().prepare(`UPDATE prompt_fragments SET share_mode='subtree' WHERE realm='tenant' AND owner_tenant_id='emea'`).run();
      const ukShared = (await db.resolveTenantEffectivePromptFragments('uk')).find((f) => (f.logical_key ?? f.key) === 'safety.disclaimer')!;
      expect(ukShared.content).toBe('EMEA DISCLAIMER');

      const apac = (await db.resolveTenantEffectivePromptFragments('apac')).find((f) => (f.logical_key ?? f.key) === 'safety.disclaimer')!;
      expect(apac.content).toBe('GLOBAL DISCLAIMER');
    });

    it('REVERT: deleting the fork falls the tenant back to the global built-in', async () => {
      const fork = (await db.listPromptFragments()).find((f) => f.realm === 'tenant' && f.owner_tenant_id === 'emea')!;
      await db.deletePromptFragment(fork.id);
      const forEmea = (await db.resolveTenantEffectivePromptFragments('emea')).find((f) => (f.logical_key ?? f.key) === 'safety.disclaimer')!;
      expect(forEmea.content).toBe('GLOBAL DISCLAIMER');
    });

    it('NULL TENANT + SECURITY: no tenant → globals only; a hostile tenant id leaks nothing', async () => {
      await db.insertRealmPromptFragmentRow(buildTenantPromptFragmentFork(gf, 'apac', { content: 'APAC SECRET' }));
      const globals = await db.resolveTenantEffectivePromptFragments(null);
      expect(globals.every((f) => (f.realm ?? 'global') === 'global')).toBe(true);
      expect(globals.some((f) => f.content === 'APAC SECRET')).toBe(false);

      const hostile = await db.resolveTenantEffectivePromptFragments(HOSTILE);
      expect(hostile.some((f) => f.content === 'APAC SECRET')).toBe(false);
      expect((await db.listPromptFragments()).length).toBeGreaterThan(0);
    });

    it('HASH: same content ⇒ same hash across tenants; changed content ⇒ drift detectable', () => {
      const a = buildTenantPromptFragmentFork(gf, 'x', { content: 'SAME' });
      const b = buildTenantPromptFragmentFork(gf, 'y', { content: 'SAME' });
      expect(a.content_hash).toBe(b.content_hash);
      expect(a.origin_hash).toBe(gf.content_hash);
      expect(buildTenantPromptFragmentFork(gf, 'x', { content: 'DIFFERENT' }).content_hash).not.toBe(a.content_hash);
    });
  });

  // ═══════════════════════ D14 — pinnedVersion enforcement ═══════════════════════
  describe('D14 — pinnedVersion is enforced at resolve', () => {
    let base: PromptRow;
    let key: string;
    let v1: string | undefined;
    const settingsFor = (id: string) => ({ systemPrompt: id } as unknown as ChatSettings);

    beforeAll(async () => {
      const id = newUUIDv7();
      key = `pin.${id.slice(-8)}`;
      await db.createPrompt({
        id, key, name: key, description: 'x', category: null, prompt_type: 'template', owner: null,
        status: 'published', tags: null, template: 'PINNED V1 CONTENT', variables: null, version: '1',
        model_compatibility: null, execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      });
      raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash='s' WHERE id=?`).run(key, id);
      base = (await db.listPrompts()).find((p) => p.id === id)!;
      v1 = (await resolveSystemPrompt(db, settingsFor(base.id), 'apac')).content;

      // Record the BASELINE as version 1, exactly as the seed-time reconcile does for shipped defaults.
      // Without a baseline the first promote would itself become version 1, and "pin to v1" would mean
      // "pin to the promoted content" — the version log is what makes a pin meaningful.
      const log = createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
      await log.append({
        family: 'prompts', logicalKey: key, note: 'baseline',
        payload: { name: key, description: 'x', category: null, template: 'PINNED V1 CONTENT', variables: null, model_compatibility: null, execution_defaults: null, framework: null },
      });

      // acme forks + promotes → the global becomes v2, while v1 stays retrievable in the log
      await db.insertRealmPromptRow(buildTenantPromptFork(base, 'acme', { template: 'PROMOTED V2 CONTENT' }));
      const fork = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'acme' && (p.logical_key ?? p.key) === key)!;
      await promoteRealmForkToGlobal(client(), 'sqlite', 'prompts', fork.id);
      expect((await log.history('prompts', key)).map((h) => h.version).sort()).toEqual([1, 2]);
    });

    it('POSITIVE: an unpinned tenant gets the new default; a tenant pinned to v1 keeps serving v1', async () => {
      const unpinned = await resolveSystemPrompt(db, settingsFor(base.id), 'uk');
      expect(unpinned.content).toContain('PROMOTED V2');
      expect(unpinned.realmPinnedVersion).toBeUndefined();

      await db.setRealmState('prompts', key, 'apac', { pinnedVersion: 1 });
      const pinned = await resolveSystemPrompt(db, settingsFor(base.id), 'apac');
      expect(pinned.content).toBe(v1);
      expect(pinned.content).not.toContain('PROMOTED V2');
      expect(pinned.realmPinnedVersion).toBe(1);
    });

    it('PRECEDENCE: a tenant’s own fork wins over a pin (a fork already opts out of upstream)', async () => {
      await db.setRealmState('prompts', key, 'acme', { pinnedVersion: 1 });
      const acme = await resolveSystemPrompt(db, settingsFor(base.id), 'acme');
      expect(acme.content).toContain('PROMOTED V2'); // acme's own fork content
      expect(acme.realmPinnedVersion).toBeUndefined();
    });

    it('NEGATIVE: a pin to a never-published version is ignored, not fatal (stale pins can’t break chat)', async () => {
      await db.setRealmState('prompts', key, 'uk', { pinnedVersion: 999 });
      const uk = await resolveSystemPrompt(db, settingsFor(base.id), 'uk');
      expect(uk.content).toContain('PROMOTED V2'); // falls back to the live default
      expect(uk.realmPinnedVersion).toBeUndefined();
      expect((await db.resolveRealmPinnedVersions('prompts', 'uk', [key])).size).toBe(0);
    });

    it('NEGATIVE: non-positive / non-integer pins are ignored', async () => {
      for (const bad of [0, -1, 1.5]) {
        await db.setRealmState('prompts', key, 'emea', { pinnedVersion: bad });
        expect((await db.resolveRealmPinnedVersions('prompts', 'emea', [key])).size).toBe(0);
      }
    });

    it('NULL TENANT + SECURITY: globals are never pinned; a hostile tenant id resolves no pins', async () => {
      expect((await db.resolveRealmPinnedVersions('prompts', null, [key])).size).toBe(0);
      expect((await db.resolveRealmPinnedVersions('prompts', HOSTILE, [key])).size).toBe(0);
      const g = await resolveSystemPrompt(db, settingsFor(base.id), null);
      expect(g.realmPinnedVersion).toBeUndefined();
    });

    it('INHERITANCE: a parent org’s pin applies to a child with no pin of its own', async () => {
      const id = newUUIDv7();
      const k2 = `pin2.${id.slice(-8)}`;
      await db.createPrompt({
        id, key: k2, name: k2, description: 'x', category: null, prompt_type: 'template', owner: null,
        status: 'published', tags: null, template: 'K2 V1', variables: null, version: '1',
        model_compatibility: null, execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      });
      raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash='s' WHERE id=?`).run(k2, id);
      const g = (await db.listPrompts()).find((p) => p.id === id)!;
      const log = createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
      await log.append({ family: 'prompts', logicalKey: k2, note: 'baseline', payload: { template: 'K2 V1' } });
      await db.insertRealmPromptRow(buildTenantPromptFork(g, 'apac', { template: 'K2 V2' }));
      const f = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'apac' && (p.logical_key ?? p.key) === k2)!;
      await promoteRealmForkToGlobal(client(), 'sqlite', 'prompts', f.id);

      await db.setRealmState('prompts', k2, 'emea', { pinnedVersion: 1 }); // parent org pins
      const pins = await db.resolveRealmPinnedVersions('prompts', 'uk', [k2]); // child inherits the pin
      expect(pins.get(k2)?.version).toBe(1);
    });

    it('STRESS: 300 pinned keys resolve without error and only published pins come back', async () => {
      const keys: string[] = [];
      for (let i = 0; i < 300; i++) keys.push(`bulk-pin-${i}`);
      for (const k of keys) await db.setRealmState('prompts', k, 'apac', { pinnedVersion: 1 });
      const pins = await db.resolveRealmPinnedVersions('prompts', 'apac', keys);
      expect(pins.size).toBe(0); // none of these logical keys were ever published
    }, 60_000);
  });

  // ═══════════════════════ D15 — deprecation lifecycle ═══════════════════════
  describe('D15 — deprecation lifecycle', () => {
    let base: PromptRow;

    beforeEach(async () => {
      const id = newUUIDv7();
      const key = `dep.${id.slice(-8)}`;
      await db.createPrompt({
        id, key, name: key, description: 'x', category: null, prompt_type: 'template', owner: null,
        status: 'published', tags: null, template: 'DEP CONTENT', variables: null, version: '1',
        model_compatibility: null, execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      });
      raw().prepare(`UPDATE prompts SET realm='global', logical_key=?, content_hash='s' WHERE id=?`).run(key, id);
      base = (await db.listPrompts()).find((p) => p.id === id)!;
    });

    it('POSITIVE: deprecating stamps the record; it still RESOLVES (never breaks a running tenant)', async () => {
      expect((await deprecateRealmRecord(client(), 'sqlite', 'prompts', base.id, { note: 'retired' })).ok).toBe(true);
      const row = (await db.listPrompts()).find((p) => p.id === base.id)!;
      expect(isDeprecated(row as unknown as Record<string, unknown>)).toBe(true);
      // still served
      const resolved = await resolveSystemPrompt(db, { systemPrompt: base.id } as unknown as ChatSettings, 'uk');
      expect(resolved.content).toContain('DEP CONTENT');
    });

    it('POSITIVE: a deprecated default may gain NO new forks, and names its replacement', async () => {
      const replacement = (await globalPrompts()).find((p) => p.id !== base.id)!;
      await deprecateRealmRecord(client(), 'sqlite', 'prompts', base.id, { note: 'use the new one', supersededById: replacement.id });
      const row = (await db.listPrompts()).find((p) => p.id === base.id)! as unknown as Record<string, unknown>;
      const gate = assertCustomizable(row);
      expect(gate.ok).toBe(false);
      if (!gate.ok) {
        expect(gate.supersededById).toBe(replacement.id);
        expect(gate.reason).toMatch(/deprecated/);
      }
    });

    it('POSITIVE: undeprecate restores it to service', async () => {
      await deprecateRealmRecord(client(), 'sqlite', 'prompts', base.id, {});
      await undeprecateRealmRecord(client(), 'sqlite', 'prompts', base.id);
      const row = (await db.listPrompts()).find((p) => p.id === base.id)! as unknown as Record<string, unknown>;
      expect(isDeprecated(row)).toBe(false);
      expect(assertCustomizable(row).ok).toBe(true);
    });

    it('NEGATIVE: only a global can be deprecated; self-supersede and unknown replacement are refused', async () => {
      await db.insertRealmPromptRow(buildTenantPromptFork(base, 'uk', {}));
      const fork = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'uk' && (p.logical_key ?? p.key) === (base.logical_key ?? base.key))!;
      expect((await deprecateRealmRecord(client(), 'sqlite', 'prompts', fork.id, {})).reason).toMatch(/only a global/);
      expect((await deprecateRealmRecord(client(), 'sqlite', 'prompts', base.id, { supersededById: base.id })).reason).toMatch(/cannot supersede itself/);
      expect((await deprecateRealmRecord(client(), 'sqlite', 'prompts', base.id, { supersededById: 'ghost' })).reason).toMatch(/superseding record not found/);
      expect((await deprecateRealmRecord(client(), 'sqlite', 'prompts', 'ghost', {})).reason).toBe('not found');
    });

    it('NEGATIVE: a deprecated global cannot be the target of a proposal', async () => {
      await db.insertRealmPromptRow(buildTenantPromptFork(base, 'apac', { template: 'X' }));
      const fork = (await db.listPrompts()).find((p) => p.realm === 'tenant' && p.owner_tenant_id === 'apac' && (p.logical_key ?? p.key) === (base.logical_key ?? base.key))!;
      await deprecateRealmRecord(client(), 'sqlite', 'prompts', base.id, {});
      expect((await proposeRealmFork(client(), 'sqlite', 'prompts', fork.id, {})).reason).toMatch(/deprecated/);
    });

    it('SECURITY: a hostile family is rejected; assertCustomizable treats a null/odd row as live', async () => {
      await expect(deprecateRealmRecord(client(), 'sqlite', HOSTILE, base.id, {})).rejects.toThrow(/unknown realm family/);
      expect(isDeprecated(null)).toBe(false);
      expect(isDeprecated({ deprecated_at: '' })).toBe(false);
      expect(assertCustomizable({}).ok).toBe(true);
    });

    it('COVERAGE: every realm family carries the deprecation columns', () => {
      for (const spec of Object.values(REALM_FAMILIES)) {
        const cols = raw().prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>;
        const names = cols.map((c) => c.name);
        expect(names, `${spec.table} deprecated_at`).toContain('deprecated_at');
        expect(names, `${spec.table} deprecation_note`).toContain('deprecation_note');
        expect(names, `${spec.table} superseded_by_id`).toContain('superseded_by_id');
      }
    });
  });

  // ═══════════════════════ D17 — logical-key collision ═══════════════════════
  describe('D17 — visible key ⇒ Customize, never create', () => {
    it('POSITIVE: a key visible as a global collides for a tenant and for the global context', async () => {
      const g = (await globalPrompts())[0]!;
      const key = g.logical_key ?? g.key!;
      const forUk = await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', key, await db.realmContext('uk'));
      expect(forUk.collides).toBe(true);
      expect(forUk.visibleRealm).toBe('global');
      expect(forUk.reason).toMatch(/customize it instead/);

      const forGlobal = await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', key, await db.realmContext(null));
      expect(forGlobal.collides).toBe(true); // creating a duplicate global is what the unique index rejects
    });

    it('NEGATIVE: an unused key does not collide, and an empty key is a no-op', async () => {
      expect((await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', 'never-used-key', await db.realmContext('uk'))).collides).toBe(false);
      expect((await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', '', await db.realmContext('uk'))).collides).toBe(false);
    });

    it('VISIBILITY: an ancestor’s PRIVATE fork does not collide; a subtree-shared one does', async () => {
      const id = newUUIDv7();
      const key = `col.${id.slice(-8)}`;
      await db.createPrompt({
        id, key, name: key, description: 'x', category: null, prompt_type: 'template', owner: null,
        status: 'published', tags: null, template: 'C', variables: null, version: '1',
        model_compatibility: null, execution_defaults: null, framework: null, metadata: null, is_default: 0, enabled: 1,
      });
      // a TENANT-native row owned by emea, private → invisible to a sibling branch
      raw().prepare(`UPDATE prompts SET realm='tenant', owner_tenant_id='emea', logical_key=?, share_mode='private', content_hash='s' WHERE id=?`).run(key, id);

      const apacCtx = await db.realmContext('apac'); // sibling branch — never sees emea's rows
      expect((await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', key, apacCtx)).collides).toBe(false);

      const ukCtx = await db.realmContext('uk'); // emea's child, but the fork is PRIVATE
      expect((await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', key, ukCtx)).collides).toBe(false);

      raw().prepare(`UPDATE prompts SET share_mode='subtree' WHERE id=?`).run(id);
      const shared = await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', key, ukCtx);
      expect(shared.collides).toBe(true); // now uk can see it → must customize, not create a twin
      expect(shared.visibleRealm).toBe('tenant');
    });

    it('REGRESSION: a row created via plain CRUD (logical_key unset) still collides on its fallback column', async () => {
      // createGuardrail/createPrompt never populate logical_key — only the migration backfill and the
      // fork builders do. Such a row still RESOLVES under its name (the resolver's logicalKeyOf falls
      // back to it), and the composite unique index misses it because NULLs compare distinct. If the
      // collision check only matched `logical_key`, a second same-named record would slip through and
      // one logical key would end up with two competing definitions.
      await db.createGuardrail({
        id: 'gr-crud-1', name: 'CrudOnlyName', description: 'd', type: 't', stage: 'input',
        config: null, priority: 1, enabled: 1, trigger_conditions: null, trigger_description: null,
      } as never);
      const row = (await db.listGuardrails()).find((g) => g.id === 'gr-crud-1')!;
      expect(row.logical_key ?? null, 'precondition: plain CRUD leaves logical_key unset').toBeNull();

      const hit = await checkVisibleKeyCollision(client(), 'sqlite', 'guardrails', 'CrudOnlyName', await db.realmContext(null));
      expect(hit.collides).toBe(true);
      expect(hit.visibleId).toBe('gr-crud-1');
      // a tenant sees the same global → must customize it, not create a twin
      expect((await checkVisibleKeyCollision(client(), 'sqlite', 'guardrails', 'CrudOnlyName', await db.realmContext('uk'))).collides).toBe(true);
      // an unrelated name is still free
      expect((await checkVisibleKeyCollision(client(), 'sqlite', 'guardrails', 'OtherName', await db.realmContext(null))).collides).toBe(false);
    });

    it('SECURITY: a hostile family throws; a hostile key is bound, not interpolated', async () => {
      await expect(checkVisibleKeyCollision(client(), 'sqlite', HOSTILE, 'k', await db.realmContext('uk'))).rejects.toThrow(/unknown realm family/);
      const res = await checkVisibleKeyCollision(client(), 'sqlite', 'prompts', HOSTILE, await db.realmContext('uk'));
      expect(res.collides).toBe(false);
      expect((await db.listPrompts()).length).toBeGreaterThan(0); // table intact
    });
  });

  // ═══════════════════════ D16 — reparent ═══════════════════════
  describe('D16 — reparent a tenant in the org tree', () => {
    // A dedicated tree so moving nodes can't disturb the other suites.
    beforeAll(async () => {
      const org = createSqlTenantHierarchy({ client: client(), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
      await org.create({ id: 'r-root', name: 'R' });
      await org.create({ id: 'r-a', name: 'A', parentTenantId: 'r-root' });
      await org.create({ id: 'r-b', name: 'B', parentTenantId: 'r-root' });
      await org.create({ id: 'r-a1', name: 'A1', parentTenantId: 'r-a' });
      await org.create({ id: 'r-a2', name: 'A2', parentTenantId: 'r-a1' });
    });

    it('POSITIVE: moving a subtree reports before/after and every affected descendant', async () => {
      const diff = await reparentTenant(client(), 'sqlite', 'r-a', 'r-b');
      expect(diff.ok).toBe(true);
      expect(diff.from!.parentTenantId).toBe('r-root');
      expect(diff.to!.parentTenantId).toBe('r-b');
      expect(diff.to!.depth).toBe(diff.from!.depth + 1);
      // the moved node AND its descendants all have new lineages
      expect(new Set(diff.affectedTenantIds)).toEqual(new Set(['r-a', 'r-a1', 'r-a2']));
    });

    it('POSITIVE: the realm lineage actually changes, so inherited config resolves differently', async () => {
      const ctx = await db.realmContext('r-a2');
      expect(ctx.lineage.map((n) => n.tenantId)).toEqual(['r-root', 'r-b', 'r-a', 'r-a1', 'r-a2']);
    });

    it('POSITIVE: a tenant can be moved to a root (null parent)', async () => {
      const diff = await reparentTenant(client(), 'sqlite', 'r-a', null);
      expect(diff.ok).toBe(true);
      expect(diff.to!.parentTenantId).toBeNull();
      expect(diff.to!.depth).toBe(0);
      const ctx = await db.realmContext('r-a2');
      expect(ctx.lineage.map((n) => n.tenantId)).toEqual(['r-a', 'r-a1', 'r-a2']);
    });

    it('NEGATIVE: a cycle is refused (moving a node under its own descendant) and the tree is unchanged', async () => {
      const before = await db.realmContext('r-a2');
      const cyc = await reparentTenant(client(), 'sqlite', 'r-a', 'r-a2');
      expect(cyc.ok).toBe(false);
      expect(cyc.reason).toMatch(/cycle|subtree/i);
      const after = await db.realmContext('r-a2');
      expect(after.lineage.map((n) => n.tenantId)).toEqual(before.lineage.map((n) => n.tenantId));
    });

    it('NEGATIVE: unknown tenant / unknown new parent are refused', async () => {
      expect((await reparentTenant(client(), 'sqlite', 'ghost', null)).reason).toBe('tenant not found');
      expect((await reparentTenant(client(), 'sqlite', 'r-a', 'ghost-parent')).reason).toBe('new parent not found');
    });

    it('SECURITY: a hostile tenant id is bound, not interpolated; the tenants table survives', async () => {
      const res = await reparentTenant(client(), 'sqlite', HOSTILE, null);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('tenant not found');
      const rows = raw().prepare('SELECT count(*) AS c FROM tenants').get() as { c: number };
      expect(rows.c).toBeGreaterThan(0);
    });

    it('SECURITY: a tenant id containing LIKE wildcards cannot sweep in siblings via the subtree prefix', async () => {
      const org = createSqlTenantHierarchy({ client: client(), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
      await org.create({ id: 'w_a', name: 'wildcard' });   // `_` is a LIKE single-char wildcard
      await org.create({ id: 'wxa', name: 'decoy' });       // would match `/w_a/%` if unescaped
      await org.create({ id: 'w_a-child', name: 'child', parentTenantId: 'w_a' });
      const diff = await reparentTenant(client(), 'sqlite', 'w_a', 'r-b');
      expect(diff.ok).toBe(true);
      expect(diff.affectedTenantIds).toContain('w_a');
      expect(diff.affectedTenantIds).toContain('w_a-child');
      expect(diff.affectedTenantIds, 'the decoy must NOT be swept in').not.toContain('wxa');
    });

    it('STRESS: a 100-node chain reparents once and every node’s lineage is rebuilt correctly', async () => {
      const org = createSqlTenantHierarchy({ client: client(), dialect: 'sqlite', table: 'tenants', ensureSchema: false });
      await org.create({ id: 'chain-root', name: 'cr' });
      let parent = 'chain-root';
      for (let i = 0; i < 100; i++) { await org.create({ id: `chain-${i}`, name: `c${i}`, parentTenantId: parent }); parent = `chain-${i}`; }

      const diff = await reparentTenant(client(), 'sqlite', 'chain-0', 'r-b');
      expect(diff.ok).toBe(true);
      expect(diff.affectedTenantIds).toHaveLength(100); // chain-0 .. chain-99

      const deepest = await db.realmContext('chain-99');
      expect(deepest.lineage[0]!.tenantId).toBe('r-root'); // r-b's root
      expect(deepest.lineage.at(-1)!.tenantId).toBe('chain-99');
      expect(deepest.lineage.map((n) => n.tenantId)).toContain('chain-0');
      expect(deepest.lineage.map((n) => n.tenantId)).not.toContain('chain-root');
    }, 60_000);
  });
});
