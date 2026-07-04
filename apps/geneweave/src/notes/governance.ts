// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — per-TENANT enterprise GOVERNANCE model (weaveNotes Phase 2).
 *
 * Enterprises buying a notes product ask the same trust questions: where does our data live, is it
 * encrypted with OUR key, will you train models on it, can we enforce SSO, how long do you keep it?
 * This module is the pure, typed source of truth for a tenant's answers to those questions — the
 * governance record, its validator, and a "posture" function that turns the record (plus a couple of
 * facts the app supplies, like whether the tenant has registered its own key) into the standard
 * enterprise CHECKLIST you can show in an admin page or a trust panel.
 *
 * It deliberately models the POLICY, not the mechanism: the heavy machinery (envelope encryption with
 * customer keys, the consent store, retention sweeps) already lives in the app — this records what the
 * tenant has CHOSEN and reports the resulting posture. Pure + zero-dependency.
 */

/** Where a tenant's data is allowed to reside. `unrestricted` = no pinning. */
export type ResidencyRegion = 'unrestricted' | 'us' | 'eu' | 'uk' | 'apac' | 'canada' | 'australia';
export const RESIDENCY_REGIONS: readonly ResidencyRegion[] = ['unrestricted', 'us', 'eu', 'uk', 'apac', 'canada', 'australia'];

/** The single-sign-on protocol a tenant uses (when SSO is enforced). */
export type SsoProtocol = 'none' | 'saml' | 'oidc';
export const SSO_PROTOCOLS: readonly SsoProtocol[] = ['none', 'saml', 'oidc'];

export interface TenantGovernance {
  /** Region the tenant's data must stay in (surfaced; enforcement is at the storage/routing layer). */
  dataResidency: ResidencyRegion;
  /** Whether the tenant permits their data to be used to improve/train models. false = "no training". */
  allowModelTraining: boolean;
  /** Whether the tenant permits product analytics over their usage. */
  allowAnalytics: boolean;
  /** Enforce single sign-on for this tenant's members. */
  ssoRequired: boolean;
  /** The SSO protocol (when required). */
  ssoProtocol: SsoProtocol;
  /** SCIM user provisioning/de-provisioning is enabled for this tenant. */
  scimEnabled: boolean;
  /** Days to keep the per-note activity log (0 = keep forever). */
  activityRetentionDays: number;
  /** Days to keep audit/compliance records (0 = keep forever). */
  auditRetentionDays: number;
  /** Legal hold: when on, retention sweeps are suspended (nothing is auto-deleted). */
  legalHold: boolean;
}

/** Sensible defaults for a tenant with no explicit governance row (the permissive base product). */
export const DEFAULT_TENANT_GOVERNANCE: TenantGovernance = {
  dataResidency: 'unrestricted',
  allowModelTraining: true,
  allowAnalytics: true,
  ssoRequired: false,
  ssoProtocol: 'none',
  scimEnabled: false,
  activityRetentionDays: 0,
  auditRetentionDays: 365,
  legalHold: false,
};

const MAX_RETENTION_DAYS = 3650; // 10 years

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return fallback;
}
function clampDays(v: unknown, fallback: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_RETENTION_DAYS, n)) : fallback;
}

/**
 * Validate + normalise a (partial) governance update against a base. Unknown enums fall back to the
 * base; retention is clamped to [0, 10y]. Returns the clean record + human-readable warnings.
 */
export function validateTenantGovernance(partial: Partial<Record<keyof TenantGovernance, unknown>>, base: TenantGovernance = DEFAULT_TENANT_GOVERNANCE): { governance: TenantGovernance; warnings: string[] } {
  const p = partial ?? {};
  const warnings: string[] = [];

  let dataResidency = base.dataResidency;
  if (p.dataResidency !== undefined) {
    if (RESIDENCY_REGIONS.includes(p.dataResidency as ResidencyRegion)) dataResidency = p.dataResidency as ResidencyRegion;
    else warnings.push(`Unknown residency region "${String(p.dataResidency)}" ignored.`);
  }
  let ssoProtocol = base.ssoProtocol;
  if (p.ssoProtocol !== undefined) {
    if (SSO_PROTOCOLS.includes(p.ssoProtocol as SsoProtocol)) ssoProtocol = p.ssoProtocol as SsoProtocol;
    else warnings.push(`Unknown SSO protocol "${String(p.ssoProtocol)}" ignored.`);
  }
  const ssoRequired = asBool(p.ssoRequired ?? base.ssoRequired, base.ssoRequired);
  // If SSO is required but no protocol chosen, default to SAML (the enterprise default) + warn.
  if (ssoRequired && ssoProtocol === 'none') { ssoProtocol = 'saml'; warnings.push('SSO required but no protocol set — defaulted to SAML.'); }

  const activityRetentionDays = clampDays(p.activityRetentionDays ?? base.activityRetentionDays, base.activityRetentionDays);
  if (p.activityRetentionDays !== undefined && activityRetentionDays !== Math.trunc(Number(p.activityRetentionDays))) warnings.push(`Activity retention clamped to ${activityRetentionDays} days (0–${MAX_RETENTION_DAYS}).`);
  const auditRetentionDays = clampDays(p.auditRetentionDays ?? base.auditRetentionDays, base.auditRetentionDays);

  return {
    governance: {
      dataResidency,
      allowModelTraining: asBool(p.allowModelTraining ?? base.allowModelTraining, base.allowModelTraining),
      allowAnalytics: asBool(p.allowAnalytics ?? base.allowAnalytics, base.allowAnalytics),
      ssoRequired,
      ssoProtocol,
      scimEnabled: asBool(p.scimEnabled ?? base.scimEnabled, base.scimEnabled),
      activityRetentionDays,
      auditRetentionDays,
      legalHold: asBool(p.legalHold ?? base.legalHold, base.legalHold),
    },
    warnings,
  };
}

