/**
 * Phase 5 — Singleton accessor for the generic live-agents StateStore.
 *
 * The Kaggle store and the generic supervisor share the same physical
 * `la_entities` table inside `./geneweave.db` (the framework keys rows by
 * mesh/agent id, so there's no overlap risk). Keeping a separate accessor
 * makes the boundary explicit and lets us swap implementations independently
 * if the generic supervisor ever moves to a different store backend.
 *
 * Path resolution order matches `kaggle/store.ts`:
 *   1. `LIVE_AGENTS_DB_PATH` (explicit override)
 *   2. `DATABASE_PATH`       (GeneWeave canonical DB path)
 *   3. `./geneweave.db`
 */

import { weaveSqliteStateStore, type SqliteStateStore } from '@weaveintel/live-agents';

let _store: SqliteStateStore | null = null;
let _pending: Promise<SqliteStateStore> | null = null;

export async function getGenericLiveStore(): Promise<SqliteStateStore> {
  if (_store) return _store;
  if (_pending) return _pending;
  const path =
    process.env['LIVE_AGENTS_DB_PATH'] ??
    process.env['DATABASE_PATH'] ??
    './geneweave.db';
  _pending = weaveSqliteStateStore({ path }).then((s) => {
    _store = s;
    _pending = null;
    return s;
  });
  return _pending;
}

/** Test-only: reset the singleton between cases. */
export function _resetGenericLiveStoreForTests(): void {
  _store = null;
  _pending = null;
}
