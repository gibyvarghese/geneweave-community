// SPDX-License-Identifier: MIT
/**
 * geneWeave note SYNCED BLOCKS (transclusion) service (weaveNotes Phase 8).
 *
 * A "synced block" embeds content from ANOTHER note so it appears in two (or more) places at
 * once and stays in lock-step. The trick that makes "edit it once, it updates everywhere"
 * correct and simple is READ-THROUGH resolution: we store only a REFERENCE (which source note,
 * and optionally which block of it) — never a copy — and resolve the source's CURRENT content
 * every time it is shown. So there is nothing to propagate: editing the source note is
 * instantly reflected in every place that syncs it.
 *
 * Scope of a sync:
 *   - whole note   (`sourceBlockIndex` omitted) — mirror the entire source note;
 *   - one block     (`sourceBlockIndex` = N)     — mirror just the N-th block of the source.
 * We anchor a block by INDEX (resolved at render time) rather than a CRDT id, because a
 * non-co-edited note's block ids are regenerated on each render — index is the robust anchor.
 *
 * Access is owner-scoped: you can only sync FROM and INTO notes you own (`getNote(id, userId)`
 * is the gate). A reference to a deleted/inaccessible source resolves to a clear "unavailable"
 * marker rather than erroring.
 *
 * --- For someone new to this ---
 * Think of it like an embedded live cell from another spreadsheet: you are not copying the
 * value, you are pointing at it, so when the original changes, what you see changes too.
 */
import { BlockDoc, pmToBlocks, blocksToMarkdown } from '@weaveintel/collab';
import { newUUIDv7 } from '@weaveintel/core';
import { type Note } from '@weaveintel/notes';
import type { DatabaseAdapter } from './db-types.js';

type NoteSyncedDb = DatabaseAdapter;

export interface SyncedBlockView {
  id: string;
  sourceNoteId: string;
  sourceTitle: string;
  /** The 0-based block index synced, or null for a whole-note sync. */
  sourceBlockIndex: number | null;
  /** The resolved CURRENT content (Markdown), or an "unavailable" marker. */
  markdown: string;
  available: boolean;
  createdAt: number;
}

export interface SyncedResult { ok: boolean; error?: string; code?: number; id?: string }

/** Render a note's current content to an ordered list of block Markdown fragments. */
function noteBlockMarkdown(note: { doc_json?: string }, ownerId: string): string[] {
  let pm: unknown = { type: 'doc', content: [] };
  try { pm = JSON.parse(note.doc_json ?? '') as unknown; } catch { /* empty */ }
  try {
    const blocks = BlockDoc.fromBlocks(`u:${ownerId}`, pmToBlocks(pm)).blocks();
    // Render each block on its own so we can pick one by index OR join them for whole-note.
    return blocks.map((b) => blocksToMarkdown([b]).trim()).filter((s) => s.length > 0);
  } catch { return []; }
}

export function createNoteSyncedService(db: NoteSyncedDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Create a synced block in `noteId` mirroring `sourceNoteId` (optionally a single block). */
  async function create(input: { noteId: string; userId: string; tenantId?: string | null; sourceNoteId: string; sourceBlockIndex?: number }): Promise<SyncedResult> {
    const host = await db.getNote(input.noteId, input.userId) as (Note | null);
    if (!host) return { ok: false, code: 404, error: 'note not found' };
    const source = await db.getNote(input.sourceNoteId, input.userId) as (Note | null);
    if (!source) return { ok: false, code: 404, error: 'source note not found' };
    if (input.sourceNoteId === input.noteId) return { ok: false, code: 400, error: 'a note cannot sync from itself' };
    const id = newUUIDv7();
    await db.createNoteSyncedBlock({
      id, note_id: input.noteId, user_id: input.userId, tenant_id: input.tenantId ?? null,
      source_note_id: input.sourceNoteId,
      source_block_id: input.sourceBlockIndex != null && input.sourceBlockIndex >= 0 ? String(input.sourceBlockIndex) : '',
      created_at: now(),
    });
    return { ok: true, id };
  }

  /** Resolve one synced block's CURRENT content read-through from its source. */
  async function resolveOne(row: { id: string; source_note_id: string; source_block_id: string; created_at: number }, userId: string): Promise<SyncedBlockView> {
    const source = await db.getNote(row.source_note_id, userId) as (Note | null);
    const idx = row.source_block_id === '' ? null : Number(row.source_block_id);
    if (!source) {
      return { id: row.id, sourceNoteId: row.source_note_id, sourceTitle: '(unavailable)', sourceBlockIndex: idx, markdown: '_Synced source is unavailable._', available: false, createdAt: row.created_at };
    }
    const frags = noteBlockMarkdown(source, userId);
    let markdown: string;
    if (idx == null) markdown = frags.join('\n\n');
    else markdown = (Number.isInteger(idx) && idx >= 0 && idx < frags.length) ? frags[idx]! : '_Synced block no longer exists._';
    return { id: row.id, sourceNoteId: row.source_note_id, sourceTitle: source.title, sourceBlockIndex: idx, markdown, available: true, createdAt: row.created_at };
  }

  /** List the synced blocks in a note, each resolved to its source's current content. Owner-only. */
  async function list(input: { noteId: string; userId: string }): Promise<SyncedBlockView[] | null> {
    const host = await db.getNote(input.noteId, input.userId) as (Note | null);
    if (!host) return null;
    const rows = await db.listNoteSyncedBlocks(input.noteId);
    return Promise.all(rows.map((r) => resolveOne(r, input.userId)));
  }

  /** Remove a synced block. Owner-only. */
  async function remove(input: { id: string; noteId: string; userId: string }): Promise<SyncedResult> {
    const host = await db.getNote(input.noteId, input.userId) as (Note | null);
    if (!host) return { ok: false, code: 404, error: 'note not found' };
    await db.deleteNoteSyncedBlock(input.id, input.noteId);
    return { ok: true };
  }

  return { create, list, remove };
}

export type NoteSyncedService = ReturnType<typeof createNoteSyncedService>;
