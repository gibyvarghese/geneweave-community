import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { runRoutingRegressionPass } from '../../routing-feedback.js';

/**
 * Routing Surface Items admin routes (anyWeave Phase 5).
 *
 * Surface items are alerts emitted by the regression detection job
 * (quality drops, auto-disabled capabilities). Admins can acknowledge or
 * resolve them and add resolution notes.
 *
 * Routes:
 *   GET    /api/admin/routing-surface-items?status=&severity=&modelId=&taskKey=&limit=
 *   GET    /api/admin/routing-surface-items/:id
 *   PATCH-equivalent via PUT:
 *   PUT    /api/admin/routing-surface-items/:id            { status?, resolution_note? }
 *   POST   /api/admin/routing-surface-items/run-now        Trigger one regression pass.
 */
export function registerRoutingSurfaceItemRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/routing-surface-items', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: Parameters<typeof db.listRoutingSurfaceItems>[0] = {};
    const st = url.searchParams.get('status');   if (st) opts.status = st;
    const md = url.searchParams.get('modelId');  if (md) opts.modelId = md;
    const pv = url.searchParams.get('provider'); if (pv) opts.provider = pv;
    const tk = url.searchParams.get('taskKey');  if (tk) opts.taskKey = tk;
    const li = url.searchParams.get('limit');    if (li) opts.limit = Number(li);
    let items = await db.listRoutingSurfaceItems(opts);
    const sev = url.searchParams.get('severity');
    if (sev) items = items.filter((i) => i.severity === sev);
    json(res, 200, { items });
  }, { auth: true });

  router.get('/api/admin/routing-surface-items/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getRoutingSurfaceItem(params['id']!);
    if (!item) { json(res, 404, { error: 'Routing surface item not found' }); return; }
    json(res, 200, { item });
  }, { auth: true });

  router.put('/api/admin/routing-surface-items/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = await db.getRoutingSurfaceItem(id);
    if (!existing) { json(res, 404, { error: 'Routing surface item not found' }); return; }
    const raw = await readBody(req);
    let body: { status?: string; resolution_note?: string | null };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Parameters<typeof db.updateRoutingSurfaceItem>[1] = {};
    if (body.status) {
      const allowed = new Set(['open', 'acknowledged', 'resolved']);
      if (!allowed.has(body.status)) { json(res, 400, { error: `Invalid status: ${body.status}` }); return; }
      fields.status = body.status;
      if (body.status === 'resolved') fields.resolved_at = new Date().toISOString();
    }
    if ('resolution_note' in body) fields.resolution_note = body.resolution_note ?? null;
    await db.updateRoutingSurfaceItem(id, fields);
    const updated = await db.getRoutingSurfaceItem(id);
    json(res, 200, { item: updated });
  }, { auth: true });

  router.post('/api/admin/routing-surface-items/run-now', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const result = await runRoutingRegressionPass(db);
    json(res, 200, result);
  }, { auth: true });
}
