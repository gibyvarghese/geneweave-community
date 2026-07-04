/**
 * GeneWeave — DB-backed WorkflowSpanEmitter
 *
 * Implements `WorkflowSpanEmitter` over the SQLite `workflow_spans` table
 * (created by migration M27). Each span is a single row for O(1) writes.
 * Reads by runId use the idx_workflow_spans_run index.
 */
import type { WorkflowSpan, WorkflowSpanEmitter } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db-types.js';
import { newUUIDv7 } from '@weaveintel/core';
import type { WorkflowSpanRow } from '../db-types/workflows.js';

type DB = { prepare(s: string): { run(...args: unknown[]): void; all(...args: unknown[]): unknown[] } };

function getDb(adapter: DatabaseAdapter): DB {
  return (adapter as unknown as { d: DB }).d;
}

function rowToSpan(row: WorkflowSpanRow): WorkflowSpan {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    stepId: row.step_id,
    handlerKind: row.handler_kind,
    handlerKey: row.handler_key,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    status: row.status as WorkflowSpan['status'],
    retryCount: row.retry_count,
    costUsd: row.cost_usd,
    ...(row.error ? { error: row.error } : {}),
    attributes: JSON.parse(row.attributes) as Record<string, string>,
  };
}

export class DbSpanEmitter implements WorkflowSpanEmitter {
  constructor(private readonly db: DatabaseAdapter) {}

  emit(span: WorkflowSpan): void {
    const id = newUUIDv7();
    getDb(this.db).prepare(`
      INSERT INTO workflow_spans
        (id, run_id, workflow_id, step_id, handler_kind, handler_key,
         started_at, completed_at, duration_ms, status, retry_count, cost_usd,
         error, attributes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      span.runId,
      span.workflowId,
      span.stepId,
      span.handlerKind,
      span.handlerKey,
      span.startedAt,
      span.completedAt,
      span.durationMs,
      span.status,
      span.retryCount,
      span.costUsd,
      span.error ?? null,
      JSON.stringify(span.attributes ?? {}),
    );
  }

  async getSpans(runId: string): Promise<WorkflowSpan[]> {
    const rows = getDb(this.db).prepare(
      'SELECT * FROM workflow_spans WHERE run_id = ? ORDER BY started_at ASC',
    ).all(runId) as WorkflowSpanRow[];
    return rows.map(rowToSpan);
  }

  async getAllSpans(): Promise<WorkflowSpan[]> {
    const rows = getDb(this.db).prepare(
      'SELECT * FROM workflow_spans ORDER BY started_at ASC',
    ).all() as WorkflowSpanRow[];
    return rows.map(rowToSpan);
  }

  async clear(runId: string): Promise<void> {
    getDb(this.db).prepare('DELETE FROM workflow_spans WHERE run_id = ?').run(runId);
  }
}
