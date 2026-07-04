/**
 * offline-sync.ts — the offline-first note sync engine (weaveNotes Phase 7, mobile).
 *
 * Pure, dependency-light, fully unit-testable in Node. It implements the standard offline-first
 * loop — *write locally, queue an op, drain the queue when online, then pull remote changes* — over
 * the {@link NotesLocalStore} port and a small {@link NotesSyncTransport} (the api-client subset).
 *
 * Key behaviours, grounded in offline-first best practice:
 *  • **Optimistic local writes.** create/edit/delete update the cache immediately and enqueue an op,
 *    so the UI is instant and works with no signal.
 *  • **Idempotent FIFO drain.** ops carry a unique id; a note created offline gets a `local:` id that
 *    is remapped to the real server id on first push, and later ops for it resolve to that server id.
 *  • **Last-write-wins, local-intent-wins.** when pulling, a server note overwrites the cache only if
 *    the cache copy is clean and not newer; a note with pending local edits is kept (its op will push
 *    and win) and reported as a conflict so the UI can surface it. Correct for single-user notes.
 *  • **Ink intact.** create/update carry the full `doc_json` (incl. `inkCanvas` nodes), and the pull
 *    fetches `doc_json` for changed notes, so drawings round-trip phone ⇆ web untouched.
 *
 * Network failures stop the drain and KEEP the ops (retry next sync); permanent (4xx) failures drop
 * the op and leave the note flagged dirty=false-but-failed via the returned result.
 */
import type { LocalNote, NotesLocalStore, PendingOp, OpKind } from './note-store.js';

/** The remote calls the engine needs — a structural subset of the geneWeave api-client. */
export interface NotesSyncTransport {
  createNote(input: { title?: string; doc_json?: string; icon?: string }): Promise<{ id: string; updated_at: string }>;
  updateNote(id: string, patch: { title?: string; doc_json?: string; icon?: string; favorite?: number }): Promise<{ updated_at: string }>;
  deleteNote(id: string): Promise<void>;
  listNotes(): Promise<Array<{ id: string; title: string; icon: string | null; favorite: number; updated_at: string; archived_at?: string | null }>>;
  getNote(id: string): Promise<{ id: string; doc_json: string; updated_at: string }>;
}

/** Injected side-effects so the engine stays pure (deterministic in tests). */
export interface SyncEnv {
  now(): string;          // ISO timestamp
  newId(): string;        // unique id (op ids + local note ids)
}

export interface SyncResult {
  pushed: number;          // ops successfully sent
  pulled: number;          // notes upserted from the server
  failed: number;          // ops dropped due to a permanent (4xx) error
  conflicts: string[];     // local note ids kept over a newer server copy (local-intent-wins)
  stoppedOffline: boolean; // true if a network error halted the drain (ops kept for retry)
}

/** The visible sync state for a note, for the list/editor badge. */
export type SyncStatus = 'synced' | 'queued' | 'failed';

const LOCAL_PREFIX = 'local:';
export function isLocalId(id: string): boolean { return id.startsWith(LOCAL_PREFIX); }

