/**
 * @weaveintel/geneweave — Admin Skill routes
 *
 * Modular CRUD endpoints for skills.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { SkillRow } from '../../db-types.js';
import { scanSkillForThreats } from '../../skill-capabilities.js';
import type { RouterLike, AdminHelpers } from './types.js';

// Phase-1 composition edges (m148 columns). The skills table stores these as JSON arrays / ints; the
// row→skill mapper reads them via the app's composition layer. Extract them from an admin request body.
function compositionFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['provides', 'requires', 'precondition', 'composes_with', 'conflicts_with', 'input_modalities']) {
    if (body[k] !== undefined) out[k] = JSON.stringify(body[k] ?? []);
  }
  if (body['trust'] !== undefined) out['trust'] = Number(body['trust']);
  if (body['trust_tier'] !== undefined) out['trust_tier'] = Number(body['trust_tier']);
  return out;
}

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

    // Phase 3 security gate: a skill's text goes straight into the model's system prompt, so scan it
    // for hidden prompt-injection before saving. Hidden characters are always blocked; an instructional
    // phrase (which a genuine security/red-team skill may quote) can be saved with explicit acknowledgement.
    {
      const threat = scanSkillForThreats({ name: body['name'] as string, description: validatedDescription, instructions: body['instructions'] as string });
      if (!threat.safe && (threat.hardBlock || body['acknowledgeInjectionRisk'] !== true)) {
        json(res, 400, {
          error: 'Skill rejected by the security scan (possible prompt-injection)',
          findings: threat.findings,
          hint: threat.hardBlock ? 'Hidden/invisible characters are not allowed.' : 'If this wording is intentional (e.g. a security-training skill), resend with acknowledgeInjectionRisk: true.',
        });
        return;
      }
    }

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
    // Persist any composition edges supplied on create (via the generic updateSkill, which writes the m148 columns).
    const comp = compositionFields(body);
    if (Object.keys(comp).length) await db.updateSkill(id, comp as never);
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

    // Phase 3 security gate on edits — but only when the model-facing text actually changes (a plain
    // enabled/priority toggle shouldn't re-scan). Scan the NEW text that will reach the system prompt.
    if (fields['name'] !== undefined || fields['description'] !== undefined || fields['instructions'] !== undefined) {
      const threat = scanSkillForThreats({
        name: (fields['name'] as string) ?? existing.name,
        description: (fields['description'] as string) ?? existing.description,
        instructions: (fields['instructions'] as string) ?? existing.instructions,
      });
      if (!threat.safe && (threat.hardBlock || body['acknowledgeInjectionRisk'] !== true)) {
        json(res, 400, {
          error: 'Skill rejected by the security scan (possible prompt-injection)',
          findings: threat.findings,
          hint: threat.hardBlock ? 'Hidden/invisible characters are not allowed.' : 'If this wording is intentional, resend with acknowledgeInjectionRisk: true.',
        });
        return;
      }
    }

    Object.assign(fields, compositionFields(body)); // Phase-1 composition edges
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
