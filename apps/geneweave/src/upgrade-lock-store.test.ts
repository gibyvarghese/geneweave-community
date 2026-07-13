// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — the single-instance advisory MUTEX (`upgrade_lock`). Real booted SQLite (m170 seeds the
 * singleton row). Covers: exclusive acquisition, idempotent re-acquire by the same holder, holder-only
 * release, stale reclaim, and the `withUpgradeLock` critical-section wrapper.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { tryAcquireUpgradeLock, releaseUpgradeLock, upgradeLockState, withUpgradeLock } from './upgrade-lock-store.js';

describe('Upgrade Engine — advisory mutex (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `lock-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  it('is mutually exclusive: a second holder cannot acquire while the first holds it', async () => {
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'A')).toBe(true);
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'B')).toBe(false);
    expect((await upgradeLockState(client(), 'sqlite')).holder).toBe('A');
  });

  it('is idempotent for the same holder (re-acquire succeeds)', async () => {
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'A')).toBe(true);
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'A')).toBe(true);
  });

  it('only the holder can release; then it is free again', async () => {
    await tryAcquireUpgradeLock(client(), 'sqlite', 'A');
    await releaseUpgradeLock(client(), 'sqlite', 'B'); // not the holder → no-op
    expect((await upgradeLockState(client(), 'sqlite')).holder).toBe('A');
    await releaseUpgradeLock(client(), 'sqlite', 'A');
    expect((await upgradeLockState(client(), 'sqlite')).holder).toBe(null);
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'B')).toBe(true); // free → B can take it
  });

  it('reclaims a STALE lock left by a crashed holder', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'CRASHED', { now: () => t0 })).toBe(true);
    // Same instant, someone else → blocked.
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'FRESH', { now: () => t0, staleMs: 60_000 })).toBe(false);
    // 2 minutes later with a 1-minute staleness window → the abandoned lock is reclaimable.
    const t2 = new Date(t0.getTime() + 120_000);
    expect(await tryAcquireUpgradeLock(client(), 'sqlite', 'FRESH', { now: () => t2, staleMs: 60_000 })).toBe(true);
    expect((await upgradeLockState(client(), 'sqlite')).holder).toBe('FRESH');
  });

  it('withUpgradeLock runs the section, releases on completion, and returns onBusy when contended', async () => {
    let ran = 0;
    const out = await withUpgradeLock(client(), 'sqlite', 'A', async () => { ran++; return 'done'; }, 'busy');
    expect(out).toBe('done');
    expect(ran).toBe(1);
    expect((await upgradeLockState(client(), 'sqlite')).holder).toBe(null); // released in finally

    // While A holds it externally, a withUpgradeLock('B') must NOT run and returns onBusy.
    await tryAcquireUpgradeLock(client(), 'sqlite', 'A');
    let ranB = 0;
    const busy = await withUpgradeLock(client(), 'sqlite', 'B', async () => { ranB++; return 'ran'; }, 'busy');
    expect(busy).toBe('busy');
    expect(ranB).toBe(0);
  });

  it('releases the lock even when the critical section throws', async () => {
    await expect(withUpgradeLock(client(), 'sqlite', 'A', async () => { throw new Error('boom'); }, null)).rejects.toThrow('boom');
    expect((await upgradeLockState(client(), 'sqlite')).holder).toBe(null);
  });
});
