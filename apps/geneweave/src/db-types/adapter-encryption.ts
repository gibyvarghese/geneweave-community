import type { TenantEncryptionPolicyRow, TenantKekRow, TenantDekRow, TenantBikRow, EncryptionAuditRow, TenantEncryptionAlertConfigRow, TenantDeletionRequestRow, TenantByokConfigRow, TenantBreakGlassRequestRow, TenantAttestationLogRow, SystemAttestationSigningKeyRow } from './encryption.js';

export interface IEncryptionStore {
  // Tenant encryption policies
  getTenantEncryptionPolicy(tenantId: string): Promise<TenantEncryptionPolicyRow | null>;
  listTenantEncryptionPolicies(opts?: { enabledOnly?: boolean }): Promise<TenantEncryptionPolicyRow[]>;
  upsertTenantEncryptionPolicy(p: Omit<TenantEncryptionPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  deleteTenantEncryptionPolicy(tenantId: string): Promise<void>;
  insertTenantKek(k: Omit<TenantKekRow, never>): Promise<void>;
  listTenantKeks(tenantId: string): Promise<TenantKekRow[]>;
  /** H-13: Point lookup — avoids O(n) list scan on every encrypt/decrypt. */
  getTenantKekById(tenantId: string, kekId: string): Promise<TenantKekRow | null>;
  updateTenantKekStatus(id: string, status: string, ts: number): Promise<void>;
  insertTenantDek(d: Omit<TenantDekRow, never>): Promise<void>;
  listTenantDeks(tenantId: string): Promise<TenantDekRow[]>;
  /** H-13: Point lookup — avoids O(n) list scan on every decrypt. */
  getTenantDekById(tenantId: string, dekId: string): Promise<TenantDekRow | null>;
  /** H-13: Max active DEK epoch — used by rotation path without a full list scan. */
  getMaxTenantDekEpoch(tenantId: string): Promise<number | null>;
  updateTenantDekStatus(id: string, status: string, ts: number): Promise<void>;
  insertTenantBik(b: Omit<TenantBikRow, never>): Promise<void>;
  listTenantBiks(tenantId: string): Promise<TenantBikRow[]>;
  updateTenantBikStatus(id: string, status: string, ts: number): Promise<void>;
  insertEncryptionAudit(e: Omit<EncryptionAuditRow, never>): Promise<void>;
  listEncryptionAudit(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<EncryptionAuditRow[]>;

  // Alert rules
  upsertEncryptionAlertConfig(r: Omit<TenantEncryptionAlertConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  listEncryptionAlertConfig(opts?: { tenantId?: string | null }): Promise<TenantEncryptionAlertConfigRow[]>;
  deleteEncryptionAlertConfig(id: string): Promise<boolean>;

  // GDPR deletion lifecycle
  deleteAllTenantWrappedMaterial(tenantId: string): Promise<{ keks: number; deks: number; biks: number }>;
  createTenantDeletionRequest(r: Omit<TenantDeletionRequestRow, 'purged_at' | 'cancelled_at'>): Promise<void>;
  getTenantDeletionRequest(id: string): Promise<TenantDeletionRequestRow | null>;
  listTenantDeletionRequests(opts?: { tenantId?: string; status?: TenantDeletionRequestRow['status']; limit?: number; offset?: number }): Promise<TenantDeletionRequestRow[]>;
  listDueTenantPurges(nowMs: number): Promise<TenantDeletionRequestRow[]>;
  markTenantPurged(id: string, purgedAtMs: number): Promise<void>;
  cancelTenantDeletionRequest(id: string, cancelledAtMs: number): Promise<boolean>;

  // BYOK / HYOK / break-glass / attestation
  upsertTenantByokConfig(c: Omit<TenantByokConfigRow, 'created_at' | 'updated_at' | 'revoked_at'>): Promise<void>;
  getTenantByokConfig(tenantId: string): Promise<TenantByokConfigRow | null>;
  listTenantByokConfigs(opts?: { activeOnly?: boolean }): Promise<TenantByokConfigRow[]>;
  revokeTenantByokConfig(tenantId: string, revokedAtMs: number): Promise<boolean>;
  deleteTenantByokConfig(tenantId: string): Promise<boolean>;
  insertBreakGlassRequest(r: Omit<TenantBreakGlassRequestRow, 'updated_at'>): Promise<void>;
  getBreakGlassRequest(id: string): Promise<TenantBreakGlassRequestRow | null>;
  listBreakGlassRequests(opts?: { tenantId?: string; status?: TenantBreakGlassRequestRow['status']; limit?: number; offset?: number }): Promise<TenantBreakGlassRequestRow[]>;
  updateBreakGlassRequest(id: string, patch: Partial<Omit<TenantBreakGlassRequestRow, 'id' | 'tenant_id' | 'created_at'>>): Promise<boolean>;
  listExpiredApprovedBreakGlassRequests(nowMs: number): Promise<TenantBreakGlassRequestRow[]>;
  insertAttestationLog(a: Omit<TenantAttestationLogRow, 'created_at'>): Promise<void>;
  listAttestationLogs(opts?: { tenantId?: string; limit?: number; offset?: number }): Promise<TenantAttestationLogRow[]>;
  getAttestationLog(id: string): Promise<TenantAttestationLogRow | null>;
  getSystemAttestationSigningKey(): Promise<SystemAttestationSigningKeyRow | null>;
  insertSystemAttestationSigningKeyIfMissing(r: Omit<SystemAttestationSigningKeyRow, 'created_at'>): Promise<boolean>;
}
