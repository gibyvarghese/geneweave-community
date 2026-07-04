// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TENANT_GOVERNANCE, validateTenantGovernance, governancePosture, governanceScore,
  RESIDENCY_REGIONS, SSO_PROTOCOLS,
} from './governance.js';

describe('governance — defaults + validation', () => {
  it('has a sane permissive default posture', () => {
    expect(DEFAULT_TENANT_GOVERNANCE.dataResidency).toBe('unrestricted');
    expect(DEFAULT_TENANT_GOVERNANCE.ssoRequired).toBe(false);
    expect(DEFAULT_TENANT_GOVERNANCE.legalHold).toBe(false);
  });

  it('accepts a valid governance update', () => {
    const { governance, warnings } = validateTenantGovernance({ dataResidency: 'eu', allowModelTraining: false, scimEnabled: true, activityRetentionDays: 90 });
    expect(governance.dataResidency).toBe('eu');
    expect(governance.allowModelTraining).toBe(false);
    expect(governance.scimEnabled).toBe(true);
    expect(governance.activityRetentionDays).toBe(90);
    expect(warnings).toEqual([]);
  });

  it('rejects unknown enums (keeps base) with a warning', () => {
    const { governance, warnings } = validateTenantGovernance({ dataResidency: 'mars' as never, ssoProtocol: 'kerberos' as never });
    expect(governance.dataResidency).toBe('unrestricted');     // base kept
    expect(governance.ssoProtocol).toBe('none');
    expect(warnings.length).toBe(2);
  });

  it('defaults the SSO protocol to SAML when SSO is required without one', () => {
    const { governance, warnings } = validateTenantGovernance({ ssoRequired: true });
    expect(governance.ssoRequired).toBe(true);
    expect(governance.ssoProtocol).toBe('saml');
    expect(warnings.join(' ')).toMatch(/SAML/);
  });

  it('clamps retention to [0, 10y] and never throws on junk', () => {
    expect(validateTenantGovernance({ activityRetentionDays: -5 }).governance.activityRetentionDays).toBe(0);
    expect(validateTenantGovernance({ auditRetentionDays: 999999 }).governance.auditRetentionDays).toBe(3650);
    expect(() => validateTenantGovernance({ activityRetentionDays: 'abc' as never })).not.toThrow();
    expect(RESIDENCY_REGIONS.length).toBeGreaterThan(3);
    expect(SSO_PROTOCOLS).toContain('saml');
  });

  it('coerces 0/1 + string booleans (admin form values)', () => {
    const g = validateTenantGovernance({ allowModelTraining: 0 as never, scimEnabled: 1 as never, legalHold: 'true' as never }).governance;
    expect(g.allowModelTraining).toBe(false);
    expect(g.scimEnabled).toBe(true);
    expect(g.legalHold).toBe(true);
  });
});

describe('governance — posture checklist', () => {
  it('reflects the policy + app-supplied facts in the checklist', () => {
    const g = validateTenantGovernance({ dataResidency: 'eu', allowModelTraining: false, ssoRequired: true, ssoProtocol: 'oidc', scimEnabled: true, activityRetentionDays: 30, legalHold: true }).governance;
    const items = governancePosture(g, { byokActive: true, encryptionAtRest: true });
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by['data_residency']!.status).toBe('on');
    expect(by['data_residency']!.detail).toMatch(/EU/);
    expect(by['byok']!.status).toBe('on');
    expect(by['encryption_at_rest']!.status).toBe('on');
    expect(by['no_training']!.status).toBe('on');             // training OFF → control ON
    expect(by['sso']!.detail).toMatch(/OIDC/);
    expect(by['scim']!.status).toBe('on');
    expect(by['activity_retention']!.detail).toMatch(/30 days/);
    expect(by['legal_hold']!.status).toBe('on');
  });

  it('shows defaults as mostly off, byok off when no key registered', () => {
    const items = governancePosture(DEFAULT_TENANT_GOVERNANCE, {});
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by['byok']!.status).toBe('off');
    expect(by['no_training']!.status).toBe('off');            // training permitted by default
    expect(by['sso']!.status).toBe('off');
  });

  it('scores how many enterprise controls are on', () => {
    const g = validateTenantGovernance({ dataResidency: 'us', allowModelTraining: false, ssoRequired: true }).governance;
    const score = governanceScore(governancePosture(g, { byokActive: true, encryptionAtRest: true }));
    expect(score.on).toBeGreaterThanOrEqual(4); // residency + byok + encryption + no-training + sso
    expect(score.total).toBe(10);
  });
});