/** One row of the enterprise trust checklist. `status`: configured/on, off, or not-applicable. */
export interface PostureItem { key: string; label: string; status: 'on' | 'off' | 'na'; detail: string }

/** Facts the APP supplies that the pure record can't know (from the encryption tables, etc.). */
export interface PostureContext {
  /** The tenant has registered its own encryption key (BYOK/CMK active). */
  byokActive?: boolean;
  /** Tenant data is encrypted at rest (an encryption policy is enabled). */
  encryptionAtRest?: boolean;
}

/**
 * Compute the enterprise governance CHECKLIST for a tenant — the residency / encryption / BYOK /
 * no-training / SSO / SCIM / retention / legal-hold posture, each with an on/off/na status and a
 * short human detail. This is what an admin page or a "trust & compliance" panel renders.
 */
export function governancePosture(g: TenantGovernance, ctx: PostureContext = {}): PostureItem[] {
  const days = (n: number): string => (n > 0 ? `${n} days` : 'kept indefinitely');
  return [
    { key: 'data_residency', label: 'Data residency', status: g.dataResidency === 'unrestricted' ? 'off' : 'on', detail: g.dataResidency === 'unrestricted' ? 'No region pinning' : `Pinned to ${g.dataResidency.toUpperCase()}` },
    { key: 'encryption_at_rest', label: 'Encryption at rest', status: ctx.encryptionAtRest ? 'on' : 'off', detail: ctx.encryptionAtRest ? 'Tenant data encrypted at rest' : 'Platform-default storage' },
    { key: 'byok', label: 'Customer-managed key (BYOK)', status: ctx.byokActive ? 'on' : 'off', detail: ctx.byokActive ? 'Encrypted with the tenant’s own key' : 'Platform-managed keys' },
    { key: 'no_training', label: 'No model training on tenant data', status: g.allowModelTraining ? 'off' : 'on', detail: g.allowModelTraining ? 'Training permitted' : 'Tenant data is never used for training' },
    { key: 'analytics', label: 'Product analytics', status: g.allowAnalytics ? 'on' : 'off', detail: g.allowAnalytics ? 'Usage analytics enabled' : 'Analytics disabled for this tenant' },
    { key: 'sso', label: 'Enforced SSO', status: g.ssoRequired ? 'on' : 'off', detail: g.ssoRequired ? `Required via ${g.ssoProtocol.toUpperCase()}` : 'Optional' },
    { key: 'scim', label: 'SCIM provisioning', status: g.scimEnabled ? 'on' : 'off', detail: g.scimEnabled ? 'Users provisioned from your IdP' : 'Manual user management' },
    { key: 'activity_retention', label: 'Activity-log retention', status: g.activityRetentionDays > 0 ? 'on' : 'off', detail: `Activity log ${days(g.activityRetentionDays)}` },
    { key: 'audit_retention', label: 'Audit retention', status: g.auditRetentionDays > 0 ? 'on' : 'off', detail: `Audit records ${days(g.auditRetentionDays)}` },
    { key: 'legal_hold', label: 'Legal hold', status: g.legalHold ? 'on' : 'off', detail: g.legalHold ? 'Auto-deletion suspended' : 'Normal retention' },
  ];
}

/** A compact score for badges: how many "enterprise controls" are switched on. */
export function governanceScore(items: PostureItem[]): { on: number; total: number } {
  const relevant = items.filter((i) => i.status !== 'na');
  return { on: relevant.filter((i) => i.status === 'on').length, total: relevant.length };
}
