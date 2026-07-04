/**
 * @weaveintel/geneweave — Admin Supervisor Agent routes (Phase 1B)
 *
 * CRUD for the operator-managed `agents` table. Each row defines a supervisor
 * agent that the chat runtime can resolve per tenant + category + (optional)
 * skill pin. Tool allocations are managed via the nested `tools` collection
 * on each row.
 */

import { newUUIDv7 } from '../../lib/uuid.js';
import type { DatabaseAdapter } from '../../db.js';
import type { SupervisorAgentRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

interface ToolAllocBody {
  tool_name?: unknown;
  allocation?: unknown;
}

function normalizeTools(raw: unknown): Array<{ tool_name: string; allocation?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      if (!t || typeof t !== 'object') return null;
      const obj = t as ToolAllocBody;
      const name = typeof obj.tool_name === 'string' ? obj.tool_name.trim() : '';
      if (!name) return null;
      const alloc = typeof obj.allocation === 'string' && obj.allocation ? obj.allocation : 'default';
      return { tool_name: name, allocation: alloc };
    })
    .filter((x): x is { tool_name: string; allocation: string } => x !== null);
}

export function registerSupervisorAgentRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody, requireDetailedDescription } = helpers;

  router.get('/api/admin/agents', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const tenantParam = url.searchParams.get('tenant_id');
    // Tenant scoping: tenant_admin can only see their tenant's agents
    const isPlatformAdmin = auth.persona === 'platform_admin';
    const tenantId: string | null | undefined = isPlatformAdmin
      ? (tenantParam === '' ? null : tenantParam ?? undefined)
      : (auth.tenantId ?? null);
    const category = url.searchParams.get('category') ?? undefined;
    const enabledOnly = url.searchParams.get('enabledOnly') === '1';
    const rows = await db.listSupervisorAgents({ tenantId, category, enabledOnly });
    // Inline tool allocations into each row so the admin UI list view can show them.
    const agents = await Promise.all(
      rows.map(async (a) => ({ ...a, tools: await db.listAgentTools(a.id) })),
    );
    json(res, 200, { agents });
  }, { auth: true });

  router.get('/api/admin/agents/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const agent = await db.getSupervisorAgent(params['id']!);
    if (!agent) { json(res, 404, { error: 'Agent not found' }); return; }
    const tools = await db.listAgentTools(agent.id);
    // Flatten so the schema-driven admin form can hydrate the `tools` field
    // alongside the agent fields.
    json(res, 200, { agent: { ...agent, tools }, tools });
  }, { auth: true });

  router.post('/api/admin/agents', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    if (!body['name'] || typeof body['name'] !== 'string') {
      json(res, 400, { error: 'name required' });
      return;
    }
    if (!body['description']) {
      json(res, 400, { error: 'description required' });
      return;
    }
    const validatedDescription = requireDetailedDescription(body['description'], 'agent', res);
    if (!validatedDescription) return;

    const id = 'agent-' + newUUIDv7();
    const tools = normalizeTools(body['tools']);
    await db.createSupervisorAgent({
      id,
      tenant_id: typeof body['tenant_id'] === 'string' && body['tenant_id'] ? (body['tenant_id'] as string) : null,
      category: typeof body['category'] === 'string' && body['category'] ? (body['category'] as string) : 'general',
      name: body['name'] as string,
      display_name: typeof body['display_name'] === 'string' ? (body['display_name'] as string) : null,
      description: validatedDescription,
      system_prompt: typeof body['system_prompt'] === 'string' ? (body['system_prompt'] as string) : null,
      include_utility_tools: body['include_utility_tools'] === false ? 0 : 1,
      default_timezone: typeof body['default_timezone'] === 'string' && body['default_timezone'] ? (body['default_timezone'] as string) : null,
      is_default: body['is_default'] === true ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    }, tools);
    const agent = await db.getSupervisorAgent(id);
    const persistedTools = await db.listAgentTools(id);
    json(res, 201, { agent: agent ? { ...agent, tools: persistedTools } : null, tools: persistedTools });
  }, { auth: true, csrf: true });

  router.put('/api/admin/agents/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const existing = await db.getSupervisorAgent(id);
    if (!existing) { json(res, 404, { error: 'Agent not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['tenant_id'] !== undefined) {
      fields['tenant_id'] = typeof body['tenant_id'] === 'string' && body['tenant_id'] ? body['tenant_id'] : null;
    }
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['display_name'] !== undefined) fields['display_name'] = body['display_name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'agent', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['system_prompt'] !== undefined) fields['system_prompt'] = body['system_prompt'];
    if (body['include_utility_tools'] !== undefined) fields['include_utility_tools'] = body['include_utility_tools'] ? 1 : 0;
    if (body['default_timezone'] !== undefined) fields['default_timezone'] = body['default_timezone'];
    if (body['is_default'] !== undefined) fields['is_default'] = body['is_default'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updateSupervisorAgent(id, fields as Partial<Omit<SupervisorAgentRow, 'id' | 'created_at' | 'updated_at'>>);

    if (body['tools'] !== undefined) {
      await db.setAgentTools(id, normalizeTools(body['tools']));
    }

    const agent = await db.getSupervisorAgent(id);
    const tools = await db.listAgentTools(id);
    json(res, 200, { agent: agent ? { ...agent, tools } : null, tools });
  }, { auth: true, csrf: true });

  router.del('/api/admin/agents/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSupervisorAgent(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
