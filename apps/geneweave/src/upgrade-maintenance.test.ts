// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — the maintenance flag (`upgrade_maintenance`, m171). Real booted SQLite; covers set / read /
 * clear and the idempotent seed row.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { setMaintenance, clearMaintenance, isMaintenanceActive, maintenanceState } from './upgrade-maintenance.js';

describe('Upgrade Engine — maintenance flag (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `maint-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  it('starts inactive (seeded row)', async () => {
    expect(await isMaintenanceActive(client(), 'sqlite')).toBe(false);
  });

  it('set raises the flag with a reason + timestamp; clear lowers it', async () => {
    await setMaintenance(client(), 'sqlite', 'applying release 2.0.0');
    const on = await maintenanceState(client(), 'sqlite');
    expect(on).toMatchObject({ active: true, reason: 'applying release 2.0.0' });
    expect(on.since).toBeTruthy();
    await clearMaintenance(client(), 'sqlite');
    expect(await maintenanceState(client(), 'sqlite')).toMatchObject({ active: false, reason: null, since: null });
  });

  it('clear is idempotent (safe when already off)', async () => {
    await clearMaintenance(client(), 'sqlite');
    await clearMaintenance(client(), 'sqlite');
    expect(await isMaintenanceActive(client(), 'sqlite')).toBe(false);
  });
});
