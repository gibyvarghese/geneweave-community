import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m173 — Upgrade Engine: `upgrade_details.undo_json`, the captured pre-action state that makes a review-queue
 * resolution UNDOABLE.
 *
 * The Upgrade Center's review queue lets an operator resolve each drifted record — keep mine, adopt incoming,
 * or defer. "Adopt incoming" overwrites the live row with the shipped default, which the operator must be able
 * to reverse ("revert" in the design). Before an adopt writes, the engine snapshots the record's exact prior
 * semantic columns + content_hash + origin_hash into this column; undo restores them verbatim and clears the
 * resolution. Keep/defer change no data, so they store nothing here and undo just re-opens the item.
 *
 * One nullable column, zero data movement, idempotent (ADD COLUMN throws if it exists → skipped). Postgres via
 * the regenerated schema.
 */
export function applyM173UpgradeDetailUndo(db: BetterSqlite3.Database): void {
  // ADD COLUMN throws on an existing column; safeExec swallows that (lenient boot) so re-running is a no-op.
  safeExec(db, `ALTER TABLE upgrade_details ADD COLUMN undo_json TEXT`);
}
