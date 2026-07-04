import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { newUUIDv7 } from '../../lib/uuid.js';

/**
 * anyWeave Phase 6 — Routing Experiments admin routes.
 *
 * Routes:
 *   GET    /api/admin/routing-experiments?status=&taskKey=&tenantId=
 *   GET    /api/admin/routing-experiments/:id
 *   POST   /api/admin/routing-experiments
 *   PUT    /api/admin/routing-experiments/:id
 *   DEL    /api/admin/routing-experiments/:id
 */
export function registerRoutingExperimentRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/routing-experiments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: { status?: string; taskKey?: string; tenantId?: string | null } = {};
    const st = url.searchParams.get('status'); if (st) opts.status = st;
    const tk = url.searchParams.get('taskKey'); if (tk) opts.taskKey = tk;
    if (url.searchParams.has('tenantId')) {
      const v = url.searchParams.get('tenantId');
      opts.tenantId = v === '' || v === null ? null : v;
    }
    const experiments = await db.listRoutingExperiments(opts);
    json(res, 200, { experiments });
  }, { auth: true });

  router.get('/api/admin/routing-experiments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getRoutingExperiment(params['id']!);
    if (!row) { json(res, 404, { error: 'Routing experiment not found' }); return; }
    json(res, 200, { experiment: row });
  }, { auth: true });

  router.post('/api/admin/routing-experiments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const required = ['name', 'baseline_provider', 'baseline_model_id', 'candidate_provider', 'candidate_model_id'];
    for (const k of required) {
      if (!body[k]) { json(res, 400, { error: `${k} required` }); return; }
    }
    const traffic = Number(body['traffic_pct'] ?? 10);
    if (!Number.isFinite(traffic) || traffic < 0 || traffic > 100) {
      json(res, 400, { error: 'traffic_pct must be between 0 and 100' }); return;
    }
    const id = newUUIDv7();
    const meta = body['metadata'];
    await db.createRoutingExperiment({
      id,
      name: String(body['name']),
      description: (body['description'] as string | null) ?? null,
      tenant_id: (body['tenant_id'] as string | null) ?? null,
      task_key: (body['task_key'] as string | null) ?? null,
      baseline_provider: String(body['baseline_provider']),
      baseline_model_id: String(body['baseline_model_id']),
      candidate_provider: String(body['candidate_provider']),
      candidate_model_id: String(body['candidate_model_id']),
      traffic_pct: traffic,
      status: String(body['status'] ?? 'active'),
      metadata: meta == null ? null : (typeof meta === 'string' ? meta : JSON.stringify(meta)),
    });
    const experiment = await db.getRoutingExperiment(id);
    json(res, 201, { experiment });
  }, { auth: true, csrf: true });

  router.put('/api/admin/routing-experiments/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getRoutingExperiment(params['id']!);
    if (!existing) { json(res, 404, { error: 'Routing experiment not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'tenant_id', 'task_key', 'baseline_provider', 'baseline_model_id', 'candidate_provider', 'candidate_model_id', 'status', 'ended_at'] as const) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (body['traffic_pct'] !== undefined) {
      const n = Number(body['traffic_pct']);
      if (!Number.isFinite(n) || n < 0 || n > 100) { json(res, 400, { error: 'traffic_pct must be between 0 and 100' }); return; }
      fields['traffic_pct'] = n;
    }
    if (body['metadata'] !== undefined) {
      fields['metadata'] = body['metadata'] == null ? null : (typeof body['metadata'] === 'string' ? body['metadata'] : JSON.stringify(body['metadata']));
    }
    await db.updateRoutingExperiment(params['id']!, fields as never);
    const experiment = await db.getRoutingExperiment(params['id']!);
    json(res, 200, { experiment });
  }, { auth: true, csrf: true });

  router.del('/api/admin/routing-experiments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteRoutingExperiment(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
