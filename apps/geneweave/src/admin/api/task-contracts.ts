import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { TaskContractRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

/**
 * Register task contract admin routes
 */
export function registerTaskContractRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/contracts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const contracts = await db.listTaskContracts();
    json(res, 200, { contracts });
  }, { auth: true });

  router.get('/api/admin/contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getTaskContract(params['id']!);
    if (!c) { json(res, 404, { error: 'Contract not found' }); return; }
    json(res, 200, { contract: c });
  }, { auth: true });

  router.post('/api/admin/contracts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'tc-' + newUUIDv7().slice(-8);
    await db.createTaskContract({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      input_schema: body['input_schema'] ? (typeof body['input_schema'] === 'string' ? body['input_schema'] as string : JSON.stringify(body['input_schema'])) : null,
      output_schema: body['output_schema'] ? (typeof body['output_schema'] === 'string' ? body['output_schema'] as string : JSON.stringify(body['output_schema'])) : null,
      acceptance_criteria: body['acceptance_criteria'] ? (typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] as string : JSON.stringify(body['acceptance_criteria'])) : '[]',
      max_attempts: (body['max_attempts'] as number) ?? null,
      timeout_ms: (body['timeout_ms'] as number) ?? null,
      evidence_required: body['evidence_required'] ? (typeof body['evidence_required'] === 'string' ? body['evidence_required'] as string : JSON.stringify(body['evidence_required'])) : null,
      min_confidence: (body['min_confidence'] as number) ?? null,
      require_human_review: body['require_human_review'] ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const contract = await db.getTaskContract(id);
    json(res, 201, { contract });
  }, { auth: true, csrf: true });

  router.put('/api/admin/contracts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTaskContract(params['id']!);
    if (!existing) { json(res, 404, { error: 'Contract not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['input_schema'] !== undefined) fields['input_schema'] = typeof body['input_schema'] === 'string' ? body['input_schema'] : JSON.stringify(body['input_schema']);
    if (body['output_schema'] !== undefined) fields['output_schema'] = typeof body['output_schema'] === 'string' ? body['output_schema'] : JSON.stringify(body['output_schema']);
    if (body['acceptance_criteria'] !== undefined) fields['acceptance_criteria'] = typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] : JSON.stringify(body['acceptance_criteria']);
    if (body['max_attempts'] !== undefined) fields['max_attempts'] = body['max_attempts'];
    if (body['timeout_ms'] !== undefined) fields['timeout_ms'] = body['timeout_ms'];
    if (body['evidence_required'] !== undefined) fields['evidence_required'] = typeof body['evidence_required'] === 'string' ? body['evidence_required'] : JSON.stringify(body['evidence_required']);
    if (body['min_confidence'] !== undefined) fields['min_confidence'] = body['min_confidence'];
    if (body['require_human_review'] !== undefined) fields['require_human_review'] = body['require_human_review'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTaskContract(params['id']!, fields as Partial<Omit<TaskContractRow, 'id' | 'created_at' | 'updated_at'>>);
    const contract = await db.getTaskContract(params['id']!);
    json(res, 200, { contract });
  }, { auth: true, csrf: true });

  router.del('/api/admin/contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTaskContract(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
