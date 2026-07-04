// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant role-access policy (m143). Mirrors the tenant-appearance CRUD contract so it drops
 * into the Builder ({ tenants: [...] } list + per-tenant GET/PUT). Controls which OPTIONAL areas a standard
 * member (tenant_user) can see; Builder/Admin stay admin-only by permission.
 *
 *   GET /api/admin/workspace-roles               — configured tenants (+ the caller's own, always)
 *   GET /api/admin/workspace-roles/:tenantId     — one tenant's policy
 *   PUT /api/admin/workspace-roles/:tenantId     — update the policy
 */
import { createWorkspaceAccessService } from '../../workspace-access-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { TenantRoleAccessRow } from '../../db-types/adapter-me.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/workspace-roles';

function toRow(t: TenantRoleAccessRow): Record<string, unknown> {
  return { tenant_id: t.tenant_id, member_dashboard: t.member_dashboard, member_connectors: t.member_connectors, member_design: t.member_design };
}

export function registerWorkspaceRolesRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createWorkspaceAccessService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listTenantRoleAccess();
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
    if (body['member_dashboard'] !== undefined) patch.member_dashboard = body['member_dashboard'] ? 1 : 0;
    if (body['member_connectors'] !== undefined) patch.member_connectors = body['member_connectors'] ? 1 : 0;
    if (body['member_design'] !== undefined) patch.member_design = body['member_design'] ? 1 : 0;
    const next = await svc.updateConfig(tenantId, patch);
    json(res, 200, { tenants: toRow(next) });
  });
}
