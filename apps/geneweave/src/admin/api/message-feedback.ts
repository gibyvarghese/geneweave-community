import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Message Feedback admin routes (anyWeave Phase 5). READ-ONLY admin view.
 * The mutation route (POST /api/messages/:id/feedback) lives in the public
 * router so any authenticated user can submit feedback on their own messages.
 *
 * Routes:
 *   GET /api/admin/message-feedback?messageId=&chatId=&signal=&limit=
 *   GET /api/admin/message-feedback/:id
 */
export function registerMessageFeedbackRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get('/api/admin/message-feedback', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: Parameters<typeof db.listMessageFeedback>[0] = {};
    const m = url.searchParams.get('messageId'); if (m) opts.messageId = m;
    const c = url.searchParams.get('chatId');    if (c) opts.chatId = c;
    const s = url.searchParams.get('signal');    if (s) opts.signal = s;
    const l = url.searchParams.get('limit');     if (l) opts.limit = Number(l);
    let feedback = await db.listMessageFeedback(opts);
    // Tenant scoping: tenant_admin only sees feedback from users in their tenant
    if (auth.persona !== 'platform_admin' && auth.tenantId) {
      const tenantUsers = await db.listUsers({ tenantId: auth.tenantId });
      const tenantUserIds = new Set(tenantUsers.map((u) => u.id));
      feedback = feedback.filter((f) => f.user_id !== null && tenantUserIds.has(f.user_id));
    }
    json(res, 200, { feedback });
  }, { auth: true });

  router.get('/api/admin/message-feedback/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getMessageFeedback(params['id']!);
    if (!item) { json(res, 404, { error: 'Message feedback not found' }); return; }
    json(res, 200, { feedback: item });
  }, { auth: true });
}
