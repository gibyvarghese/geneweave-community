import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration M29 — guardrail_revisions table
 *
 * Append-only audit trail for every create / update / delete of a guardrail
 * rule. Each revision stores a full JSON snapshot of the rule before and
 * after the change, the actor (user id or 'system'), and a free-text reason.
 *
 * No foreign-key enforcement on guardrail_id so revisions survive guardrail
 * deletion (allowing post-mortem history queries).
 */
export function applyM29GuardrailRevisions(db: BetterSqlite3.Database): void {
  // Add escalation column to guardrail_evals if missing (idempotent via PRAGMA check).
  const evalCols = (db.pragma('table_info(guardrail_evals)') as Array<{ name: string }>).map(c => c.name);
  if (!evalCols.includes('escalation')) {
    db.exec(`ALTER TABLE guardrail_evals ADD COLUMN escalation TEXT;`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS guardrail_revisions (
      id            TEXT    PRIMARY KEY,
      guardrail_id  TEXT    NOT NULL,
      version       INTEGER NOT NULL,
      snapshot      TEXT    NOT NULL,
      before        TEXT,
      actor         TEXT    NOT NULL DEFAULT 'system',
      reason        TEXT    NOT NULL DEFAULT '',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_guardrail_revisions_guardrail
      ON guardrail_revisions (guardrail_id, created_at);
  `);
}
