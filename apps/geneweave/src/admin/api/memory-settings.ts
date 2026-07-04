import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerMemorySettingsRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // List all settings rows (global + per-tenant overrides)
  router.get('/api/admin/memory-settings', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listMemorySettings();
    json(res, 200, { 'memory-settings': items });
  }, { auth: true });

  // Get effective settings for a given tenant (or global)
  router.get('/api/admin/memory-settings/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] === 'global' ? undefined : params['tenantId'];
    const item = await db.getMemorySettings(tenantId);
    if (!item) { json(res, 404, { error: 'Memory settings not found' }); return; }
    json(res, 200, { 'memory-settings-row': item });
  }, { auth: true });

  function parseBool(v: unknown, fallback: boolean): boolean {
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'false') return false;
    return fallback;
  }

  router.put('/api/admin/memory-settings/:tenantId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const tenantId = params['tenantId'] === 'global' ? null : params['tenantId']!;
    const existing = await db.getMemorySettings(tenantId ?? undefined);

    const id = existing?.id ?? ('mset-' + newUUIDv7().slice(-8));
    await db.upsertMemorySettings({
      id,
      tenant_id: tenantId,
      enable_semantic: parseBool(body['enable_semantic'], existing?.enable_semantic === 1) ? 1 : 0,
      enable_entity: parseBool(body['enable_entity'], existing?.enable_entity === 1) ? 1 : 0,
      enable_episodic: parseBool(body['enable_episodic'], existing?.enable_episodic === 1) ? 1 : 0,
      enable_procedural: parseBool(body['enable_procedural'], existing?.enable_procedural === 1) ? 1 : 0,
      enable_working: parseBool(body['enable_working'], existing?.enable_working === 1) ? 1 : 0,
      auto_extract_on_turn: parseBool(body['auto_extract_on_turn'], existing?.auto_extract_on_turn === 1) ? 1 : 0,
      consolidation_enabled: parseBool(body['consolidation_enabled'], existing?.consolidation_enabled === 1) ? 1 : 0,
      consolidation_interval_min: typeof body['consolidation_interval_min'] === 'number'
        ? Math.max(1, body['consolidation_interval_min'])
        : (existing?.consolidation_interval_min ?? 60),
      max_episodic_per_user: typeof body['max_episodic_per_user'] === 'number'
        ? Math.max(1, body['max_episodic_per_user'])
        : (existing?.max_episodic_per_user ?? 200),
      max_semantic_per_user: typeof body['max_semantic_per_user'] === 'number'
        ? Math.max(1, body['max_semantic_per_user'])
        : (existing?.max_semantic_per_user ?? 500),
      max_entity_per_user: typeof body['max_entity_per_user'] === 'number'
        ? Math.max(1, body['max_entity_per_user'])
        : (existing?.max_entity_per_user ?? 100),
    });
    const updated = await db.getMemorySettings(tenantId ?? undefined);
    json(res, 200, { 'memory-settings-row': updated });
  }, { auth: true, csrf: true });
}
