// SPDX-License-Identifier: MIT
/**
 * Realm merge — PER-NODE workflow merge, end to end through `applyRealmMerge` on real booted SQLite.
 *
 * A workflow's `steps` is a node graph. The engine-generic per-node merge (`workflow-merge.ts`) was built but
 * unwired; `applyRealmMerge` treated `steps` as one atomic field, so a release adding a node conflicted with a
 * tenant re-wiring a DIFFERENT node. This proves the wiring: a vendor-added node and a tenant edit of another
 * node MERGE cleanly (both survive, no manual resolution), while the SAME node changed on both sides is still a
 * conflict that must be resolved.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createSqlVersionLog } from '@weaveintel/realm';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { sqliteSqlClient } from './realm-prompt-drift.js';
import { realmContentHash } from './migrations/m151-realm-columns.js';
import { loadThreeWayDiff, applyRealmMerge, semanticOfRow } from './realm-diff.js';
import { realmFamily } from './realm-families.js';
import { parseSteps } from './workflow-merge.js';

type Step = { id: string; [k: string]: unknown };

describe('Realm merge — per-node workflow steps (real booted SQLite)', () => {
  let db: DatabaseAdapter;
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = () => (db as any).d as Database.Database;
  const client = () => sqliteSqlClient(raw());
  const NAME = 'wf-merge-test';

  beforeEach(async () => {
    dbPath = join(tmpdir(), `wfmerge-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
    db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
  });
  afterEach(async () => { await db?.close?.(); for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }); } catch { /* ignore */ } } });

  /**
   * Seed a global workflow whose baseline is `base`, whose live `steps` is `local`, and whose latest published
   * upstream is `remote`. Returns the record id.
   */
  async function seedWorkflow(base: Step[], local: Step[], remote: Step[]): Promise<string> {
    const spec = realmFamily('workflows');
    const semantic = (steps: Step[]) => ({ description: 'a workflow', version: '1.0', steps, entry_step_id: base[0]!.id, metadata: null });
    const log = createSqlVersionLog<Record<string, unknown>>({ client: client(), dialect: 'sqlite', table: 'realm_versions' });
    const baseV = await log.append({ family: 'workflows', logicalKey: NAME, payload: semantic(base) });
    await log.append({ family: 'workflows', logicalKey: NAME, payload: semantic(remote) }); // remote = latest published
    const id = 'wf-merge-1';
    const localHash = realmContentHash(semantic(local));
    raw().prepare(
      `INSERT INTO workflow_defs (id, name, description, version, steps, entry_step_id, metadata, realm, logical_key, content_hash, origin_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, NAME, 'a workflow', '1.0', JSON.stringify(local), base[0]!.id, '{}', 'global', NAME, localHash, baseV.contentHash);
    return id;
  }

  it('MERGES per node: a vendor-added node and a tenant re-wire of another node both survive, no conflict', async () => {
    const base: Step[] = [{ id: 'a', w: 0 }, { id: 'b', w: 0 }];
    const local: Step[] = [{ id: 'a', w: 0 }, { id: 'b', w: 1 }];               // tenant re-wired b
    const remote: Step[] = [{ id: 'a', w: 0 }, { id: 'b', w: 0 }, { id: 'c', w: 0 }]; // vendor added c
    const id = await seedWorkflow(base, local, remote);

    // The diff no longer reports `steps` as a blocking conflict (it merges per node).
    const diff = await loadThreeWayDiff(client(), 'sqlite', 'workflows', id);
    expect('error' in diff).toBe(false);
    if (!('error' in diff)) expect(diff.conflicts).not.toContain('steps');

    // The merge applies with NO manual resolution and both changes survive.
    const res = await applyRealmMerge(client(), 'sqlite', 'workflows', id, {});
    expect(res.ok).toBe(true);
    const steps = parseSteps((raw().prepare(`SELECT steps FROM workflow_defs WHERE id=?`).get(id) as { steps: string }).steps);
    expect(steps.find((x) => x.id === 'b')!['w']).toBe(1);          // tenant's re-wire kept
    expect(steps.map((x) => x.id)).toContain('c');                  // vendor's node added
    // Re-baselined: content_hash now matches the merged semantic, so drift settles (no phantom divergence).
    const row = raw().prepare(`SELECT * FROM workflow_defs WHERE id=?`).get(id) as Record<string, unknown>;
    expect(row['content_hash']).toBe(realmContentHash(semanticOfRow(realmFamily('workflows'), row)));
  });

  it('CONFLICTS per node: the SAME node changed on both sides must be resolved (merge refused)', async () => {
    const base: Step[] = [{ id: 'a', w: 0 }];
    const local: Step[] = [{ id: 'a', w: 1 }];   // tenant edits a
    const remote: Step[] = [{ id: 'a', w: 2 }];  // vendor edits a differently
    const id = await seedWorkflow(base, local, remote);
    const diff = await loadThreeWayDiff(client(), 'sqlite', 'workflows', id);
    if (!('error' in diff)) expect(diff.conflicts).toContain('steps'); // a genuine per-node conflict remains
    const res = await applyRealmMerge(client(), 'sqlite', 'workflows', id, {});
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('steps');
    // Supplying an explicit resolution for steps lets it through.
    const forced = await applyRealmMerge(client(), 'sqlite', 'workflows', id, { steps: remote });
    expect(forced.ok).toBe(true);
  });
});
