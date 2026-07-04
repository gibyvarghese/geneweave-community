// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant suggested/starter prompts policy (m146). Mirrors the tenant-appearance CRUD contract
 * so it drops into the Builder ({ tenants: [...] } list + per-tenant GET/PUT). Controls whether the empty chat
 * shows starters, whether they may be personalised from recent notes/chats or AI-generated, and how many.
 *
 *   GET /api/admin/suggested-prompts               — configured tenants (+ the caller's own, always)
 *   GET /api/admin/suggested-prompts/:tenantId     — one tenant's policy
 *   PUT /api/admin/suggested-prompts/:tenantId     — update the policy
 */
import { createSuggestedPromptsService } from '../../suggested-prompts-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { TenantSuggestedPromptsRow } from '../../db-types/adapter-me.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/suggested-prompts';

function toRow(t: TenantSuggestedPromptsRow): Record<string, unknown> {
  return { tenant_id: t.tenant_id, enabled: t.enabled, use_recent_notes: t.use_recent_notes, use_recent_chats: t.use_recent_chats, use_ai: t.use_ai, max_curated: t.max_curated, max_personalized: t.max_personalized };
}

export function registerSuggestedPromptsRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createSuggestedPromptsService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantSuggestedPrompts();
    const tenants = rows.map(toRow);
    const own = auth.tenantId ?? 'default';
    if (!tenants.some((t) => t['tenant_id'] === own)) tenants.unshift(toRow(await svc.getConfig(own)));
    json(res, 200, { tenants });
  });

  router.get(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    json(res, 200, { tenants: toRow(await svc.getConfig(tenantId)) });
  });

  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Parameters<typeof svc.updateConfig>[1] = {};
    if (body['enabled'] !== undefined) patch.enabled = body['enabled'] ? 1 : 0;
    if (body['use_recent_notes'] !== undefined) patch.use_recent_notes = body['use_recent_notes'] ? 1 : 0;
    if (body['use_recent_chats'] !== undefined) patch.use_recent_chats = body['use_recent_chats'] ? 1 : 0;
    if (body['use_ai'] !== undefined) patch.use_ai = body['use_ai'] ? 1 : 0;
    if (body['max_curated'] !== undefined) patch.max_curated = Number(body['max_curated']);
    if (body['max_personalized'] !== undefined) patch.max_personalized = Number(body['max_personalized']);
    const next = await svc.updateConfig(tenantId, patch);
    json(res, 200, { tenants: toRow(next) });
  });
}
