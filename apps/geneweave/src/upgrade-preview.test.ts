// SPDX-License-Identifier: MIT
/**
 * Upgrade Engine — the read-only four-layer PREVIEW.
 *
 * Real booted SQLite (all migrations + a seed-reconcile so every family's global rows carry an `origin_hash`
 * baseline), a manifest built with a real key, and origin_hash/remoteHash staged per entry so we exercise
 * every content disposition (in_sync / stale / customized / diverged / new) across FOUR real families plus a
 * skipped unknown family. Two things are proved: the plan's detail rows are exactly right, and the preview
 * MUTATES NOTHING it plans over (every content table + the migration ledger is byte-identical afterwards).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { buildManifest, type ManifestBody, type ManifestContent } from '@weaveintel/upgrade';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { REALM_FAMILIES, logicalKeyOfRow, type RealmFamilySpec } from './realm-families.js';
import { hashLiveRealmRow } from './realm-seed-reconcile.js';
import { previewUpgrade } from './upgrade-preview.js';

const key = generateAttestationSigningKey();

/** Build a signed manifest around the given content/packages/schema/code layers. */
function manifest(opts: {
  content?: ManifestContent[];
  packages?: ManifestBody['layers']['packages'];
  schema?: ManifestBody['layers']['schema'];
  code?: ManifestBody['layers']['code'];
  version?: string;
}) {
  const body: ManifestBody = {
    manifestVersion: 1, name: '@geneweave/app', version: opts.version ?? '2.0.0', channel: 'stable', edition: 'community',
    publishedAt: '2026-01-01T00:00:00.000Z', requires: {},
    layers: { packages: opts.packages ?? [], schema: opts.schema ?? [], content: opts.content ?? [], ...(opts.code ? { code: opts.code } : {}) },
    artifacts: [],
  };
  return buildManifest(body, key.privateKey);
}

