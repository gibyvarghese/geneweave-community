// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant answer-versions (regenerate) config (m139). Mirrors the tenant-appearance CRUD
 * contract so it drops straight into the Builder ({ tenants: [...] } list + per-tenant GET/PUT).
 *
 * An admin controls whether Regenerate is offered in chat and how many versions to keep per answer.
 *
 *   GET /api/admin/answer-versions               — configured tenants (+ the caller's own, always)
 *   GET /api/admin/answer-versions/:tenantId     — one tenant's config
 *   PUT /api/admin/answer-versions/:tenantId     — update the config
 */
import { createAnswerVersionsService } from '../../answer-versions-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { TenantAnswerVersionsRow } from '../../db-types/adapter-me.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/answer-versions';

function toRow(t: TenantAnswerVersionsRow): Record<string, unknown> {
  return { tenant_id: t.tenant_id, enabled: t.enabled, max_variants: t.max_variants };
}

export function registerAnswerVersionsRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createAnswerVersionsService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantAnswerVersions();
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
    if (body['max_variants'] !== undefined) patch.max_variants = Number(body['max_variants']);
    const next = await svc.updateConfig(tenantId, patch);
    json(res, 200, { tenants: toRow(next) });
  });
}
