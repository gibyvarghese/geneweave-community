/**
 * @weaveintel/geneweave — Admin Skill routes
 *
 * Modular CRUD endpoints for skills.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { SkillRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerSkillRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody, requireDetailedDescription } = helpers;

  router.get('/api/admin/skills', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const skills = await db.listSkills();
    json(res, 200, { skills });
  }, { auth: true });

  router.get('/api/admin/skills/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const skill = await db.getSkill(params['id']!);
    if (!skill) { json(res, 404, { error: 'Skill not found' }); return; }
    json(res, 200, { skill });
  }, { auth: true });

  router.post('/api/admin/skills', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['instructions']) {
      json(res, 400, { error: 'name and instructions required' });
      return;
    }
    const validatedDescription = requireDetailedDescription(body['description'], 'skill', res);
    if (!validatedDescription) return;

    const id = 'skill-' + newUUIDv7().slice(-8);
    await db.createSkill({
      id,
      name: body['name'] as string,
      description: validatedDescription,
      category: (body['category'] as string) ?? 'general',
      trigger_patterns: JSON.stringify(Array.isArray(body['trigger_patterns']) ? body['trigger_patterns'] : []),
      instructions: body['instructions'] as string,
      tool_names: body['tool_names'] ? JSON.stringify(body['tool_names']) : null,
      examples: body['examples'] ? JSON.stringify(body['examples']) : null,
      tags: body['tags'] ? JSON.stringify(body['tags']) : null,
      priority: Number(body['priority'] ?? 0),
      version: (body['version'] as string) ?? '1.0',
      enabled: body['enabled'] !== false ? 1 : 0,
      tool_policy_key: (body['tool_policy_key'] as string) ?? null,
      domain_sections: body['domain_sections'] ? JSON.stringify(body['domain_sections']) : null,
      execution_contract: body['execution_contract'] ? JSON.stringify(body['execution_contract']) : null,
    });
    const skill = await db.getSkill(id);
    json(res, 201, { skill });
  }, { auth: true, csrf: true });

  router.put('/api/admin/skills/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSkill(params['id']!);
    if (!existing) { json(res, 404, { error: 'Skill not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'skill', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['trigger_patterns'] !== undefined) fields['trigger_patterns'] = JSON.stringify(Array.isArray(body['trigger_patterns']) ? body['trigger_patterns'] : []);
    if (body['instructions'] !== undefined) fields['instructions'] = body['instructions'];
    if (body['tool_names'] !== undefined) fields['tool_names'] = body['tool_names'] ? JSON.stringify(body['tool_names']) : null;
    if (body['examples'] !== undefined) fields['examples'] = body['examples'] ? JSON.stringify(body['examples']) : null;
    if (body['tags'] !== undefined) fields['tags'] = body['tags'] ? JSON.stringify(body['tags']) : null;
    if (body['priority'] !== undefined) fields['priority'] = Number(body['priority']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['domain_sections'] !== undefined) fields['domain_sections'] = body['domain_sections'] ? JSON.stringify(body['domain_sections']) : null;
    if (body['execution_contract'] !== undefined) fields['execution_contract'] = body['execution_contract'] ? JSON.stringify(body['execution_contract']) : null;

    await db.updateSkill(params['id']!, fields as Partial<Omit<SkillRow, 'id' | 'created_at' | 'updated_at'>>);
    const skill = await db.getSkill(params['id']!);
    json(res, 200, { skill });
  }, { auth: true, csrf: true });

  router.del('/api/admin/skills/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSkill(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
