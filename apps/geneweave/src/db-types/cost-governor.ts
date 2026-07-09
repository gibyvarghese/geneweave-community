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
  // ── Tenancy Realm (m158) — present on every row via SELECT *; built-ins are realm='global' ──
  realm?: string;                 // 'global' | 'tenant'
  owner_tenant_id?: string | null;
  logical_key?: string | null;    // = the policy's canonical key; shared by a global + its tenant forks
  origin_id?: string | null;      // the global policy a tenant fork was copied from
  origin_hash?: string | null;    // that origin's content_hash at fork time (drift base)
  content_hash?: string;          // canonical hash of this policy's tier/lever fields
  track_mode?: string;            // 'pin' | 'track_latest'
  share_mode?: string;            // 'private' | 'children' | 'subtree'
  created_at: string;
  updated_at: string;
}
