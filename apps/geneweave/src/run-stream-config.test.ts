/**
 * geneWeave — Client Phase 0: run_stream_config + journal pruning.
 *
 * Verifies the app-layer wiring end-to-end:
 *   - m91 migration creates `run_stream_config` and seeds the defaults from
 *     `RUN_STREAM_CONFIG_DEFAULTS`.
 *   - DB CRUD round-trips the fields; `loadRunStreamConfig` maps the row →
 *     `RunStreamConfig`, caches for 60s, and degrades to defaults on bad input.
 *   - `pruneUserRunEvents` enforces age-based (terminal-only) + per-run-cap
 *     retention without ever touching in-flight runs.
 *
 * Positive, negative, stress, and security/robustness cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { loadRunStreamConfig, clientStreamConfig, _resetRunStreamConfigCache } from './chat-run-stream-utils.js';
import { RUN_STREAM_CONFIG_DEFAULTS } from '@weaveintel/core';

function tmpDb(): string {
  return join(tmpdir(), `gw-run-stream-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function seedRun(db: SQLiteAdapter, id: string, userId: string, status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled', eventCount: number): Promise<void> {
  await db.createUserRun({ id, user_id: userId, status: 'pending' });
  const terminalKind = status === 'completed' ? 'run.completed' : status === 'failed' ? 'run.failed' : status === 'cancelled' ? 'run.cancelled' : 'text.delta';
  for (let i = 0; i < eventCount; i++) {
    const last = i === eventCount - 1;
    await db.appendUserRunEvent({ id: `${id}-e${i}`, run_id: id, sequence: i, kind: last ? terminalKind : 'text.delta', payload: '{}' });
  }
  if (status !== 'pending') await db.updateUserRunStatus(id, userId, status);
}

function backdateEvents(db: SQLiteAdapter, runId: string, hoursAgo: number): void {
  db.getRawDb().prepare(`UPDATE user_run_events SET created_at = datetime('now', ?) WHERE run_id = ?`).run(`-${hoursAgo} hours`, runId);
}

// ─── Migration & seed ────────────────────────────────────────

describe('run_stream_config — migration & seed', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { _resetRunStreamConfigCache(); db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); });
  afterEach(async () => { await db.close(); });

  it('seeds a single global row with the documented defaults', async () => {
    const row = await db.getRunStreamConfig();
    expect(row).toBeTruthy();
    expect(row!.id).toBe('global');
    expect(row!.enabled).toBe(1);
    expect(row!.heartbeat_ms).toBe(15000);
    expect(row!.max_reconnects).toBe(8);
    expect(row!.stall_timeout_ms).toBe(60000);
    expect(row!.journal_retention_hours).toBe(24);
    expect(row!.journal_max_events).toBe(2000);
    expect(JSON.parse(row!.backoff_ms)).toEqual(RUN_STREAM_CONFIG_DEFAULTS.backoffMs);
  });

  it('updateRunStreamConfig round-trips a field change', async () => {
    await db.updateRunStreamConfig({ heartbeat_ms: 5000, journal_max_events: 500 });
    const row = await db.getRunStreamConfig();
    expect(row!.heartbeat_ms).toBe(5000);
    expect(row!.journal_max_events).toBe(500);
    // Untouched fields are preserved.
    expect(row!.max_reconnects).toBe(8);
  });

  it('updateRunStreamConfig with no fields is a no-op (negative)', async () => {
    const before = await db.getRunStreamConfig();
    await db.updateRunStreamConfig({});
    const after = await db.getRunStreamConfig();
    expect(after!.heartbeat_ms).toBe(before!.heartbeat_ms);
  });
});

// ─── loadRunStreamConfig — mapping, cache, robustness ────────

describe('loadRunStreamConfig — mapping & cache', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { _resetRunStreamConfigCache(); db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); });
  afterEach(async () => { await db.close(); });

  it('maps the row onto RunStreamConfig (positive)', async () => {
    const cfg = await loadRunStreamConfig(db, 1000);
    expect(cfg.heartbeatMs).toBe(15000);
    expect(cfg.maxReconnects).toBe(8);
    expect(cfg.backoffMs).toEqual(RUN_STREAM_CONFIG_DEFAULTS.backoffMs);
    expect(cfg.journalRetentionHours).toBe(24);
  });

  it('clientStreamConfig exposes only the client-facing subset (no journal/retention leak)', async () => {
    const sub = clientStreamConfig(await loadRunStreamConfig(db, 1000));
    expect(sub).toHaveProperty('heartbeatMs');
    expect(sub).toHaveProperty('backoffMs');
    expect(sub).not.toHaveProperty('journalRetentionHours');
    expect(sub).not.toHaveProperty('journalMaxEvents');
  });

  it('caches for 60s, then reflects a change after the TTL window', async () => {
    await loadRunStreamConfig(db, 1_000);                 // prime cache
    await db.updateRunStreamConfig({ heartbeat_ms: 3000 });
    const stillCached = await loadRunStreamConfig(db, 31_000); // < 60s later
    expect(stillCached.heartbeatMs).toBe(15000);          // served from cache
    const afterTtl = await loadRunStreamConfig(db, 70_000);    // > 60s later
    expect(afterTtl.heartbeatMs).toBe(3000);              // refreshed
  });

  it('falls back to defaults when backoff_ms is malformed (security/robustness)', async () => {
    db.getRawDb().prepare(`UPDATE run_stream_config SET backoff_ms = '{not-an-array' WHERE id = 'global'`).run();
    const cfg = await loadRunStreamConfig(db, 5_000);
    expect(cfg.backoffMs).toEqual(RUN_STREAM_CONFIG_DEFAULTS.backoffMs);
  });

  it('falls back to defaults when the table is absent (fresh DB, no migration)', async () => {
    const bare = new SQLiteAdapter(tmpDb());
    await bare.initialize();
    bare.getRawDb().exec('DROP TABLE IF EXISTS run_stream_config');
    _resetRunStreamConfigCache();
    const cfg = await loadRunStreamConfig(bare, 9_000);
    expect(cfg).toEqual(RUN_STREAM_CONFIG_DEFAULTS);
    await bare.close();
  });
});

// ─── pruneUserRunEvents ──────────────────────────────────────

describe('pruneUserRunEvents — per-run cap', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); });
  afterEach(async () => { await db.close(); });

  it('keeps only the most recent N events per run, including the terminal one (positive)', async () => {
    await seedRun(db, 'run-cap', 'u1', 'completed', 100); // seq 0..99, terminal at 99
    const removed = await db.pruneUserRunEvents({ olderThanHours: 0, maxEventsPerRun: 10 });
    expect(removed).toBe(90);
    const left = await db.listUserRunEvents('run-cap', -1);
    expect(left).toHaveLength(10);
    expect(left.map((e) => e.sequence)).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
    expect(left[left.length - 1]!.kind).toBe('run.completed'); // terminal preserved
  });

  it('maxEventsPerRun=0 disables the cap (negative)', async () => {
    await seedRun(db, 'run-nocap', 'u1', 'running', 5);
    const removed = await db.pruneUserRunEvents({ olderThanHours: 0, maxEventsPerRun: 0 });
    expect(removed).toBe(0);
    expect(await db.listUserRunEvents('run-nocap', -1)).toHaveLength(5);
  });

  it('stress: trims a 5000-event run to the cap and keeps the tail', async () => {
    await seedRun(db, 'run-big', 'u1', 'running', 5000);
    await db.pruneUserRunEvents({ olderThanHours: 0, maxEventsPerRun: 2000 });
    const left = await db.listUserRunEvents('run-big', -1);
    expect(left).toHaveLength(2000);
    expect(left[0]!.sequence).toBe(3000);
    expect(left[left.length - 1]!.sequence).toBe(4999);
  });
});

describe('pruneUserRunEvents — age-based (terminal only)', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => { db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData(); });
  afterEach(async () => { await db.close(); });

  it('prunes old TERMINAL runs but never in-flight runs (positive + security)', async () => {
    await seedRun(db, 'run-old-done', 'u1', 'completed', 3);
    await seedRun(db, 'run-old-live', 'u1', 'running', 3);
    backdateEvents(db, 'run-old-done', 48);
    backdateEvents(db, 'run-old-live', 48); // also old, but NOT terminal

    const removed = await db.pruneUserRunEvents({ olderThanHours: 24, maxEventsPerRun: 0 });
    expect(removed).toBe(3);
    expect(await db.listUserRunEvents('run-old-done', -1)).toHaveLength(0); // terminal + old → pruned
    expect(await db.listUserRunEvents('run-old-live', -1)).toHaveLength(3); // in-flight → retained
  });

  it('does not prune fresh terminal runs within the horizon (negative)', async () => {
    await seedRun(db, 'run-fresh-done', 'u1', 'completed', 3); // created_at = now
    const removed = await db.pruneUserRunEvents({ olderThanHours: 24, maxEventsPerRun: 0 });
    expect(removed).toBe(0);
    expect(await db.listUserRunEvents('run-fresh-done', -1)).toHaveLength(3);
  });

  it('olderThanHours=0 disables age pruning (negative)', async () => {
    await seedRun(db, 'run-x', 'u1', 'completed', 3);
    backdateEvents(db, 'run-x', 100);
    const removed = await db.pruneUserRunEvents({ olderThanHours: 0, maxEventsPerRun: 0 });
    expect(removed).toBe(0);
  });
});
