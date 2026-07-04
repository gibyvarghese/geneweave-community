/**
 * use-notes.ts — the offline-first notes hook (weaveNotes Phase 7, G7).
 *
 * Wires the pure sync engine (`src/lib/notes`) to the device: a durable SQLite cache on a phone (or
 * an in-memory cache on web, where expo-sqlite is unavailable), the geneWeave api-client as the sync
 * transport, and the network observer so edits flush automatically when signal returns.
 *
 * The screen is a thin renderer over this hook. Every write is optimistic (updates the cache + the
 * returned `notes` immediately, works with no signal) and durably queued; `sync()` drains the queue
 * and pulls remote changes. The visible sync state per note comes from {@link noteSyncStatus}.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { GeneweaveClient, NotesCapabilities } from '@weaveintel/api-client';
import {
  createInMemoryNotesStore, createNoteOffline, editNoteOffline, deleteNoteOffline,
  syncNotes, pendingCount as libPendingCount,
  type LocalNote, type NotesLocalStore, type NotesSyncTransport, type SyncEnv,
} from '../../lib';
import { useAuth } from '../providers/auth-provider';
import { subscribeNetworkStatus } from '../offline/offline-state';

/** A unique id for ops + local note ids (RN runtime; the pure lib stays deterministic via injection). */
function uid(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }

const ENV: SyncEnv = { now: () => new Date().toISOString(), newId: uid };

/** Build the durable store on a device, or an in-memory cache on web (expo-sqlite has no web build). */
function makeStore(namespace: string): NotesLocalStore {
  if (Platform.OS === 'web') return createInMemoryNotesStore();
  // Lazy require so the web bundle never pulls in expo-sqlite.
  const { createSqliteNotesStore } = require('../adapters/expo-sqlite-notes-store') as typeof import('../adapters/expo-sqlite-notes-store');
  return createSqliteNotesStore(namespace);
}

/** Adapt the api-client to the engine's transport shape. */
function makeTransport(client: GeneweaveClient): NotesSyncTransport {
  return {
    createNote: (input) => client.createNote(input).then((n) => ({ id: n.id, updated_at: n.updated_at })),
    updateNote: (id, patch) => client.updateNote(id, patch).then((n) => ({ updated_at: n.updated_at })),
    deleteNote: (id) => client.deleteNote(id),
    listNotes: () => client.listNotes().then((rows) => rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon, favorite: r.favorite, updated_at: r.updated_at, archived_at: r.archived_at ?? null }))),
    getNote: (id) => client.getNote(id).then((n) => ({ id: n.id, doc_json: n.doc_json, updated_at: n.updated_at })),
  };
}

export interface UseNotesResult {
  notes: LocalNote[];
  loading: boolean;
  syncing: boolean;
  online: boolean;
  /** Count of notes not yet synced (drives the header "N pending" badge). */
  pending: number;
  capabilities: NotesCapabilities | null;
  create: (input?: { title?: string; doc_json?: string; template_key?: string }) => Promise<LocalNote>;
  edit: (id: string, patch: { title?: string; doc_json?: string; icon?: string | null; favorite?: number }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  toggleFavorite: (note: LocalNote) => Promise<void>;
  sync: () => Promise<void>;
  getLocal: (id: string) => Promise<LocalNote | null>;
  refresh: () => Promise<void>;
}

export function useNotes(): UseNotesResult {
  const { client } = useAuth();
  const store = useMemo(() => makeStore(client?.host ?? 'default'), [client?.host]);
  const transport = useMemo(() => (client ? makeTransport(client) : null), [client]);

  const [notes, setNotes] = useState<LocalNote[]>([]);
  const [allOps, setAllOps] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [capabilities, setCapabilities] = useState<NotesCapabilities | null>(null);
  const syncingRef = useRef(false);

  const reload = useCallback(async () => {
    const [list, ops] = await Promise.all([store.list(), store.ops()]);
    setNotes(list);
    setAllOps(libPendingCount(list, ops));
  }, [store]);

  const sync = useCallback(async () => {
    if (!transport || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      await syncNotes(store, transport, ENV);
      await reload();
    } catch {
      // keep the cache; a later sync retries
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [store, transport, reload]);

  // Initial load + capability fetch + first sync.
  useEffect(() => {
    let alive = true;
    void (async () => {
      await reload();
      if (alive) setLoading(false);
      if (client) { try { const caps = await client.getNotesCapabilities(); if (alive) setCapabilities(caps); } catch { /* default-on */ } }
      void sync();
    })();
    return () => { alive = false; };
  }, [reload, sync, client]);

  // Auto-sync when connectivity returns; track online state for the banner.
  useEffect(() => {
    const unsub = subscribeNetworkStatus((status) => {
      setOnline(status.isOnline);
      if (status.isOnline) void sync();
    });
    return unsub;
  }, [sync]);

  const create = useCallback(async (input?: { title?: string; doc_json?: string; template_key?: string }) => {
    const note = await createNoteOffline(store, { title: input?.title, doc_json: input?.doc_json }, ENV);
    await reload();
    void sync();
    return note;
  }, [store, reload, sync]);

  const edit = useCallback(async (id: string, patch: { title?: string; doc_json?: string; icon?: string | null; favorite?: number }) => {
    await editNoteOffline(store, id, patch, ENV);
    await reload();
    void sync();
  }, [store, reload, sync]);

  const remove = useCallback(async (id: string) => {
    await deleteNoteOffline(store, id, ENV);
    await reload();
    void sync();
  }, [store, reload, sync]);

  const toggleFavorite = useCallback(async (note: LocalNote) => {
    await edit(note.id, { favorite: note.favorite ? 0 : 1 });
  }, [edit]);

  const getLocal = useCallback((id: string) => store.get(id), [store]);

  return { notes, loading, syncing, online, pending: allOps, capabilities, create, edit, remove, toggleFavorite, sync, getLocal, refresh: reload };
}
