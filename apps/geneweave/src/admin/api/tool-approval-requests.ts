/**
 * GeneWeave — Admin Tool Approval Requests routes (Phase 6)
 *
 * Endpoints for listing and resolving pending tool approval requests.
 * Approval requests are created at runtime when a policy-gated tool requires human
 * approval before execution. Operators approve or deny via these endpoints.
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerToolApprovalRequestRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  /** List approval requests with optional filters */
  router.get('/api/admin/tool-approval-requests', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status   = url.searchParams.get('status')    ?? undefined;
    const chatId   = url.searchParams.get('chat_id')   ?? undefined;
    const toolName = url.searchParams.get('tool_name') ?? undefined;
    const limit    = Math.min(parseInt(url.searchParams.get('limit')  ?? '100', 10), 500);
    const offset   = Math.max(parseInt(url.searchParams.get('offset') ?? '0',   10), 0);

    const requests = await db.listToolApprovalRequests({ status, chatId, toolName, limit, offset });
    json(res, 200, { requests, limit, offset });
  }, { auth: true });

  /** Get a single approval request by ID */
  router.get('/api/admin/tool-approval-requests/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const request = await db.getToolApprovalRequest(params['id']!);
    if (!request) { json(res, 404, { error: 'Approval request not found' }); return; }
    json(res, 200, { request });
  }, { auth: true });

  /** Approve a pending request */
  router.post('/api/admin/tool-approval-requests/:id/approve', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolApprovalRequest(params['id']!);
    if (!existing) { json(res, 404, { error: 'Approval request not found' }); return; }
    if (existing.status !== 'pending') {
      json(res, 409, { error: `Request is already ${existing.status}` });
      return;
    }
    let body: { note?: string } = {};
    try {
      const raw = await new Promise<string>((resolve) => {
        let buf = '';
        req.on('data', (c: Buffer) => { buf += c.toString(); });
        req.on('end', () => resolve(buf));
      });
      if (raw) body = JSON.parse(raw);
    } catch { /* ignore parse errors */ }

    await db.resolveToolApprovalRequest(params['id']!, {
      status: 'approved',
      resolved_by: auth.userId,
      resolution_note: body.note,
    });
    const updated = await db.getToolApprovalRequest(params['id']!);
    json(res, 200, { request: updated });
  }, { auth: true });

  /** Deny a pending request */
  router.post('/api/admin/tool-approval-requests/:id/deny', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolApprovalRequest(params['id']!);
    if (!existing) { json(res, 404, { error: 'Approval request not found' }); return; }
    if (existing.status !== 'pending') {
      json(res, 409, { error: `Request is already ${existing.status}` });
      return;
    }
    let body: { note?: string } = {};
    try {
      const raw = await new Promise<string>((resolve) => {
        let buf = '';
        req.on('data', (c: Buffer) => { buf += c.toString(); });
        req.on('end', () => resolve(buf));
      });
      if (raw) body = JSON.parse(raw);
    } catch { /* ignore parse errors */ }

    await db.resolveToolApprovalRequest(params['id']!, {
      status: 'denied',
      resolved_by: auth.userId,
      resolution_note: body.note,
    });
    const updated = await db.getToolApprovalRequest(params['id']!);
    json(res, 200, { request: updated });
  }, { auth: true });
}
