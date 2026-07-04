// SPDX-License-Identifier: MIT
/**
 * geneWeave collaborative NOTE co-editing — the TRUSTED RELAY around
 * `@weaveintel/collab`'s {@link BlockDoc} (weaveNotes Phase 2).
 *
 * This is the notes counterpart of the Phase 7 run co-edit relay
 * ({@link "./coedit-sql"}), with three differences that matter:
 *
 *  1. A note is a RICH-TEXT document, so it is co-edited as `BlockDoc` BLOCK ops
 *     (insert char/marker, delete, set attribute, add/remove mark) rather than
 *     plain-text RGA ops.
 *  2. A note is USER-scoped (not attached to a run), so access is resolved by note
 *     OWNERSHIP or an explicit note SHARE ({@link resolveNoteAccess}), and the
 *     module brings its own lightweight sharing (invite tokens + membership).
 *  3. The canonical doc SEEDS from the note's existing `doc_json` the first time
 *     someone opens it for co-editing, so collaboration starts from real content.
 *
 * The server holds the canonical replica. A client never writes the DB directly:
 * it submits block ops, which the relay VALIDATES (anti-forgery + size/flood caps —
 * {@link validateClientBlockOps}), applies to a server-side `BlockDoc` loaded from
 * the persisted snapshot, persists the new snapshot + appends to the op log, and
 * hands back the accepted ops to broadcast. CRDTs converge but are NOT
 * Byzantine-tolerant, so this single trusted point is what keeps the shared truth
 * honest (mid-2026 research: Kleppmann BFT-CRDT).
 */
import {
  BlockDoc,
  blockOpId,
  validateClientBlockOps,
  pmToBlocks,
  blocksToProseMirror,
  blocksToMarkdown,
  diffBlocks,
  type BlockOp,
  type BlockDocSnapshot,
  type BlockStateVector,
  type RenderedBlock,
  type BlockSpec,
} from '@weaveintel/collab';
import { newUUIDv7 } from '@weaveintel/core';
import { roleAtLeast, type SessionRole } from '@weaveintel/collab';
import { randomBytes, createHash } from 'node:crypto';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteCoeditDocRow, NoteShareRow, NoteShareTokenRow } from './db-types/adapter-me.js';

/** The site id the server replica loads snapshots under (matches the run relay). */
const SERVER_SITE = 'server';

type NoteCoeditDb = Pick<DatabaseAdapter,
  | 'createNoteCoeditDoc' | 'getNoteCoeditDoc' | 'getNoteCoeditDocByNote' | 'updateNoteCoeditDoc'
  | 'appendNoteCoeditOp' | 'listNoteCoeditOps'
  | 'getNoteForOwner' | 'getNoteShare' | 'listNoteShares' | 'upsertNoteShare' | 'deleteNoteShare'
  | 'createNoteShareToken' | 'getNoteShareTokenByHash' | 'listNoteShareTokens'
  | 'incrementNoteShareTokenUses' | 'revokeNoteShareToken'>;

/** The site NAMESPACE a given user edits a note as (derived server-side — anti-forgery). */
export function userNoteSiteId(userId: string): string {
  return `u:${userId}`;
}

export interface NoteCoeditView {
  docId: string;
  blocks: RenderedBlock[];
  prosemirror: { type: 'doc'; content: unknown[] };
  markdown: string;
  snapshot: BlockDocSnapshot;
  stateVector: BlockStateVector;
}

function loadDoc(row: NoteCoeditDocRow): BlockDoc {
  let snap: BlockDocSnapshot;
  try { snap = JSON.parse(row.snapshot_json) as BlockDocSnapshot; } catch { snap = { elements: [], attrs: [], marks: [] }; }
  return BlockDoc.fromSnapshot(SERVER_SITE, snap);
}

function viewOf(docId: string, doc: BlockDoc): NoteCoeditView {
  const blocks = doc.blocks();
  return {
    docId,
    blocks,
    prosemirror: blocksToProseMirror(blocks),
    markdown: blocksToMarkdown(blocks),
    snapshot: doc.snapshot(),
    stateVector: doc.stateVector(),
  };
}

async function persist(db: NoteCoeditDb, docId: string, doc: BlockDoc, ops: BlockOp[], now: number): Promise<void> {
  await db.updateNoteCoeditDoc(docId, {
    snapshot_json: JSON.stringify(doc.snapshot()),
    state_vector_json: JSON.stringify(doc.stateVector()),
    updated_at: now,
  });
  for (const op of ops) {
    const id = blockOpId(op);
    await db.appendNoteCoeditOp({ id: newUUIDv7(), doc_id: docId, op_site: id.siteId, op_counter: id.counter, op_json: JSON.stringify(op), created_at: now });
  }
}

