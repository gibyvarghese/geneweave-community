/**
 * /api/me — regenerate an answer, keeping version history (m139).
 *
 *   POST /api/me/chats/:chatId/messages/:messageId/regenerate      make a fresh alternative; keeps the old one
 *   GET  /api/me/chats/:chatId/messages/:messageId/versions        the stored versions (to hydrate the pager)
 *   POST /api/me/chats/:chatId/messages/:messageId/select-version  switch the shown version (lossless)
 *   GET  /api/me/answer-versions                                   this workspace's config (drives the UI)
 *
 * All scoped to the signed-in user; the chat is ownership-checked first.
 */
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createAnswerVersionsService } from '../answer-versions-sql.js';
import type { NoteAiGenerate } from '../note-ai-sql.js';

function metaOf(m: { metadata?: string | null } | undefined): Record<string, unknown> {
  try { return m?.metadata ? JSON.parse(m.metadata) as Record<string, unknown> : {}; } catch { return {}; }
}

export function registerMeVersionsRoutes(router: Router, db: DatabaseAdapter, opts: { aiGenerate?: NoteAiGenerate } = {}): void {
  const svc = createAnswerVersionsService(db, opts.aiGenerate ? { aiGenerate: opts.aiGenerate } : {});

  router.post('/api/me/chats/:chatId/messages/:messageId/regenerate', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chatId = params['chatId']!; const messageId = params['messageId']!;
    const chat = await db.getChat(chatId, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const messages = await db.getMessages(chatId);
    if (!messages.some((m) => m.id === messageId)) { json(res, 404, { error: 'Message not found' }); return; }
    const r = await svc.regenerate({
      userId: auth.userId, tenantId: auth.tenantId ?? null, chatId, messageId,
      history: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata })),
    });
    if (!r.ok) { json(res, 400, { error: r.error }); return; }
    json(res, 200, { messageId: r.messageId, content: r.content, variants: r.variants, activeIndex: r.activeIndex, label: r.label });
  }, { auth: true, csrf: true });

  router.get('/api/me/chats/:chatId/messages/:messageId/versions', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const messages = await db.getMessages(params['chatId']!);
    const msg = messages.find((m) => m.id === params['messageId']!);
    if (!msg) { json(res, 404, { error: 'Message not found' }); return; }
    const r = await svc.listVersions(params['messageId']!, auth.tenantId ?? null, metaOf(msg));
    json(res, 200, { variants: r.variants, activeIndex: r.activeIndex, content: r.content, label: r.label });
  });

  router.post('/api/me/chats/:chatId/messages/:messageId/select-version', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chatId = params['chatId']!; const messageId = params['messageId']!;
    const chat = await db.getChat(chatId, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const messages = await db.getMessages(chatId);
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) { json(res, 404, { error: 'Message not found' }); return; }
    let body: { index?: unknown };
    try { body = JSON.parse(await readBody(req)) as { index?: unknown }; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const index = Number(body.index);
    if (!Number.isFinite(index)) { json(res, 400, { error: 'index is required' }); return; }
    const r = await svc.selectVariant({ userId: auth.userId, tenantId: auth.tenantId ?? null, chatId, messageId, index, currentMeta: metaOf(msg) });
    if (!r.ok) { json(res, 400, { error: r.error }); return; }
    json(res, 200, { content: r.content, activeIndex: r.activeIndex, label: r.label });
  }, { auth: true, csrf: true });

  router.get('/api/me/answer-versions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await svc.getConfig(auth.tenantId ?? 'default');
    json(res, 200, { enabled: c.enabled === 1, maxVariants: c.max_variants });
  });
}
