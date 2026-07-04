/**
 * expo-sqlite-notes-store.ts — durable on-device {@link NotesLocalStore} (weaveNotes Phase 7).
 *
 * Device-gated: imports expo-sqlite. Implements the SAME `NotesLocalStore` port the sync engine's
 * tests run against (the in-memory reference), so the offline cache + outbox survive app kills while
 * the sync logic stays identical and fully unit-tested in Node.
 *
 * Two tables, namespaced per `tenantId@host` so multiple tenant sessions on one device never collide:
 *   • `notes`     — the offline note cache (one row per LocalNote; doc_json holds the body incl. ink).
 *   • `notes_outbox` — the durable write queue (one row per PendingOp), drained oldest-first.
 *
 * expo-sqlite v14+ serialises writes per database, so the synchronous calls below are safe.
 */
import * as SQLite from 'expo-sqlite';
import type { LocalNote, NotesLocalStore, PendingOp, OpKind } from '../../lib';

const DB_NAME = 'geneweave_notes.db';

let _db: SQLite.SQLiteDatabase | null = null;
function getDb(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync(DB_NAME);
    _db.execSync('PRAGMA journal_mode=WAL;');
    _db.execSync(`
      CREATE TABLE IF NOT EXISTS notes (
        namespace   TEXT NOT NULL,
        id          TEXT NOT NULL,
        server_id   TEXT,
        title       TEXT NOT NULL,
        icon        TEXT,
        favorite    INTEGER NOT NULL DEFAULT 0,
        doc_json    TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        archived_at TEXT,
        dirty       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (namespace, id)
      );
      CREATE TABLE IF NOT EXISTS notes_outbox (
        namespace  TEXT NOT NULL,
        id         TEXT NOT NULL,
        kind       TEXT NOT NULL,
        local_id   TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        payload    TEXT,
        seq        INTEGER PRIMARY KEY AUTOINCREMENT
      );
    `);
  }
  return _db;
}

interface NoteRow { id: string; server_id: string | null; title: string; icon: string | null; favorite: number; doc_json: string; updated_at: string; archived_at: string | null; dirty: number }
interface OpRow { id: string; kind: string; local_id: string; created_at: string; attempts: number; payload: string | null }

function rowToNote(r: NoteRow): LocalNote {
  return { id: r.id, serverId: r.server_id, title: r.title, icon: r.icon, favorite: r.favorite, doc_json: r.doc_json, updated_at: r.updated_at, archived_at: r.archived_at, dirty: r.dirty === 1 };
}
function rowToOp(r: OpRow): PendingOp {
  return { id: r.id, kind: r.kind as OpKind, localId: r.local_id, createdAt: r.created_at, attempts: r.attempts, payload: r.payload ? JSON.parse(r.payload) : undefined };
}

/** A durable, namespaced {@link NotesLocalStore} backed by SQLite. */
export function createSqliteNotesStore(namespace: string): NotesLocalStore {
  const db = getDb();
  return {
    async list() {
      const rows = db.getAllSync<NoteRow>('SELECT * FROM notes WHERE namespace = ? ORDER BY favorite DESC, updated_at DESC', namespace);
      return rows.map(rowToNote);
    },
    async get(id) {
      const r = db.getFirstSync<NoteRow>('SELECT * FROM notes WHERE namespace = ? AND id = ?', namespace, id);
      return r ? rowToNote(r) : null;
    },
    async put(note) {
      db.runSync(
        `INSERT OR REPLACE INTO notes (namespace, id, server_id, title, icon, favorite, doc_json, updated_at, archived_at, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        namespace, note.id, note.serverId, note.title, note.icon, note.favorite, note.doc_json, note.updated_at, note.archived_at, note.dirty ? 1 : 0,
      );
    },
    async remove(id) {
      db.runSync('DELETE FROM notes WHERE namespace = ? AND id = ?', namespace, id);
    },
    async ops() {
      const rows = db.getAllSync<OpRow>('SELECT id, kind, local_id, created_at, attempts, payload FROM notes_outbox WHERE namespace = ? ORDER BY seq ASC', namespace);
      return rows.map(rowToOp);
    },
    async enqueue(op) {
      db.runSync(
        'INSERT INTO notes_outbox (namespace, id, kind, local_id, created_at, attempts, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
        namespace, op.id, op.kind, op.localId, op.createdAt, op.attempts, op.payload ? JSON.stringify(op.payload) : null,
      );
    },
    async dequeue(opId) {
      db.runSync('DELETE FROM notes_outbox WHERE namespace = ? AND id = ?', namespace, opId);
    },
  };
}
