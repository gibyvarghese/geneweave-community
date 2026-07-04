/**
 * expo-sqlite-outbox.ts — durable SQLite-backed OutboxStorage for run queuing.
 *
 * Device-gated: imports expo-sqlite. Implements the `OutboxStorage` interface
 * from `@weaveintel/client` so the api-client's `createRunOutbox` can persist
 * outboxed runs across app kills (unlike the default in-memory store).
 *
 * Schema: a single `outbox` table keyed by `id` (string), with `payload` (JSON)
 * and `created_at` (ISO string). Entries are keyed per namespace (tenant@host)
 * so multiple tenants on one device never collide.
 *
 * Thread safety: expo-sqlite v14+ uses a single serialized write queue per
 * database, so concurrent mutations are safe.
 */
import * as SQLite from 'expo-sqlite';
import type { StartRunInput } from '@weaveintel/client';

/** The OutboxStorage interface from @weaveintel/client (reproduced inline to avoid circular dep). */
export interface OutboxStorage {
  add(id: string, input: StartRunInput): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<Array<{ id: string; input: StartRunInput }>>;
}

const DB_NAME = 'geneweave_outbox.db';

let _db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync(DB_NAME);
    // WAL mode for better concurrent read performance.
    _db.execSync('PRAGMA journal_mode=WAL;');
    _db.execSync(`
      CREATE TABLE IF NOT EXISTS outbox (
        namespace TEXT NOT NULL,
        id        TEXT NOT NULL,
        payload   TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (namespace, id)
      );
    `);
  }
  return _db;
}

/**
 * Creates a namespaced OutboxStorage backed by SQLite. Pass the same namespace
 * used for the token store (`tenantId@host`) so multiple tenant sessions on
 * the same device have isolated outboxes.
 */
export function createSqliteOutboxStorage(namespace: string): OutboxStorage {
  const db = getDb();

  return {
    async add(id: string, input: StartRunInput): Promise<void> {
      const payload = JSON.stringify(input);
      db.runSync(
        'INSERT OR REPLACE INTO outbox (namespace, id, payload) VALUES (?, ?, ?)',
        namespace,
        id,
        payload,
      );
    },

    async remove(id: string): Promise<void> {
      db.runSync('DELETE FROM outbox WHERE namespace = ? AND id = ?', namespace, id);
    },

    async list(): Promise<Array<{ id: string; input: StartRunInput }>> {
      const rows = db.getAllSync<{ id: string; payload: string }>(
        'SELECT id, payload FROM outbox WHERE namespace = ? ORDER BY created_at ASC',
        namespace,
      );
      return rows.map((row) => ({
        id: row.id,
        input: JSON.parse(row.payload) as StartRunInput,
      }));
    },
  };
}
