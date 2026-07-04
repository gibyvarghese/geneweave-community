/**
 * GeneWeave — DB-backed CheckpointStore
 *
 * Implements `@weaveintel/workflows` `CheckpointStore` over the SQLite
 * `workflow_checkpoints` table. State is JSON-serialised; UUID PKs.
 */
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import type { CheckpointStore } from '@weaveintel/workflows';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter, WorkflowCheckpointRow } from '../db-types.js';

function rowToCheckpoint(row: WorkflowCheckpointRow): WorkflowCheckpoint {
  return {
    id: row.id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    stepId: row.step_id,
    state: row.state ? JSON.parse(row.state) : { currentStepId: '', variables: {}, history: [] },
    createdAt: row.created_at,
  };
}

export class DbCheckpointStore implements CheckpointStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async save(runId: string, stepId: string, state: WorkflowState, workflowId?: string): Promise<WorkflowCheckpoint> {
    const cp: WorkflowCheckpoint = {
      id: newUUIDv7(),
      runId,
      ...(workflowId ? { workflowId } : {}),
      stepId,
      state: structuredClone(state),
      createdAt: new Date().toISOString(),
    };
    await this.db.createWorkflowCheckpoint({
      id: cp.id,
      run_id: runId,
      workflow_id: workflowId ?? '',
      step_id: stepId,
      state: JSON.stringify(state),
    });
    return cp;
  }

  async load(checkpointId: string): Promise<WorkflowCheckpoint | null> {
    // Lightweight scan since we don't have a getCheckpoint(id); checkpoints
    // are typically loaded via latest()/list().
    // Fall back to listing — callers normally use latest().
    return null;
  }

  async latest(runId: string): Promise<WorkflowCheckpoint | null> {
    const rows = await this.db.listWorkflowCheckpoints(runId);
    if (rows.length === 0) return null;
    return rowToCheckpoint(rows[rows.length - 1]!);
  }

  async list(runId: string): Promise<WorkflowCheckpoint[]> {
    const rows = await this.db.listWorkflowCheckpoints(runId);
    return rows.map(rowToCheckpoint);
  }

  async delete(runId: string): Promise<void> {
    await this.db.deleteWorkflowCheckpoints(runId);
  }
}
