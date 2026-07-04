/**
 * geneWeave SQL adapters for Collaboration Phase 4 — run comments + annotations.
 * These are the SQL implementations of the `@weaveintel/collab`
 * `CommentManager` and `AnnotationManager` PORTS; both pass the SAME shared
 * contracts the in-memory reference adapters pass (the Phase 0–3 pattern).
 * Plus the public-share token util (256-bit, SHA-256-hashed at rest).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  renderCommentMarkdown,
  normalizeAnnotationValue,
  type CommentManager,
  type RunComment,
  type CommentAnchor,
  type AnnotationManager,
  type RunAnnotation,
  type AnnotationDataType,
  type AnnotationSource,
} from '@weaveintel/collab';
import type { DatabaseAdapter } from './db-types.js';
import type { RunCommentRow, RunAnnotationRow } from './db-types/adapter-me.js';

const GLOBAL_TENANT = '__global__';

// ─── Public-share token (capability URL) ────────────────────────────────────────

/** Mint a public-share token: 256-bit base64url secret + its SHA-256 hash + a prefix hint. */
export function mintPublicShareToken(): { token: string; hash: string; prefix: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashPublicShareToken(token), prefix: token.slice(0, 8) };
}
/** SHA-256 hex of a public-share token (what we store / look up by). */
export function hashPublicShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ─── Comment SQL adapter ────────────────────────────────────────────────────────

function rowToComment(r: RunCommentRow): RunComment {
  const anchor: CommentAnchor = {
    partId: r.anchor_part_id,
    createdAtSeq: r.anchor_seq,
    ...(r.anchor_range_json ? { subRange: JSON.parse(r.anchor_range_json) as CommentAnchor['subRange'] } : {}),
  };
  return {
    id: r.id, runId: r.run_id, tenantId: r.tenant_id ?? GLOBAL_TENANT,
    threadId: r.thread_id, parentId: r.parent_id, authorId: r.author_id,
    body: r.body, bodyHtml: r.body_html,
    mentions: (() => { try { return JSON.parse(r.mentions_json) as string[]; } catch { return []; } })(),
    anchor,
    createdAt: r.created_at, updatedAt: r.updated_at, editedAt: r.edited_at,
    deletedAt: r.deleted_at, deletedBy: r.deleted_by,
    resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
  };
}

/**
 * Mirror the thread's resolution onto a comment at read time (resolution is
 * stored only on the ROOT). Matches the in-memory adapter's behaviour so both
 * pass the same contract.
 */
function applyThreadResolution(c: RunComment, byId: Map<string, RunCommentRow>): RunComment {
  const root = byId.get(c.threadId);
  return root ? { ...c, resolvedAt: root.resolved_at, resolvedBy: root.resolved_by } : c;
}

