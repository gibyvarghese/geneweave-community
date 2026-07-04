/**
 * @weaveintel/geneweave — Admin Worker Agent routes
 *
 * Modular CRUD endpoints for worker agents.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { WorkerAgentRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerWorkerAgentRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody, requireDetailedDescription } = helpers;

  router.get('/api/admin/worker-agents', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const workerAgents = await db.listWorkerAgents();
    json(res, 200, { workerAgents });
  }, { auth: true });

  router.get('/api/admin/worker-agents/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const workerAgent = await db.getWorkerAgent(params['id']!);
    if (!workerAgent) { json(res, 404, { error: 'Worker agent not found' }); return; }
    json(res, 200, { workerAgent });
  }, { auth: true });

  router.post('/api/admin/worker-agents', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['description']) {
      json(res, 400, { error: 'name and description required' });
      return;
    }
    const validatedDescription = requireDetailedDescription(body['description'], 'agent', res);
    if (!validatedDescription) return;

    const id = 'wa-' + newUUIDv7().slice(-8);
    await db.createWorkerAgent({
      id,
      name: body['name'] as string,
      display_name: (body['display_name'] as string) ?? null,
      job_profile: (body['job_profile'] as string) ?? null,
      description: validatedDescription,
      system_prompt: (body['system_prompt'] as string) ?? null,
      tool_names: body['tool_names'] ? JSON.stringify(body['tool_names']) : '[]',
      persona: (body['persona'] as string) ?? 'agent_worker',
      trigger_patterns: body['trigger_patterns'] ? JSON.stringify(body['trigger_patterns']) : '[]',
      task_contract_id: (body['task_contract_id'] as string) ?? null,
      max_retries: body['max_retries'] !== undefined ? Number(body['max_retries']) : 0,
      priority: body['priority'] !== undefined ? Number(body['priority']) : 0,
      category: (body['category'] as string) ?? 'general',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const workerAgent = await db.getWorkerAgent(id);
    json(res, 201, { workerAgent });
  }, { auth: true, csrf: true });

  router.put('/api/admin/worker-agents/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWorkerAgent(params['id']!);
    if (!existing) { json(res, 404, { error: 'Worker agent not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['display_name'] !== undefined) fields['display_name'] = body['display_name'];
    if (body['job_profile'] !== undefined) fields['job_profile'] = body['job_profile'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'agent', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['system_prompt'] !== undefined) fields['system_prompt'] = body['system_prompt'];
    if (body['tool_names'] !== undefined) fields['tool_names'] = body['tool_names'] ? JSON.stringify(body['tool_names']) : '[]';
    if (body['persona'] !== undefined) fields['persona'] = body['persona'];
    if (body['trigger_patterns'] !== undefined) fields['trigger_patterns'] = body['trigger_patterns'] ? JSON.stringify(body['trigger_patterns']) : '[]';
    if (body['task_contract_id'] !== undefined) fields['task_contract_id'] = body['task_contract_id'];
    if (body['max_retries'] !== undefined) fields['max_retries'] = Number(body['max_retries']);
    if (body['priority'] !== undefined) fields['priority'] = Number(body['priority']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updateWorkerAgent(params['id']!, fields as Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>);
    const workerAgent = await db.getWorkerAgent(params['id']!);
    json(res, 200, { workerAgent });
  }, { auth: true, csrf: true });

  router.del('/api/admin/worker-agents/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkerAgent(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
