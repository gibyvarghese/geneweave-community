/**
 * Phase M22 — DB-Driven Live-Agents Runtime: provisioned meshes & agents.
 *
 * Admin CRUD for the four runtime tables that describe what is *actually live*
 * for a tenant (vs the blueprint definitions in M21):
 *   - live_meshes                    (provisioned mesh per tenant per blueprint)
 *   - live_agents                    (provisioned agent inside a runtime mesh)
 *   - live_agent_handler_bindings    (which handler kind dispatches each agent)
 *   - live_agent_tool_bindings       (M2M agent → tool_catalog or MCP url)
 *
 * Pattern mirrors `live-mesh-definitions.ts`:
 *   - All routes auth-guarded (401 when no auth).
 *   - Writes require CSRF.
 *   - Inserts allocate a fresh UUIDv7.
 *   - PUT supports partial patch via field-by-field assignment.
 */
import { newUUIDv7 } from '../../lib/uuid.js';
import type { DatabaseAdapter } from '../../db.js';
import type {
  LiveMeshRow,
  LiveAgentRow,
  LiveAgentHandlerBindingRow,
  LiveAgentToolBindingRow,
} from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

const MESH_BASE         = '/api/admin/live-meshes';
const AGENT_BASE        = '/api/admin/live-agents';
const HANDLER_BIND_BASE = '/api/admin/live-agent-handler-bindings';
const TOOL_BIND_BASE    = '/api/admin/live-agent-tool-bindings';

function asBool(v: unknown, def = 1): number {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' ? 1 : 0;
}
function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

// ─── live_meshes ───────────────────────────────────────────────────────────