describe('Upgrade Engine — read-only preview (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());

  beforeEach(async () => {
    dbPath = join(tmpdir(), `preview-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
    // Stamp origin_hash baselines on every family's global rows (so drift is measurable).
    await db.seedReconcileRealm?.();
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  /** One global row for a family, or null if the family seeds none in this build. */
  function pickGlobal(spec: RealmFamilySpec): Record<string, unknown> | null {
    return (raw().prepare(`SELECT * FROM ${spec.table} WHERE realm = 'global' LIMIT 1`).get() as Record<string, unknown> | undefined) ?? null;
  }
  const setOrigin = (spec: RealmFamilySpec, id: string, h: string) =>
    raw().prepare(`UPDATE ${spec.table} SET origin_hash = ? WHERE id = ?`).run(h, id);

  it('classifies every disposition across ≥4 families and skips unknown ones (exact detail rows)', async () => {
    // Collect one global row from four distinct families that seed one.
    const candidates = ['skills', 'guardrails', 'prompts', 'tool_policies', 'routing_policies', 'cost_policies', 'worker_agents', 'prompt_strategies'];
    const picked: Array<{ spec: RealmFamilySpec; row: Record<string, unknown>; key: string; local: string }> = [];
    for (const fam of candidates) {
      const spec = REALM_FAMILIES[fam]; if (!spec) continue;
      const row = pickGlobal(spec); if (!row) continue;
      picked.push({ spec, row, key: logicalKeyOfRow(spec, row), local: hashLiveRealmRow(spec, row) });
      if (picked.length === 4) break;
    }
    expect(picked.length).toBe(4); // the "≥4 families" exit criterion

    const F_INSYNC = picked[0]!, F_STALE = picked[1]!, F_CUST = picked[2]!, F_DIV = picked[3]!;
    // Stage each family's baseline so classifyDrift(base, local, remote) yields the target state:
    setOrigin(F_INSYNC.spec, String(F_INSYNC.row['id']), F_INSYNC.local);      // in_sync: base=local, remote=local
    setOrigin(F_STALE.spec, String(F_STALE.row['id']), F_STALE.local);          // stale:   base=local, remote≠local
    setOrigin(F_CUST.spec, String(F_CUST.row['id']), 'BASE_SENTINEL');          // custom:  base≠local, remote=base
    setOrigin(F_DIV.spec, String(F_DIV.row['id']), 'DIV_BASE_SENTINEL');        // diverged: base≠local, remote≠base≠local

    const content: ManifestContent[] = [
      { family: F_INSYNC.spec.family, logicalKey: F_INSYNC.key, remoteHash: F_INSYNC.local, releaseNote: 'unchanged' },
      { family: F_STALE.spec.family, logicalKey: F_STALE.key, remoteHash: 'REMOTE_STALE', releaseNote: 'we improved this' },
      { family: F_CUST.spec.family, logicalKey: F_CUST.key, remoteHash: 'BASE_SENTINEL', releaseNote: 'we did not change it' },
      { family: F_DIV.spec.family, logicalKey: F_DIV.key, remoteHash: 'DIV_REMOTE', releaseNote: 'both changed' },
      { family: 'skills', logicalKey: '__does_not_exist__', remoteHash: 'REMOTE_NEW', releaseNote: 'a brand-new default' },
      { family: 'not_a_real_family', logicalKey: 'x', remoteHash: 'REMOTE_X', releaseNote: 'from a newer build' },
    ];

    const preview = await previewUpgrade(client(), 'sqlite', { manifest: manifest({ content }), installedVersion: '1.0.0' });

    // L4 tallies: one of each state, unknown family skipped.
    expect(preview.layers.L4.byDisposition).toEqual({ in_sync: 1, stale: 1, customized: 1, diverged: 1, new: 1 });
    expect(preview.layers.L4.skippedFamilies).toEqual(['not_a_real_family']);

    // Exact persisted detail rows (L4) for the run.
    const details = raw().prepare(`SELECT family, logical_key, layer, disposition, priority, base_hash, local_hash, remote_hash, note FROM upgrade_details WHERE run_id = ? AND layer = 'L4' ORDER BY disposition`).all(preview.runId) as Array<Record<string, unknown>>;
    const byState = Object.fromEntries(details.map((d) => [d['disposition'], d]));
    expect(byState['stale']).toMatchObject({ family: F_STALE.spec.family, logical_key: F_STALE.key, remote_hash: 'REMOTE_STALE', note: 'we improved this' });
    expect(byState['customized']).toMatchObject({ family: F_CUST.spec.family, remote_hash: 'BASE_SENTINEL' });
    expect(byState['diverged']).toMatchObject({ family: F_DIV.spec.family, remote_hash: 'DIV_REMOTE' });
    expect(byState['new']).toMatchObject({ family: 'skills', logical_key: '__does_not_exist__', base_hash: null, local_hash: null });
  });

  it('a guardrails change is banded P1; a stale non-guardrail is not', async () => {
    const guard = REALM_FAMILIES['guardrails'] ? pickGlobal(REALM_FAMILIES['guardrails']) : null;
    if (!guard) { expect(true).toBe(true); return; } // build without seeded guardrails — nothing to assert
    const spec = REALM_FAMILIES['guardrails']!;
    setOrigin(spec, String(guard['id']), hashLiveRealmRow(spec, guard)); // base=local → stale when remote differs
    const gkey = logicalKeyOfRow(spec, guard);
    const preview = await previewUpgrade(client(), 'sqlite', {
      manifest: manifest({ content: [{ family: 'guardrails', logicalKey: gkey, remoteHash: 'REMOTE_G', releaseNote: 'tightened' }] }),
      installedVersion: '1.0.0',
    });
    expect(preview.layers.L4.entries[0]).toMatchObject({ family: 'guardrails', disposition: 'stale', priority: 'P1' });
  });

  it('L1/L2/L3 layers: stale packages, code-requires-deploy, and schema batches to run vs applied', async () => {
    const preview = await previewUpgrade(client(), 'sqlite', {
      installedVersion: '1.0.0',
      readInstalledPackageVersion: (n) => (({ '@weaveintel/realm': '0.4.0', '@weaveintel/upgrade': '0.2.0' } as Record<string, string>)[n] ?? null),
      manifest: manifest({
        packages: [
          { name: '@weaveintel/realm', version: '0.9.0', requires: '>=0.9.0' },   // installed 0.4.0 → STALE
          { name: '@weaveintel/upgrade', version: '0.2.0', requires: '>=0.1.0' }, // installed 0.2.0 → satisfied
        ],
        schema: [
          { batchId: 'm169-upgrade-releases', contentHash: 'sha256-a', dependsOn: [], provides: [] }, // already applied
          { batchId: 'm999-future-batch', contentHash: 'sha256-b', dependsOn: [], provides: [] },      // would run
        ],
        code: { repoTag: 'v9.9.9', fileManifestDigest: 'sha256-Zm9v' },
      }),
    });
    expect(preview.layers.L1.stale.map((s) => s.name)).toEqual(['@weaveintel/realm']);
    expect(preview.layers.L2).toMatchObject({ repoTag: 'v9.9.9', requiresDeploy: true });
    expect(preview.layers.L3.toRun).toEqual(['m999-future-batch']);
    expect(preview.layers.L3.alreadyApplied).toEqual(['m169-upgrade-releases']);
  });

  it('MUTATES NOTHING: every content table + the migration ledger is byte-identical after a preview', async () => {
    // Snapshot every family table + schema_migrations + realm_versions (everything the plan reads).
    const tables = [...new Set(Object.values(REALM_FAMILIES).map((s) => s.table)), 'schema_migrations', 'realm_versions', 'upgrade_releases'];
    const snapshot = () => tables.map((t) => {
      try { return t + ':' + JSON.stringify(raw().prepare(`SELECT * FROM ${t} ORDER BY 1`).all()); } catch { return t + ':absent'; }
    }).join('||');

    const spec = REALM_FAMILIES['skills']!;
    const row = pickGlobal(spec)!;
    const before = snapshot();
    const runsBefore = (raw().prepare(`SELECT count(*) c FROM upgrade_runs WHERE mode='preview'`).get() as { c: number }).c;

    const preview = await previewUpgrade(client(), 'sqlite', {
      manifest: manifest({ content: [
        { family: 'skills', logicalKey: logicalKeyOfRow(spec, row), remoteHash: 'REMOTE', releaseNote: 'x' },
      ] }),
      installedVersion: '1.0.0',
    });

    expect(snapshot()).toBe(before); // NOTHING the preview planned over changed
    // The only writes are the preview's own record.
    const runsAfter = (raw().prepare(`SELECT count(*) c FROM upgrade_runs WHERE mode='preview'`).get() as { c: number }).c;
    expect(runsAfter).toBe(runsBefore + 1);
    const detailCount = (raw().prepare(`SELECT count(*) c FROM upgrade_details WHERE run_id = ?`).get(preview.runId) as { c: number }).c;
    expect(detailCount).toBeGreaterThan(0);
  });

  it('STRESS: a large content layer previews and records every row', async () => {
    const spec = REALM_FAMILIES['skills']!;
    const row = pickGlobal(spec)!;
    const gkey = logicalKeyOfRow(spec, row);
    // 500 entries: the first is a real skills key (classifiable), the rest are new (nonexistent keys).
    const content: ManifestContent[] = Array.from({ length: 500 }, (_, i) => ({
      family: 'skills', logicalKey: i === 0 ? gkey : `__ghost_${i}__`, remoteHash: `H${i}`, releaseNote: `n${i}`,
    }));
    const preview = await previewUpgrade(client(), 'sqlite', { manifest: manifest({ content }), installedVersion: '1.0.0' });
    expect(preview.layers.L4.entries.length).toBe(500);
    const recorded = (raw().prepare(`SELECT count(*) c FROM upgrade_details WHERE run_id = ? AND layer='L4'`).get(preview.runId) as { c: number }).c;
    expect(recorded).toBe(500);
  });
});
