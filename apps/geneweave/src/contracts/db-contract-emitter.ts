/**
 * apps/geneweave — db-contract-emitter.ts
 *
 * Phase 4 (DB-driven capability plan) — Mesh contract emitter.
 *
 * Persists every emitted contract to the `mesh_contracts` table and
 * notifies an in-process Node EventEmitter so the triggers dispatcher
 * (via `MeshContractSourceAdapter`) can route on the same event.
 *
 * Per the Phase 4 contract:
 *   - Emit is best-effort. We swallow DB errors here because the engine
 *     also catches them; logging happens on the bus side.
 *   - Each row gets a fresh UUID. The bus event payload includes the id
 *     so downstream consumers can join back to the row if needed.
 */
import type { EventEmitter } from 'node:events';
import { newUUIDv7 } from '@weaveintel/core';
import type { ContractEmitter, EmittedContract } from '@weaveintel/workflows';
import type { DatabaseAdapter } from '../db-types.js';

export interface DbContractEmitterOptions {
  /** Event name dispatched on the bus. Defaults to 'contract_emitted'. */
  eventName?: string;
}

export class DbContractEmitter implements ContractEmitter {
  private readonly eventName: string;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly bus: EventEmitter,
    opts: DbContractEmitterOptions = {},
  ) {
    this.eventName = opts.eventName ?? 'contract_emitted';
  }

  async emit(contract: EmittedContract): Promise<void> {
    const id = newUUIDv7();
    const bodyJson = JSON.stringify(contract.body ?? {});
    const evidenceJson = contract.evidence !== undefined
      ? JSON.stringify(contract.evidence)
      : null;
    const metadataJson = contract.meta.metadata !== undefined
      ? JSON.stringify(contract.meta.metadata)
      : null;

    await this.db.insertMeshContract({
      id,
      kind: contract.kind,
      body_json: bodyJson,
      evidence_json: evidenceJson,
      mesh_id: contract.meta.meshId ?? null,
      source_workflow_definition_id: contract.meta.workflowDefinitionId || null,
      source_workflow_run_id: contract.meta.workflowRunId || null,
      source_agent_id: null,
      metadata: metadataJson,
      emitted_at: contract.meta.emittedAt,
    });

    // Best-effort bus notification — never throw.
    try {
      this.bus.emit(this.eventName, {
        id,
        kind: contract.kind,
        body: contract.body,
        ...(contract.evidence !== undefined ? { evidence: contract.evidence } : {}),
        meta: contract.meta,
      });
    } catch {
      // swallow — DB row is the source of truth.
    }
  }
}
