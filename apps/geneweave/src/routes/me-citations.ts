/**
 * /api/me — answer citations in chat (m138).
 *
 *   POST /api/me/chats/:chatId/cite                              answer the question grounded in my workspace,
 *                                                                with verified [n] citations; persists both turns
 *   GET  /api/me/chats/:chatId/messages/:messageId/citations    the stored verified citations for one message
 *   GET  /api/me/chat-citations                                  this workspace's citation config (drives the UI)
 *
 * All scoped to the signed-in user; the chat is ownership-checked first.
 */
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createChatCitationsService } from '../chat-citations-sql.js';
import type { NoteAiGenerate } from '../note-ai-sql.js';

export function registerMeCitationsRoutes(router: Router, db: DatabaseAdapter, opts: { aiGenerate?: NoteAiGenerate } = {}): void {
  const svc = createChatCitationsService(db, opts.aiGenerate ? { aiGenerate: opts.aiGenerate } : {});

  router.post('/api/me/chats/:chatId/cite', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    let body: { question?: unknown };
    try { body = JSON.parse(await readBody(req)) as { question?: unknown }; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const question = typeof body.question === 'string' ? body.question : '';
    if (!question.trim()) { json(res, 400, { error: 'question is required' }); return; }
    const r = await svc.answerWithCitations({ userId: auth.userId, tenantId: auth.tenantId ?? null, chatId: params['chatId']!, question });
    if (!r.ok) { json(res, 400, { error: r.error }); return; }
    json(res, 200, {
      userMessageId: r.userMessageId, messageId: r.messageId,
      answer: r.answer, citations: r.citations, sources: r.sources,
      grounded: r.grounded, groundingNote: r.groundingNote,
    });
  }, { auth: true, csrf: true });

  router.get('/api/me/chats/:chatId/messages/:messageId/citations', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    json(res, 200, { citations: await svc.getMessageCitations(params['messageId']!) });
  });

  router.get('/api/me/chat-citations', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await svc.getConfig(auth.tenantId ?? 'default');
    json(res, 200, { enabled: c.enabled === 1, minCitations: c.min_citations, scope: c.scope, maxSources: c.max_sources });
  });
}
