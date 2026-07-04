/**
 * Per-Agent Attention Policy Resolver — Phase 4 bridge.
 *
 * Geneweave bridge that reads an agent's `attention_policy_key` (from the
 * `live_agents` row), loads the matching `live_attention_policies` row from
 * the DB, and returns a live `AttentionPolicy` instance via the shared
 * `@weaveintel/live-agents-runtime` factory.
 *
 * This file is intentionally thin:
 *   - All scheduling logic lives in `@weaveintel/live-agents` policy factories.
 *   - All DB row → policy mapping lives in `@weaveintel/live-agents-runtime`.
 *   - This file only wires the two together with geneweave-specific types.
 *
 * Callers (heartbeat, MeshProvisioner) should call
 * `resolveAgentAttentionPolicy(db, agentRow, opts)` once per agent per boot
 * and cache the result for the lifetime of the tick scheduler. Policies are
 * stateless, so caching is safe.
 */

import {
  resolveAttentionPolicyFromDb,
  type AttentionFactoryOptions,
} from '@weaveintel/live-agents-runtime';
import { createStandardAttentionPolicy, type AttentionPolicy } from '@weaveintel/live-agents';
import type { DatabaseAdapter } from '../db-types.js';
import { newUUIDv7 } from '../lib/uuid.js';

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a `live_agents` row that the resolver needs. Mirrors the
 * shape of `LiveAgentRow` without importing the full type so this module
 * remains easy to unit-test with plain objects.
 */
export interface AgentAttentionFieldsRow {
  id: string;
  /** Nullable FK to `live_attention_policies.key`. */
  attention_policy_key: string | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolveAgentAttentionOptions extends AttentionFactoryOptions {
  /**
   * Optional run id. When set, a `live_run_events` row of kind
   * `attention.resolved` is appended for observability / replay.
   */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolves the live `AttentionPolicy` for an agent.
 *
 * Resolution order:
 *   1. `agentRow.attention_policy_key` set → load row from DB → factory.
 *   2. No key or row not found / disabled → `createStandardAttentionPolicy()`.
 *
 * Emits a `live_run_events` row (`kind = 'attention.resolved'`) when `runId`
 * is provided, so replays can reconstruct which policy governed each tick.
 *
 * @example
 * // In the heartbeat supervisor, resolve once per agent at tick start.
 * const policy = await resolveAgentAttentionPolicy(db, agentRow, {
 *   runId: currentRunId,
 *   model: resolvedModel, // Required for kind='model' policies
 * });
 * const action = await policy.decide(attentionContext, execCtx);
 */
export async function resolveAgentAttentionPolicy(
  db: DatabaseAdapter,
  agentRow: AgentAttentionFieldsRow,
  opts: ResolveAgentAttentionOptions = {},
): Promise<AttentionPolicy> {
  const { runId, ...factoryOpts } = opts;

  // Delegate DB lookup + factory dispatch to the shared runtime package.
  const policy = await resolveAttentionPolicyFromDb(
    db,
    agentRow.attention_policy_key ?? null,
    factoryOpts,
  );

  // --- Observability: emit a resolved event so the run ledger captures the
  //     active policy key for this tick. Non-fatal if the emit fails. ---
  if (runId) {
    try {
      await db.appendLiveRunEvent({
        id: newUUIDv7(),
        run_id: runId,
        step_id: null,
        kind: 'attention.resolved',
        agent_id: agentRow.id,
        tool_key: null,
        summary: `attention policy resolved: ${policy.key ?? agentRow.attention_policy_key ?? 'standard'}`,
        payload_json: JSON.stringify({
          attention_policy_key: agentRow.attention_policy_key ?? null,
          resolved_policy_key: policy.key,
        }),
      });
    } catch (err) {
      console.warn('[agent-attention-resolver] audit emit failed (non-fatal)', err);
    }
  }

  return policy;
}

/**
 * Compatibility shim: delegates directly to `resolveAttentionPolicyFromDb`.
 *
 * Use this when you have already loaded the key from somewhere other than
 * a `live_agents` row (e.g. a one-off CLI script, a test). It exists so
 * call sites that only have the key string don't need to import
 * `resolveAttentionPolicyFromDb` directly — the two functions are identical
 * in behaviour.
 *
 * @example
 * const policy = await resolveAttentionPolicyByKey(db, 'cron.rest-only', {});
 */
export async function resolveAttentionPolicyByKey(
  db: DatabaseAdapter,
  key: string | null | undefined,
  opts: AttentionFactoryOptions = {},
): Promise<AttentionPolicy> {
  return resolveAttentionPolicyFromDb(db, key, opts);
}