export function registerLiveMeshRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(MESH_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const tenantId  = url.searchParams.get('tenant_id')   ?? undefined;
    const meshDefId = url.searchParams.get('mesh_def_id') ?? undefined;
    const status    = url.searchParams.get('status')      ?? undefined;
    const items = await db.listLiveMeshes({
      ...(tenantId  ? { tenantId }  : {}),
      ...(meshDefId ? { meshDefId } : {}),
      ...(status    ? { status }    : {}),
    });
    json(res, 200, { 'live-meshes': items });
  }, { auth: true });

  router.get(`${MESH_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveMesh(params['id']!);
    if (!item) { json(res, 404, { error: 'Live mesh not found' }); return; }
    json(res, 200, { 'live-mesh': item });
  }, { auth: true });

  router.post(MESH_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['mesh_def_id']) { json(res, 400, { error: 'mesh_def_id required' }); return; }
    if (!body['name'])        { json(res, 400, { error: 'name required' }); return; }
    const row: Omit<LiveMeshRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      tenant_id: strOrNull(body['tenant_id']),
      mesh_def_id: String(body['mesh_def_id']),
      name: String(body['name']),
      status: String(body['status'] ?? 'ACTIVE'),
      domain: strOrNull(body['domain']),
      dual_control_required_for: String(body['dual_control_required_for'] ?? '[]'),
      owner_human_id: strOrNull(body['owner_human_id']),
      mcp_server_ref: strOrNull(body['mcp_server_ref']),
      account_id: strOrNull(body['account_id']),
      context_json: strOrNull(body['context_json']),
    };
    const created = await db.createLiveMesh(row);
    json(res, 201, { 'live-mesh': created });
  }, { auth: true, csrf: true });

  router.put(`${MESH_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveMesh(params['id']!);
    if (!existing) { json(res, 404, { error: 'Live mesh not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveMeshRow, 'id' | 'created_at'>> = {};
    if (body['tenant_id']                 !== undefined) patch.tenant_id                 = strOrNull(body['tenant_id']);
    if (body['mesh_def_id']               !== undefined) patch.mesh_def_id               = String(body['mesh_def_id']);
    if (body['name']                      !== undefined) patch.name                      = String(body['name']);
    if (body['status']                    !== undefined) patch.status                    = String(body['status']);
    if (body['domain']                    !== undefined) patch.domain                    = strOrNull(body['domain']);
    if (body['dual_control_required_for'] !== undefined) patch.dual_control_required_for = String(body['dual_control_required_for']);
    if (body['owner_human_id']            !== undefined) patch.owner_human_id            = strOrNull(body['owner_human_id']);
    if (body['mcp_server_ref']            !== undefined) patch.mcp_server_ref            = strOrNull(body['mcp_server_ref']);
    if (body['account_id']                !== undefined) patch.account_id                = strOrNull(body['account_id']);
    if (body['context_json']              !== undefined) patch.context_json              = strOrNull(body['context_json']);
    await db.updateLiveMesh(params['id']!, patch);
    const item = await db.getLiveMesh(params['id']!);
    json(res, 200, { 'live-mesh': item });
  }, { auth: true, csrf: true });

  router.del(`${MESH_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveMesh(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── live_agents ───────────────────────────────────────────────────────────

export function registerLiveAgentRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(AGENT_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const meshId = url.searchParams.get('mesh_id') ?? undefined;
    const status = url.searchParams.get('status')  ?? undefined;
    const items = await db.listLiveAgents({
      ...(meshId ? { meshId } : {}),
      ...(status ? { status } : {}),
    });
    json(res, 200, { 'live-agents': items });
  }, { auth: true });

  router.get(`${AGENT_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveAgent(params['id']!);
    if (!item) { json(res, 404, { error: 'Live agent not found' }); return; }
    json(res, 200, { 'live-agent': item });
  }, { auth: true });

  router.post(AGENT_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    for (const k of ['mesh_id', 'role_key', 'name', 'role_label']) {
      if (!body[k]) { json(res, 400, { error: `${k} required` }); return; }
    }
    const row: Omit<LiveAgentRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      mesh_id: String(body['mesh_id']),
      agent_def_id: strOrNull(body['agent_def_id']),
      role_key: String(body['role_key']),
      name: String(body['name']),
      role_label: String(body['role_label']),
      persona: String(body['persona'] ?? ''),
      objectives: String(body['objectives'] ?? '[]'),
      success_indicators: String(body['success_indicators'] ?? '[]'),
      attention_policy_key: strOrNull(body['attention_policy_key']),
      contract_version_id: strOrNull(body['contract_version_id']),
      status: String(body['status'] ?? 'ACTIVE'),
      ordering: Number(body['ordering'] ?? 0),
      archived_at: strOrNull(body['archived_at']),
      model_pinned_id: strOrNull(body['model_pinned_id']),
      model_capability_json: strOrNull(body['model_capability_json']),
      model_routing_policy_key: strOrNull(body['model_routing_policy_key']),
      prepare_config_json: strOrNull(body['prepare_config_json']),
    };
    const created = await db.createLiveAgent(row);
    json(res, 201, { 'live-agent': created });
  }, { auth: true, csrf: true });

  router.put(`${AGENT_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveAgent(params['id']!);
    if (!existing) { json(res, 404, { error: 'Live agent not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveAgentRow, 'id' | 'mesh_id' | 'created_at'>> = {};
    if (body['agent_def_id']         !== undefined) patch.agent_def_id         = strOrNull(body['agent_def_id']);
    if (body['role_key']             !== undefined) patch.role_key             = String(body['role_key']);
    if (body['name']                 !== undefined) patch.name                 = String(body['name']);
    if (body['role_label']           !== undefined) patch.role_label           = String(body['role_label']);
    if (body['persona']              !== undefined) patch.persona              = String(body['persona']);
    if (body['objectives']           !== undefined) patch.objectives           = String(body['objectives']);
    if (body['success_indicators']   !== undefined) patch.success_indicators   = String(body['success_indicators']);
    if (body['attention_policy_key'] !== undefined) patch.attention_policy_key = strOrNull(body['attention_policy_key']);
    if (body['contract_version_id']  !== undefined) patch.contract_version_id  = strOrNull(body['contract_version_id']);
    if (body['status']               !== undefined) patch.status               = String(body['status']);
    if (body['ordering']             !== undefined) patch.ordering             = Number(body['ordering']);
    if (body['archived_at']          !== undefined) patch.archived_at          = strOrNull(body['archived_at']);
    if (body['model_pinned_id']           !== undefined) patch.model_pinned_id           = strOrNull(body['model_pinned_id']);
    if (body['model_capability_json']     !== undefined) patch.model_capability_json     = strOrNull(body['model_capability_json']);
    if (body['model_routing_policy_key']  !== undefined) patch.model_routing_policy_key  = strOrNull(body['model_routing_policy_key']);
    if (body['prepare_config_json']       !== undefined) patch.prepare_config_json       = strOrNull(body['prepare_config_json']);
    await db.updateLiveAgent(params['id']!, patch);
    const item = await db.getLiveAgent(params['id']!);
    json(res, 200, { 'live-agent': item });
  }, { auth: true, csrf: true });

  router.del(`${AGENT_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveAgent(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── live_agent_handler_bindings ───────────────────────────────────────────

export function registerLiveAgentHandlerBindingRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(HANDLER_BIND_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const agentId = url.searchParams.get('agent_id') ?? undefined;
    const items = await db.listLiveAgentHandlerBindings(agentId ? { agentId } : undefined);
    json(res, 200, { 'live-agent-handler-bindings': items });
  }, { auth: true });

  router.get(`${HANDLER_BIND_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveAgentHandlerBinding(params['id']!);
    if (!item) { json(res, 404, { error: 'Handler binding not found' }); return; }
    json(res, 200, { 'live-agent-handler-binding': item });
  }, { auth: true });

  router.post(HANDLER_BIND_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['agent_id'])     { json(res, 400, { error: 'agent_id required' }); return; }
    if (!body['handler_kind']) { json(res, 400, { error: 'handler_kind required' }); return; }
    // Soft FK check: ensure handler_kind is registered.
    const known = await db.getLiveHandlerKindByKind(String(body['handler_kind']));
    if (!known) { json(res, 400, { error: `unknown handler_kind: ${String(body['handler_kind'])}` }); return; }
    const row: Omit<LiveAgentHandlerBindingRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      agent_id: String(body['agent_id']),
      handler_kind: String(body['handler_kind']),
      config_json: String(body['config_json'] ?? '{}'),
      enabled: asBool(body['enabled'], 1),
    };
    const created = await db.createLiveAgentHandlerBinding(row);
    json(res, 201, { 'live-agent-handler-binding': created });
  }, { auth: true, csrf: true });

  router.put(`${HANDLER_BIND_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveAgentHandlerBinding(params['id']!);
    if (!existing) { json(res, 404, { error: 'Handler binding not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveAgentHandlerBindingRow, 'id' | 'agent_id' | 'created_at'>> = {};
    if (body['handler_kind'] !== undefined) patch.handler_kind = String(body['handler_kind']);
    if (body['config_json']  !== undefined) patch.config_json  = String(body['config_json']);
    if (body['enabled']      !== undefined) patch.enabled      = asBool(body['enabled']);
    await db.updateLiveAgentHandlerBinding(params['id']!, patch);
    const item = await db.getLiveAgentHandlerBinding(params['id']!);
    json(res, 200, { 'live-agent-handler-binding': item });
  }, { auth: true, csrf: true });

  router.del(`${HANDLER_BIND_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveAgentHandlerBinding(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── live_agent_tool_bindings ──────────────────────────────────────────────

export function registerLiveAgentToolBindingRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(TOOL_BIND_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const agentId = url.searchParams.get('agent_id') ?? undefined;
    const items = await db.listLiveAgentToolBindings(agentId ? { agentId } : undefined);
    json(res, 200, { 'live-agent-tool-bindings': items });
  }, { auth: true });

  router.get(`${TOOL_BIND_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveAgentToolBinding(params['id']!);
    if (!item) { json(res, 404, { error: 'Tool binding not found' }); return; }
    json(res, 200, { 'live-agent-tool-binding': item });
  }, { auth: true });

  router.post(TOOL_BIND_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['agent_id']) { json(res, 400, { error: 'agent_id required' }); return; }
    const toolCatalogId = strOrNull(body['tool_catalog_id']);
    const mcpServerUrl  = strOrNull(body['mcp_server_url']);
    if (!toolCatalogId && !mcpServerUrl) {
      json(res, 400, { error: 'either tool_catalog_id or mcp_server_url is required' });
      return;
    }
    const row: Omit<LiveAgentToolBindingRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      agent_id: String(body['agent_id']),
      tool_catalog_id: toolCatalogId,
      mcp_server_url: mcpServerUrl,
      capability_keys: String(body['capability_keys'] ?? '[]'),
      enabled: asBool(body['enabled'], 1),
    };
    const created = await db.createLiveAgentToolBinding(row);
    json(res, 201, { 'live-agent-tool-binding': created });
  }, { auth: true, csrf: true });

  router.put(`${TOOL_BIND_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveAgentToolBinding(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool binding not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveAgentToolBindingRow, 'id' | 'agent_id' | 'created_at'>> = {};
    if (body['tool_catalog_id'] !== undefined) patch.tool_catalog_id = strOrNull(body['tool_catalog_id']);
    if (body['mcp_server_url']  !== undefined) patch.mcp_server_url  = strOrNull(body['mcp_server_url']);
    if (body['capability_keys'] !== undefined) patch.capability_keys = String(body['capability_keys']);
    if (body['enabled']         !== undefined) patch.enabled         = asBool(body['enabled']);
    await db.updateLiveAgentToolBinding(params['id']!, patch);
    const item = await db.getLiveAgentToolBinding(params['id']!);
    json(res, 200, { 'live-agent-tool-binding': item });
  }, { auth: true, csrf: true });

  router.del(`${TOOL_BIND_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveAgentToolBinding(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
