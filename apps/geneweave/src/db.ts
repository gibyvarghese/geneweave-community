/**
 * @weaveintel/geneweave — Database adapter layer
 *
 * Repository-pattern interface so any database backend (SQLite, Postgres, MySQL,
 * MongoDB…) can be plugged in. The default ships SQLite via better-sqlite3.
 * Tables are auto-created on first \`initialize()\` call.
 */

export * from './db-types.js';
export { SCHEMA_SQL } from './db-schema.js';
export { SQLiteAdapter, createDatabaseAdapter } from './db-sqlite.js';
