// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — a REVIEW-QUEUE FIXTURE for the Upgrade Center E2E.
 *
 * The review queue is normally populated by a real apply's reconcile. To exercise the Upgrade Center UI end to
 * end without staging a full signed-release apply, this seeds a representative mixed queue: one genuinely
 * DIVERGED global skill with a published upstream (so `adopt` and `undo` operate on a real record), plus a P1
 * item (which the bulk guardrail must never touch) and two ordinary P3 items.
 *
 * It is TEST-ONLY: the route that calls it (`POST /admin/upgrade/_test/seed-review`) is registered only when
 * `PLAYWRIGHT_E2E=1`, so it can never run in production. It reuses the same primitives the real engine and the
 * vitest tests use — nothing bespoke.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { createSqlVersionLog } from '@weaveintel/realm';
import { ph } from './realm-sql.js';
import { realmFamily, logicalKeyOfRow } from './realm-families.js';
import { semanticOfRow } from './realm-diff.js';
import { beginUpgradeRun, recordUpgradeDetail } from './upgrade-run-store.js';

/** What the fixture seeded — returned so the E2E can target the diverged skill precisely. */
export interface SeededReviewFixture {
  readonly runId: string;
  readonly skillId: string;
  readonly skillKey: string;
  /** The description the diverged skill's live row carries (what `undo` must restore it to). */
  readonly localValue: string;
  /** The description the shipped upstream carries (what `adopt` sets). */
  readonly upstreamValue: string;
  readonly seeded: number;
}

/**
 * Seed a mixed review queue for the Upgrade Center E2E.
 * @param client the SqlClient (SQLite in the E2E's managed server).
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the seeded ids/values. Side effects: one apply run, one edited+versioned skill, four detail rows.
 */
export async function seedReviewFixture(client: SqlClient, dialect: SqlDialect): Promise<SeededReviewFixture> {
  const localValue = 'LOCAL_EDIT_E2E';
  const upstreamValue = 'UPSTREAM_VALUE_E2E';
  const runId = await beginUpgradeRun(client, dialect, { mode: 'apply', toVersion: 'e2e-fixture' });

  // A genuinely diverged global skill with a published upstream (adoptable + undoable).
  const spec = realmFamily('skills');
  const { rows } = await client.query(`SELECT * FROM skills WHERE realm = 'global' LIMIT 1`);
  const row = rows[0] as Record<string, unknown>;
  const key = logicalKeyOfRow(spec, row);
  const base = semanticOfRow(spec, row);
  const log = createSqlVersionLog<Record<string, unknown>>({ client, dialect, table: 'realm_versions' });
  const baseV = await log.append({ family: 'skills', logicalKey: key, payload: base });
  await log.append({ family: 'skills', logicalKey: key, payload: { ...base, description: upstreamValue } }); // remote = latest
  await client.query(
    `UPDATE skills SET description = ${ph(dialect, 1)}, origin_hash = ${ph(dialect, 2)} WHERE id = ${ph(dialect, 3)}`,
    [localValue, baseV.contentHash, String(row['id'])],
  );
  await recordUpgradeDetail(client, dialect, runId, { family: 'skills', logicalKey: key, disposition: 'diverged', priority: 'P3', note: 'the release changed this skill' });

  // A P1 (guardrail conflict — never bulk-resolved) and two ordinary P3 items.
  await recordUpgradeDetail(client, dialect, runId, { family: 'guardrails', logicalKey: 'g-e2e', disposition: 'conflict', priority: 'P1', note: 'a guardrail conflict' });
  await recordUpgradeDetail(client, dialect, runId, { family: 'prompts', logicalKey: 'p-e2e-1', disposition: 'diverged', priority: 'P3', note: 'a prompt diverged' });
  await recordUpgradeDetail(client, dialect, runId, { family: 'prompts', logicalKey: 'p-e2e-2', disposition: 'customized', priority: 'P3', note: 'a prompt you customised' });

  return { runId, skillId: String(row['id']), skillKey: key, localValue, upstreamValue, seeded: 4 };
}
