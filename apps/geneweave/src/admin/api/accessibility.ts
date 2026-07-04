// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant accessibility defaults (m140). Mirrors the tenant-appearance CRUD contract so it
 * drops straight into the Builder ({ tenants: [...] } list + per-tenant GET/PUT).
 *
 *   GET /api/admin/accessibility               — configured tenants (+ the caller's own, always)
 *   GET /api/admin/accessibility/:tenantId     — one tenant's config
 *   PUT /api/admin/accessibility/:tenantId     — update the config
 */
import { createAccessibilityService } from '../../accessibility-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { TenantAccessibilityRow } from '../../db-types/adapter-me.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/accessibility';

function toRow(t: TenantAccessibilityRow): Record<string, unknown> {
  return { tenant_id: t.tenant_id, announce_mode: t.announce_mode, reduced_motion: t.reduced_motion, always_show_focus: t.always_show_focus, confirm_destructive: t.confirm_destructive, show_skeletons: t.show_skeletons };
}

export function registerAccessibilityRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createAccessibilityService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantAccessibility();
    const tenants = rows.map(toRow);
    const own = auth.tenantId ?? 'default';
    if (!tenants.some((t) => t['tenant_id'] === own)) tenants.unshift(toRow(await svc.getConfig(own)));
    json(res, 200, { tenants, announce_modes: ['summary', 'live', 'off'] });
  });

  router.get(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    json(res, 200, { tenants: toRow(await svc.getConfig(tenantId)), announce_modes: ['summary', 'live', 'off'] });
  });

  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] || (auth.tenantId ?? 'default');
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Parameters<typeof svc.updateConfig>[1] = {};
    if (typeof body['announce_mode'] === 'string') patch.announce_mode = body['announce_mode'];
    if (body['reduced_motion'] !== undefined) patch.reduced_motion = body['reduced_motion'] ? 1 : 0;
    if (body['always_show_focus'] !== undefined) patch.always_show_focus = body['always_show_focus'] ? 1 : 0;
    if (body['confirm_destructive'] !== undefined) patch.confirm_destructive = body['confirm_destructive'] ? 1 : 0;
    if (body['show_skeletons'] !== undefined) patch.show_skeletons = body['show_skeletons'] ? 1 : 0;
    const next = await svc.updateConfig(tenantId, patch);
    json(res, 200, { tenants: toRow(next) });
  });
}
