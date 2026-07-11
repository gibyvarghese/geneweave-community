import type BetterSqlite3 from 'better-sqlite3';
import { applyRealmColumns } from './realm-columns-helper.js';

/**
 * m164 — Realm columns on `workflow_defs` (Tenancy Realm — extend content-forking to workflows).
 *
 * Classifies every built-in workflow definition as a GLOBAL realm original so a tenant can fork its own
 * copy — re-wire steps, change the entry point — with provenance + drift, resolved nearest-owner-wins.
 * Keys on `name` (no UNIQUE across owners; a fork keeps the name, logical_key = name).
 *
 * The `steps` column is a structured graph (nodes + edges). Ordinary field-level merge would treat two
 * edited step-lists as an all-or-nothing conflict; the realm diff has a workflow-aware structured merge
 * (see `workflow-merge.ts`) so a vendor-added node and a tenant's re-wiring can coexist. The column set
 * here is what drift *compares*; the structured merge is what the workbench *applies*.
 *
 * Relabel, zero data movement. Idempotent. Postgres via regenerated schema.
 */
export const WORKFLOW_SEMANTIC_COLS = ['description', 'version', 'steps', 'entry_step_id', 'metadata'] as const;

export function applyM164RealmColumnsWorkflows(db: BetterSqlite3.Database): void {
  applyRealmColumns(db, 'workflow_defs', 'name', WORKFLOW_SEMANTIC_COLS);
}
