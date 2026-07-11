import type BetterSqlite3 from 'better-sqlite3';
import { applyRealmColumns } from './realm-columns-helper.js';

/**
 * m167 — Realm columns on `scaffold_templates` (Tenancy Realm — extend content-forking to scaffold
 * templates).
 *
 * Scaffold templates are the reusable project/agent starter definitions. A tenant can keep its own edited
 * copy of a built-in template (different files, dependencies, post-install) without touching the global
 * default. Keys on `name`; excludes enabled.
 *
 * Relabel, zero data movement. Idempotent. Postgres via regenerated schema.
 */
export const SCAFFOLD_TEMPLATE_SEMANTIC_COLS = [
  'description', 'template_type', 'files', 'dependencies', 'dev_dependencies', 'variables', 'post_install',
] as const;

export function applyM167RealmColumnsTemplates(db: BetterSqlite3.Database): void {
  applyRealmColumns(db, 'scaffold_templates', 'name', SCAFFOLD_TEMPLATE_SEMANTIC_COLS);
}
