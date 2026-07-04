import type BetterSqlite3 from 'better-sqlite3';
import { A2A_TASKS_DDL } from '@weaveintel/a2a';

/**
 * m62 — A2A Tasks: persistent SQLite-backed task store
 *
 * Creates the `a2a_tasks` table that backs createSqliteA2ATaskStore().
 * Prior to this migration the A2A route used an in-memory store — tasks
 * were lost on every server restart and GetTask/ListTasks returned nothing
 * after a restart. This table makes task state durable.
 *
 * The DDL is owned by @weaveintel/a2a (A2A_TASKS_DDL) to keep store and
 * schema co-located in the package that defines them.
 */
export function applyM62A2ATasks(db: BetterSqlite3.Database): void {
  db.exec(A2A_TASKS_DDL);
}