export function createNoteCoeditRepo(db: NoteCoeditDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  return {
    /**
     * Create (idempotently) the co-edit doc for a note, SEEDING it from the note's
     * current ProseMirror content the first time. Returns the current view.
     */
    async ensureDoc(input: { noteId: string; tenantId: string | null; ownerId: string; seedPm?: unknown }): Promise<NoteCoeditView> {
      const existing = await db.getNoteCoeditDocByNote(input.noteId);
      if (existing) return viewOf(existing.id, loadDoc(existing));
      const ts = now();
      // Seed from existing note content so collaboration begins from real text.
      let specs: BlockSpec[] = [];
      try { specs = pmToBlocks(input.seedPm ?? { type: 'doc', content: [] }); } catch { specs = []; }
      const seeded = BlockDoc.fromBlocks(SERVER_SITE, specs);
      const id = newUUIDv7();
      await db.createNoteCoeditDoc({
        id, note_id: input.noteId, tenant_id: input.tenantId, owner_id: input.ownerId,
        snapshot_json: JSON.stringify(seeded.snapshot()), state_vector_json: JSON.stringify(seeded.stateVector()),
        created_at: ts, updated_at: ts,
      });
      const row = (await db.getNoteCoeditDocByNote(input.noteId))!;
      return viewOf(row.id, loadDoc(row));
    },

    async getViewByNote(noteId: string): Promise<NoteCoeditView | null> {
      const row = await db.getNoteCoeditDocByNote(noteId);
      return row ? viewOf(row.id, loadDoc(row)) : null;
    },

    async getView(docId: string): Promise<NoteCoeditView | null> {
      const row = await db.getNoteCoeditDoc(docId);
      return row ? viewOf(row.id, loadDoc(row)) : null;
    },

    /**
     * Apply a batch of client-submitted BLOCK ops authored by `authorSiteId`.
     * Validates (anti-forgery + caps), applies to the canonical replica, persists,
     * and returns the accepted ops to broadcast (or an error string).
     */
    async submitOps(docId: string, authorSiteId: string, rawOps: unknown): Promise<{ ok: true; applied: BlockOp[]; view: NoteCoeditView } | { ok: false; error: string }> {
      const row = await db.getNoteCoeditDoc(docId);
      if (!row) return { ok: false, error: 'doc not found' };
      // Phase 4: creative atoms (a diagram `scene`, an ink `strokes` list) carry structured JSON in
      // a block attr, which is legitimately larger than a text formatting value — allow up to 256KB.
      const valid = validateClientBlockOps(rawOps, { expectedSiteId: authorSiteId, maxValueLen: 262_144 });
      if (!valid.ok) return { ok: false, error: valid.error ?? 'invalid ops' };
      const doc = loadDoc(row);
      const applied: BlockOp[] = [];
      for (const op of valid.ops!) if (doc.apply(op)) applied.push(op);
      await persist(db, docId, doc, applied, now());
      return { ok: true, applied, view: viewOf(docId, doc) };
    },

    /**
     * Server-side DIFF-on-save: apply the difference between the canonical replica
     * and a whole new ProseMirror document as block ops authored by `authorSiteId`.
     * Used by the legacy single-editor PATCH path once a note is in co-edit mode, so
     * an old client's full-document save still merges instead of clobbering.
     */
    async syncFromProseMirror(docId: string, authorSiteId: string, pm: unknown): Promise<{ ok: true; applied: BlockOp[]; view: NoteCoeditView } | { ok: false; error: string }> {
      const row = await db.getNoteCoeditDoc(docId);
      if (!row) return { ok: false, error: 'doc not found' };
      // Author the diff under the user's namespace so the op log stays attributable.
      const doc = BlockDoc.fromSnapshot(`${authorSiteId}:patch`, JSON.parse(row.snapshot_json) as BlockDocSnapshot);
      let target: BlockSpec[];
      try { target = pmToBlocks(pm); } catch { return { ok: false, error: 'invalid document' }; }
      const applied = diffBlocks(doc, target);
      await persist(db, docId, doc, applied, now());
      return { ok: true, applied, view: viewOf(docId, doc) };
    },

    /** The ops a peer (described by `since`) is missing — for offline reconcile. */
    async opsSince(docId: string, since: BlockStateVector): Promise<BlockOp[]> {
      const rows = await db.listNoteCoeditOps(docId);
      const out: BlockOp[] = [];
      for (const r of rows) {
        if (r.op_counter > (since[r.op_site] ?? 0)) {
          try { out.push(JSON.parse(r.op_json) as BlockOp); } catch { /* skip malformed */ }
        }
      }
      return out;
    },
  };
}

// ─── Access resolution + sharing ──────────────────────────────────────────────

export interface NoteAccess {
  noteId: string;
  ownerId: string;
  tenantId: string | null;
  role: SessionRole;
}

type NoteAccessDb = Pick<DatabaseAdapter, 'getNoteForOwner' | 'getNoteShare'>;

/**
 * Resolve a user's access to a note: the note + their role, or `null` for no access
 * (the caller turns that into a 404 — never leaking that the note exists). Order:
 * ownership first (the fast, common path), then an explicit note share. Mirrors
 * {@link resolveRunAccess} so the two collaboration surfaces behave identically.
 */
