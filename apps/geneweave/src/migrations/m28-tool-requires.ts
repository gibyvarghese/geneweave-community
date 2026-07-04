/**
 * M28 — Phase D: tool_catalog.requires column.
 *
 * Adds a JSON-encoded array of capability ids (e.g. `runtime.net.egress`)
 * that a built-in tool needs at runtime. Populated by `syncToolCatalog`
 * from each tool's `schema.requires`. Used by the admin UI to surface
 * capability needs and by registration-time runtime assertions.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

export function applyM28ToolRequires(db: BetterSqlite3.Database): void {
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN requires TEXT`);
}
