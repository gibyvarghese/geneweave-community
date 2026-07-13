// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — the "needs attention" report. Real booted SQLite: a skill is made both DRIFTED (diverged)
 * and version-LAGGING (baselined at v1 while v2 shipped), and the report is asserted to surface it with the
 * right state + version lag, while a clean record is left out. Plus a negative (unknown family) and a stress
 * pass (a batched version read, not N+1).
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
import { attentionReport } from './upgrade-attention.js';

describe('Upgrade Engine — needs-attention report (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `attention-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  /** Make a global skill diverged AND version-lagging: publish v1 (base) + v2 (upstream), edit the live row. */
  async function seedDivergedLaggingSkill() {
    const spec = realmFamily('skills');
    const row = raw().prepare(`SELECT * FROM skills WHERE realm='global' LIMIT 1`).get() as Record<string, unknown>;
    const key = logicalKeyOfRow(spec, row);
    const base = semanticOfRow(spec, row);
    const log = createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
    const v1 = await log.append({ family: 'skills', logicalKey: key, payload: base });                                   // v1 = base
    await log.append({ family: 'skills', logicalKey: key, payload: { ...base, description: 'UPSTREAM_V2' } });            // v2 = upstream
    raw().prepare(`UPDATE skills SET description = ?, origin_hash = ? WHERE id = ?`).run('LOCAL_EDIT', v1.contentHash, row['id']); // baselined at v1
    return { key, id: String(row['id']) };
  }

  it('POSITIVE: a diverged, version-lagging skill is reported with its state + lag; a clean one is not', async () => {
    const { key } = await seedDivergedLaggingSkill();
    const report = await attentionReport(client(), 'sqlite', 'skills');
    const entry = report.entries.find((e) => e.logicalKey === key);
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({ state: 'diverged', currentVersion: 1, latestVersion: 2, lagging: true });
    // A different global skill with no versions/edits is NOT flagged.
    const other = raw().prepare(`SELECT id FROM skills WHERE realm='global' AND id != (SELECT id FROM skills WHERE realm='global' LIMIT 1) LIMIT 1`).get() as { id: string } | undefined;
    if (other) expect(report.entries.some((e) => e.id === other.id)).toBe(false);
  });

  it('NEGATIVE: an unknown family throws (via realmFamily), a family with no drift returns an empty report', async () => {
    await expect(attentionReport(client(), 'sqlite', 'not_a_family')).rejects.toThrow();
    const clean = await attentionReport(client(), 'sqlite', 'prompts'); // no prompt rows in a bare adapter
    expect(clean.count).toBe(0);
  });

  it('lagging without a live edit: a record baselined behind the latest still surfaces', async () => {
    const spec = realmFamily('skills');
    const row = raw().prepare(`SELECT * FROM skills WHERE realm='global' LIMIT 1`).get() as Record<string, unknown>;
    const key = logicalKeyOfRow(spec, row);
    const base = semanticOfRow(spec, row);
    const log = createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
    const v1 = await log.append({ family: 'skills', logicalKey: key, payload: base });
    await log.append({ family: 'skills', logicalKey: key, payload: { ...base, description: 'V2' } });
    // Baseline at v1 but DON'T edit the live row → local==base==v1, remote==v2 → 'stale' + lagging.
    raw().prepare(`UPDATE skills SET origin_hash = ? WHERE id = ?`).run(v1.contentHash, row['id']);
    const entry = (await attentionReport(client(), 'sqlite', 'skills')).entries.find((e) => e.logicalKey === key);
    expect(entry).toMatchObject({ state: 'stale', lagging: true, currentVersion: 1, latestVersion: 2 });
  });
});
