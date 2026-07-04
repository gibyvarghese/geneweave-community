/**
 * routes/me-conversations.ts — User-scoped conversation list (SP2, mobile)
 *
 * Backs the mobile conversation list (M6) and any other client that needs a
 * searchable, pinnable, archivable list of the caller's conversations.
 *
 *   GET   /api/me/conversations?query=&filter=&limit=&offset=
 *           → { conversations: [{ id, title, snippet, mode, updatedAt,
 *                                 runStatus, pinned, archived, hasPendingAction,
 *                                 participants, unread }] }
 *   PATCH /api/me/conversations/:id   { pinned?, archived?, title? }
 *           → { conversation: { ... } }   (404 for cross-principal / unknown id)
 *
 * Conversations are backed by the `chats` table (id, title, model, provider,
 * pinned, archived). `snippet` is the most-recent message content, `mode` comes
 * from chat_settings, `hasPendingAction` is derived from open action-item tasks
 * whose provenance.sourceRunId points at the conversation, and `participants` is
 * length-1 today (team-ready for a future multi-participant model).
 */

import type { Router } from '../server-core.js';
import { readBody, json } from '../server-core.js';
import type {
  DatabaseAdapter,
  ConversationRow,
  ConversationListFilter,
} from '../db-types.js';
import { meTaskRepo, OPEN_TASK_STATUSES } from './me-stores.js';
import { safePageInt } from './index.js';

const SNIPPET_MAX = 140;
const TITLE_MAX = 200;
const VALID_FILTERS: ReadonlySet<string> = new Set(['active', 'archived', 'pinned', 'all']);

/**
 * Resolves which of the given conversation ids have at least one open
 * (non-terminal) action-item task. Batched: reads the principal's tasks once
 * and returns the set of conversation ids with a pending action.
 */
export type PendingActionResolver = (
  userId: string,
  conversationIds: string[],
) => Promise<Set<string>>;

export interface MeConversationsOptions {
  /** Override the default in-memory-task-repo-backed pending-action resolver. */
  pendingActionResolver?: PendingActionResolver;
}

const defaultPendingActionResolver: PendingActionResolver = async (userId, conversationIds) => {
  const wanted = new Set(conversationIds);
  const out = new Set<string>();
  if (wanted.size === 0) return out;
  try {
    const tasks = await meTaskRepo.listByAssignee(userId);
    for (const t of tasks) {
      const src = t.provenance?.sourceRunId;
      if (src && wanted.has(src) && OPEN_TASK_STATUSES.has(t.status)) out.add(src);
    }
  } catch {
    // Graceful degradation — pending-action is a hint, never load-bearing.
  }
  return out;
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

function toConversationResponse(row: ConversationRow, userId: string, hasPendingAction: boolean) {
  return {
    id: row.id,
    title: row.title,
    snippet: row.snippet ? truncate(row.snippet, SNIPPET_MAX) : null,
    mode: row.mode,
    updatedAt: row.updated_at,
    // Chats have no run lifecycle yet; field is present for client-schema parity
    // with future run-backed conversations.
    runStatus: null as string | null,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    hasPendingAction,
    participants: [userId],
    unread: false,
  };
}

export function registerMeConversationsRoutes(
  router: Router,
  db: DatabaseAdapter,
  opts: MeConversationsOptions = {},
): void {
  const resolvePending = opts.pendingActionResolver ?? defaultPendingActionResolver;

  router.get('/api/me/conversations', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }

    const url = new URL(req.url ?? '/', 'http://x');
    const query = url.searchParams.get('query') ?? undefined;
    const rawFilter = url.searchParams.get('filter') ?? 'active';
    const filter = (VALID_FILTERS.has(rawFilter) ? rawFilter : 'active') as ConversationListFilter;
    const limit = safePageInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = safePageInt(url.searchParams.get('offset'), 0, 0, 1_000_000);

    const rows = await db.listUserConversations(auth.userId, {
      ...(query ? { query } : {}),
      filter,
      limit,
      offset,
    });

    const pending = await resolvePending(auth.userId, rows.map((r) => r.id));
    const conversations = rows.map((r) => toConversationResponse(r, auth.userId, pending.has(r.id)));

    json(res, 200, { conversations });
  }, { auth: true });

  router.add('PATCH', '/api/me/conversations/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }

    let body: { pinned?: unknown; archived?: unknown; title?: unknown };
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const flags: { pinned?: boolean; archived?: boolean; title?: string } = {};
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') { json(res, 400, { error: 'pinned must be a boolean' }); return; }
      flags.pinned = body.pinned;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') { json(res, 400, { error: 'archived must be a boolean' }); return; }
      flags.archived = body.archived;
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string') { json(res, 400, { error: 'title must be a string' }); return; }
      const trimmed = body.title.trim();
      if (!trimmed) { json(res, 400, { error: 'title must not be empty' }); return; }
      if (trimmed.length > TITLE_MAX) { json(res, 400, { error: `title must be at most ${TITLE_MAX} characters` }); return; }
      flags.title = trimmed;
    }

    if (flags.pinned === undefined && flags.archived === undefined && flags.title === undefined) {
      json(res, 400, { error: 'at least one of pinned, archived, title is required' });
      return;
    }

    const updated = await db.setConversationFlags(params['id']!, auth.userId, flags);
    // Cross-principal or unknown id is hidden behind a 404 (no existence disclosure).
    if (!updated) { json(res, 404, { error: 'Not found' }); return; }

    const pending = await resolvePending(auth.userId, [updated.id]);
    json(res, 200, { conversation: toConversationResponse(updated, auth.userId, pending.has(updated.id)) });
  }, { auth: true, csrf: true });

  // GET /api/me/conversations/:id/messages — message history for one of the
  // caller's conversations (transcript hydration when a chat is re-opened).
  // Ownership is verified with getUserConversation, so a cross-principal or
  // unknown id is hidden behind a 404 (no existence disclosure, matching PATCH).
  router.get('/api/me/conversations/:id/messages', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }

    const id = params['id']!;
    const conversation = await db.getUserConversation(id, auth.userId);
    if (!conversation) { json(res, 404, { error: 'Not found' }); return; }

    const url = new URL(req.url ?? '', 'http://localhost');
    const limit = safePageInt(url.searchParams.get('limit'), 500, 1, 1000);

    const rows = await db.getMessages(id);
    // Only user/assistant turns are part of the visible transcript; system and
    // tool rows are internal. getMessages is already ASC by created_at.
    const visible = rows.filter((m) => m.role === 'user' || m.role === 'assistant');
    const messages = visible.slice(0, limit).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    }));

    json(res, 200, { messages });
  }, { auth: true });
}
