// SPDX-License-Identifier: MIT
/** A per-tenant enterprise governance row (m127). Booleans are 0/1 integers in SQLite. */
export interface TenantGovernanceRow {
  id: string;
  tenant_id: string;
  data_residency: string;
  allow_model_training: number;
  allow_analytics: number;
  sso_required: number;
  sso_protocol: string;
  scim_enabled: number;
  activity_retention_days: number;
  audit_retention_days: number;
  legal_hold: number;
  created_at: string;
  updated_at: string | null;
}
