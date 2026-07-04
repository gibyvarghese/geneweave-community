/**
 * Admin routes for per-tenant ENTERPRISE GOVERNANCE (weaveNotes Phase 2).
 *
 * Operators set each tenant's enterprise posture (data residency, no-training, analytics, enforced
 * SSO + protocol, SCIM, activity/audit retention, legal hold) and see the resulting compliance
 * CHECKLIST (which also reflects the tenant's encryption/BYOK state, read from the encryption tables).
 *
 * Routes:
 *   GET    /api/admin/tenant-governance               — list all configured tenants (+ posture)
 *   GET    /api/admin/tenant-governance/:tenantId      — one tenant's effective governance + checklist
 *   PUT    /api/admin/tenant-governance/:tenantId      — upsert a tenant's governance (validated)
 *   DELETE /api/admin/tenant-governance/:tenantId      — revert a tenant to defaults
 */
import { RESIDENCY_REGIONS, SSO_PROTOCOLS, type TenantGovernance } from '../../notes/governance.js';
import { createTenantGovernanceService, type EffectiveGovernance } from '../../tenant-governance-sql.js';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

const BASE = '/api/admin/tenant-governance';

/** Flatten the effective governance into a single row for the data-driven Builder table/form. */
function toAdminRow(eff: EffectiveGovernance): Record<string, unknown> {
  const g = eff.governance;
  const on = (key: string): boolean => eff.posture.find((p) => p.key === key)?.status === 'on';
  return {
    tenant_id: eff.tenantId,
    data_residency: g.dataResidency,
    allow_model_training: g.allowModelTraining,
    allow_analytics: g.allowAnalytics,
    sso_required: g.ssoRequired,
    sso_protocol: g.ssoProtocol,
    scim_enabled: g.scimEnabled,
    activity_retention_days: g.activityRetentionDays,
    audit_retention_days: g.auditRetentionDays,
    legal_hold: g.legalHold,
    byok_active: on('byok'),
    encryption_at_rest: on('encryption_at_rest'),
    controls: `${eff.score.on}/${eff.score.total}`,
    configured: eff.configured,
  };
}

export function registerTenantGovernanceRoutes(router: RouterLike, db: DatabaseAdapter, helpers: AdminHelpers): void {
  const { json, readBody } = helpers;
  const svc = createTenantGovernanceService(db as unknown as Parameters<typeof createTenantGovernanceService>[0]);

  router.get(BASE, async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenants = (await svc.list()).map(toAdminRow);
    json(res, 200, { tenants, residency_regions: RESIDENCY_REGIONS, sso_protocols: SSO_PROTOCOLS });
  });

  router.get(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] ?? '';
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    const eff = await svc.getEffective(tenantId);
    // `governance` = the rich posture (for a posture panel); `tenants` = the flat row (for the form).
    json(res, 200, { governance: eff, tenants: toAdminRow(eff), residency_regions: RESIDENCY_REGIONS, sso_protocols: SSO_PROTOCOLS });
  });

  router.put(`${BASE}/:tenantId`, async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] ?? '';
    if (!tenantId) { json(res, 400, { error: 'tenantId required' }); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    // Accept both snake_case (admin form) and camelCase keys → the validator's partial shape.
    const partial: Partial<Record<keyof TenantGovernance, unknown>> = {};
    const pick = (snake: string, camel: keyof TenantGovernance): void => { if (body[snake] !== undefined) partial[camel] = body[snake]; else if (body[camel] !== undefined) partial[camel] = body[camel]; };
    pick('data_residency', 'dataResidency');
    pick('allow_model_training', 'allowModelTraining');
    pick('allow_analytics', 'allowAnalytics');
    pick('sso_required', 'ssoRequired');
    pick('sso_protocol', 'ssoProtocol');
    pick('scim_enabled', 'scimEnabled');
    pick('activity_retention_days', 'activityRetentionDays');
    pick('audit_retention_days', 'auditRetentionDays');
    pick('legal_hold', 'legalHold');

    const { effective, warnings } = await svc.update(tenantId, partial);
    json(res, 200, { governance: effective, tenants: toAdminRow(effective), warnings });
  });

  router.del(`${BASE}/:tenantId`, async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tenantId = params['tenantId'] ?? '';
    if (!tenantId || tenantId === 'default') { json(res, 400, { error: 'Cannot delete the global default' }); return; }
    await svc.remove(tenantId);
    json(res, 200, { ok: true });
  });
}
