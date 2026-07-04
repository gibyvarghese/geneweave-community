/**
 * GeneWeave — Admin Endpoint Health routes (Resilience Phase 4)
 *
 * Read-only endpoints surfacing per-endpoint resilience telemetry (success /
 * failed / rate-limited / circuit state) accumulated by `DbResilienceObserver`
 * into the `endpoint_health` table.
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerEndpointHealthRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json } = helpers;

  /** List every observed endpoint, newest activity first. */
  router.get('/api/admin/endpoint-health', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const circuitState = url.searchParams.get('circuit_state') ?? undefined;
    const limit  = Math.min(parseInt(url.searchParams.get('limit')  ?? '200', 10), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0);
    const endpoints = await db.listEndpointHealth({
      ...(circuitState ? { circuitState } : {}),
      limit,
      offset,
    });
    json(res, 200, { endpoints });
  }, { auth: true });

  /** Single endpoint by id (e.g. `openai:rest`, `tools-http:weather`). */
  router.get('/api/admin/endpoint-health/:endpoint', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = decodeURIComponent(params['endpoint']!);
    const endpoint = await db.getEndpointHealth(id);
    if (!endpoint) { json(res, 404, { error: 'Endpoint not found' }); return; }
    json(res, 200, { endpoint });
  }, { auth: true });
}