export function createSqlCommentManager(
  db: Pick<DatabaseAdapter, 'createRunComment' | 'getRunComment' | 'listRunComments' | 'listRunCommentThread' | 'updateRunCommentBody' | 'softDeleteRunComment' | 'setRunThreadResolution'>,
  opts: { now?: () => number } = {},
): CommentManager {
  const now = opts.now ?? (() => Date.now());

  async function resolveOne(id: string): Promise<RunComment | null> {
    const r = await db.getRunComment(id);
    if (!r) return null;
    const root = r.thread_id === r.id ? r : (await db.getRunComment(r.thread_id)) ?? r;
    return applyThreadResolution(rowToComment(r), new Map([[root.id, root]]));
  }

  return {
    async create(input) {
      const parent = input.parentId ? await db.getRunComment(input.parentId) : null;
      if (input.parentId && !parent) throw new Error(`parent comment '${input.parentId}' not found`);
      if (parent && parent.run_id !== input.runId) throw new Error('reply must target the same run as its parent');
      const threadId = parent ? parent.thread_id : input.id;
      const ts = now();
      const mentions = [...new Set(input.mentions ?? [])];
      const row: RunCommentRow = {
        id: input.id, run_id: input.runId, tenant_id: input.tenantId === GLOBAL_TENANT ? null : input.tenantId,
        thread_id: threadId, parent_id: input.parentId ?? null, author_id: input.authorId,
        body: input.body, body_html: renderCommentMarkdown(input.body),
        mentions_json: JSON.stringify(mentions),
        anchor_part_id: input.anchor.partId, anchor_seq: input.anchor.createdAtSeq,
        anchor_range_json: input.anchor.subRange ? JSON.stringify(input.anchor.subRange) : null,
        created_at: ts, updated_at: ts, edited_at: null,
        deleted_at: null, deleted_by: null, resolved_at: null, resolved_by: null,
      };
      await db.createRunComment(row);
      return (await resolveOne(input.id))!;
    },
    async getById(id) { return resolveOne(id); },
    async listForRun(runId) {
      const rows = await db.listRunComments(runId);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return rows.map((r) => applyThreadResolution(rowToComment(r), byId));
    },
    async listThread(threadId) {
      const rows = await db.listRunCommentThread(threadId);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return rows.map((r) => applyThreadResolution(rowToComment(r), byId));
    },
    async edit(id, byUserId, body, mentions) {
      const r = await db.getRunComment(id);
      if (!r) throw new Error(`comment '${id}' not found`);
      if (r.deleted_at) throw new Error('cannot edit a deleted comment');
      if (r.author_id !== byUserId) throw new Error('forbidden: only the author may edit a comment');
      const ts = now();
      const mentionsJson = mentions ? JSON.stringify([...new Set(mentions)]) : r.mentions_json;
      await db.updateRunCommentBody(id, body, renderCommentMarkdown(body), mentionsJson, ts, ts);
      return (await resolveOne(id))!;
    },
    async softDelete(id, byUserId, opts2) {
      const r = await db.getRunComment(id);
      if (!r) return;
      if (r.author_id !== byUserId && !opts2?.force) throw new Error('forbidden: only the author (or a moderator) may delete a comment');
      await db.softDeleteRunComment(id, byUserId, now());
    },
    async resolveThread(threadId, byUserId) {
      const r = await db.getRunComment(threadId);
      if (!r) throw new Error(`thread '${threadId}' not found`);
      await db.setRunThreadResolution(threadId, now(), byUserId, now());
    },
    async reopenThread(threadId, byUserId) {
      const r = await db.getRunComment(threadId);
      if (!r) throw new Error(`thread '${threadId}' not found`);
      await db.setRunThreadResolution(threadId, null, null, now());
      void byUserId;
    },
  };
}

// ─── Annotation SQL adapter ─────────────────────────────────────────────────────

function rowToAnnotation(r: RunAnnotationRow): RunAnnotation {
  return {
    id: r.id, runId: r.run_id, tenantId: r.tenant_id ?? GLOBAL_TENANT,
    partId: r.part_id, authorId: r.author_id, name: r.name,
    dataType: r.data_type as AnnotationDataType, value: r.value, stringValue: r.string_value,
    comment: r.comment, source: r.source as AnnotationSource, createdAt: r.created_at,
  };
}

export function createSqlAnnotationManager(
  db: Pick<DatabaseAdapter, 'createRunAnnotation' | 'getRunAnnotation' | 'listRunAnnotations' | 'deleteRunAnnotation'>,
  opts: { now?: () => number } = {},
): AnnotationManager {
  const now = opts.now ?? (() => Date.now());
  return {
    async create(input) {
      const { value, stringValue } = normalizeAnnotationValue(input);
      const row: RunAnnotationRow = {
        id: input.id, run_id: input.runId, tenant_id: input.tenantId === GLOBAL_TENANT ? null : input.tenantId,
        part_id: input.partId ?? '', author_id: input.authorId, name: input.name,
        data_type: input.dataType, value, string_value: stringValue,
        comment: input.comment ?? null, source: input.source ?? 'human', created_at: now(),
      };
      await db.createRunAnnotation(row);
      return rowToAnnotation(row);
    },
    async getById(id) {
      const r = await db.getRunAnnotation(id);
      return r ? rowToAnnotation(r) : null;
    },
    async listForRun(runId) { return (await db.listRunAnnotations(runId)).map(rowToAnnotation); },
    async listForPart(runId, partId) {
      return (await db.listRunAnnotations(runId)).filter((r) => r.part_id === partId).map(rowToAnnotation);
    },
    async delete(id, byUserId, opts2) {
      const r = await db.getRunAnnotation(id);
      if (!r) return;
      if (r.author_id !== byUserId && !opts2?.force) throw new Error('forbidden: only the author (or a moderator) may delete an annotation');
      await db.deleteRunAnnotation(id);
    },
  };
}
