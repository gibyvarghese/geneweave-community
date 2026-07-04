/**
 * Phase K5 — Singleton accessor for the Kaggle live-agents StateStore.
 *
 * The live-agents framework persists meshes/agents/contracts/bindings as JSON
 * payloads in a single `la_entities` table. We default to colocating that
 * table inside the canonical GeneWeave SQLite database (`./geneweave.db`) so
 * everything lives in one auditable file. Path resolution order:
 *   1. `LIVE_AGENTS_DB_PATH` (explicit override)
 *   2. `DATABASE_PATH`       (the GeneWeave canonical DB path)
 *   3. `./geneweave.db`
 *
 * Admin routes and the seed function call `getKaggleLiveStore()`; example
 * scripts construct their own ephemeral stores.
 */

import { weaveSqliteStateStore, type SqliteStateStore } from '@weaveintel/live-agents';

let _store: SqliteStateStore | null = null;
let _pending: Promise<SqliteStateStore> | null = null;

export async function getKaggleLiveStore(): Promise<SqliteStateStore> {
  if (_store) return _store;
  if (_pending) return _pending;
  const path = process.env['LIVE_AGENTS_DB_PATH']
    ?? process.env['DATABASE_PATH']
    ?? './geneweave.db';
  _pending = weaveSqliteStateStore({ path }).then((s) => {
    _store = s;
    _pending = null;
    return s;
  });
  return _pending;
}

/** Test-only: reset the singleton so tests can swap stores between cases. */
export async function _resetKaggleLiveStoreForTests(replacement?: SqliteStateStore): Promise<void> {
  if (_store) {
    try { await _store.close(); } catch { /* ignore */ }
  }
  _store = replacement ?? null;
  _pending = null;
}
