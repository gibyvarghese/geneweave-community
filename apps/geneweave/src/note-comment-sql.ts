// SPDX-License-Identifier: MIT
/**
 * geneWeave note COMMENTS service (weaveNotes Phase 8).
 *
 * Threaded, BLOCK-ANCHORED review comments on a note — the "leave a margin note / start a
 * discussion on this paragraph" feature. Mirrors the Collaboration Phase 4 `run_comments`
 * design (and reuses its `renderCommentMarkdown` sanitizer), but anchors to a CRDT BLOCK ID
 * instead of a run part id, so a comment sticks to its paragraph even as the note is
 * co-edited around it. An empty anchor ('') means a note-level comment.
 *
 * Model (same as run comments):
 *   - A comment is the ROOT of a thread when `thread_id == id`; replies carry the root's
 *     `thread_id` and a `parent_id`.
 *   - Body is raw Markdown (source of truth) + a sanitized `body_html` render cache.
 *   - Soft-delete keeps the row (so replies are not orphaned) but scrubs the body — a tombstone.
 *   - Resolution is recorded on the ROOT and mirrored across the thread at read time.
 *
 * Access: reading/commenting requires note access (owner or a share); only the AUTHOR may
 * edit or delete their own comment; the note owner may resolve/reopen any thread. All
 * tenant-isolated via the note's access.
 *
 * --- For someone new to this ---
 * It is exactly like comments in a shared doc: you highlight a paragraph, leave a note, others
 * reply, and someone marks the thread "resolved" when it is handled. "Anchored to a block"
 * just means the comment remembers WHICH paragraph it is about, even after edits move things.
 */
import { renderCommentMarkdown } from '@weaveintel/collab';
import { newUUIDv7 } from '@weaveintel/core';
import { resolveNoteAccess } from './note-coedit-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteCommentRow } from './db-types/adapter-me.js';

type NoteCommentDb = DatabaseAdapter;

export interface NoteCommentView {
  id: string; noteId: string; threadId: string; parentId: string | null; authorId: string;
  body: string; bodyHtml: string; mentions: string[]; anchorBlockId: string;
  createdAt: number; updatedAt: number; editedAt: number | null;
  deletedAt: number | null; deletedBy: string | null;
  resolvedAt: number | null; resolvedBy: string | null;
}

export interface CommentResult { ok: boolean; error?: string; code?: number; comment?: NoteCommentView }

function rowToView(r: NoteCommentRow): NoteCommentView {
  return {
    id: r.id, noteId: r.note_id, threadId: r.thread_id, parentId: r.parent_id, authorId: r.author_id,
    body: r.body, bodyHtml: r.body_html,
    mentions: (() => { try { return JSON.parse(r.mentions_json) as string[]; } catch { return []; } })(),
    anchorBlockId: r.anchor_block_id,
    createdAt: r.created_at, updatedAt: r.updated_at, editedAt: r.edited_at,
    deletedAt: r.deleted_at, deletedBy: r.deleted_by, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
  };
}

/** Mirror the thread's resolution (stored on the ROOT) onto every comment in the thread. */
function applyResolution(v: NoteCommentView, rootById: Map<string, NoteCommentRow>): NoteCommentView {
  const root = rootById.get(v.threadId);
  return root ? { ...v, resolvedAt: root.resolved_at, resolvedBy: root.resolved_by } : v;
}