export async function resolveNoteAccess(db: NoteAccessDb, noteId: string, userId: string): Promise<NoteAccess | null> {
  // 1. Owner.
  const owned = await db.getNoteForOwner(noteId, userId);
  if (owned) return { noteId, ownerId: userId, tenantId: owned.tenant_id, role: 'owner' };
  // 2. Shared participant — the note is resolved via its OWNER (recorded on the share).
  const share = await db.getNoteShare(noteId, userId);
  if (!share) return null;
  const note = await db.getNoteForOwner(noteId, share.owner_id);
  if (!note) return null;
  return { noteId, ownerId: share.owner_id, tenantId: note.tenant_id, role: share.role };
}

/** Mint a fresh invite token: 256-bit CSPRNG value, URL-safe (matches m95). */
export function mintNoteShareToken(): { token: string; hash: string; prefix: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashNoteShareToken(token), prefix: token.slice(0, 8) };
}
/** Hash a token for storage/lookup — the plaintext is never persisted. */
export function hashNoteShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type NoteShareDb = Pick<DatabaseAdapter,
  | 'getNoteForOwner' | 'getNoteShare' | 'listNoteShares' | 'upsertNoteShare' | 'deleteNoteShare'
  | 'createNoteShareToken' | 'getNoteShareTokenByHash' | 'listNoteShareTokens'
  | 'incrementNoteShareTokenUses' | 'revokeNoteShareToken'>;

export function createNoteSharing(db: NoteShareDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  return {
    /** Owner mints an invite link granting `role` (default viewer). Returns the plaintext token ONCE. */
    async createInvite(input: { noteId: string; ownerId: string; tenantId: string | null; role?: 'collaborator' | 'viewer'; maxUses?: number | null; expiresAt?: number | null }): Promise<{ token: string; prefix: string; role: 'collaborator' | 'viewer' } | null> {
      const note = await db.getNoteForOwner(input.noteId, input.ownerId);
      if (!note) return null; // only the owner may share
      const role = input.role ?? 'viewer';
      const { token, hash, prefix } = mintNoteShareToken();
      await db.createNoteShareToken({
        id: newUUIDv7(), note_id: input.noteId, tenant_id: input.tenantId, owner_id: input.ownerId, role,
        token_hash: hash, token_prefix: prefix, max_uses: input.maxUses ?? null, uses: 0,
        expires_at: input.expiresAt ?? null, revoked_at: null, created_by: input.ownerId, created_at: now(),
      });
      return { token, prefix, role };
    },

    /**
     * Join a note via an invite token. Validates the token (exists / not revoked /
     * not expired / under max-uses), then records membership idempotently — keeping
     * the HIGHER role if the user already had access ("highest permission wins").
     */
    async join(token: string, userId: string): Promise<{ ok: true; noteId: string; role: SessionRole } | { ok: false; error: string }> {
      const row = await db.getNoteShareTokenByHash(hashNoteShareToken(token));
      if (!row) return { ok: false, error: 'invalid token' };
      if (row.revoked_at) return { ok: false, error: 'token revoked' };
      if (row.expires_at && row.expires_at < now()) return { ok: false, error: 'token expired' };
      if (row.max_uses != null && row.uses >= row.max_uses) return { ok: false, error: 'token exhausted' };
      if (row.owner_id === userId) return { ok: true, noteId: row.note_id, role: 'owner' }; // owner doesn't need a share row
      const existing = await db.getNoteShare(row.note_id, userId);
      const granted: 'collaborator' | 'viewer' = existing && roleAtLeast(existing.role, row.role) ? existing.role : row.role;
      await db.upsertNoteShare({
        id: existing?.id ?? newUUIDv7(), note_id: row.note_id, tenant_id: row.tenant_id, owner_id: row.owner_id,
        user_id: userId, role: granted, joined_at: existing?.joined_at ?? now(), invited_via_token_id: row.id,
      });
      if (!existing) await db.incrementNoteShareTokenUses(row.id);
      return { ok: true, noteId: row.note_id, role: granted };
    },

    /** List participants (owner + shared members) for the owner's management UI. */
    async listParticipants(noteId: string, ownerId: string): Promise<Array<{ userId: string; role: SessionRole }>> {
      const shares: NoteShareRow[] = await db.listNoteShares(noteId);
      return [{ userId: ownerId, role: 'owner' as SessionRole }, ...shares.map((s) => ({ userId: s.user_id, role: s.role as SessionRole }))];
    },

    /** Owner revokes a member's access (removes the membership row). */
    async revokeMember(noteId: string, ownerId: string, userId: string): Promise<boolean> {
      const note = await db.getNoteForOwner(noteId, ownerId);
      if (!note) return false;
      return (await db.deleteNoteShare(noteId, userId)) > 0;
    },

    /** Owner revokes an outstanding invite link. */
    async revokeInvite(noteId: string, ownerId: string, tokenId: string): Promise<boolean> {
      const note = await db.getNoteForOwner(noteId, ownerId);
      if (!note) return false;
      return (await db.revokeNoteShareToken(tokenId, noteId, now())) > 0;
    },

    async listInvites(noteId: string, ownerId: string): Promise<NoteShareTokenRow[]> {
      const note = await db.getNoteForOwner(noteId, ownerId);
      if (!note) return [];
      return db.listNoteShareTokens(noteId);
    },
  };
}
