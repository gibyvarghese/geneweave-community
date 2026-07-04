import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getCapabilityMatrixCache } from '../../capability-matrix-cache.js';

/**
 * Task Type Definitions admin routes (anyWeave Phase 4 / M15).
 *
 * Routes:
 *   GET  /api/admin/task-types
 *   GET  /api/admin/task-types/:id
 *   POST /api/admin/task-types
 *   PUT  /api/admin/task-types/:id
 *   DEL  /api/admin/task-types/:id
 */
export function registerTaskTypeRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/task-types', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const taskTypes = await db.listTaskTypes();
    json(res, 200, { taskTypes });
  }, { auth: true });

  router.get('/api/admin/task-types/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const idOrKey = params['id']!;
    const row = (await db.getTaskTypeById(idOrKey)) ?? (await db.getTaskType(idOrKey));
    if (!row) { json(res, 404, { error: 'Task type not found' }); return; }
    json(res, 200, { taskType: row });
  }, { auth: true });

  router.post('/api/admin/task-types', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['task_key'] || !body['display_name']) {
      json(res, 400, { error: 'task_key and display_name required' }); return;
    }
    const id = newUUIDv7();
    const weights = body['default_weights'];
    const hints = body['inference_hints'];
    await db.createTaskType({
      id,
      task_key: String(body['task_key']),
      display_name: String(body['display_name']),
      category: String(body['category'] ?? 'general'),
      description: String(body['description'] ?? ''),
      output_modality: String(body['output_modality'] ?? 'text'),
      default_strategy: String(body['default_strategy'] ?? 'balanced'),
      default_weights: typeof weights === 'string' ? weights : JSON.stringify(weights ?? { cost: 0.25, speed: 0.25, quality: 0.25, capability: 0.25 }),
      inference_hints: typeof hints === 'string' ? hints : JSON.stringify(hints ?? {}),
      enabled: body['enabled'] === false ? 0 : 1,
    });
    const taskType = await db.getTaskTypeById(id);
    getCapabilityMatrixCache().invalidateTaskTypes();
    json(res, 201, { taskType });
  }, { auth: true, csrf: true });

  router.put('/api/admin/task-types/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = (await db.getTaskTypeById(id)) ?? (await db.getTaskType(id));
    if (!existing) { json(res, 404, { error: 'Task type not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['task_key', 'display_name', 'category', 'description', 'output_modality', 'default_strategy'] as const) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (body['default_weights'] !== undefined) {
      fields['default_weights'] = typeof body['default_weights'] === 'string' ? body['default_weights'] : JSON.stringify(body['default_weights']);
    }
    if (body['inference_hints'] !== undefined) {
      fields['inference_hints'] = typeof body['inference_hints'] === 'string' ? body['inference_hints'] : JSON.stringify(body['inference_hints']);
    }
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTaskType(existing.id, fields as never);
    const taskType = await db.getTaskTypeById(existing.id);
    getCapabilityMatrixCache().invalidateTaskTypes();
    json(res, 200, { taskType });
  }, { auth: true, csrf: true });

  router.del('/api/admin/task-types/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = (await db.getTaskTypeById(id)) ?? (await db.getTaskType(id));
    if (!existing) { json(res, 404, { error: 'Task type not found' }); return; }
    await db.deleteTaskType(existing.id);
    getCapabilityMatrixCache().invalidateTaskTypes();
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
