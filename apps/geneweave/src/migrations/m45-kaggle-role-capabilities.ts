/**
 * Migration m45 — Kaggle role capability matrix (DB-configurable defaults)
 *
 * Creates `kaggle_role_capabilities` table seeded with the historical defaults
 * from KAGGLE_CAPABILITY_MATRIX. Operators can now update role capabilities via
 * the admin API without a code deploy. The code constant remains as a hard
 * fallback if the table is empty.
 *
 * Schema
 *   role         TEXT PRIMARY KEY  — KaggleAgentRole value
 *   capabilities TEXT NOT NULL     — JSON array of capability strings
 *   updated_at   TEXT NOT NULL     — ISO8601 timestamp of last write
 *   updated_by   TEXT              — user_id that last changed this row (nullable)
 */

import type BetterSqlite3 from 'better-sqlite3';

const DEFAULTS: Record<string, string[]> = {
  discoverer:  ['KAGGLE_LIST_COMPETITIONS', 'KAGGLE_READ_DATASETS'],
  strategist:  ['KAGGLE_LIST_KERNELS', 'KAGGLE_READ_KERNELS'],
  implementer: ['KAGGLE_PUSH_KERNEL', 'KAGGLE_READ_KERNELS'],
  validator:   ['KAGGLE_DOWNLOAD_DATA', 'KAGGLE_LOCAL_COMPUTE'],
  submitter:   ['KAGGLE_SUBMIT'],
  observer:    ['KAGGLE_READ_LEADERBOARD', 'KAGGLE_READ_SUBMISSIONS'],
};

export function applyM45KaggleRoleCapabilities(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kaggle_role_capabilities (
      role         TEXT PRIMARY KEY,
      capabilities TEXT NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by   TEXT
    )
  `);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO kaggle_role_capabilities (role, capabilities, updated_at)
     VALUES (?, ?, datetime('now'))`,
  );
  const insertMany = db.transaction((entries: [string, string][]) => {
    for (const [role, caps] of entries) {
      insert.run(role, caps);
    }
  });
  insertMany(
    Object.entries(DEFAULTS).map(([role, caps]) => [role, JSON.stringify(caps)] as [string, string]),
  );
}
