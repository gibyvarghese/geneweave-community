/**
 * Migration m42 — W9b additive columns
 *
 * Closes two W9 gaps without introducing new tables:
 *   1. semantic_memory.metadata (TEXT) — carries the correction / supersede
 *      trail markers written by @weaveintel/memory applyCorrection/supersede
 *      so user-authored memory edits keep an auditable lineage.
 *   2. notification_preferences.timezone (TEXT) — IANA timezone used to
 *      evaluate quiet-hours for the principal. Defaults to Pacific/Auckland
 *      at evaluation time when unset (column stays NULL).
 *
 * Both are pure ALTER TABLE ADD COLUMN — additive, idempotent (a duplicate
 * column on re-run throws and is swallowed by safe()).
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent — column may already exist */ }
}

export function applyM42UserMemoryAndTz(db: BetterSqlite3.Database): void {
  // 1. Correction/supersede lineage for user-authored semantic memory.
  safe(db, 'ALTER TABLE semantic_memory ADD COLUMN metadata TEXT');

  // 2. Per-user IANA timezone for quiet-hours evaluation.
  safe(db, 'ALTER TABLE notification_preferences ADD COLUMN timezone TEXT');
}
