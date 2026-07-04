/**
 * /api/me — answer feedback (read-side) + AI transparency (m137).
 *
 *   GET  /api/me/chats/:chatId/feedback   my feedback across the chat (hydrate the thumbs in the UI)
 *   GET  /api/me/ai-transparency          this workspace's transparency config (drives the AI-generated label)
 *
 * Submitting feedback reuses the platform's existing endpoint — POST /api/messages/:id/feedback — which
 * m137 extended to also accept the tiered `categories` reason. All read routes are scoped to the signed-in
 * user; the chat is ownership-checked first.
 */
import type { DatabaseAdapter } from '../db.js';
import { json } from '../server-core.js';
import type { Router } from '../server-core.js';
import { createAnswerFeedbackService } from '../answer-feedback-sql.js';

export function registerMeFeedbackRoutes(router: Router, db: DatabaseAdapter): void {
  const svc = createAnswerFeedbackService(db);

  router.get('/api/me/chats/:chatId/feedback', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    json(res, 200, { feedback: await svc.getMineForChat(params['chatId']!, auth.userId) });
  });

  router.get('/api/me/ai-transparency', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const t = await svc.getTransparency(auth.tenantId ?? 'default');
    json(res, 200, {
      showAiLabel: t.show_ai_label === 1,
      disclosureText: t.disclosure_text,
      contentWarnings: t.content_warnings === 1,
      feedbackEnabled: t.feedback_enabled === 1,
      categories: svc.categories.map((c) => ({ key: c.key, label: c.label, help: c.help })),
    });
  });
}
