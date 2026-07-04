// SPDX-License-Identifier: MIT
/**
 * geneWeave note VERSION HISTORY service (weaveNotes Phase 8).
 *
 * A safety net + a time machine for a note. Each saved VERSION is a full snapshot of the
 * note's content (`doc_json`) at a moment in time, kept in `note_versions`. You can browse
 * the timeline and RESTORE any older version. Restore is always undoable: it first snapshots
 * the CURRENT content (reason 'restore') before overwriting, so "undo a restore" is just
 * "restore the snapshot taken right before it".
 *
 * Snapshots are taken explicitly (a "Save version" button, or before a restore) rather than
 * on every keystroke — version history should be a short, meaningful list, not noise. All
 * operations are owner-scoped: `getNote(id, userId)` is the access gate (returns null for a
 * note the user does not own, which the caller turns into a 404).
 *
 * --- For someone new to this ---
 * Think of it like "Save As… / Version history" in a word processor: you keep named copies
 * of the document at points you care about, and you can roll back to any of them. Restoring
 * does not throw away your current draft — it tucks it into history first, so nothing is lost.
 */
import { extractPlainText, type Note } from '@weaveintel/notes';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteVersionRow } from './db-types/adapter-me.js';

type NoteVersionDb = DatabaseAdapter;

export interface VersionSummary { id: string; title: string; label: string | null; reason: string; wordCount: number; createdBy: string; createdAt: number }
export interface VersionResult { ok: boolean; error?: string; code?: number; versionId?: string }

function wordCountOf(docJson: string): number {
  try { return (extractPlainText(JSON.parse(docJson) as unknown).match(/\S+/g) ?? []).length; } catch { return 0; }
}

export function createNoteVersionService(db: NoteVersionDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Snapshot a note's current content as a new version. Owner-only. */
  async function saveVersion(input: { noteId: string; userId: string; tenantId?: string | null; label?: string; reason?: string }): Promise<VersionResult> {
    const note = await db.getNote(input.noteId, input.userId) as (Note | null);
    if (!note) return { ok: false, code: 404, error: 'note not found' };
    const id = newUUIDv7();
    const row: NoteVersionRow = {
      id, note_id: input.noteId, user_id: input.userId, tenant_id: input.tenantId ?? null,
      title: note.title, doc_json: note.doc_json ?? '{"type":"doc","content":[]}',
      label: input.label?.trim() || null, reason: input.reason ?? 'manual',
      word_count: wordCountOf(note.doc_json ?? ''), created_by: input.userId, created_at: now(),
    };
    await db.createNoteVersion(row);
    return { ok: true, versionId: id };
  }

  /** List a note's versions (newest first). Owner-only. */
  async function listVersions(input: { noteId: string; userId: string }): Promise<VersionSummary[] | null> {
    const note = await db.getNote(input.noteId, input.userId) as (Note | null);
    if (!note) return null;
    return (await db.listNoteVersions(input.noteId)).map((v) => ({
      id: v.id, title: v.title, label: v.label, reason: v.reason, wordCount: v.word_count, createdBy: v.created_by, createdAt: v.created_at,
    }));
  }

  /** Fetch one version's full content (for preview / diff). Owner-only. */
  async function getVersion(input: { versionId: string; userId: string }): Promise<NoteVersionRow | null> {
    const v = await db.getNoteVersion(input.versionId);
    if (!v) return null;
    const note = await db.getNote(v.note_id, input.userId) as (Note | null);
    if (!note) return null; // not the owner
    return v;
  }

  /**
   * Restore a note to an older version. Snapshots the CURRENT content first (reason
   * 'restore') so the restore is undoable, then writes the version's content back.
   */
  async function restoreVersion(input: { noteId: string; versionId: string; userId: string; tenantId?: string | null }): Promise<VersionResult> {
    const note = await db.getNote(input.noteId, input.userId) as (Note | null);
    if (!note) return { ok: false, code: 404, error: 'note not found' };
    const version = await db.getNoteVersion(input.versionId);
    if (!version || version.note_id !== input.noteId) return { ok: false, code: 404, error: 'version not found' };
    // 1. Snapshot the current content so the restore can itself be undone.
    await saveVersion({ noteId: input.noteId, userId: input.userId, tenantId: input.tenantId ?? null, label: 'before restore', reason: 'restore' });
    // 2. Write the version's content back onto the note.
    await db.updateNote(input.noteId, input.userId, { doc_json: version.doc_json, title: version.title });
    return { ok: true, versionId: input.versionId };
  }

  return { saveVersion, listVersions, getVersion, restoreVersion };
}

export type NoteVersionService = ReturnType<typeof createNoteVersionService>;
