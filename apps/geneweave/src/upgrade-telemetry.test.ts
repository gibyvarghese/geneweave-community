// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — telemetry opt-out gate + local, PII-free upgrade-lifecycle recording.
 *
 * Covers the opt-out semantics (DO_NOT_TRACK / GENEWEAVE_TELEMETRY), that recording is a no-op when opted out,
 * counts sanitization (no non-number can ride into the stored JSON), the read path, stress + concurrency (many
 * events recorded without corruption), and that the global `recordTraceSpans` gate honors the opt-out.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { telemetryEnabled } from './telemetry-config.js';
import { recordUpgradeTelemetry, listUpgradeTelemetry } from './upgrade-telemetry.js';
import { recordTraceSpans } from './chat-trace-utils.js';

describe('Upgrade Engine — telemetry opt-out gate (pure)', () => {
  it('is ON by default and honors DO_NOT_TRACK + GENEWEAVE_TELEMETRY opt-outs', () => {
    expect(telemetryEnabled({})).toBe(true);                                  // default: enabled
    expect(telemetryEnabled({ DO_NOT_TRACK: '1' })).toBe(false);             // DNT convention
    expect(telemetryEnabled({ DO_NOT_TRACK: 'true' })).toBe(false);
    expect(telemetryEnabled({ DO_NOT_TRACK: '0' })).toBe(true);              // DNT=0 is NOT opt-out
    for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) expect(telemetryEnabled({ GENEWEAVE_TELEMETRY: v })).toBe(false);
    for (const v of ['1', 'true', 'on', 'yes', '']) expect(telemetryEnabled({ GENEWEAVE_TELEMETRY: v })).toBe(true);
  });
});

describe('Upgrade Engine — upgrade telemetry (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const count = () => (raw().prepare(`SELECT COUNT(*) c FROM upgrade_telemetry`).get() as { c: number }).c;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `telemetry-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  it('POSITIVE: records a PII-free event when enabled; readable newest-first', async () => {
    const ok = await recordUpgradeTelemetry(client(), 'sqlite', 'apply', {
      outcome: 'succeeded', edition: 'community', fromVersion: '1.0.0', toVersion: '2.0.0',
      counts: { adopted: 3, published: 1, review: 2 },
    }, { env: {} });
    expect(ok).toBe(true);
    const rows = await listUpgradeTelemetry(client(), 'sqlite');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'apply', outcome: 'succeeded', edition: 'community', to_version: '2.0.0' });
    expect(JSON.parse(rows[0]!.counts_json!)).toEqual({ adopted: 3, published: 1, review: 2 });
    // PII-free by schema: the table has no user/key/path/payload column.
    const cols = (raw().prepare(`PRAGMA table_info(upgrade_telemetry)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('user_id');
    expect(cols.some((c) => /user|email|key|path|payload|prompt/.test(c))).toBe(false);
  });

  it('OPT-OUT: recording is a no-op when the operator opted out (nothing written)', async () => {
    expect(await recordUpgradeTelemetry(client(), 'sqlite', 'apply', { outcome: 'succeeded' }, { env: { DO_NOT_TRACK: '1' } })).toBe(false);
    expect(await recordUpgradeTelemetry(client(), 'sqlite', 'apply', { outcome: 'succeeded' }, { env: { GENEWEAVE_TELEMETRY: '0' } })).toBe(false);
    expect(count()).toBe(0);
  });

  it('SECURITY: counts are sanitized — only finite numbers survive (no object/string leak into the JSON)', async () => {
    await recordUpgradeTelemetry(client(), 'sqlite', 'prune', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      counts: { deleted: 5, evil: { secret: 'x' } as any, note: 'leak' as any, nan: NaN, inf: Infinity } as any,
    }, { env: {} });
    const row = (await listUpgradeTelemetry(client(), 'sqlite'))[0]!;
    expect(JSON.parse(row.counts_json!)).toEqual({ deleted: 5 }); // object/string/NaN/Infinity all dropped
  });

  it('READ: event filter + limit', async () => {
    for (let i = 0; i < 5; i++) await recordUpgradeTelemetry(client(), 'sqlite', 'check', { outcome: 'rejected' }, { env: {} });
    for (let i = 0; i < 3; i++) await recordUpgradeTelemetry(client(), 'sqlite', 'apply', { outcome: 'succeeded' }, { env: {} });
    expect(await listUpgradeTelemetry(client(), 'sqlite', { event: 'check' })).toHaveLength(5);
    expect(await listUpgradeTelemetry(client(), 'sqlite', { limit: 2 })).toHaveLength(2);
  });

  it('STRESS + CONCURRENCY: 2000 concurrent records all land, no corruption', async () => {
    const N = 2000;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, (_, i) => recordUpgradeTelemetry(client(), 'sqlite', 'reconcile', { counts: { i } }, { env: {} })));
    const ms = performance.now() - t0;
    expect(count()).toBe(N); // every event persisted exactly once — no lost writes
    // eslint-disable-next-line no-console
    console.log(`[telemetry stress] ${N} concurrent records in ${ms.toFixed(0)}ms (${Math.round(N / (ms / 1000))}/s)`);
  });
});

describe('Upgrade Engine — recordTraceSpans honors the global opt-out', () => {
  it('records NO run trace when telemetry is opted out', async () => {
    let saved = 0;
    // A minimal fake adapter — recordTraceSpans only needs saveTrace; the opt-out must short-circuit before it.
    const fakeDb = { saveTrace: async () => { saved++; } } as unknown as DatabaseAdapter;
    const prev = process.env['GENEWEAVE_TELEMETRY'];
    try {
      process.env['GENEWEAVE_TELEMETRY'] = '0';
      await recordTraceSpans(fakeDb, 'u1', 'c1', 'm1', 't1', 'chat', 0, 10);
      expect(saved).toBe(0); // opted out → nothing recorded
      delete process.env['GENEWEAVE_TELEMETRY'];
      await recordTraceSpans(fakeDb, 'u1', 'c1', 'm1', 't1', 'chat', 0, 10);
      expect(saved).toBeGreaterThan(0); // default on → the root span is recorded
    } finally {
      if (prev === undefined) delete process.env['GENEWEAVE_TELEMETRY']; else process.env['GENEWEAVE_TELEMETRY'] = prev;
    }
  });
});
