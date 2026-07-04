/**
 * @weaveintel/geneweave — Admin Tool Catalog routes
 *
 * Modular CRUD endpoints for the operator-managed tool catalog.
 */

import { newUUIDv7 } from '@weaveintel/core';
import { normalizeCallableDescription } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { ToolCatalogRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerToolRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody, requireDetailedDescription } = helpers;

  router.get('/api/admin/tool-catalog', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tools = await db.listToolConfigs();
    json(res, 200, { tools });
  }, { auth: true });

  router.get('/api/admin/tool-catalog/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const t = await db.getToolConfig(params['id']!);
    if (!t) { json(res, 404, { error: 'Tool config not found' }); return; }
    json(res, 200, { tool: t });
  }, { auth: true });

  router.post('/api/admin/tool-catalog', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const validatedDescription = requireDetailedDescription(body['description'], 'tool', res);
    if (!validatedDescription) return;
    const id = newUUIDv7();
    await db.createToolConfig({
      id, name: body['name'] as string, description: validatedDescription,
      category: (body['category'] as string) ?? null, risk_level: (body['risk_level'] as string) ?? 'read-only',
      requires_approval: body['requires_approval'] ? 1 : 0,
      max_execution_ms: (body['max_execution_ms'] as number) ?? null,
      rate_limit_per_min: (body['rate_limit_per_min'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
      tool_key: (body['tool_key'] as string) ?? null,
      version: (body['version'] as string) ?? '1.0',
      side_effects: body['side_effects'] ? 1 : 0,
      tags: body['tags'] ? JSON.stringify(body['tags']) : null,
      source: (body['source'] as string) ?? 'custom',
      credential_id: (body['credential_id'] as string) ?? null,
    });
    const tool = await db.getToolConfig(id);
    json(res, 201, { tool });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tool-catalog/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'tool', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['risk_level'] !== undefined) fields['risk_level'] = body['risk_level'];
    if (body['requires_approval'] !== undefined) fields['requires_approval'] = body['requires_approval'] ? 1 : 0;
    if (body['max_execution_ms'] !== undefined) fields['max_execution_ms'] = body['max_execution_ms'];
    if (body['rate_limit_per_min'] !== undefined) fields['rate_limit_per_min'] = body['rate_limit_per_min'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['side_effects'] !== undefined) fields['side_effects'] = body['side_effects'] ? 1 : 0;
    if (body['tags'] !== undefined) fields['tags'] = Array.isArray(body['tags']) ? JSON.stringify(body['tags']) : body['tags'];
    if (body['credential_id'] !== undefined) fields['credential_id'] = body['credential_id'];
    await db.updateToolConfig(params['id']!, fields as Partial<Omit<ToolCatalogRow, 'id' | 'created_at' | 'updated_at'>>);
    const tool = await db.getToolConfig(params['id']!);
    json(res, 200, { tool });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tool-catalog/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
