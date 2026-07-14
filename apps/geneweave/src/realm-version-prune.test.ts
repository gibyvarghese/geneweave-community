// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — `realm_versions` retention pruning. Real booted SQLite.
 *
 * Covers the keep-set invariants (head window ∪ live-referenced ∪ pinned are NEVER deleted), dry-run,
 * idempotency, negatives, stress (10k versions within budget), concurrency (parallel prunes converge with no
 * corruption), and the security-critical property: a pinned or live-referenced version can never be pruned
 * (which would silently drop a tenant off its pin / destroy a diff baseline).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createSqlVersionLog } from '@weaveintel/realm';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { pruneRealmVersions } from './realm-version-prune.js';

const FAMILY = 'prompts';

describe('Upgrade Engine — realm_versions pruning (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const log = () => createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });

  beforeEach(async () => {
    dbPath = join(tmpdir(), `prune-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  /** Append `n` distinct versions for a key; returns their content hashes indexed by version (1-based). */
  async function seedVersions(logicalKey: string, n: number): Promise<Record<number, string>> {
    const byVersion: Record<number, string> = {};
    for (let i = 1; i <= n; i++) {
      const v = await log().append({ family: FAMILY, logicalKey, payload: { step: i, body: `payload-${i}` } });
      byVersion[v.version] = v.contentHash;
    }
    return byVersion;
  }
  const versionsOf = (logicalKey: string): number[] =>
    (raw().prepare(`SELECT version FROM realm_versions WHERE family=? AND logical_key=? ORDER BY version`).all(FAMILY, logicalKey) as Array<{ version: number }>).map((r) => r.version);

  it('POSITIVE: keeps the newest keepPerKey versions per key, deletes the older tail', async () => {
    await seedVersions('k', 6);
    const res = await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 2, family: FAMILY });
    expect(res.examined).toBe(6);
    expect(res.deleted).toBe(4);
    expect(res.kept).toBe(2);
    expect(versionsOf('k')).toEqual([5, 6]); // the two newest survive; the head (6) is always kept
  });

  it('KEEP: a live row referencing an OLD version by origin_hash pins it against pruning', async () => {
    await db.seedDefaultData?.(); // populate live prompt rows to reference from
    const hashes = await seedVersions('k', 6);
    // A live prompt row whose origin_hash points at version 2 (the Base it was forked/baselined from).
    const anyPrompt = raw().prepare(`SELECT id FROM prompts LIMIT 1`).get() as { id: string } | undefined;
    expect(anyPrompt, 'seeded prompts exist').toBeTruthy();
    raw().prepare(`UPDATE prompts SET origin_hash=? WHERE id=?`).run(hashes[2], anyPrompt!.id);
    await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 2, family: FAMILY });
    // 5,6 (head window) + 2 (referenced) survive; 1,3,4 pruned.
    expect(versionsOf('k')).toEqual([2, 5, 6]);
  });

  it('KEEP: a tenant pin holds its exact version number, however old', async () => {
    await seedVersions('k', 6);
    // Tenant pins version 3 of key 'k'.
    raw().prepare(`INSERT INTO realm_tenant_state (id, tenant_id, family, logical_key, pinned_version, updated_at) VALUES ('s1','t1',?, 'k', 3, datetime('now'))`).run(FAMILY);
    await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 2, family: FAMILY });
    expect(versionsOf('k')).toEqual([3, 5, 6]); // 5,6 head + 3 pinned
  });

  it('DRY RUN: reports the plan (would-delete count) without touching the table', async () => {
    await seedVersions('k', 6);
    const res = await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 2, family: FAMILY, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.deleted).toBe(4);            // the PLAN
    expect(versionsOf('k')).toEqual([1, 2, 3, 4, 5, 6]); // nothing actually deleted
  });

  it('IDEMPOTENT: a second prune deletes nothing new', async () => {
    await seedVersions('k', 6);
    await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 2, family: FAMILY });
    const again = await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 2, family: FAMILY });
    expect(again.deleted).toBe(0);
    expect(versionsOf('k')).toEqual([5, 6]);
  });

  it('NEGATIVE: an unknown family throws (a typo must not silently prune nothing across all families)', async () => {
    await expect(pruneRealmVersions(client(), 'sqlite', { family: 'not_a_family' })).rejects.toThrow(/unknown realm family/);
  });

  it('BOUNDARY: keepPerKey below 1 is clamped to 1 (the head is never deletable)', async () => {
    await seedVersions('k', 4);
    await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 0, family: FAMILY });
    expect(versionsOf('k')).toEqual([4]); // only the head survives, but it DOES survive
  });

  it('STRESS: pruning a 10k-version log completes within budget and keeps exactly the head window', async () => {
    const N = 10_000, KEYS = 100, PER = N / KEYS;
    const ins = raw().prepare(`INSERT INTO realm_versions (id, family, logical_key, version, content_hash, payload, published_at) VALUES (?,?,?,?,?,?,datetime('now'))`);
    raw().transaction(() => {
      for (let k = 0; k < KEYS; k++) for (let v = 1; v <= PER; v++) ins.run(`r-${k}-${v}`, FAMILY, `key${k}`, v, `sha256:h${k}-${v}`, '{}');
    })();
    const t0 = performance.now();
    const res = await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 5, family: FAMILY });
    const ms = performance.now() - t0;
    expect(res.examined).toBe(N);
    expect(res.deleted).toBe(N - KEYS * 5); // 5 kept per key
    expect(res.kept).toBe(KEYS * 5);
    // eslint-disable-next-line no-console
    console.log(`[prune stress] ${N} versions across ${KEYS} keys pruned in ${ms.toFixed(0)}ms (${Math.round(N / (ms / 1000))}/s)`);
    expect(ms).toBeLessThan(60_000);
  });

  it('CONCURRENCY: 100 concurrent prunes converge to the same keep-set with no error or corruption', async () => {
    await seedVersions('k', 50);
    // Fire 100 prunes at the same log; DELETE ... WHERE id IN (...) is naturally idempotent (a row already
    // gone matches nothing), so racing passes must converge, never error or over/under-delete.
    const results = await Promise.all(Array.from({ length: 100 }, () => pruneRealmVersions(client(), 'sqlite', { keepPerKey: 5, family: FAMILY })));
    expect(results.every((r) => r.examined >= 5)).toBe(true);
    expect(versionsOf('k')).toEqual([46, 47, 48, 49, 50]); // exactly the head window remains — no lost/extra rows
  });

  it('SECURITY: a pinned + referenced version is NEVER deleted, even under an aggressive keepPerKey=1', async () => {
    await db.seedDefaultData?.();
    const hashes = await seedVersions('k', 8);
    raw().prepare(`INSERT INTO realm_tenant_state (id, tenant_id, family, logical_key, pinned_version, updated_at) VALUES ('s1','t1',?, 'k', 2, datetime('now'))`).run(FAMILY);
    const anyPrompt = raw().prepare(`SELECT id FROM prompts LIMIT 1`).get() as { id: string };
    raw().prepare(`UPDATE prompts SET origin_hash=? WHERE id=?`).run(hashes[5], anyPrompt.id);
    await pruneRealmVersions(client(), 'sqlite', { keepPerKey: 1, family: FAMILY });
    // head (8) + pinned (2) + referenced (5) — data an operator/tenant depends on is untouched.
    expect(versionsOf('k')).toEqual([2, 5, 8]);
  });
});
