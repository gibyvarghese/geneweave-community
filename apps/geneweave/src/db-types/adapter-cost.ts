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

  // Tool embeddings (Intent-RAG)
  upsertToolEmbedding(e: Omit<ToolEmbeddingRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolEmbedding(toolKey: string): Promise<ToolEmbeddingRow | null>;
  listToolEmbeddings(opts?: { modelId?: string }): Promise<ToolEmbeddingRow[]>;
  deleteToolEmbedding(toolKey: string): Promise<void>;
}
