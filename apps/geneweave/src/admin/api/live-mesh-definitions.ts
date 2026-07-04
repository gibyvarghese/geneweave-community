/**
 * Phase M21 — Live Mesh Definitions admin CRUD routes.
 *
 * Three framework-level tables back the live-agents runtime:
 *   - live_mesh_definitions
 *   - live_agent_definitions
 *   - live_mesh_delegation_edges
 *
 * `bootKaggleMesh` (and any future generic mesh boot) reads a snapshot from
 * these tables keyed by `mesh_key`. Operators edit them here. Defaults are
 * seeded on first boot via `seedLiveMeshDefinitions`.
 */
import { newUUIDv7 } from '../../lib/uuid.js';
import type { DatabaseAdapter } from '../../db.js';
import type {
  LiveMeshDefinitionRow,
  LiveAgentDefinitionRow,
  LiveMeshDelegationEdgeRow,
} from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

const MESH_BASE  = '/api/admin/live-mesh-definitions';
const AGENT_BASE = '/api/admin/live-agent-definitions';
const EDGE_BASE  = '/api/admin/live-mesh-delegation-edges';

function asBool(v: unknown, def = 1): number {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' ? 1 : 0;
}

// ─── Mesh Definitions ──────────────────────────────────────────────────────

export function registerLiveMeshDefinitionRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(MESH_BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listLiveMeshDefinitions();
    json(res, 200, { 'live-mesh-definitions': items });
  }, { auth: true });

  router.get(`${MESH_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveMeshDefinition(params['id']!);
    if (!item) { json(res, 404, { error: 'Live mesh definition not found' }); return; }
    json(res, 200, { 'live-mesh-definition': item });
  }, { auth: true });

  router.post(MESH_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['mesh_key']) { json(res, 400, { error: 'mesh_key required' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const row: Omit<LiveMeshDefinitionRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      mesh_key: String(body['mesh_key']),
      name: String(body['name']),
      charter_prose: String(body['charter_prose'] ?? ''),
      dual_control_required_for: String(body['dual_control_required_for'] ?? '[]'),
      enabled: asBool(body['enabled'], 1),
      description: (body['description'] as string | null) ?? null,
    };
    const created = await db.createLiveMeshDefinition(row);
    json(res, 201, { 'live-mesh-definition': created });
  }, { auth: true, csrf: true });

  router.put(`${MESH_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveMeshDefinition(params['id']!);
    if (!existing) { json(res, 404, { error: 'Live mesh definition not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveMeshDefinitionRow, 'id' | 'created_at'>> = {};
    if (body['mesh_key'] !== undefined) patch.mesh_key = String(body['mesh_key']);
    if (body['name'] !== undefined) patch.name = String(body['name']);
    if (body['charter_prose'] !== undefined) patch.charter_prose = String(body['charter_prose']);
    if (body['dual_control_required_for'] !== undefined) patch.dual_control_required_for = String(body['dual_control_required_for']);
    if (body['enabled'] !== undefined) patch.enabled = asBool(body['enabled']);
    if (body['description'] !== undefined) patch.description = (body['description'] as string | null) ?? null;
    await db.updateLiveMeshDefinition(params['id']!, patch);
    const item = await db.getLiveMeshDefinition(params['id']!);
    json(res, 200, { 'live-mesh-definition': item });
  }, { auth: true, csrf: true });

  router.del(`${MESH_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveMeshDefinition(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── Agent Definitions ─────────────────────────────────────────────────────

export function registerLiveAgentDefinitionRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(AGENT_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const meshDefId = url.searchParams.get('mesh_def_id') ?? undefined;
    const items = await db.listLiveAgentDefinitions(meshDefId ? { meshDefId } : undefined);
    json(res, 200, { 'live-agent-definitions': items });
  }, { auth: true });

  router.get(`${AGENT_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveAgentDefinition(params['id']!);
    if (!item) { json(res, 404, { error: 'Live agent definition not found' }); return; }
    json(res, 200, { 'live-agent-definition': item });
  }, { auth: true });

  router.post(AGENT_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    for (const k of ['mesh_def_id', 'role_key', 'name', 'role_label']) {
      if (!body[k]) { json(res, 400, { error: `${k} required` }); return; }
    }
    const row: Omit<LiveAgentDefinitionRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      mesh_def_id: String(body['mesh_def_id']),
      role_key: String(body['role_key']),
      name: String(body['name']),
      role_label: String(body['role_label']),
      persona: String(body['persona'] ?? ''),
      objectives: String(body['objectives'] ?? ''),
      success_indicators: String(body['success_indicators'] ?? ''),
      ordering: Number(body['ordering'] ?? 0),
      enabled: asBool(body['enabled'], 1),
      // Phase 3.5 + Phase 5 routing/provisioner defaults (all optional).
      model_capability_json:        body['model_capability_json']        != null ? String(body['model_capability_json'])        : null,
      model_routing_policy_key:     body['model_routing_policy_key']     != null ? String(body['model_routing_policy_key'])     : null,
      model_pinned_id:              body['model_pinned_id']              != null ? String(body['model_pinned_id'])              : null,
      default_handler_kind:         body['default_handler_kind']         != null ? String(body['default_handler_kind'])         : null,
      default_handler_config_json:  body['default_handler_config_json']  != null ? String(body['default_handler_config_json'])  : null,
      default_tool_catalog_keys:    body['default_tool_catalog_keys']    != null ? String(body['default_tool_catalog_keys'])    : null,
      default_attention_policy_key: body['default_attention_policy_key'] != null ? String(body['default_attention_policy_key']) : null,
    };
    const created = await db.createLiveAgentDefinition(row);
    json(res, 201, { 'live-agent-definition': created });
  }, { auth: true, csrf: true });

  router.put(`${AGENT_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveAgentDefinition(params['id']!);
    if (!existing) { json(res, 404, { error: 'Live agent definition not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveAgentDefinitionRow, 'id' | 'mesh_def_id' | 'created_at'>> = {};
    if (body['role_key'] !== undefined) patch.role_key = String(body['role_key']);
    if (body['name'] !== undefined) patch.name = String(body['name']);
    if (body['role_label'] !== undefined) patch.role_label = String(body['role_label']);
    if (body['persona'] !== undefined) patch.persona = String(body['persona']);
    if (body['objectives'] !== undefined) patch.objectives = String(body['objectives']);
    if (body['success_indicators'] !== undefined) patch.success_indicators = String(body['success_indicators']);
    if (body['ordering'] !== undefined) patch.ordering = Number(body['ordering']);
    if (body['enabled'] !== undefined) patch.enabled = asBool(body['enabled']);
    // Phase 3.5 + Phase 5 default fields
    for (const k of [
      'model_capability_json','model_routing_policy_key','model_pinned_id',
      'default_handler_kind','default_handler_config_json',
      'default_tool_catalog_keys','default_attention_policy_key',
    ] as const) {
      if (body[k] !== undefined) {
        (patch as Record<string, unknown>)[k] = body[k] === null || body[k] === '' ? null : String(body[k]);
      }
    }
    await db.updateLiveAgentDefinition(params['id']!, patch);
    const item = await db.getLiveAgentDefinition(params['id']!);
    json(res, 200, { 'live-agent-definition': item });
  }, { auth: true, csrf: true });

  router.del(`${AGENT_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveAgentDefinition(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── Delegation Edges ──────────────────────────────────────────────────────

export function registerLiveMeshDelegationEdgeRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(EDGE_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://x');
    const meshDefId = url.searchParams.get('mesh_def_id') ?? undefined;
    const items = await db.listLiveMeshDelegationEdges(meshDefId ? { meshDefId } : undefined);
    json(res, 200, { 'live-mesh-delegation-edges': items });
  }, { auth: true });

  router.get(`${EDGE_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveMeshDelegationEdge(params['id']!);
    if (!item) { json(res, 404, { error: 'Delegation edge not found' }); return; }
    json(res, 200, { 'live-mesh-delegation-edge': item });
  }, { auth: true });

  router.post(EDGE_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    for (const k of ['mesh_def_id', 'from_role_key', 'to_role_key', 'relationship']) {
      if (!body[k]) { json(res, 400, { error: `${k} required` }); return; }
    }
    const row: Omit<LiveMeshDelegationEdgeRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      mesh_def_id: String(body['mesh_def_id']),
      from_role_key: String(body['from_role_key']),
      to_role_key: String(body['to_role_key']),
      relationship: String(body['relationship']),
      prose: String(body['prose'] ?? ''),
      ordering: Number(body['ordering'] ?? 0),
      enabled: asBool(body['enabled'], 1),
    };
    const created = await db.createLiveMeshDelegationEdge(row);
    json(res, 201, { 'live-mesh-delegation-edge': created });
  }, { auth: true, csrf: true });

  router.put(`${EDGE_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveMeshDelegationEdge(params['id']!);
    if (!existing) { json(res, 404, { error: 'Delegation edge not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveMeshDelegationEdgeRow, 'id' | 'mesh_def_id' | 'created_at'>> = {};
    if (body['from_role_key'] !== undefined) patch.from_role_key = String(body['from_role_key']);
    if (body['to_role_key'] !== undefined) patch.to_role_key = String(body['to_role_key']);
    if (body['relationship'] !== undefined) patch.relationship = String(body['relationship']);
    if (body['prose'] !== undefined) patch.prose = String(body['prose']);
    if (body['ordering'] !== undefined) patch.ordering = Number(body['ordering']);
    if (body['enabled'] !== undefined) patch.enabled = asBool(body['enabled']);
    await db.updateLiveMeshDelegationEdge(params['id']!, patch);
    const item = await db.getLiveMeshDelegationEdge(params['id']!);
    json(res, 200, { 'live-mesh-delegation-edge': item });
  }, { auth: true, csrf: true });

  router.del(`${EDGE_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveMeshDelegationEdge(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
