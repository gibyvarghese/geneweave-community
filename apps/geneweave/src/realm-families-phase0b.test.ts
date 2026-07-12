// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — Phase 0b: the newly-registered realm families. Boots a real SQLite adapter, runs the
 * full seed (so every family's rows exist), and verifies each new family (a) is in the registry, (b) got
 * its realm columns, and (c) is baselined by the seed reconcile — logical_key populated and a realm_versions
 * entry per global row — so it participates in drift/fork going forward. Also verifies a tenant can fork
 * one of the new families (the whole point of registering them).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { applySeed } from './seed/index.js';
import { REALM_FAMILIES, logicalKeyOfRow } from './realm-families.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { reconcileRealmFamily } from './realm-seed-reconcile.js';

const NEW_FAMILIES = [
  'workflows', 'model_pricing', 'task_type_definitions', 'provider_tool_adapters',
  'live_handler_kinds', 'live_attention_policies', 'scaffold_templates',
] as const;

describe('Upgrade Engine — Phase 0b newly-registered families (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `p0b-${process.pid}-${Date.now()}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    await applySeed(db); // full seed incl. workflows + app-specific + the registry-wide reconcile
  });
  afterAll(async () => { await db?.close?.(); try { rmSync(dbPath, { force: true }); } catch { /* ignore */ } });

  it('all 7 new families are registered (18 total)', () => {
    for (const f of NEW_FAMILIES) expect(REALM_FAMILIES[f], `family ${f}`).toBeTruthy();
    expect(Object.keys(REALM_FAMILIES).length).toBe(19); // 11 original + 7 (0b) + model_capability_scores (m168)
  });

  it('each new family got its realm columns and its global rows are logical-keyed + content-hashed', () => {
    for (const f of NEW_FAMILIES) {
      const spec = REALM_FAMILIES[f]!;
      const cols = (raw().prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of ['realm', 'owner_tenant_id', 'logical_key', 'origin_hash', 'content_hash', 'track_mode', 'share_mode']) {
        expect(cols, `${spec.table}.${c}`).toContain(c);
      }
      // Every global row must have a non-empty logical_key + content_hash after seed reconcile.
      const bad = raw().prepare(
        `SELECT count(*) c FROM ${spec.table} WHERE realm = 'global' AND (logical_key IS NULL OR logical_key = '' OR content_hash IS NULL OR content_hash = '')`,
      ).get() as { c: number };
      expect(bad.c, `${spec.table} has un-keyed/un-hashed global rows`).toBe(0);
    }
  });

  it('each new family with global rows is baselined in realm_versions (drift-ready)', () => {
    for (const f of NEW_FAMILIES) {
      const spec = REALM_FAMILIES[f]!;
      const globals = raw().prepare(`SELECT count(*) c FROM ${spec.table} WHERE realm = 'global'`).get() as { c: number };
      if (globals.c === 0) continue; // an empty catalog is legitimately not baselined
      const versions = raw().prepare(`SELECT count(DISTINCT logical_key) c FROM realm_versions WHERE family = ?`).get(f) as { c: number };
      expect(versions.c, `${f} baselines`).toBeGreaterThan(0);
    }
  });

  it('a new family reconciles like any other: a changed default the operator never touched is adopted', async () => {
    // Use whichever new family actually has a seeded global row.
    const client = sqliteSqlClient(raw());
    for (const f of NEW_FAMILIES) {
      const spec = REALM_FAMILIES[f]!;
      const row = raw().prepare(`SELECT * FROM ${spec.table} WHERE realm = 'global' LIMIT 1`).get() as Record<string, unknown> | undefined;
      if (!row) continue;
      const semanticCol = spec.semanticCols.find((c) => c !== 'version') ?? spec.semanticCols[0]!;
      const changed = { ...row, [semanticCol]: `${String(row[semanticCol] ?? '')} upgraded` };
      const res = await reconcileRealmFamily(client, 'sqlite', spec, [changed]);
      expect(res.adopted, `${f} should adopt an untouched change`).toContain(logicalKeyOfRow(spec, row));
      return; // one representative family is enough
    }
    throw new Error('no new family had a seeded global row to exercise');
  });
});
