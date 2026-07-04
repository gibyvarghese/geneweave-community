import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RoutingPolicyRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Register routing policy admin routes
 *
 * Routes:
 * - GET /api/admin/routing
 * - GET /api/admin/routing/:id
 * - POST /api/admin/routing
 * - PUT /api/admin/routing/:id
 * - DEL /api/admin/routing/:id
 */
export function registerRoutingRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/routing', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listRoutingPolicies();
    json(res, 200, { policies });
  }, { auth: true });

  router.get('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getRoutingPolicy(params['id']!);
    if (!p) { json(res, 404, { error: 'Routing policy not found' }); return; }
    json(res, 200, { policy: p });
  }, { auth: true });

  router.post('/api/admin/routing', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['strategy']) { json(res, 400, { error: 'name and strategy required' }); return; }
    const id = 'route-' + newUUIDv7().slice(-8);
    await db.createRoutingPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      strategy: body['strategy'] as string,
      constraints: body['constraints'] ? JSON.stringify(body['constraints']) : null,
      weights: body['weights'] ? JSON.stringify(body['weights']) : null,
      fallback_model: (body['fallback_model'] as string) ?? null,
      fallback_provider: (body['fallback_provider'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const policy = await db.getRoutingPolicy(id);
    json(res, 201, { policy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/routing/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getRoutingPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Routing policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['strategy'] !== undefined) fields['strategy'] = body['strategy'];
    if (body['constraints'] !== undefined) fields['constraints'] = JSON.stringify(body['constraints']);
    if (body['weights'] !== undefined) fields['weights'] = JSON.stringify(body['weights']);
    if (body['fallback_model'] !== undefined) fields['fallback_model'] = body['fallback_model'];
    if (body['fallback_provider'] !== undefined) fields['fallback_provider'] = body['fallback_provider'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateRoutingPolicy(params['id']!, fields as Partial<Omit<RoutingPolicyRow, 'id' | 'created_at' | 'updated_at'>>);
    const policy = await db.getRoutingPolicy(params['id']!);
    json(res, 200, { policy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteRoutingPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
