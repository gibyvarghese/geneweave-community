/**
 * Built-in target adapters for the GeneWeave trigger dispatcher.
 *
 * Each adapter wraps a runtime capability (workflow engine, agent
 * tick, mesh message bus, contract emitter, …) so triggers can route
 * events to it via DB rows alone. The dispatcher itself stays
 * runtime-agnostic — adapters live in the app and inject app-specific
 * deps.
 */

import type { TargetAdapter, TriggerTargetRef, TargetDispatchMeta, TargetDispatchResult } from '@weaveintel/triggers';
import { CallbackTargetAdapter } from '@weaveintel/triggers';
import type { ContractEmitter } from '@weaveintel/workflows';
import type { WorkflowEngineHandle } from '../workflow-engine.js';

/**
 * `target_kind: 'workflow'` adapter.
 * `target.config.workflowDefId` (required) — the `workflow_defs.id`
 * to start. Returns the new run id as `targetRef`.
 */
export function createWorkflowTargetAdapter(handle: WorkflowEngineHandle): TargetAdapter {
  return new CallbackTargetAdapter('workflow', async (target: TriggerTargetRef, input: unknown, _meta: TargetDispatchMeta): Promise<TargetDispatchResult> => {
    const defId = target.config['workflowDefId'];
    if (typeof defId !== 'string' || defId.length === 0) {
      throw new Error("workflow target requires 'workflowDefId' string in target.config");
    }
    const variables = (input && typeof input === 'object' ? input : { value: input }) as Record<string, unknown>;
    const run = await handle.engine.startRun(defId, variables);
    return { ref: run.id };
  });
}

/**
 * `target_kind: 'contract'` adapter.
 * `target.config.kind` (required) — the contract kind to emit. The
 * trigger's projected input becomes the contract body. Provenance
 * (workflow ids, mesh) is left empty since this is a trigger-driven
 * emission, not a workflow-completion emission.
 */
export function createContractTargetAdapter(emitter: ContractEmitter): TargetAdapter {
  return new CallbackTargetAdapter('contract', async (target: TriggerTargetRef, input: unknown, _meta: TargetDispatchMeta): Promise<TargetDispatchResult> => {
    const kind = target.config['kind'];
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new Error("contract target requires 'kind' string in target.config");
    }
    const body = (input && typeof input === 'object' ? input : { value: input }) as Record<string, unknown>;
    await emitter.emit({
      kind,
      body,
      meta: {
        workflowDefinitionId: '',
        workflowRunId: '',
        emittedAt: new Date().toISOString(),
      },
    });
    return { ref: `contract:${kind}` };
  });
}
