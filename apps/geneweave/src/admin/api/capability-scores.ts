import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getCapabilityMatrixCache } from '../../capability-matrix-cache.js';

/**
 * Model Capability Scores admin routes (anyWeave Phase 4 / M15).
 *
 * Routes:
 *   GET  /api/admin/capability-scores?taskKey=&tenantId=&modelId=&provider=
 *   GET  /api/admin/capability-scores/heatmap?tenantId=
 *   GET  /api/admin/capability-scores/:id
 *   POST /api/admin/capability-scores            (insert or upsert by unique key)
 *   PUT  /api/admin/capability-scores/:id
 *   DEL  /api/admin/capability-scores/:id
 */
export function registerCapabilityScoreRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/capability-scores/heatmap', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const tenantParam = url.searchParams.get('tenantId');
    const tenantId = tenantParam === '' || tenantParam === null ? null : tenantParam;
    const opts: { tenantId?: string | null } = {};
    if (tenantParam !== null) opts.tenantId = tenantId;
    const rows = await db.listCapabilityScores(opts);
    const taskTypes = await db.listTaskTypes();
    // Group: { [model_id+provider]: { provider, modelId, scoresByTask: { [task_key]: score } } }
    type Cell = { provider: string; model_id: string; tenant_id: string | null; scores: Record<string, number | null> };
    const grid = new Map<string, Cell>();
    for (const r of rows) {
      const key = `${r.provider}::${r.model_id}::${r.tenant_id ?? ''}`;
      let cell = grid.get(key);
      if (!cell) {
        cell = { provider: r.provider, model_id: r.model_id, tenant_id: r.tenant_id, scores: {} };
        grid.set(key, cell);
      }
      cell.scores[r.task_key] = r.quality_score;
    }
    json(res, 200, {
      taskKeys: taskTypes.map(t => t.task_key),
      taskTypes,
      models: Array.from(grid.values()),
      total: rows.length,
    });
  }, { auth: true });

  router.get('/api/admin/capability-scores', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: { taskKey?: string; tenantId?: string | null; modelId?: string; provider?: string } = {};
    const tk = url.searchParams.get('taskKey'); if (tk) opts.taskKey = tk;
    const md = url.searchParams.get('modelId'); if (md) opts.modelId = md;
    const pr = url.searchParams.get('provider'); if (pr) opts.provider = pr;
    if (url.searchParams.has('tenantId')) {
      const v = url.searchParams.get('tenantId');
      opts.tenantId = v === '' || v === null ? null : v;
    }
    const scores = await db.listCapabilityScores(opts);
    json(res, 200, { capabilityScores: scores });
  }, { auth: true });

  router.get('/api/admin/capability-scores/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const row = await db.getCapabilityScore(params['id']!);
    if (!row) { json(res, 404, { error: 'Capability score not found' }); return; }
    json(res, 200, { capabilityScore: row });
  }, { auth: true });

  router.post('/api/admin/capability-scores', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['model_id'] || !body['provider'] || !body['task_key']) {
      json(res, 400, { error: 'model_id, provider, and task_key required' }); return;
    }
    const id = (body['id'] as string) || newUUIDv7();
    await db.upsertCapabilityScore({
      id,
      tenant_id: (body['tenant_id'] as string | null) ?? null,
      model_id: String(body['model_id']),
      provider: String(body['provider']),
      task_key: String(body['task_key']),
      quality_score: Number(body['quality_score'] ?? 0),
      supports_tools: body['supports_tools'] === false ? 0 : 1,
      supports_streaming: body['supports_streaming'] === false ? 0 : 1,
      supports_thinking: body['supports_thinking'] ? 1 : 0,
      supports_json_mode: body['supports_json_mode'] ? 1 : 0,
      supports_vision: body['supports_vision'] ? 1 : 0,
      max_output_tokens: body['max_output_tokens'] !== undefined && body['max_output_tokens'] !== null ? Number(body['max_output_tokens']) : null,
      benchmark_source: (body['benchmark_source'] as string | null) ?? null,
      raw_benchmark_score: body['raw_benchmark_score'] !== undefined && body['raw_benchmark_score'] !== null ? Number(body['raw_benchmark_score']) : null,
      is_active: body['is_active'] === false ? 0 : 1,
      last_evaluated_at: (body['last_evaluated_at'] as string | null) ?? null,
      production_signal_score: body['production_signal_score'] !== undefined && body['production_signal_score'] !== null ? Number(body['production_signal_score']) : null,
      signal_sample_count: body['signal_sample_count'] !== undefined ? Number(body['signal_sample_count']) : 0,
    });
    // Find row by unique key (insert may have hit ON CONFLICT path)
    const matches = await db.listCapabilityScores({
      taskKey: String(body['task_key']),
      tenantId: (body['tenant_id'] as string | null) ?? null,
      modelId: String(body['model_id']),
      provider: String(body['provider']),
    });
    getCapabilityMatrixCache().invalidateCapabilityScores();
    json(res, 201, { capabilityScore: matches[0] ?? null });
  }, { auth: true, csrf: true });

  router.put('/api/admin/capability-scores/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCapabilityScore(params['id']!);
    if (!existing) { json(res, 404, { error: 'Capability score not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['model_id', 'provider', 'task_key', 'tenant_id', 'benchmark_source', 'last_evaluated_at'] as const) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    for (const k of ['quality_score', 'max_output_tokens', 'raw_benchmark_score'] as const) {
      if (body[k] !== undefined) fields[k] = body[k] === null ? null : Number(body[k]);
    }
    for (const k of ['supports_tools', 'supports_streaming', 'supports_thinking', 'supports_json_mode', 'supports_vision', 'is_active'] as const) {
      if (body[k] !== undefined) fields[k] = body[k] ? 1 : 0;
    }
    await db.updateCapabilityScore(params['id']!, fields as never);
    const capabilityScore = await db.getCapabilityScore(params['id']!);
    getCapabilityMatrixCache().invalidateCapabilityScores();
    json(res, 200, { capabilityScore });
  }, { auth: true, csrf: true });

  router.del('/api/admin/capability-scores/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCapabilityScore(params['id']!);
    getCapabilityMatrixCache().invalidateCapabilityScores();
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
