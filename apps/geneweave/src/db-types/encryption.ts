/** Tenant-scoped envelope encryption row types (Phases 1–10). */

// Per-tenant policy + key hierarchy. KEK -> DEK -> ciphertext. BIK reserved
// for blind-index lookups in a future phase. All key material persisted as
// `SerializedWrappedKey` JSON via @weaveintel/encryption.
export interface TenantEncryptionPolicyRow {
  tenant_id: string;
  enabled: number;
  kms_provider_id: string;
  /** JSON object passed to KMS provider. Optional. */
  kms_config: string | null;
  active_kek_id: string | null;
  active_dek_id: string | null;
  active_bik_id: string | null;
  rotation_schedule: string;
  blind_index_enabled: number;
  /** JSON-encoded FieldPolicy: which (table,column) pairs to encrypt. */
  field_policy: string;
  shred_requested_at: number | null;
  shred_completed_at: number | null;
  created_at: string;
  updated_at: string;
}

export interface TenantKekRow {
  id: string;
  tenant_id: string;
  version: number;
  status: string;
  /** JSON-serialized SerializedWrappedKey wrapped under root KMS key. */
  wrapped: string;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export interface TenantDekRow {
  id: string;
  tenant_id: string;
  kek_id: string;
  epoch: number;
  status: string;
  /** JSON-serialized SerializedWrappedKey wrapped under tenant KEK. */
  wrapped: string;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export interface TenantBikRow {
  id: string;
  tenant_id: string;
  epoch: number;
  status: string;
  wrapped: string;
  created_at: number;
  revoked_at: number | null;
  /** KEK that wraps this BIK — recorded at creation for correct per-BIK unwrap during KEK rotation. */
  kek_id: string;
}

export interface EncryptionAuditRow {
  id: string;
  tenant_id: string;
  event_kind: string;
  actor: string | null;
  /** JSON-encoded `Record<string, unknown>` or null. */
  details: string | null;
  created_at: number;
}

/**
 * Phase 9 — Operator-configurable alert rule. `tenant_id` NULL means
 * fleet-wide; `window_ms` NULL falls back to the kind-specific default in
 * `@weaveintel/encryption.evaluateAlerts`.
 */
export interface TenantEncryptionAlertConfigRow {
  id: string;
  tenant_id: string | null;
  kind: string;
  threshold: number;
  window_ms: number | null;
  enabled: number;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Phase 6 — Tenant deletion request lifecycle. Operator-initiated GDPR
 * right-to-be-forgotten with retention window. Status flow:
 *   pending → cancelled  (operator changed mind before retention_until)
 *   pending → purged     (background scheduler hard-shreds after retention_until)
 */
export interface TenantDeletionRequestRow {
  id: string;
  tenant_id: string;
  requested_at: number;
  retention_until: number;
  requested_by: string | null;
  status: 'pending' | 'cancelled' | 'purged';
  purged_at: number | null;
  cancelled_at: number | null;
  reason: string | null;
}

/**
 * Phase 10 — Customer-managed key (BYOK) / hold-your-own-key (HYOK) config.
 * One row per tenant; presence flips the resolver onto the `byok-pem`
 * provider. `private_key_pem_dev` is DEV ONLY (never populated in prod) —
 * production deployments populate `hyok_endpoint` so unwrap is a customer
 * round-trip.
 */
export interface TenantByokConfigRow {
  tenant_id: string;
  mode: 'byok' | 'hyok';
  public_key_pem: string;
  public_key_fingerprint: string;
  hyok_endpoint: string | null;
  hyok_bearer_secret_id: string | null;
  hyok_timeout_ms: number | null;
  /** DEV ONLY — never set in production. Server logs a warning if present. */
  private_key_pem_dev: string | null;
  status: 'active' | 'revoked';
  created_by: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

/**
 * Phase 10 — Break-glass grant request. Pending → approved (dual-approval) |
 * denied; approved → expired (reaper) once `expires_at` passes. The
 * encryption package's break-glass evaluator owns all status transitions —
 * routes only persist the result.
 */
export interface TenantBreakGlassRequestRow {
  id: string;
  tenant_id: string;
  requested_by: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  customer_approver: string | null;
  approved_at: number | null;
  expires_at: number;
  consume_count: number;
  denial_reason: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Phase 10 — Compliance attestation export. Each row is a signed JSON
 * snapshot the customer's auditor can independently verify with the
 * platform's published Ed25519 public key.
 */
export interface TenantAttestationLogRow {
  id: string;
  tenant_id: string;
  generated_at: number;
  signature_alg: string;
  signature: string;
  signing_key_fingerprint: string;
  payload_hash: string;
  payload_json: string;
  requested_by: string | null;
  created_at: number;
}

/**
 * Phase 10 — Platform-level Ed25519 signing key used for attestations.
 * Single-row table keyed by `key` (currently always `'default'`); leave room
 * to add a rotation flag if multiple active keys are needed later.
 */
export interface SystemAttestationSigningKeyRow {
  key: string;
  private_key_pem: string;
  public_key_pem: string;
  fingerprint: string;
  created_at: number;
}
