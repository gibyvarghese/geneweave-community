import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { newUUIDv7 } from '../../lib/uuid.js';

/**
 * Provider Tool Adapters admin routes (anyWeave Phase 4 / M15).
 *
 * Routes:
 *   GET  /api/admin/provider-tool-adapters
 *   GET  /api/admin/provider-tool-adapters/:id   (id can be UUID or provider key)
 *   POST /api/admin/provider-tool-adapters
 *   PUT  /api/admin/provider-tool-adapters/:id
 *   DEL  /api/admin/provider-tool-adapters/:id
 */
export function registerProviderToolAdapterRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/provider-tool-adapters', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const adapters = await db.listProviderToolAdapters();
    json(res, 200, { adapters });
  }, { auth: true });

  router.get('/api/admin/provider-tool-adapters/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const idOrKey = params['id']!;
    const row = (await db.getProviderToolAdapterById(idOrKey)) ?? (await db.getProviderToolAdapter(idOrKey));
    if (!row) { json(res, 404, { error: 'Provider tool adapter not found' }); return; }
    json(res, 200, { adapter: row });
  }, { auth: true });

  router.post('/api/admin/provider-tool-adapters', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['provider'] || !body['display_name'] || !body['adapter_module'] || !body['tool_format']) {
      json(res, 400, { error: 'provider, display_name, adapter_module, tool_format required' }); return;
    }
    const id = newUUIDv7();
    await db.createProviderToolAdapter({
      id,
      provider: String(body['provider']),
      display_name: String(body['display_name']),
      adapter_module: String(body['adapter_module']),
      tool_format: String(body['tool_format']),
      tool_call_response_format: String(body['tool_call_response_format'] ?? 'function_call'),
      tool_result_format: String(body['tool_result_format'] ?? 'tool_message'),
      system_prompt_location: String(body['system_prompt_location'] ?? 'system_message'),
      name_validation_regex: String(body['name_validation_regex'] ?? '^[a-zA-Z0-9_-]{1,64}$'),
      max_tool_count: Number(body['max_tool_count'] ?? 128),
      enabled: body['enabled'] === false ? 0 : 1,
    });
    const adapter = await db.getProviderToolAdapterById(id);
    json(res, 201, { adapter });
  }, { auth: true, csrf: true });

  router.put('/api/admin/provider-tool-adapters/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = (await db.getProviderToolAdapterById(id)) ?? (await db.getProviderToolAdapter(id));
    if (!existing) { json(res, 404, { error: 'Provider tool adapter not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    for (const k of ['provider', 'display_name', 'adapter_module', 'tool_format',
      'tool_call_response_format', 'tool_result_format', 'system_prompt_location',
      'name_validation_regex'] as const) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (body['max_tool_count'] !== undefined) fields['max_tool_count'] = Number(body['max_tool_count']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateProviderToolAdapter(existing.id, fields as never);
    const adapter = await db.getProviderToolAdapterById(existing.id);
    json(res, 200, { adapter });
  }, { auth: true, csrf: true });

  router.del('/api/admin/provider-tool-adapters/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = (await db.getProviderToolAdapterById(id)) ?? (await db.getProviderToolAdapter(id));
    if (!existing) { json(res, 404, { error: 'Provider tool adapter not found' }); return; }
    await db.deleteProviderToolAdapter(existing.id);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
