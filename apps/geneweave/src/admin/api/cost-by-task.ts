import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * anyWeave Phase 6 — Cost telemetry aggregated by task_key.
 *
 * Routes:
 *   GET /api/admin/cost-by-task?since=&until=&tenantId=
 */
export function registerCostByTaskRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get('/api/admin/cost-by-task', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: { since?: string; until?: string; tenantId?: string } = {};
    const s = url.searchParams.get('since'); if (s) opts.since = s;
    const u = url.searchParams.get('until'); if (u) opts.until = u;
    const t = url.searchParams.get('tenantId'); if (t) opts.tenantId = t;
    const items = await db.aggregateCostByTask(opts);
    const totals = items.reduce(
      (acc, i) => {
        acc.invocations += i.invocation_count;
        acc.cost_usd += i.total_cost_usd;
        return acc;
      },
      { invocations: 0, cost_usd: 0 },
    );
    json(res, 200, { items, totals });
  }, { auth: true });
}
