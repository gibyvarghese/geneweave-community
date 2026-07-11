// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — Phase 0 acceptance + safety tests for the registry-driven seed reconcile, the migration
 * ledger, the priority scorer, and the run/detail persistence. Exercises the exact exit criteria:
 *   • a changed shipped default adopts on an UNTOUCHED install and is kept+flagged on a CUSTOMIZED one,
 *     recorded in upgrade_details;
 *   • edit-then-revert returns to in_sync (Local hashed live, so a revert is seen);
 *   • a second ledgered migration run applies zero batches;
 * plus negative (bad family), stress (many records), and security (SQL-injection-safe logical keys) cases.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { REALM_FAMILIES } from './realm-families.js';
import { reconcileRealmFamily, reconcileAllRealmFamilies, adoptPolicyFor } from './realm-seed-reconcile.js';
import { beginUpgradeRun, finishUpgradeRun, listUpgradeDetails } from './upgrade-run-store.js';
import { upgradePriority, needsReview } from './upgrade-priority.js';
import { createMigrationRunner, type MigrationBatch } from './migrations/helpers.js';

const SKILLS = REALM_FAMILIES['skills']!;

describe('Upgrade Engine — priority scorer (pure)', () => {
  it('bands families as specified and forces collisions/conflicts to P1', () => {
    expect(upgradePriority('guardrails', 'stale')).toBe('P1');
    expect(upgradePriority('skills', 'diverged')).toBe('P2');
    expect(upgradePriority('routing_policies', 'customized')).toBe('P3');
    expect(upgradePriority('model_pricing', 'stale')).toBe('P5');
    // A collision/conflict is always P1 regardless of family.
    expect(upgradePriority('model_pricing', 'collision')).toBe('P1');
    expect(upgradePriority('cost_policies', 'conflict')).toBe('P1');
    // Unknown family → P3 default.
    expect(upgradePriority('something_new', 'stale')).toBe('P3');
  });
  it('needsReview flags only human-actionable dispositions', () => {
    expect(needsReview('customized')).toBe(true);
    expect(needsReview('diverged')).toBe(true);
    expect(needsReview('conflict')).toBe(true);
    expect(needsReview('adopted')).toBe(false);
    expect(needsReview('in_sync')).toBe(false);
    expect(needsReview('published')).toBe(false);
  });
});

describe('Upgrade Engine — migration ledger', () => {
  it('POSITIVE: first ledgered run applies all batches; second applies zero', () => {
    const db = new Database(':memory:');
    const ran: string[] = [];
    const batches: MigrationBatch[] = [
      { id: 'b1', description: 'one', run: () => { ran.push('b1'); db.exec('CREATE TABLE IF NOT EXISTS t1(x)'); } },
      { id: 'b2', description: 'two', run: () => { ran.push('b2'); db.exec('CREATE TABLE IF NOT EXISTS t2(x)'); } },
    ];
    const runner = createMigrationRunner(batches);
    const first = runner.run(db, { ledgered: true });
    expect(first.applied).toEqual(['b1', 'b2']);
    expect(first.skipped).toEqual([]);
    const second = runner.run(db, { ledgered: true });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['b1', 'b2']);
    expect(ran).toEqual(['b1', 'b2']); // each batch body ran exactly once
    // A hash change (edited migration) forces a re-run of just that batch.
    const bumped = createMigrationRunner([batches[0]!, { ...batches[1]!, hash: 'v2' }]);
    const third = bumped.run(db, { ledgered: true });
    expect(third.applied).toEqual(['b2']);
    expect(third.skipped).toEqual(['b1']);
    db.close();
  });
  it('NEGATIVE: non-ledgered run preserves legacy behaviour (every batch every time)', () => {
    const db = new Database(':memory:');
    const ran: string[] = [];
    const runner = createMigrationRunner([{ id: 'b', description: 'd', run: () => ran.push('x') }]);
    runner.run(db);
    runner.run(db);
    expect(ran).toEqual(['x', 'x']);
    db.close();
  });
});

