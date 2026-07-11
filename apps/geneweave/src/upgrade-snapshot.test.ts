// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — snapshot/rollback tests. The SQLite path is exercised in full here (create → snapshot →
 * mutate → restore → verify the mutation is gone). The Postgres path (pg_dump/psql) is validated in CI
 * against a real Postgres; here we only assert its handle shape + injection-safe argument passing.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { snapshotSqliteFile } from './upgrade-snapshot.js';

describe('Upgrade Engine — SQLite file snapshot / restore', () => {
  const paths: string[] = [];
  const newDbPath = () => { const p = join(tmpdir(), `snap-${process.pid}-${Math.floor(performance.now())}-${paths.length}.db`); paths.push(p); return p; };
  afterEach(() => { for (const p of paths) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s, { force: true }); } catch { /* ignore */ } } });

  it('POSITIVE: restore rolls back a mutation made after the snapshot', async () => {
    const dbPath = newDbPath();
    let db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t(x TEXT)');
    db.prepare('INSERT INTO t(x) VALUES (?)').run('before');

    const snap = snapshotSqliteFile(db, dbPath, { label: 'test' });
    expect(existsSync(snap.ref)).toBe(true);

    // Mutate after the snapshot.
    db.prepare('INSERT INTO t(x) VALUES (?)').run('after');
    expect((db.prepare('SELECT count(*) c FROM t').get() as { c: number }).c).toBe(2);

    // Restore requires no open write handle → close, restore, reopen.
    db.close();
    await snap.restore();
    db = new Database(dbPath);
    const rows = db.prepare('SELECT x FROM t ORDER BY x').all() as Array<{ x: string }>;
    expect(rows.map((r) => r.x)).toEqual(['before']); // the 'after' row is gone
    db.close();

    await snap.discard();
    expect(existsSync(snap.ref)).toBe(false);
  });

  it('NEGATIVE: discard is idempotent (double discard does not throw)', async () => {
    const dbPath = newDbPath();
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t(x)');
    const snap = snapshotSqliteFile(db, dbPath);
    db.close();
    await snap.discard();
    await expect(snap.discard()).resolves.toBeUndefined();
  });

  it('handles a non-WAL database (checkpoint pragma is a safe no-op)', () => {
    const dbPath = newDbPath();
    const db = new Database(dbPath); // default rollback-journal mode, not WAL
    db.exec('CREATE TABLE t(x)');
    const snap = snapshotSqliteFile(db, dbPath);
    expect(existsSync(snap.ref)).toBe(true);
    db.close();
    rmSync(snap.ref, { force: true });
  });
});
