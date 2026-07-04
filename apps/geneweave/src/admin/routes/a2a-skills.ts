// SPDX-License-Identifier: MIT
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike } from '../api/types.js';
import { normalizeJsonField } from '../api/admin-route-helpers.js';
import type { ServerResponse, IncomingMessage } from 'node:http';

/**
 * Admin CRUD for DB-backed A2A skills.
 *
 * Endpoints (all require tenant_admin or platform_admin):
 *   GET    /api/admin/a2a-skills           — list all (ordered by sort_order ASC)
 *   GET    /api/admin/a2a-skills/:id       — get one
 *   POST   /api/admin/a2a-skills           — create
 *   PUT    /api/admin/a2a-skills/:id       — update
 *   DELETE /api/admin/a2a-skills/:id       — delete
 */
export function registerAdminA2ASkillRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
): void {
  router.get('/api/admin/a2a-skills', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const skills = await db.listA2ASkills();
    json(res, 200, { skills });
  });

  router.get('/api/admin/a2a-skills/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const skill = await db.getA2ASkill(params['id']!);
    if (!skill) { json(res, 404, { error: 'A2A skill not found' }); return; }
    json(res, 200, { skill });
  });

  router.post('/api/admin/a2a-skills', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const id = (body['id'] as string | undefined)?.trim() || newUUIDv7();
    const name = (body['name'] as string | undefined)?.trim();
    const description = (body['description'] as string | undefined)?.trim() ?? '';
    const mode = (body['mode'] as string | undefined)?.trim() || 'agent';

    if (!name) { json(res, 400, { error: 'name is required' }); return; }
    if (!['agent', 'supervisor', 'ensemble'].includes(mode)) {
      json(res, 400, { error: "mode must be 'agent', 'supervisor', or 'ensemble'" }); return;
    }

    await db.createA2ASkill({
      id,
      name,
      description,
      tags: normalizeJsonField(body['tags']),
      examples: normalizeJsonField(body['examples']),
      input_modes: normalizeJsonField(body['input_modes']),
      output_modes: normalizeJsonField(body['output_modes']),
      security_scopes: normalizeJsonField(body['security_scopes']) ?? JSON.stringify(['a2a:chat']),
      mode,
      required_permission: (body['required_permission'] as string | undefined)?.trim() || null,
      sort_order: typeof body['sort_order'] === 'number' ? body['sort_order'] : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
      agent_tools: normalizeJsonField(body['agent_tools']),
      agent_workers: normalizeJsonField(body['agent_workers']),
    });
    const skill = await db.getA2ASkill(id);
    json(res, 201, { skill });
  }, { auth: true, csrf: true });

  router.put('/api/admin/a2a-skills/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getA2ASkill(params['id']!);
    if (!existing) { json(res, 404, { error: 'A2A skill not found' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = String(body['name']).trim();
    if (body['description'] !== undefined) fields['description'] = String(body['description']).trim();
    if (body['mode'] !== undefined) {
      const m = String(body['mode']).trim();
      if (!['agent', 'supervisor', 'ensemble'].includes(m)) {
        json(res, 400, { error: "mode must be 'agent', 'supervisor', or 'ensemble'" }); return;
      }
      fields['mode'] = m;
    }
    if (body['tags'] !== undefined) fields['tags'] = normalizeJsonField(body['tags']);
    if (body['examples'] !== undefined) fields['examples'] = normalizeJsonField(body['examples']);
    if (body['input_modes'] !== undefined) fields['input_modes'] = normalizeJsonField(body['input_modes']);
    if (body['output_modes'] !== undefined) fields['output_modes'] = normalizeJsonField(body['output_modes']);
    if (body['security_scopes'] !== undefined) fields['security_scopes'] = normalizeJsonField(body['security_scopes']) ?? existing.security_scopes;
    if (body['required_permission'] !== undefined) fields['required_permission'] = (body['required_permission'] as string | null)?.trim() || null;
    if (body['sort_order'] !== undefined) fields['sort_order'] = Number(body['sort_order']) || 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['agent_tools'] !== undefined) fields['agent_tools'] = normalizeJsonField(body['agent_tools']);
    if (body['agent_workers'] !== undefined) fields['agent_workers'] = normalizeJsonField(body['agent_workers']);

    await db.updateA2ASkill(params['id']!, fields);
    const skill = await db.getA2ASkill(params['id']!);
    json(res, 200, { skill });
  }, { auth: true, csrf: true });

  router.del('/api/admin/a2a-skills/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteA2ASkill(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