describe('Upgrade Engine — registry-driven seed reconcile (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  /** A real global skill row to reconcile against. */
  let skillRow: Record<string, unknown>;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `upgrade-p0-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await db.seedDefaultData?.();
    await db.seedReconcileRealm?.(); // establishes baselines for every family
    const rows = raw().prepare(`SELECT * FROM skills WHERE realm = 'global' LIMIT 1`).all() as Array<Record<string, unknown>>;
    skillRow = rows[0]!;
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('SETUP: seedReconcileRealm baselines every global skill (origin_hash + content_hash + a version)', () => {
    const r = raw().prepare(`SELECT origin_hash, content_hash FROM skills WHERE id = ?`).get(skillRow['id']) as Record<string, unknown>;
    expect(r['origin_hash']).toBeTruthy();
    expect(r['content_hash']).toBeTruthy();
    const v = raw().prepare(`SELECT count(*) c FROM realm_versions WHERE family = 'skills' AND logical_key = ?`).get(skillRow['id']) as { c: number };
    expect(v.c).toBeGreaterThan(0);
  });

  it('POSITIVE (the money test): a changed shipped default the operator never touched is ADOPTED + recorded', async () => {
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    // A new release ships a changed default for this skill (operator has NOT edited the row).
    const changed = { ...skillRow, description: `${String(skillRow['description'])} (v2 improved)` };
    const res = await reconcileRealmFamily(client(), 'sqlite', SKILLS, [changed], { runId });
    expect(res.adopted).toContain(String(skillRow['id']));
    // The row now carries the shipped default.
    const after = raw().prepare(`SELECT description, origin_hash, content_hash FROM skills WHERE id = ?`).get(skillRow['id']) as Record<string, string>;
    expect(after['description']).toContain('(v2 improved)');
    expect(after['origin_hash']).toBe(after['content_hash']); // re-baselined → in_sync
    // It was recorded in upgrade_details as an adoption at the skills priority band (P2).
    const details = await listUpgradeDetails(client(), 'sqlite', runId, { family: 'skills' });
    const rec = details.find((d) => d.logical_key === String(skillRow['id']));
    expect(rec?.disposition).toBe('adopted');
    expect(rec?.priority).toBe('P2');
    await finishUpgradeRun(client(), 'sqlite', runId, { status: 'succeeded' });
  });

  it('POSITIVE: reconciling the SAME default again is a no-op (in_sync, nothing adopted/recorded)', async () => {
    const current = raw().prepare(`SELECT * FROM skills WHERE id = ?`).get(skillRow['id']) as Record<string, unknown>;
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    const res = await reconcileRealmFamily(client(), 'sqlite', SKILLS, [current], { runId });
    expect(res.adopted).toEqual([]);
    expect(res.review).toEqual([]);
    const details = await listUpgradeDetails(client(), 'sqlite', runId);
    expect(details.filter((d) => d.logical_key === String(skillRow['id']))).toEqual([]);
  });

  it('NEGATIVE (keep mine): an operator-customized skill is KEPT and flagged, never overwritten', async () => {
    const id = String(skillRow['id']);
    // Operator edits the row in place (Local now differs from Base).
    raw().prepare(`UPDATE skills SET instructions = ? WHERE id = ?`).run('operator custom instructions', id);
    const current = raw().prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as Record<string, unknown>;
    // The release ships the SAME default we last recorded (origin) — so this is 'customized', not 'diverged'.
    const shippedSame = { ...current, instructions: current['instructions'] }; // remote == origin baseline
    // Reconstruct the shipped default = what origin_hash was baselined from. Simplest: reconcile with the
    // pre-edit content by reading the latest version payload is overkill here; instead assert the edit is
    // classified as customized against the recorded baseline and the row is untouched.
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    // Ship a default equal to the ORIGINAL baseline (operator changed instructions; we didn't).
    const original = { ...current, instructions: String(skillRow['instructions'] ?? '') };
    void shippedSame;
    const res = await reconcileRealmFamily(client(), 'sqlite', SKILLS, [original], { runId });
    expect(res.adopted).not.toContain(id);
    expect(res.review.find((r) => r.logicalKey === id)?.state).toBe('customized');
    // Row still holds the operator's edit.
    const after = raw().prepare(`SELECT instructions FROM skills WHERE id = ?`).get(id) as Record<string, string>;
    expect(after['instructions']).toBe('operator custom instructions');
    const details = await listUpgradeDetails(client(), 'sqlite', runId, { disposition: 'customized' });
    expect(details.some((d) => d.logical_key === id)).toBe(true);
  });

  it('edit-then-revert ⇒ in_sync (Local hashed live, so the revert is seen)', async () => {
    const id = String(skillRow['id']);
    // Revert the operator edit back to what the recorded baseline shipped.
    raw().prepare(`UPDATE skills SET instructions = ? WHERE id = ?`).run(String(skillRow['instructions'] ?? ''), id);
    const current = raw().prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as Record<string, unknown>;
    const original = { ...current, instructions: String(skillRow['instructions'] ?? '') };
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    const res = await reconcileRealmFamily(client(), 'sqlite', SKILLS, [original], { runId });
    expect(res.adopted).toEqual([]);
    expect(res.review).toEqual([]); // back to in_sync, nothing to do
  });

  it('SECURITY: a hostile logical key is a bound parameter, never SQL — no injection, no match', async () => {
    const hostile = "skill'; DROP TABLE skills; --";
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    const res = await reconcileRealmFamily(client(), 'sqlite', SKILLS, [{ id: hostile, name: 'x', description: 'y' }], { runId });
    // No global row matches the hostile key → treated as 'new' (published), and skills table survives.
    expect(res.published).toContain(hostile);
    const stillThere = raw().prepare(`SELECT count(*) c FROM skills`).get() as { c: number };
    expect(stillThere.c).toBeGreaterThan(0);
  });

  it('STRESS: reconciling 500 unchanged defaults is a fast no-op (content-addressed)', async () => {
    const all = raw().prepare(`SELECT * FROM skills WHERE realm = 'global'`).all() as Array<Record<string, unknown>>;
    const many = Array.from({ length: 500 }, (_, i) => all[i % all.length]!);
    const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply' });
    const res = await reconcileRealmFamily(client(), 'sqlite', SKILLS, many, { runId });
    expect(res.adopted).toEqual([]); // nothing changed
    await finishUpgradeRun(client(), 'sqlite', runId, { status: 'succeeded' });
    // Assert on THIS run (multiple same-second runs exist from earlier cases, so query by id, not latest).
    const row = raw().prepare(`SELECT status FROM upgrade_runs WHERE id = ?`).get(runId) as { status: string };
    expect(row.status).toBe('succeeded');
  });

  it('reconcileAllRealmFamilies covers every registered family without error (baseline-only where unwired)', async () => {
    const res = await reconcileAllRealmFamilies(client(), 'sqlite', {});
    expect(res.perFamily.map((f) => f.family).sort()).toEqual(Object.keys(REALM_FAMILIES).sort());
  });

  it('adoptPolicyFor defaults conservatively', () => {
    expect(adoptPolicyFor('skills')).toBe('patch_only');
    expect(adoptPolicyFor('unknown_family')).toBe('patch_only');
  });
});