export function createNoteCommentService(db: NoteCommentDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Create a comment (or a reply). Requires note access; anchors to a block id ('' = note-level). */
  async function create(input: { noteId: string; userId: string; body: string; anchorBlockId?: string; parentId?: string; mentions?: string[] }): Promise<CommentResult> {
    const access = await resolveNoteAccess(db, input.noteId, input.userId);
    if (!access) return { ok: false, code: 404, error: 'note not found' };
    const body = (input.body ?? '').trim();
    if (!body) return { ok: false, code: 400, error: 'empty comment' };
    let threadId: string;
    let anchor = (input.anchorBlockId ?? '').trim();
    if (input.parentId) {
      const parent = await db.getNoteComment(input.parentId);
      if (!parent || parent.note_id !== input.noteId) return { ok: false, code: 400, error: 'parent not found' };
      threadId = parent.thread_id; anchor = parent.anchor_block_id; // replies inherit the root's anchor
    } else {
      threadId = '';
    }
    const id = newUUIDv7();
    if (!input.parentId) threadId = id; // a root's thread is itself
    const ts = now();
    const row: NoteCommentRow = {
      id, note_id: input.noteId, tenant_id: access.tenantId, thread_id: threadId,
      parent_id: input.parentId ?? null, author_id: input.userId,
      body, body_html: renderCommentMarkdown(body),
      mentions_json: JSON.stringify([...new Set(input.mentions ?? [])]),
      anchor_block_id: anchor,
      created_at: ts, updated_at: ts, edited_at: null,
      deleted_at: null, deleted_by: null, resolved_at: null, resolved_by: null,
    };
    await db.createNoteComment(row);
    return { ok: true, comment: rowToView(row) };
  }

  /** List all comments on a note (with thread resolution mirrored). Requires note access. */
  async function list(input: { noteId: string; userId: string }): Promise<NoteCommentView[] | null> {
    const access = await resolveNoteAccess(db, input.noteId, input.userId);
    if (!access) return null;
    const rows = await db.listNoteComments(input.noteId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows.map((r) => applyResolution(rowToView(r), byId));
  }

  /** Edit a comment's body. Author-only. */
  async function edit(input: { commentId: string; userId: string; body: string; mentions?: string[] }): Promise<CommentResult> {
    const r = await db.getNoteComment(input.commentId);
    if (!r) return { ok: false, code: 404, error: 'comment not found' };
    if (r.deleted_at) return { ok: false, code: 400, error: 'cannot edit a deleted comment' };
    if (r.author_id !== input.userId) return { ok: false, code: 403, error: 'only the author may edit' };
    const body = (input.body ?? '').trim();
    if (!body) return { ok: false, code: 400, error: 'empty comment' };
    const ts = now();
    const mentionsJson = input.mentions ? JSON.stringify([...new Set(input.mentions)]) : r.mentions_json;
    await db.updateNoteCommentBody(input.commentId, body, renderCommentMarkdown(body), mentionsJson, ts, ts);
    const updated = await db.getNoteComment(input.commentId);
    return { ok: true, comment: updated ? rowToView(updated) : undefined };
  }

  /** Soft-delete a comment (tombstone). Author-only (note owner may force). */
  async function remove(input: { commentId: string; userId: string }): Promise<CommentResult> {
    const r = await db.getNoteComment(input.commentId);
    if (!r) return { ok: true }; // idempotent
    const access = await resolveNoteAccess(db, r.note_id, input.userId);
    const isOwner = access?.role === 'owner';
    if (r.author_id !== input.userId && !isOwner) return { ok: false, code: 403, error: 'only the author or note owner may delete' };
    await db.softDeleteNoteComment(input.commentId, input.userId, now());
    return { ok: true };
  }

  /** Resolve (or reopen) a thread. Note owner or the thread author. */
  async function setResolution(input: { threadId: string; userId: string; resolved: boolean }): Promise<CommentResult> {
    const root = await db.getNoteComment(input.threadId);
    if (!root) return { ok: false, code: 404, error: 'thread not found' };
    const access = await resolveNoteAccess(db, root.note_id, input.userId);
    if (!access) return { ok: false, code: 404, error: 'note not found' };
    const isOwner = access.role === 'owner';
    if (!isOwner && root.author_id !== input.userId) return { ok: false, code: 403, error: 'only the note owner or thread author may resolve' };
    const ts = now();
    await db.setNoteThreadResolution(input.threadId, input.resolved ? ts : null, input.resolved ? input.userId : null, ts);
    return { ok: true };
  }

  return { create, list, edit, remove, setResolution };
}

export type NoteCommentService = ReturnType<typeof createNoteCommentService>;
