// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — L2 Private-edition patch reapply. A sanctioned patch (operator baseline + edit) reapplies
 * onto the new vendor file via a real three-way merge: non-overlapping vendor changes merge cleanly; the same
 * lines changed on both sides is a conflict that enters the review queue (as a P1, never silently dropped).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { beginUpgradeRun } from './upgrade-run-store.js';
import { getReviewQueue, bulkResolveReview } from './upgrade-review.js';
import { reapplyPatch, reapplyPatchSet, recordPatchConflicts, type OperatorPatch } from './code-patch.js';

describe('L2 Private-edition patch reapply', () => {
  it('CLEAN: an operator edit reapplies over a NON-overlapping vendor change', () => {
    const patch: OperatorPatch = { path: 'a.ts', baseline: 'l1\nl2\nl3\nl4', edited: 'l1\nMINE\nl3\nl4' }; // edits l2
    const newVendor = 'l1\nl2\nl3\nTHEIRS';                                                                  // vendor edits l4
    const r = reapplyPatch(patch, newVendor);
    expect(r.clean).toBe(true);
    expect(r.merged).toContain('MINE');    // operator's edit kept
    expect(r.merged).toContain('THEIRS');  // vendor's change kept
  });

  it('CONFLICT: the same line changed on both sides no longer applies cleanly (never silently clobbered)', () => {
    const patch: OperatorPatch = { path: 'a.ts', baseline: 'l1\nl2\nl3', edited: 'l1\nMINE\nl3' };
    const newVendor = 'l1\nVENDOR\nl3';                                    // vendor changed the same line
    const r = reapplyPatch(patch, newVendor);
    expect(r.clean).toBe(false);
    expect(r.merged).toContain('<<<<<<<');
    expect(r.merged).toContain('MINE');
    expect(r.merged).toContain('VENDOR');   // the vendor's change is preserved in the conflict, not lost
  });

  it('ORPHAN: the vendor deletes a file the operator customised → conflict, edit surfaced not lost', () => {
    const r = reapplyPatch({ path: 'gone.ts', baseline: 'x', edited: 'x-edited' }, null);
    expect(r.clean).toBe(false);
    expect(r.merged).toBe('x-edited');
  });

  it('reapplyPatchSet tallies clean vs conflict across a set', () => {
    const patches: OperatorPatch[] = [
      { path: 'clean.ts', baseline: 'a\nb', edited: 'A\nb' },
      { path: 'conflict.ts', baseline: 'a\nb', edited: 'a\nMINE' },
    ];
    const vendor: Record<string, string | null> = { 'clean.ts': 'a\nb', 'conflict.ts': 'a\nTHEIRS' };
    const set = reapplyPatchSet(patches, (p) => vendor[p] ?? null);
    expect(set.cleanCount).toBe(1);
    expect(set.conflicts).toEqual(['conflict.ts']);
  });

  describe('review-queue integration (real booted SQLite)', () => {
    let db: DatabaseAdapter;
    let dbPath: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = () => (db as any).d as Database.Database;
    const client = () => sqliteSqlClient(raw());
    beforeEach(async () => { dbPath = join(tmpdir(), `patch-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`); db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath }); });
    afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

    it('a locked-mode patch conflict enters the review queue as a P1 and is never bulk-resolved', async () => {
      const runId = await beginUpgradeRun(client(), 'sqlite', { mode: 'preview', toVersion: 'patch' });
      const set = reapplyPatchSet(
        [{ path: 'clean.ts', baseline: 'a\nb', edited: 'A\nb' }, { path: 'bad.ts', baseline: 'a\nb', edited: 'a\nMINE' }],
        (p) => ({ 'clean.ts': 'a\nb', 'bad.ts': 'a\nTHEIRS' } as Record<string, string | null>)[p] ?? null,
      );
      const recorded = await recordPatchConflicts(client(), 'sqlite', runId, set);
      expect(recorded).toBe(1); // only the conflict is recorded (clean reapplies just apply)
      const item = (await getReviewQueue(client(), 'sqlite', { family: 'code' })).items[0]!;
      expect(item).toMatchObject({ logical_key: 'bad.ts', disposition: 'conflict', priority: 'P1' });
      // The P1 patch conflict survives a bulk keep-mine (server guardrail).
      const bulk = await bulkResolveReview(client(), 'sqlite', 'keep', { family: 'code' });
      expect(bulk).toMatchObject({ resolved: 0, skippedP1: 1 });
    });
  });
});
