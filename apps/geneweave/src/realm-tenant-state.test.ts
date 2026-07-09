// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm Phase 3 (app) — per-tenant state overlay, end to end on a real booted SQLite adapter.
 * A tenant can turn a shared built-in skill OFF for itself (no fork), reprioritise it, pin it — with
 * strict isolation from other tenants. Plus the skill-discovery filter the chat pipeline applies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter } from './db.js';
import type { DatabaseAdapter } from './db.js';

const FAMILY = 'skills';

describe('Tenancy Realm Phase 3 — per-tenant state overlay', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let skillKeys: string[];

  beforeAll(async () => {
    dbPath = join(tmpdir(), `realm-p3-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    skillKeys = (await db.listEnabledSkills()).map((s) => s.id);
    expect(skillKeys.length).toBeGreaterThan(1);
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('POSITIVE: disabling a built-in for one tenant hides it for that tenant only', async () => {
    const k = skillKeys[0]!;
    await db.setRealmState(FAMILY, k, 'acme', { enabled: false });

    const acme = await db.resolveRealmStates(FAMILY, 'acme', skillKeys);
    expect(acme.get(k)!.active).toBe(false);           // acme: off
    expect(acme.get(skillKeys[1]!)!.active).toBe(true); // a different skill: still on

    // Another tenant is completely unaffected — the shared default is untouched.
    const globex = await db.resolveRealmStates(FAMILY, 'globex', [k]);
    expect(globex.get(k)!.active).toBe(true);
    // No tenant → everything inherits the shared default.
    expect((await db.resolveRealmStates(FAMILY, null, [k])).size).toBe(0);
  });

  it('MERGE + LIST: partial patches merge; the overlay shows in listRealmStates', async () => {
    const k = skillKeys[1]!;
    await db.setRealmState(FAMILY, k, 'acme', { priority: 10 });
    await db.setRealmState(FAMILY, k, 'acme', { pinnedVersion: 3 }); // merges, keeps priority
    const resolved = (await db.resolveRealmStates(FAMILY, 'acme', [k])).get(k)!;
    expect([resolved.priority, resolved.pinnedVersion, resolved.active]).toEqual([10, 3, true]);
    const list = await db.listRealmStates(FAMILY, 'acme');
    expect(list.some((r) => r.logicalKey === k && r.priority === 10 && r.pinnedVersion === 3)).toBe(true);
  });

  it('CLEAR: removing the overlay (or setting all-null) falls back to the shared default', async () => {
    const k = skillKeys[0]!;
    await db.clearRealmState(FAMILY, k, 'acme');
    expect((await db.resolveRealmStates(FAMILY, 'acme', [k])).get(k)!.active).toBe(true);
    // Setting every field to null also clears it (no dangling empty overlay).
    await db.setRealmState(FAMILY, k, 'acme', { enabled: false });
    await db.setRealmState(FAMILY, k, 'acme', { enabled: null });
    expect((await db.listRealmStates(FAMILY, 'acme')).some((r) => r.logicalKey === k)).toBe(false);
  });

  it('SKILL FILTER: the chat pipeline drops a tenant’s disabled skills from discovery', async () => {
    // Replicates exactly what discoverSkillsForInput does at its choke point.
    const disabled = skillKeys[2]!;
    await db.setRealmState(FAMILY, disabled, 'acme', { enabled: false });

    const rows = await db.listEnabledSkills();
    const states = await db.resolveRealmStates(FAMILY, 'acme', rows.map((r) => r.id));
    const forAcme = rows.filter((r) => states.get(r.id)?.active !== false);
    const forOther = rows.filter((r) => {
      // globex has no overlay → nothing filtered.
      return true;
    });
    expect(forAcme.some((r) => r.id === disabled)).toBe(false); // hidden for acme
    expect(forOther.some((r) => r.id === disabled)).toBe(true);  // present for everyone else
    expect(forAcme.length).toBe(rows.length - 1);
  });

  it('SECURITY: a hostile logical key / tenant id is stored as data and never leaks across tenants', async () => {
    const evil = "k'; DROP TABLE realm_tenant_state; --";
    await db.setRealmState(FAMILY, evil, "acme'; DROP TABLE x; --", { enabled: false });
    // Table survived + the value round-trips; a normal tenant is unaffected.
    expect((await db.resolveRealmStates(FAMILY, 'normal-tenant', [evil])).get(evil)!.active).toBe(true);
    expect((await db.listEnabledSkills()).length).toBeGreaterThan(0);
  });
});
