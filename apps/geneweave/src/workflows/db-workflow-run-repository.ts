/**
 * GeneWeave — DB-backed WorkflowRunRepository
 *
 * Implements `@weaveintel/workflows` `WorkflowRunRepository` over the
 * SQLite `workflow_runs` table. Persists `costTotal` and `metadata` for
 * Phase 5 governance/durability.
 */
import type { WorkflowRun } from '@weaveintel/core';
import type { WorkflowRunRepository, RunFilterOpts } from '@weaveintel/workflows';
import type { DatabaseAdapter, WorkflowRunRow } from '../db-types.js';

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  const state = row.state ? JSON.parse(row.state) : { currentStepId: '', variables: {}, history: [] };
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowRun['status'],
    state,
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.cost_total !== undefined && row.cost_total !== null ? { costTotal: row.cost_total } : {}),
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.child_run_ids ? { childRunIds: JSON.parse(row.child_run_ids) as string[] } : {}),
    ...(row.priority !== undefined && row.priority !== null ? { priority: row.priority } : {}),
    ...(row.cost_breakdown ? { costBreakdown: JSON.parse(row.cost_breakdown) as Record<string, number> } : {}),
  };
}

export class DbWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async save(run: WorkflowRun): Promise<void> {
    const existing = await this.db.getWorkflowRun(run.id);
    const stateJson = JSON.stringify(run.state ?? {});
    if (!existing) {
      await this.db.createWorkflowRun({
        id: run.id,
        workflow_id: run.workflowId,
        status: run.status,
        state: stateJson,
        input: null,
        error: run.error ?? null,
        started_at: run.startedAt,
        ...(run.costTotal !== undefined ? { cost_total: run.costTotal } : {}),
        ...(run.traceId ? { trace_id: run.traceId } : {}),
        ...(run.tenantId ? { tenant_id: run.tenantId } : {}),
      });
      // Set completed_at on initial save if already terminal
      if (run.completedAt) {
        await this.db.updateWorkflowRun(run.id, { completed_at: run.completedAt });
      }
      return;
    }
    await this.db.updateWorkflowRun(run.id, {
      status: run.status,
      state: stateJson,
      error: run.error ?? null,
      ...(run.completedAt ? { completed_at: run.completedAt } : {}),
      ...(run.costTotal !== undefined ? { cost_total: run.costTotal } : {}),
      // Phase W4 — persist parent/child linkage on every save so updates propagate.
      ...(run.parentRunId !== undefined ? { parent_run_id: run.parentRunId } : {}),
      ...(run.childRunIds !== undefined ? { child_run_ids: JSON.stringify(run.childRunIds) } : {}),
      // Phase W5 — cost breakdown and priority.
      ...(run.costBreakdown !== undefined ? { cost_breakdown: JSON.stringify(run.costBreakdown) } : {}),
    });
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const row = await this.db.getWorkflowRun(runId);
    return row ? rowToRun(row) : null;
  }

  async list(workflowId?: string): Promise<WorkflowRun[]> {
    const rows = await this.db.listWorkflowRuns(workflowId);
    return rows.map(rowToRun);
  }

  async listByParent(parentRunId: string): Promise<WorkflowRun[]> {
    const db = (this.db as unknown as { d: { prepare(s: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown } } }).d;
    const rows = db.prepare(
      'SELECT * FROM workflow_runs WHERE parent_run_id = ?',
    ).all(parentRunId) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  async listFiltered(opts: RunFilterOpts): Promise<WorkflowRun[]> {
    const db = (this.db as unknown as { d: { prepare(s: string): { all(...args: unknown[]): unknown[] } } }).d;
    const conditions: string[] = [];
    const args: unknown[] = [];
    if (opts.workflowId) { conditions.push('workflow_id = ?'); args.push(opts.workflowId); }
    if (opts.status)     { conditions.push('status = ?'); args.push(opts.status); }
    if (opts.tenantId)   { conditions.push('tenant_id = ?'); args.push(opts.tenantId); }
    if (opts.before)     { conditions.push('started_at < ?'); args.push(opts.before); }
    if (opts.after)      { conditions.push('started_at > ?'); args.push(opts.after); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ? ` LIMIT ${opts.limit}` : '';
    const rows = db.prepare(
      `SELECT * FROM workflow_runs ${where} ORDER BY started_at DESC${limit}`,
    ).all(...args) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  async countActive(workflowId: string): Promise<number> {
    const db = (this.db as unknown as { d: { prepare(s: string): { get(...args: unknown[]): unknown } } }).d;
    const row = db.prepare(
      "SELECT COUNT(*) as n FROM workflow_runs WHERE workflow_id = ? AND status IN ('running','paused')",
    ).get(workflowId) as { n: number };
    return row.n;
  }

  async delete(runId: string): Promise<void> {
    await this.db.deleteWorkflowRun(runId);
  }
}
