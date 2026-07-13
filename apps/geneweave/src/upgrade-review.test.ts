// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — the review-queue engine. Real booted SQLite: a diverged realm record is engineered (a
 * published upstream version + an operator edit + a sentinel baseline) so `adopt`/`undo` exercise the real
 * field-level merge + restore, and plain detail rows drive keep/defer/bulk. Covers positive, negative,
 * the bulk P1 guardrail (security), and stress.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createSqlVersionLog } from '@weaveintel/realm';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { realmFamily, logicalKeyOfRow } from './realm-families.js';
import { semanticOfRow } from './realm-diff.js';
import { beginUpgradeRun, recordUpgradeDetail, getUpgradeDetail } from './upgrade-run-store.js';
import { getReviewQueue, resolveReviewItem, bulkResolveReview, undoReviewItem } from './upgrade-review.js';

describe('Upgrade Engine — review queue (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  let runId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `review-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    // No seed-reconcile: the queue starts empty, and adopt/undo publish their own upstream versions below.
    runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'apply', toVersion: '2.0.0' });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  /** Insert a plain (no live-record) review detail — for keep/defer/bulk. */
  const addDetail = (over: { family?: string; logicalKey?: string; disposition?: string; priority?: string } = {}) =>
    recordUpgradeDetail(client(), 'sqlite', runId, {
      family: over.family ?? 'prompts', logicalKey: over.logicalKey ?? `k-${Math.random().toString(36).slice(2)}`,
      disposition: (over.disposition ?? 'diverged') as never, priority: (over.priority ?? 'P3') as never,
    });

  /**
   * Engineer a genuinely-diverged global SKILL (skills seed real global rows in a bare adapter) WITH an
   * upstream to adopt: publish a base + an upstream version, edit the live row so base ≠ local ≠ remote, and
   * file a diverged detail for it.
   */
  async function seedDivergedSkill() {
    const spec = realmFamily('skills');
    const field = 'description'; // a plain-text semantic column that isn't the logical key (skills key = id)
    const row = raw().prepare(`SELECT * FROM skills WHERE realm='global' LIMIT 1`).get() as Record<string, unknown>;
    const key = logicalKeyOfRow(spec, row);
    const base = semanticOfRow(spec, row);
    const log = createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
    const baseV = await log.append({ family: 'skills', logicalKey: key, payload: base });
    await log.append({ family: 'skills', logicalKey: key, payload: { ...base, [field]: 'UPSTREAM_VALUE' } }); // remote = latest
    // Edit the live row (local diverges) and baseline it to the base version → base ≠ local ≠ remote = diverged.
    raw().prepare(`UPDATE skills SET ${field} = ?, origin_hash = ? WHERE id = ?`).run('LOCAL_EDIT', baseV.contentHash, row['id']);
    await recordUpgradeDetail(client(), 'sqlite', runId, { family: 'skills', logicalKey: key, disposition: 'diverged', priority: 'P3' });
    const detail = raw().prepare(`SELECT id FROM upgrade_details WHERE family='skills' AND logical_key=? LIMIT 1`).get(key) as { id: string };
    return { detailId: detail.id, recordId: String(row['id']), key, field };
  }
  const skillField = (id: string, field: string) => (raw().prepare(`SELECT ${field} AS v FROM skills WHERE id=?`).get(id) as { v: string }).v;

  it('POSITIVE: the queue lists unresolved items P1→P5 with tallies', async () => {
    await addDetail({ family: 'guardrails', priority: 'P1' });
    await addDetail({ family: 'prompts', priority: 'P3' });
    const q = await getReviewQueue(client(), 'sqlite');
    expect(q.items.length).toBe(2);
    expect(q.items[0]!.priority).toBe('P1'); // most-urgent first
    expect(q.byPriority).toMatchObject({ P1: 1, P3: 1 });
  });

  it('KEEP: marks the item resolved with no data change', async () => {
    await addDetail({ logicalKey: 'keep-me' });
    const id = (raw().prepare(`SELECT id FROM upgrade_details WHERE logical_key='keep-me'`).get() as { id: string }).id;
    const r = await resolveReviewItem(client(), 'sqlite', id, 'keep', { resolvedBy: 'admin-1' });
    expect(r.ok).toBe(true);
    expect(await getUpgradeDetail(client(), 'sqlite', id)).toMatchObject({ resolution: 'kept', resolved_by: 'admin-1' });
    expect((await getReviewQueue(client(), 'sqlite')).items.length).toBe(0); // gone from the queue
  });

  it('DEFER: records the comment alongside the release note', async () => {
    await addDetail({ logicalKey: 'defer-me' });
    const id = (raw().prepare(`SELECT id FROM upgrade_details WHERE logical_key='defer-me'`).get() as { id: string }).id;
    await resolveReviewItem(client(), 'sqlite', id, 'defer', { resolvedBy: 'admin-1', comment: 'waiting on legal' });
    const row = await getUpgradeDetail(client(), 'sqlite', id);
    expect(row?.resolution).toBe('deferred');
    expect(row?.note).toContain('waiting on legal');
  });

  it('ADOPT + UNDO: adopt takes upstream and re-baselines; undo restores the exact prior row', async () => {
    const { detailId, recordId, field } = await seedDivergedSkill();
    expect(skillField(recordId, field)).toBe('LOCAL_EDIT');
    const adopt = await resolveReviewItem(client(), 'sqlite', detailId, 'adopt', { resolvedBy: 'admin-1' });
    expect(adopt.ok).toBe(true);
    expect(skillField(recordId, field)).toBe('UPSTREAM_VALUE');                  // took the shipped upstream
    expect(await getUpgradeDetail(client(), 'sqlite', detailId)).toMatchObject({ resolution: 'adopted' });
    const undo = await undoReviewItem(client(), 'sqlite', detailId);
    expect(undo.ok).toBe(true);
    expect(skillField(recordId, field)).toBe('LOCAL_EDIT');                      // restored the operator's edit
    expect((await getUpgradeDetail(client(), 'sqlite', detailId))?.resolution).toBe(null); // back in the queue
  });

  it('BULK GUARDRAIL: bulk never resolves P1, even when it matches; a P1-scoped bulk is refused', async () => {
    await addDetail({ family: 'guardrails', priority: 'P1', logicalKey: 'g1' });
    await addDetail({ family: 'prompts', priority: 'P3', logicalKey: 'p1' });
    await addDetail({ family: 'prompts', priority: 'P3', logicalKey: 'p2' });
    const res = await bulkResolveReview(client(), 'sqlite', 'keep', {}, { resolvedBy: 'admin-1' });
    expect(res).toMatchObject({ resolved: 2, skippedP1: 1 });                    // both P3 kept, the P1 skipped
    expect((await getUpgradeDetail(client(), 'sqlite', (raw().prepare(`SELECT id FROM upgrade_details WHERE logical_key='g1'`).get() as { id: string }).id))?.resolution).toBe(null); // P1 untouched
    // A bulk explicitly scoped to P1 is refused outright.
    const p1 = await bulkResolveReview(client(), 'sqlite', 'keep', { priority: 'P1' });
    expect(p1).toMatchObject({ resolved: 0, skippedP1: 1 });
  });

  it('NEGATIVE: unknown id, already-resolved, and adopt of a non-content family all fail cleanly', async () => {
    expect((await resolveReviewItem(client(), 'sqlite', 'nope', 'keep')).ok).toBe(false);
    await addDetail({ logicalKey: 'twice' });
    const id = (raw().prepare(`SELECT id FROM upgrade_details WHERE logical_key='twice'`).get() as { id: string }).id;
    await resolveReviewItem(client(), 'sqlite', id, 'keep');
    expect((await resolveReviewItem(client(), 'sqlite', id, 'keep')).reason).toContain('already resolved');
    // 'schema' is not a realm family — adopt has no record to overwrite.
    await addDetail({ family: 'schema', logicalKey: 'm999', priority: 'P3' });
    const sid = (raw().prepare(`SELECT id FROM upgrade_details WHERE family='schema'`).get() as { id: string }).id;
    expect((await resolveReviewItem(client(), 'sqlite', sid, 'adopt')).reason).toContain('non-content layer');
  });

  it('STRESS: a large queue bulk-resolves in one pass', async () => {
    for (let i = 0; i < 200; i++) await addDetail({ family: 'prompts', priority: 'P3', logicalKey: `bulk-${i}` });
    const res = await bulkResolveReview(client(), 'sqlite', 'keep', { family: 'prompts' }, { resolvedBy: 'admin-1' });
    expect(res.resolved).toBe(200);
    expect((await getReviewQueue(client(), 'sqlite', { family: 'prompts' })).items.length).toBe(0);
  });
});
