/**
 * DbCostPolicyResolver — resolves a CostPolicy for a given runtime context
 * by reading capability_policy_bindings (policy_kind = 'cost_policy') and
 * the cost_policies table. Implements the package-level CostPolicyResolver
 * contract so the wiring is reusable beyond geneweave (any DB-backed host
 * implements the same interface).
 *
 * Precedence convention (per copilot-instructions):
 *   agent     = 100
 *   mesh      = 50
 *   workflow  = 10
 *   tenant    = 5
 *
 * Resolution order:
 *   1. agent binding (if ctx.agentId set)
 *   2. mesh  binding (if ctx.meshId set)
 *   3. workflow binding (if ctx.workflowId set)
 *   4. tenant binding (if ctx.tenantId set) — tenant-wide default
 *   5. null  (caller falls back to package default 'balanced')
 *
 * All errors are logged + swallowed so the chat / tick hot path never
 * fails because of a config lookup.
 */

import type {
  CostPolicy,
  CostPolicyResolver,
  CostPolicyResolutionContext,
  ResolvedCostPolicyBinding,
} from '@weaveintel/cost-governor';
import {
  resolveCapabilityBinding,
  type CapabilityPolicyBinding,
  type CapabilityBindingKind,
} from '@weaveintel/core';
import type { DatabaseAdapter, CapabilityPolicyBindingRow, CostPolicyRow } from '../db-types.js';

export interface DbCostPolicyResolverOptions {
  /**
   * Optional logger for resolution failures. Defaults to console.warn.
   */
  logger?: { warn: (msg: string, err?: unknown) => void };
}

export class DbCostPolicyResolver implements CostPolicyResolver {
  private readonly db: DatabaseAdapter;
  private readonly logger: { warn: (msg: string, err?: unknown) => void };

  constructor(db: DatabaseAdapter, opts: DbCostPolicyResolverOptions = {}) {
    this.db = db;
    this.logger = opts.logger ?? { warn: (m, e) => console.warn(m, e) };
  }

  async resolve(ctx: CostPolicyResolutionContext): Promise<ResolvedCostPolicyBinding | null> {
    try {
      const rows = await this.db.listCapabilityPolicyBindings({
        policyKind: 'cost_policy',
        enabledOnly: true,
      });
      const bindings: CapabilityPolicyBinding[] = rows.map(rowToBinding);

      const tryKind = async (
        kind: CapabilityBindingKind,
        ref: string | undefined,
        source: ResolvedCostPolicyBinding['source'],
      ): Promise<ResolvedCostPolicyBinding | null> => {
        if (!ref) return null;
        const match = resolveCapabilityBinding(bindings, kind, ref, 'cost_policy');
        if (!match) return null;
        const policyRow = await this.db.getCostPolicy(match.policyRef);
        if (!policyRow || policyRow.enabled !== 1) return null;
        const policy = costPolicyFromRow(policyRow);
        return {
          policy,
          source,
          bindingId: match.id,
          policyId: policyRow.id,
        };
      };

      return (
        (await tryKind('agent', ctx.agentId, 'agent_binding')) ??
        (await tryKind('mesh', ctx.meshId, 'mesh_binding')) ??
        (await tryKind('workflow', ctx.workflowId, 'workflow_binding')) ??
        (await tryKind('tenant', ctx.tenantId, 'tenant_default')) ??
        null
      );
    } catch (err) {
      this.logger.warn('[cost-policy-resolver] failed', err);
      return null;
    }
  }
}

function rowToBinding(r: CapabilityPolicyBindingRow): CapabilityPolicyBinding {
  return {
    id: r.id,
    bindingKind: r.binding_kind as CapabilityBindingKind,
    bindingRef: r.binding_ref,
    policyKind: 'cost_policy',
    policyRef: r.policy_ref,
    precedence: r.precedence,
    ...(r.created_at ? { createdAt: r.created_at } : {}),
  };
}

/**
 * Convert a `cost_policies` row to the package-level `CostPolicy` shape.
 * `levers_json` is a partial CostPolicy override merged on top of the tier.
 */
export function costPolicyFromRow(row: CostPolicyRow): CostPolicy {
  const tier = row.tier as CostPolicy['tier'];
  let levers: Partial<CostPolicy> = {};
  if (row.levers_json) {
    try {
      const parsed = JSON.parse(row.levers_json);
      if (parsed && typeof parsed === 'object') levers = parsed as Partial<CostPolicy>;
    } catch {
      // ignore — invalid JSON falls back to tier-only policy
    }
  }
  return { ...levers, tier };
}
