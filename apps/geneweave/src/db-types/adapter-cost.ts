import type { CostPolicyRow } from './cost-governor.js';
import type { ToolEmbeddingRow } from './tools.js';

export interface ICostStore {
  // Cost policies
  createCostPolicy(p: Omit<CostPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCostPolicy(id: string): Promise<CostPolicyRow | null>;
  getCostPolicyByKey(key: string): Promise<CostPolicyRow | null>;
  listCostPolicies(opts?: { enabledOnly?: boolean }): Promise<CostPolicyRow[]>;
  updateCostPolicy(id: string, fields: Partial<Omit<CostPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCostPolicy(id: string): Promise<void>;
  /** Tenancy Realm (m158) — insert a fully-formed realm cost-policy row (a tenant fork), realm columns included. */
  insertRealmCostPolicyRow(p: Omit<CostPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  /** Tenancy Realm (m158) — the effective cost-policy set for a tenant (its forks + shared ancestors + globals, nearest-owner-wins, canonical key restored). Null tenant = globals only. */
  resolveTenantEffectiveCostPolicies(tenantId: string | null): Promise<CostPolicyRow[]>;
  /** Tenancy Realm (m158) — the effective cost policy for a tenant under a canonical logical key (used by DbCostPolicyResolver). Null tenant → the global row by key. */
  getEffectiveCostPolicyByKey(logicalKey: string, tenantId: string | null): Promise<CostPolicyRow | null>;

  // Tool embeddings (Intent-RAG)
  upsertToolEmbedding(e: Omit<ToolEmbeddingRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolEmbedding(toolKey: string): Promise<ToolEmbeddingRow | null>;
  listToolEmbeddings(opts?: { modelId?: string }): Promise<ToolEmbeddingRow[]>;
  deleteToolEmbedding(toolKey: string): Promise<void>;
}