/** A network/offline error vs a permanent rejection. The transport throws; we classify by `.status`. */
function isPermanent(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// ── Optimistic local writes ─────────────────────────────────────────────────────

/** Create a note offline: cache it with a `local:` id + queue a create op. Returns the new note. */
export async function createNoteOffline(
  store: NotesLocalStore,
  input: { title?: string; doc_json?: string; icon?: string },
  env: SyncEnv,
): Promise<LocalNote> {
  const id = `${LOCAL_PREFIX}${env.newId()}`;
  const ts = env.now();
  const note: LocalNote = {
    id, serverId: null,
    title: input.title?.trim() || 'Untitled',
    icon: input.icon ?? null, favorite: 0,
    doc_json: input.doc_json ?? '{"type":"doc","content":[]}',
    updated_at: ts, archived_at: null, dirty: true,
  };
  await store.put(note);
  await store.enqueue({ id: env.newId(), kind: 'create', localId: id, createdAt: ts, attempts: 0,
    payload: { title: note.title, doc_json: note.doc_json, icon: note.icon ?? undefined } });
  return note;
}

/** Edit a note offline: patch the cache + queue an update op (coalesced with any pending update). */
export async function editNoteOffline(
  store: NotesLocalStore,
  id: string,
  patch: { title?: string; doc_json?: string; icon?: string | null; favorite?: number },
  env: SyncEnv,
): Promise<LocalNote | null> {
  const note = await store.get(id);
  if (!note) return null;
  const ts = env.now();
  const next: LocalNote = {
    ...note,
    title: patch.title !== undefined ? patch.title : note.title,
    icon: patch.icon !== undefined ? patch.icon : note.icon,
    favorite: patch.favorite !== undefined ? patch.favorite : note.favorite,
    doc_json: patch.doc_json !== undefined ? patch.doc_json : note.doc_json,
    updated_at: ts, dirty: true,
  };
  await store.put(next);

  // Coalesce: if an un-pushed update op already exists for this note, merge into it (fewer requests).
  const ops = await store.ops();
  const existing = ops.find((o) => o.localId === id && o.kind === 'update' && o.attempts === 0);
  const payload = {
    ...(patch.title !== undefined ? { title: next.title } : {}),
    ...(patch.doc_json !== undefined ? { doc_json: next.doc_json } : {}),
    ...(patch.icon !== undefined ? { icon: next.icon ?? undefined } : {}),
    ...(patch.favorite !== undefined ? { favorite: next.favorite } : {}),
  };
  if (existing) {
    await store.dequeue(existing.id);
    await store.enqueue({ ...existing, payload: { ...existing.payload, ...payload }, createdAt: ts });
  } else {
    // If the note is still only-local (pending create), fold edits into the create instead.
    const pendingCreate = ops.find((o) => o.localId === id && o.kind === 'create');
    if (pendingCreate) {
      await store.dequeue(pendingCreate.id);
      await store.enqueue({ ...pendingCreate, payload: { ...pendingCreate.payload, ...payload } });
    } else {
      await store.enqueue({ id: env.newId(), kind: 'update', localId: id, createdAt: ts, attempts: 0, payload });
    }
  }
  return next;
}

/** Delete a note offline. A note that only ever lived locally is simply forgotten (no server call). */
export async function deleteNoteOffline(store: NotesLocalStore, id: string, env: SyncEnv): Promise<void> {
  const note = await store.get(id);
  if (!note) return;
  const ops = await store.ops();
  await store.remove(id);
  if (note.serverId === null) {
    // Never reached the server → drop any queued ops for it; nothing to delete remotely.
    for (const o of ops.filter((o) => o.localId === id)) await store.dequeue(o.id);
    return;
  }
  // Drop queued create/update (superseded) and queue a single delete.
  for (const o of ops.filter((o) => o.localId === id && o.kind !== 'delete')) await store.dequeue(o.id);
  await store.enqueue({ id: env.newId(), kind: 'delete', localId: id, createdAt: env.now(), attempts: 0 });
}

// ── The sync worker (push then pull) ────────────────────────────────────────────

/** Drain the outbox then pull remote changes. Safe to call repeatedly (idempotent per op). */
export async function syncNotes(store: NotesLocalStore, transport: NotesSyncTransport, env: SyncEnv): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, failed: 0, conflicts: [], stoppedOffline: false };

  // 1) PUSH — drain ops oldest-first. A network error stops the drain (keep remaining ops).
  const queue = await store.ops();
  for (const op of queue) {
    try {
      await pushOp(store, transport, op);
      await store.dequeue(op.id);
      result.pushed += 1;
    } catch (err) {
      if (isPermanent(err)) {
        await store.dequeue(op.id);      // 4xx → the op can never succeed; drop it
        result.failed += 1;
        continue;
      }
      result.stoppedOffline = true;       // network/5xx → stop, retry whole queue next time
      break;
    }
  }

  // 2) PULL — only if the push fully drained (so we never overwrite un-pushed local edits blindly).
  if (!result.stoppedOffline) {
    try {
      const remote = await transport.listNotes();
      const remaining = await store.ops();
      const dirtyIds = new Set(remaining.map((o) => o.localId));
      for (const r of remote) {
        const localById = await store.get(r.id);
        const local = localById ?? (await findByServerId(store, r.id));
        if (local && (local.dirty || dirtyIds.has(local.id))) { result.conflicts.push(local.id); continue; }
        if (local && local.updated_at >= r.updated_at && local.serverId === r.id) continue; // up to date
        // New or server-newer → fetch full doc (ink intact) and upsert under the server id.
        const full = await transport.getNote(r.id);
        if (local && local.id !== r.id) await store.remove(local.id);
        await store.put({
          id: r.id, serverId: r.id, title: r.title, icon: r.icon, favorite: r.favorite,
          doc_json: full.doc_json, updated_at: r.updated_at, archived_at: r.archived_at ?? null, dirty: false,
        });
        result.pulled += 1;
      }
    } catch {
      result.stoppedOffline = true; // pull failed — local cache stays as-is
    }
  }
  return result;
}

