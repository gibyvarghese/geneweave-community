// SPDX-License-Identifier: MIT
/**
 * geneWeave per-tenant enterprise GOVERNANCE service (weaveNotes Phase 2).
 *
 * Surfaces — and, where machinery exists, ENFORCES — a tenant's enterprise posture:
 *   • read/write the per-tenant governance record (residency, no-training, analytics, enforced SSO +
 *     protocol, SCIM, activity/audit retention, legal hold), going through the pure validator so a
 *     value can never be saved out of range or with an unknown enum;
 *   • compute the effective POSTURE — the standard compliance checklist — by projecting the record
 *     PLUS the facts only the app knows: whether the tenant has registered its own encryption key
 *     (BYOK) and whether an encryption-at-rest policy is enabled (read from the existing encryption
 *     tables — we surface real state, never a faked toggle);
 *   • enforce per-tenant ACTIVITY RETENTION (the one control with a sweep here): prune each tenant's
 *     note-activity older than their window, while honouring legal hold (a hold suspends deletion).
 *
 * The pure governance model lives in `@weaveintel/notes` (validated + checklist), reused here.
 */
import { validateTenantGovernance, governancePosture, governanceScore, DEFAULT_TENANT_GOVERNANCE, type TenantGovernance, type PostureItem } from './notes/governance.js';
import type { DatabaseAdapter } from './db-types.js';
import type { TenantGovernanceRow } from './db-types/governance.js';

type GovDb = DatabaseAdapter & {
  getTenantGovernance(tenantId: string): Promise<TenantGovernanceRow | null>;
  listTenantGovernance(): Promise<TenantGovernanceRow[]>;
  upsertTenantGovernance(tenantId: string, fields: Partial<Omit<TenantGovernanceRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>): Promise<TenantGovernanceRow>;
  deleteTenantGovernance(tenantId: string): Promise<void>;
  pruneNoteActivityForTenant(tenantId: string, cutoffIso: string): Promise<number>;
};

const DAY_MS = 86_400_000;

/** DB row → the validated, normalised governance record. */
export function rowToGovernance(row: TenantGovernanceRow | null): TenantGovernance {
  if (!row) return DEFAULT_TENANT_GOVERNANCE;
  return validateTenantGovernance({
    dataResidency: row.data_residency,
    allowModelTraining: row.allow_model_training !== 0,
    allowAnalytics: row.allow_analytics !== 0,
    ssoRequired: row.sso_required !== 0,
    ssoProtocol: row.sso_protocol,
    scimEnabled: row.scim_enabled !== 0,
    activityRetentionDays: row.activity_retention_days,
    auditRetentionDays: row.audit_retention_days,
    legalHold: row.legal_hold !== 0,
  }).governance;
}

/** The validated record → the DB column fields. */
function governanceToFields(g: TenantGovernance): Partial<Omit<TenantGovernanceRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>> {
  return {
    data_residency: g.dataResidency,
    allow_model_training: g.allowModelTraining ? 1 : 0,
    allow_analytics: g.allowAnalytics ? 1 : 0,
    sso_required: g.ssoRequired ? 1 : 0,
    sso_protocol: g.ssoProtocol,
    scim_enabled: g.scimEnabled ? 1 : 0,
    activity_retention_days: g.activityRetentionDays,
    audit_retention_days: g.auditRetentionDays,
    legal_hold: g.legalHold ? 1 : 0,
  };
}

export interface EffectiveGovernance {
  tenantId: string;
  governance: TenantGovernance;
  posture: PostureItem[];
  score: { on: number; total: number };
  /** Whether an explicit governance row exists (vs synthesized defaults). */
  configured: boolean;
}

export function createTenantGovernanceService(db: GovDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Read the facts the pure checklist can't know — from the existing encryption tables. */
  async function encryptionContext(tenantId: string): Promise<{ byokActive: boolean; encryptionAtRest: boolean }> {
    let byokActive = false, encryptionAtRest = false;
    try {
      const byok = await (db as unknown as { getTenantByokConfig?: (t: string) => Promise<{ status?: string } | null> }).getTenantByokConfig?.(tenantId);
      byokActive = !!byok && byok.status === 'active';
    } catch { /* surface as off */ }
    try {
      const pol = await (db as unknown as { getTenantEncryptionPolicy?: (t: string) => Promise<{ enabled?: number } | null> }).getTenantEncryptionPolicy?.(tenantId);
      encryptionAtRest = !!pol && Number(pol.enabled) === 1;
    } catch { /* surface as off */ }
    return { byokActive, encryptionAtRest };
  }

  /** The effective governance + compliance checklist for a tenant. */
  async function getEffective(tenantId: string): Promise<EffectiveGovernance> {
    const row = await db.getTenantGovernance(tenantId);
    const governance = rowToGovernance(row);
    const ctx = await encryptionContext(tenantId);
    const posture = governancePosture(governance, ctx);
    return { tenantId, governance, posture, score: governanceScore(posture), configured: !!row };
  }

  /** All tenants with an explicit governance row, each as an effective view. */
  async function list(): Promise<EffectiveGovernance[]> {
    const rows = await db.listTenantGovernance();
    return Promise.all(rows.map((r) => getEffective(r.tenant_id)));
  }

  /** Validate + persist a (partial) governance update for a tenant. Returns the new effective view + warnings. */
  async function update(tenantId: string, partial: Partial<Record<keyof TenantGovernance, unknown>>): Promise<{ effective: EffectiveGovernance; warnings: string[] }> {
    const base = rowToGovernance(await db.getTenantGovernance(tenantId));
    const { governance, warnings } = validateTenantGovernance(partial, base);
    await db.upsertTenantGovernance(tenantId, governanceToFields(governance));
    return { effective: await getEffective(tenantId), warnings };
  }

  async function remove(tenantId: string): Promise<void> { await db.deleteTenantGovernance(tenantId); }

  /**
   * Enforce per-tenant ACTIVITY RETENTION: for each tenant whose governance sets a positive window and
   * is NOT under legal hold, prune note-activity older than the window. Returns a per-tenant summary.
   */
  async function runActivityRetentionSweep(): Promise<Array<{ tenantId: string; pruned: number; skipped?: string }>> {
    const rows = await db.listTenantGovernance();
    const out: Array<{ tenantId: string; pruned: number; skipped?: string }> = [];
    for (const row of rows) {
      const g = rowToGovernance(row);
      if (g.legalHold) { out.push({ tenantId: row.tenant_id, pruned: 0, skipped: 'legal-hold' }); continue; }
      if (g.activityRetentionDays <= 0) { out.push({ tenantId: row.tenant_id, pruned: 0, skipped: 'keep-forever' }); continue; }
      const cutoffIso = new Date(now() - g.activityRetentionDays * DAY_MS).toISOString();
      const pruned = await db.pruneNoteActivityForTenant(row.tenant_id, cutoffIso);
      out.push({ tenantId: row.tenant_id, pruned });
    }
    return out;
  }

  return { getEffective, list, update, remove, runActivityRetentionSweep, encryptionContext };
}

export type TenantGovernanceService = ReturnType<typeof createTenantGovernanceService>;
