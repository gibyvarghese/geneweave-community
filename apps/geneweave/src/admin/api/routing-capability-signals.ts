import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Routing Capability Signals admin routes (anyWeave Phase 5). READ-ONLY.
 *
 * Routes:
 *   GET /api/admin/routing-capability-signals?source=&modelId=&provider=&taskKey=&afterIso=&limit=
 *   GET /api/admin/routing-capability-signals/:id
 */
export function registerRoutingCapabilitySignalRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  router.get('/api/admin/routing-capability-signals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: Parameters<typeof db.listRoutingCapabilitySignals>[0] = {};
    const src = url.searchParams.get('source');     if (src) opts.source = src;
    const mid = url.searchParams.get('modelId');    if (mid) opts.modelId = mid;
    const pv  = url.searchParams.get('provider');   if (pv)  opts.provider = pv;
    const tk  = url.searchParams.get('taskKey');    if (tk)  opts.taskKey = tk;
    const af  = url.searchParams.get('afterIso');   if (af)  opts.afterIso = af;
    const bf  = url.searchParams.get('beforeIso');  if (bf)  opts.beforeIso = bf;
    const lim = url.searchParams.get('limit');      if (lim) opts.limit = Number(lim);
    const signals = await db.listRoutingCapabilitySignals(opts);
    json(res, 200, { signals });
  }, { auth: true });

  router.get('/api/admin/routing-capability-signals/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const signal = await db.getRoutingCapabilitySignal(params['id']!);
    if (!signal) { json(res, 404, { error: 'Routing capability signal not found' }); return; }
    json(res, 200, { signal });
  }, { auth: true });
}
