/**
 * GeneWeave — Admin Tool Audit routes (Phase 3)
 *
 * Read-only endpoints for the append-only tool_audit_events table.
 * No POST/PUT/DELETE — audit records are immutable.
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerToolAuditRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  /** List audit events with optional filters */
  router.get('/api/admin/tool-audit', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const toolName = url.searchParams.get('tool_name') ?? undefined;
    const chatId   = url.searchParams.get('chat_id')   ?? undefined;
    const outcome  = url.searchParams.get('outcome')   ?? undefined;
    const afterIso = url.searchParams.get('after')     ?? undefined;
    const beforeIso = url.searchParams.get('before')   ?? undefined;
    const limit    = Math.min(parseInt(url.searchParams.get('limit')  ?? '100', 10), 500);
    const offset   = Math.max(parseInt(url.searchParams.get('offset') ?? '0',   10), 0);

    const events = await db.listToolAuditEvents({ toolName, chatId, outcome, afterIso, beforeIso, limit, offset });
    json(res, 200, { events, limit, offset });
  }, { auth: true });

  /** Get a single audit event by ID */
  router.get('/api/admin/tool-audit/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const event = await db.getToolAuditEvent(params['id']!);
    if (!event) { json(res, 404, { error: 'Audit event not found' }); return; }
    json(res, 200, { event });
  }, { auth: true });
}
