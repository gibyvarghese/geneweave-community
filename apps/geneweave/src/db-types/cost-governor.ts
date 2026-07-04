/** Cost Governor Phase 2: Cost Policy row type. */

// Operator-defined cost tiers + lever overrides. Bound to agents/meshes/
// workflows via capability_policy_bindings (policy_kind = 'cost_policy').
export interface CostPolicyRow {
  id: string;
  key: string;
  /** One of 'economy' | 'balanced' | 'performance' | 'max' | 'custom'. */
  tier: string;
  /** JSON-encoded subset of CostPolicy lever fields. Optional. */
  levers_json: string | null;
  description: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}
