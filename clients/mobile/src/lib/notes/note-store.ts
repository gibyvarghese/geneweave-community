/**
 * note-store.ts — the offline note cache + outbox PORT (weaveNotes Phase 7, mobile).
 *
 * The mobile app is **offline-first**: every note you see, create, or edit lives in a local cache
 * first, and a durable **outbox** of write-operations is drained to the server when there is signal.
 * This module defines that storage seam — the {@link NotesLocalStore} port — plus a pure in-memory
 * reference implementation used by the sync engine's tests. The on-device adapter (expo-sqlite)
 * implements the SAME port, so the sync logic is identical and fully testable in Node.
 *
 * Design follows the standard offline-first shape (local store + outbox + sync worker): see
 * `offline-sync.ts` for the worker. Single-user note ownership means last-write-wins is the correct,
 * simple merge; the web's CRDT engine handles true multi-user co-editing separately.
 */

/** A note as cached on the device. `id` is a `local:` id until the note exists on the server. */
export interface LocalNote {
  /** Stable local id. `local:<rand>` for offline-created notes; the server id once synced. */
  id: string;
  /** The server's id once this note has been created remotely (null while only-local). */
  serverId: string | null;
  title: string;
  icon: string | null;
  favorite: number;
  /** The note body as ProseMirror `doc_json` (the shared cross-platform format). */
  doc_json: string;
  /** ISO timestamp of the last LOCAL edit — drives last-write-wins + the sync badge. */
  updated_at: string;
  /** Phase 6 soft-archive timestamp mirrored from the server (NULL = active). */
  archived_at: string | null;
  /** True when there are un-synced local changes (a pending op exists for this note). */
  dirty: boolean;
}

export type OpKind = 'create' | 'update' | 'delete';

/** One queued write, the unit of the durable outbox. `id` is the idempotency key. */
export interface PendingOp {
  /** Unique op id — the idempotency key so a retried op is never applied twice locally. */
  id: string;
  kind: OpKind;
  /** The {@link LocalNote.id} this op concerns (resolved to a server id at push time). */
  localId: string;
  createdAt: string;
  /** How many times we have tried to push this op (for backoff + giving up). */
  attempts: number;
  /** The fields to send (create/update). Absent for delete. */
  payload?: { title?: string; doc_json?: string; icon?: string; favorite?: number };
}

/**
 * The storage port. The in-memory + expo-sqlite adapters both implement it, so the sync engine
 * (and its tests) never depend on a device. All methods are async to match the SQLite adapter.
 */
export interface NotesLocalStore {
  /** All cached notes (caller filters archived/sorts). */
  list(): Promise<LocalNote[]>;
  get(id: string): Promise<LocalNote | null>;
  put(note: LocalNote): Promise<void>;
  remove(id: string): Promise<void>;
  /** The outbox, oldest-first (FIFO drain order). */
  ops(): Promise<PendingOp[]>;
  enqueue(op: PendingOp): Promise<void>;
  dequeue(opId: string): Promise<void>;
}

/** A pure in-memory {@link NotesLocalStore} — the reference adapter the sync tests run against. */
export function createInMemoryNotesStore(seed?: { notes?: LocalNote[]; ops?: PendingOp[] }): NotesLocalStore {
  const notes = new Map<string, LocalNote>((seed?.notes ?? []).map((n) => [n.id, { ...n }]));
  const queue: PendingOp[] = [...(seed?.ops ?? [])];
  return {
    async list() { return [...notes.values()].map((n) => ({ ...n })); },
    async get(id) { const n = notes.get(id); return n ? { ...n } : null; },
    async put(note) { notes.set(note.id, { ...note }); },
    async remove(id) { notes.delete(id); },
    async ops() { return queue.map((o) => ({ ...o })); },
    async enqueue(op) { queue.push({ ...op }); },
    async dequeue(opId) { const i = queue.findIndex((o) => o.id === opId); if (i >= 0) queue.splice(i, 1); },
  };
}
