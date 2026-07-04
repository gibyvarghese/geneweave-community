import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { HumanTaskPolicyRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Register human task policy admin routes
 */
export function registerTaskPolicyRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/task-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listHumanTaskPolicies();
    json(res, 200, { taskPolicies: policies });
  }, { auth: true });

  router.get('/api/admin/task-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getHumanTaskPolicy(params['id']!);
    if (!p) { json(res, 404, { error: 'Task policy not found' }); return; }
    json(res, 200, { taskPolicy: p });
  }, { auth: true });

  router.post('/api/admin/task-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['trigger']) { json(res, 400, { error: 'name and trigger required' }); return; }
    const id = 'htp-' + newUUIDv7().slice(-8);
    await db.createHumanTaskPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      trigger: body['trigger'] as string, task_type: (body['task_type'] as string) ?? 'approval',
      default_priority: (body['default_priority'] as string) ?? 'normal',
      sla_hours: (body['sla_hours'] as number) ?? null, auto_escalate_after_hours: (body['auto_escalate_after_hours'] as number) ?? null,
      assignment_strategy: (body['assignment_strategy'] as string) ?? 'round-robin',
      assign_to: (body['assign_to'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const taskPolicy = await db.getHumanTaskPolicy(id);
    json(res, 201, { taskPolicy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/task-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getHumanTaskPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Task policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['trigger'] !== undefined) fields['trigger'] = body['trigger'];
    if (body['task_type'] !== undefined) fields['task_type'] = body['task_type'];
    if (body['default_priority'] !== undefined) fields['default_priority'] = body['default_priority'];
    if (body['sla_hours'] !== undefined) fields['sla_hours'] = body['sla_hours'];
    if (body['auto_escalate_after_hours'] !== undefined) fields['auto_escalate_after_hours'] = body['auto_escalate_after_hours'];
    if (body['assignment_strategy'] !== undefined) fields['assignment_strategy'] = body['assignment_strategy'];
    if (body['assign_to'] !== undefined) fields['assign_to'] = body['assign_to'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateHumanTaskPolicy(params['id']!, fields as Partial<Omit<HumanTaskPolicyRow, 'id' | 'created_at' | 'updated_at'>>);
    const taskPolicy = await db.getHumanTaskPolicy(params['id']!);
    json(res, 200, { taskPolicy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/task-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteHumanTaskPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
