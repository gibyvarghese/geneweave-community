/**
 * Phase M22 — DB-Driven Live-Agents Runtime: framework registries.
 *
 * Two small, mostly-static-but-editable tables that the runtime consults:
 *   - live_handler_kinds      (catalog of registered handler kinds — selectable
 *                              in the UI but implementations live in code plugins;
 *                              admins can disable a kind to take it out of rotation)
 *   - live_attention_policies (DB-defined attention policies — e.g. when should
 *                              this agent take a tick? heuristic / cron / model)
 *
 * Both are seeded with built-ins on first boot (see live-runtime-seed.ts).
 */
import { newUUIDv7 } from '../../lib/uuid.js';
import type { DatabaseAdapter } from '../../db.js';
import type { LiveHandlerKindRow, LiveAttentionPolicyRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';

const HANDLER_KIND_BASE = '/api/admin/live-handler-kinds';
const ATTN_POLICY_BASE  = '/api/admin/live-attention-policies';

function asBool(v: unknown, def = 1): number {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' ? 1 : 0;
}

// ─── live_handler_kinds ────────────────────────────────────────────────────

export function registerLiveHandlerKindRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(HANDLER_KIND_BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listLiveHandlerKinds();
    json(res, 200, { 'live-handler-kinds': items });
  }, { auth: true });

  router.get(`${HANDLER_KIND_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveHandlerKind(params['id']!);
    if (!item) { json(res, 404, { error: 'Handler kind not found' }); return; }
    json(res, 200, { 'live-handler-kind': item });
  }, { auth: true });

  router.post(HANDLER_KIND_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['kind']) { json(res, 400, { error: 'kind required' }); return; }
    const row: Omit<LiveHandlerKindRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      kind: String(body['kind']),
      description: String(body['description'] ?? ''),
      config_schema_json: String(body['config_schema_json'] ?? '{}'),
      source: String(body['source'] ?? 'plugin'),
      enabled: asBool(body['enabled'], 1),
    };
    const created = await db.createLiveHandlerKind(row);
    json(res, 201, { 'live-handler-kind': created });
  }, { auth: true, csrf: true });

  router.put(`${HANDLER_KIND_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveHandlerKind(params['id']!);
    if (!existing) { json(res, 404, { error: 'Handler kind not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveHandlerKindRow, 'id' | 'created_at'>> = {};
    if (body['kind']               !== undefined) patch.kind               = String(body['kind']);
    if (body['description']        !== undefined) patch.description        = String(body['description']);
    if (body['config_schema_json'] !== undefined) patch.config_schema_json = String(body['config_schema_json']);
    if (body['source']             !== undefined) patch.source             = String(body['source']);
    if (body['enabled']            !== undefined) patch.enabled            = asBool(body['enabled']);
    await db.updateLiveHandlerKind(params['id']!, patch);
    const item = await db.getLiveHandlerKind(params['id']!);
    json(res, 200, { 'live-handler-kind': item });
  }, { auth: true, csrf: true });

  router.del(`${HANDLER_KIND_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveHandlerKind(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}

// ─── live_attention_policies ───────────────────────────────────────────────

export function registerLiveAttentionPolicyRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  router.get(ATTN_POLICY_BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listLiveAttentionPolicies();
    json(res, 200, { 'live-attention-policies': items });
  }, { auth: true });

  router.get(`${ATTN_POLICY_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const item = await db.getLiveAttentionPolicy(params['id']!);
    if (!item) { json(res, 404, { error: 'Attention policy not found' }); return; }
    json(res, 200, { 'live-attention-policy': item });
  }, { auth: true });

  router.post(ATTN_POLICY_BASE, async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'])  { json(res, 400, { error: 'key required' });  return; }
    if (!body['kind']) { json(res, 400, { error: 'kind required' }); return; }
    const row: Omit<LiveAttentionPolicyRow, 'created_at' | 'updated_at'> = {
      id: newUUIDv7(),
      key: String(body['key']),
      kind: String(body['kind']),
      description: String(body['description'] ?? ''),
      config_json: String(body['config_json'] ?? '{}'),
      enabled: asBool(body['enabled'], 1),
    };
    const created = await db.createLiveAttentionPolicy(row);
    json(res, 201, { 'live-attention-policy': created });
  }, { auth: true, csrf: true });

  router.put(`${ATTN_POLICY_BASE}/:id`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getLiveAttentionPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Attention policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Partial<Omit<LiveAttentionPolicyRow, 'id' | 'created_at'>> = {};
    if (body['key']         !== undefined) patch.key         = String(body['key']);
    if (body['kind']        !== undefined) patch.kind        = String(body['kind']);
    if (body['description'] !== undefined) patch.description = String(body['description']);
    if (body['config_json'] !== undefined) patch.config_json = String(body['config_json']);
    if (body['enabled']     !== undefined) patch.enabled     = asBool(body['enabled']);
    await db.updateLiveAttentionPolicy(params['id']!, patch);
    const item = await db.getLiveAttentionPolicy(params['id']!);
    json(res, 200, { 'live-attention-policy': item });
  }, { auth: true, csrf: true });

  router.del(`${ATTN_POLICY_BASE}/:id`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteLiveAttentionPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
