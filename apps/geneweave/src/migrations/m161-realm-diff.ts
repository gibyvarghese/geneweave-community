// SPDX-License-Identifier: MIT
/**
 * Tenancy Realm — drift extras (Section E): make the BASE payload retrievable by hash.
 *
 * A three-way merge of a `diverged` record needs three payloads: BASE (what the tenant forked from),
 * LOCAL (their current content) and REMOTE (the latest published default). LOCAL is the row itself and
 * REMOTE is `realm_versions` latest — but BASE is identified by the fork's `origin_hash`, which is a
 * CONTENT HASH, not a version number. The version log is indexed by `(family, logical_key, version)`
 * only, so recovering BASE meant a full history scan.
 *
 * This adds the covering index for `(family, logical_key, content_hash)` so the workbench can fetch the
 * base payload in one indexed lookup. Pure index; no data movement. Idempotent.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

export function applyM161RealmDiff(db: BetterSqlite3.Database): void {
  safeExec(db, `CREATE INDEX IF NOT EXISTS ix_realm_versions_key_hash ON realm_versions(family, logical_key, content_hash)`);
}
