// SPDX-License-Identifier: MIT
/**
 * Admin API — per-tenant Appearance / branding (white-label). Registered on the RBAC-gated adminRouter
 * (admin:tenant:write for PUT), so only a workspace admin can re-brand.
 *
 *   GET /api/admin/tenant-appearance             — list configured tenants (for the collection view)
 *   GET /api/admin/tenant-appearance/:tenantId   — one tenant's stored brand + resolved (a11y-safe) preview
 *   PUT /api/admin/tenant-appearance/:tenantId   — upsert a tenant's brand (validated + contrast-enforced)
 */
import { createTenantAppearanceService } from '../../tenant-appearance-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/tenant-appearance';
const APPEARANCE_FIELDS = ['enabled', 'brand_name', 'logo_svg', 'color_scheme', 'variant', 'accent', 'on_accent', 'corner_style', 'font_display', 'font_body', 'density'] as const;

/** Flatten the effective appearance into a flat admin-form row. */
function toAdminRow(tenantId: string, eff: Awaited<ReturnType<ReturnType<typeof createTenantAppearanceService>['getEffective']>>): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    enabled: eff.enabled ? 1 : 0,
    brand_name: eff.brandName ?? '',
    logo_svg: eff.logoSvg ?? '',
    color_scheme: eff.colorScheme,
    variant: eff.variant,
    corner_style: eff.cornerStyle,
    density: eff.density,
    degraded: eff.degraded ? 1 : 0,
  };
}

export function registerTenantAppearanceRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createTenantAppearanceService(db);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await svc.list();
    const tenants = [];
    for (const r of rows) tenants.push(toAdminRow(r.tenant_id, await svc.getEffective(r.tenant_id)));
    // Always surface the caller's own tenant even if unconfigured, so there's a row to edit.
    const own = auth.tenantId ?? '';
    if (own && !tenants.some((t) => t['tenant_id'] === own)) tenants.unshift(toAdminRow(own, await svc.getEffective(own)));
    json(res, 200, { tenants, color_schemes: ['system', 'light', 'dark'], variants: ['pro', 'creative'], corner_styles: ['soft', 'sharp', 'round'], densities: ['comfortable', 'compact'] });
  });

  router.get(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] ?? '';
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    const eff = await svc.getEffective(tenantId);
    json(res, 200, { appearance: eff, tenants: toAdminRow(tenantId, eff), color_schemes: ['system', 'light', 'dark'], variants: ['pro', 'creative'], corner_styles: ['soft', 'sharp', 'round'], densities: ['comfortable', 'compact'] });
  });

  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] ?? '';
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const patch: Record<string, unknown> = {};
    for (const f of APPEARANCE_FIELDS) if (body[f] !== undefined) patch[f] = body[f];
    const result = await svc.update(tenantId, patch);
    if (!result.ok) { json(res, 400, { error: result.error }); return; }
    json(res, 200, { tenants: toAdminRow(tenantId, result.effective!), appearance: result.effective, warnings: result.warnings });
  });
}
