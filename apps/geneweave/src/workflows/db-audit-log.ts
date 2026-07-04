/**
 * GeneWeave — DB-backed WorkflowAuditLog
 *
 * Implements `@weaveintel/core` `WorkflowAuditLog` over the SQLite
 * `workflow_events` table (created by migration M25).
 *
 * Rows are append-only and sorted by timestamp for causal ordering.
 */
import type { WorkflowAuditEvent, WorkflowAuditLog } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db-types.js';
import { newUUIDv7 } from '@weaveintel/core';
import type { WorkflowEventRow } from '../db-types/workflows.js';

type DB = { prepare(s: string): { run(...args: unknown[]): void; all(...args: unknown[]): unknown[] } };

function getDb(adapter: DatabaseAdapter): DB {
  return (adapter as unknown as { d: DB }).d;
}

function rowToEvent(row: WorkflowEventRow): WorkflowAuditEvent {
  return {
    id: row.id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    type: row.type,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    timestamp: row.timestamp,
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ...(row.caused_by ? { causedBy: row.caused_by } : {}),
    ...(row.data ? { data: JSON.parse(row.data) as Record<string, unknown> } : {}),
  };
}

export class DbAuditLog implements WorkflowAuditLog {
  constructor(private readonly db: DatabaseAdapter) {}

  async append(event: Omit<WorkflowAuditEvent, 'id'>): Promise<void> {
    const id = newUUIDv7();
    getDb(this.db).prepare(`
      INSERT INTO workflow_events
        (id, run_id, workflow_id, type, step_id, timestamp, trace_id, tenant_id, caused_by, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.runId,
      event.workflowId,
      event.type,
      event.stepId ?? null,
      event.timestamp,
      event.traceId ?? null,
      event.tenantId ?? null,
      event.causedBy ?? null,
      event.data ? JSON.stringify(event.data) : null,
    );
  }

  async list(runId: string): Promise<WorkflowAuditEvent[]> {
    const rows = getDb(this.db).prepare(
      'SELECT * FROM workflow_events WHERE run_id = ? ORDER BY timestamp ASC',
    ).all(runId) as WorkflowEventRow[];
    return rows.map(rowToEvent);
  }

  async listAll(opts?: { workflowId?: string; limit?: number }): Promise<WorkflowAuditEvent[]> {
    let sql = 'SELECT * FROM workflow_events';
    const args: unknown[] = [];
    if (opts?.workflowId) {
      sql += ' WHERE workflow_id = ?';
      args.push(opts.workflowId);
    }
    sql += ' ORDER BY timestamp ASC';
    if (opts?.limit) {
      sql += ' LIMIT ?';
      args.push(opts.limit);
    }
    const rows = getDb(this.db).prepare(sql).all(...args) as WorkflowEventRow[];
    return rows.map(rowToEvent);
  }
}
