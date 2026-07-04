import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Routing Decision Traces admin routes (anyWeave Phase 4 / M16). READ-ONLY.
 *
 * Routes:
 *   GET /api/admin/routing-decision-traces?tenantId=&agentId=&taskKey=&limit=&after=
 *   GET /api/admin/routing-decision-traces/:id
 */
export function registerRoutingDecisionTraceRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get('/api/admin/routing-decision-traces', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: { tenantId?: string; agentId?: string; taskKey?: string; limit?: number; after?: string } = {};
    const tn = url.searchParams.get('tenantId'); if (tn) opts.tenantId = tn;
    const ag = url.searchParams.get('agentId'); if (ag) opts.agentId = ag;
    const tk = url.searchParams.get('taskKey'); if (tk) opts.taskKey = tk;
    const lim = url.searchParams.get('limit'); if (lim) opts.limit = Number(lim);
    const af = url.searchParams.get('after'); if (af) opts.after = af;
    const traces = await db.listRoutingDecisionTraces(opts);
    json(res, 200, { traces });
  }, { auth: true });

  router.get('/api/admin/routing-decision-traces/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const trace = await db.getRoutingDecisionTrace(params['id']!);
    if (!trace) { json(res, 404, { error: 'Routing decision trace not found' }); return; }
    json(res, 200, { trace });
  }, { auth: true });
}
