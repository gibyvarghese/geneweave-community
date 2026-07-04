/**
 * SqliteDecisionStore — persists SmartModelRouter decisions into the
 * `routing_decision_traces` table (anyWeave Phase 2).
 *
 * Implements the @weaveintel/routing DecisionStore contract.
 */

import type { RoutingDecision } from '@weaveintel/core';
import type { DecisionStore } from '@weaveintel/routing';
import type { DatabaseAdapter } from './db.js';
import { newUUIDv7 } from './lib/uuid.js';

export interface SqliteDecisionStoreOptions {
  /** Tenant scope to record on each trace (NULL = global). */
  tenantId?: string | null;
  /** Agent id for trace correlation. */
  agentId?: string | null;
  /** Workflow step id for trace correlation. */
  workflowStepId?: string | null;
  /** Weights actually used by the scorer (JSON-serialised). */
  weights?: Record<string, number>;
  /** Source provider, for cross-provider tool translation tracking. */
  sourceProvider?: string | null;
  /** True when the executor had to translate tool schemas before calling the model. */
  toolTranslationApplied?: boolean;
  /** Estimated cost in USD for the call (best effort). */
  estimatedCostUsd?: number | null;
}

export class SqliteDecisionStore implements DecisionStore {
  private readonly cache: RoutingDecision[] = [];

  constructor(private readonly db: DatabaseAdapter, private readonly opts: SqliteDecisionStoreOptions = {}) {}

  async record(decision: RoutingDecision): Promise<void> {
    this.cache.push(decision);
    if (this.cache.length > 1000) this.cache.shift();
    try {
      const breakdown = [
        { modelId: decision.modelId, providerId: decision.providerId, score: decision.scores[`${decision.providerId}:${decision.modelId}`] ?? null, selected: true },
        ...decision.alternatives.map(a => ({ modelId: a.modelId, providerId: a.providerId, score: a.score, selected: false })),
      ];
      await this.db.insertRoutingDecisionTrace({
        id: newUUIDv7(),
        tenant_id: this.opts.tenantId ?? null,
        agent_id: this.opts.agentId ?? null,
        workflow_step_id: this.opts.workflowStepId ?? null,
        task_key: decision.taskMeta?.taskKey ?? null,
        inference_source: decision.taskMeta?.inferenceSource ?? null,
        selected_model_id: decision.modelId,
        selected_provider: decision.providerId,
        selected_capability_score: null,
        weights_used: JSON.stringify(this.opts.weights ?? {}),
        candidate_breakdown: JSON.stringify({
          candidates: breakdown,
          exclusions: decision.taskMeta?.exclusionReasons ?? [],
          reason: decision.reason,
        }),
        tool_translation_applied: this.opts.toolTranslationApplied ? 1 : 0,
        source_provider: this.opts.sourceProvider ?? null,
        estimated_cost_usd: this.opts.estimatedCostUsd ?? null,
      });
    } catch {
      // Trace persistence is best-effort; never block routing.
    }
  }

  async list(opts?: { limit?: number; modelId?: string; providerId?: string }): Promise<RoutingDecision[]> {
    let result = [...this.cache];
    if (opts?.modelId) result = result.filter(d => d.modelId === opts.modelId);
    if (opts?.providerId) result = result.filter(d => d.providerId === opts.providerId);
    result.reverse();
    if (opts?.limit) result = result.slice(0, opts.limit);
    return result;
  }

  async clear(): Promise<void> {
    this.cache.length = 0;
  }
}