/** Push one op, remapping a `local:` note to its server id on create. */
async function pushOp(store: NotesLocalStore, transport: NotesSyncTransport, op: PendingOp): Promise<void> {
  if (op.kind === 'create') {
    const note = await store.get(op.localId);
    if (!note) return; // deleted before it synced
    const created = await transport.createNote({ title: op.payload?.title ?? note.title, doc_json: op.payload?.doc_json ?? note.doc_json, icon: op.payload?.icon ?? note.icon ?? undefined });
    // Remap the cached note from its local id to the real server id.
    await store.remove(note.id);
    await store.put({ ...note, id: created.id, serverId: created.id, updated_at: created.updated_at, dirty: false });
    await remapOps(store, note.id, created.id);
    return;
  }
  const serverId = await resolveServerId(store, op.localId);
  if (!serverId) return; // its create hasn't landed yet; leave for a later round (op stays till dequeued by caller)
  if (op.kind === 'delete') {
    await transport.deleteNote(serverId);
    return;
  }
  // update
  const updated = await transport.updateNote(serverId, op.payload ?? {});
  const note = await store.get(serverId) ?? await store.get(op.localId);
  if (note) await store.put({ ...note, serverId, updated_at: updated.updated_at, dirty: false });
}

async function resolveServerId(store: NotesLocalStore, localId: string): Promise<string | null> {
  if (!isLocalId(localId)) return localId; // already a server id
  const n = await store.get(localId);
  return n?.serverId ?? null;
}
async function findByServerId(store: NotesLocalStore, serverId: string): Promise<LocalNote | null> {
  return (await store.list()).find((n) => n.serverId === serverId) ?? null;
}
/** After a create lands, repoint any queued ops from the temp local id to the new server id. */
async function remapOps(store: NotesLocalStore, fromLocalId: string, toServerId: string): Promise<void> {
  for (const o of await store.ops()) {
    if (o.localId === fromLocalId && o.kind !== 'create') {
      await store.dequeue(o.id);
      await store.enqueue({ ...o, localId: toServerId });
    }
  }
}

// ── Derived UI state ────────────────────────────────────────────────────────────

/** The visible sync status for a note, from its dirty flag + the outbox. */
export function noteSyncStatus(note: LocalNote, ops: PendingOp[]): SyncStatus {
  const mine = ops.filter((o) => o.localId === note.id);
  if (mine.some((o) => o.attempts > 0)) return 'failed';
  if (note.dirty || mine.length > 0) return 'queued';
  return 'synced';
}

/** Count of notes still waiting to sync (for a header badge). */
export function pendingCount(notes: LocalNote[], ops: PendingOp[]): number {
  const ids = new Set(ops.map((o) => o.localId));
  return notes.filter((n) => n.dirty || ids.has(n.id)).length;
}

const _opKinds: OpKind[] = ['create', 'update', 'delete']; void _opKinds;
