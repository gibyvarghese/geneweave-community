import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { newUUIDv7 } from '../../lib/uuid.js';

/**
 * Task Type Tenant Overrides admin routes (anyWeave Phase 4 / M15).
 *
 * Routes:
 *   GET  /api/admin/task-type-tenant-overrides?tenantId=&taskKey=
 *   GET  /api/admin/task-type-tenant-overrides/:id
 *   POST /api/admin/task-type-tenant-overrides
 *   PUT  /api/admin/task-type-tenant-overrides/:id
 *   DEL  /api/admin/task-type-tenant-overrides/:id
 */
export function registerTaskTypeTenantOverrideRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/task-type-tenant-overrides', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: { tenantId?: string; taskKey?: string } = {};
    const tn = url.searchParams.get('tenantId'); if (tn) opts.tenantId = tn;
    const tk = url.searchParams.get('taskKey'); if (tk) opts.taskKey = tk;
    const overrides = await db.listTaskTypeTenantOverrides(opts);
    json(res, 200, { overrides });
  }, { auth: true });

  router.get('/api/admin/task-type-tenant-overrides/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getTaskTypeTenantOverride(params['id']!);
    if (!row) { json(res, 404, { error: 'Override not found' }); return; }
    json(res, 200, { override: row });
  }, { auth: true });

  router.post('/api/admin/task-type-tenant-overrides', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['tenant_id'] || !body['task_key']) {
      json(res, 400, { error: 'tenant_id and task_key required' }); return;
    }
    const id = newUUIDv7();
    const weights = body['weights'];
    await db.createTaskTypeTenantOverride({
      id,
      tenant_id: String(body['tenant_id']),
      task_key: String(body['task_key']),
      weights: weights == null ? null : (typeof weights === 'string' ? weights : JSON.stringify(weights)),
      preferred_model_id: (body['preferred_model_id'] as string | null) ?? null,
      preferred_provider: (body['preferred_provider'] as string | null) ?? null,
      preferred_boost_pct: Number(body['preferred_boost_pct'] ?? 20),
      cost_ceiling_per_call: body['cost_ceiling_per_call'] !== undefined && body['cost_ceiling_per_call'] !== null
        ? Number(body['cost_ceiling_per_call']) : null,
      optimisation_strategy: (body['optimisation_strategy'] as string | null) ?? null,
      enabled: body['enabled'] === false ? 0 : 1,
    });
    const override = await db.getTaskTypeTenantOverride(id);
    json(res, 201, { override });
  }, { auth: true, csrf: true });

  router.put('/api/admin/task-type-tenant-overrides/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTaskTypeTenantOverride(params['id']!);
    if (!existing) { json(res, 404, { error: 'Override not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['tenant_id', 'task_key', 'preferred_model_id', 'preferred_provider', 'optimisation_strategy'] as const) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (body['weights'] !== undefined) {
      fields['weights'] = body['weights'] == null ? null : (typeof body['weights'] === 'string' ? body['weights'] : JSON.stringify(body['weights']));
    }
    if (body['preferred_boost_pct'] !== undefined) fields['preferred_boost_pct'] = Number(body['preferred_boost_pct']);
    if (body['cost_ceiling_per_call'] !== undefined) fields['cost_ceiling_per_call'] = body['cost_ceiling_per_call'] === null ? null : Number(body['cost_ceiling_per_call']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTaskTypeTenantOverride(params['id']!, fields as never);
    const override = await db.getTaskTypeTenantOverride(params['id']!);
    json(res, 200, { override });
  }, { auth: true, csrf: true });

  router.del('/api/admin/task-type-tenant-overrides/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTaskTypeTenantOverride(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
