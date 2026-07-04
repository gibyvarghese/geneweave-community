/**
 * GeneWeave — DB-backed StepLockStore
 *
 * Implements `@weaveintel/workflows` `StepLockStore` over the SQLite
 * `workflow_step_locks` table (created by migration M25).
 *
 * Provides exactly-once step execution semantics:
 *   lock()    — writes `locked` record before handler execution.
 *   markDone()— upgrades to `done` and stores cached output.
 *   isDone()  — returns true + cached output for done records (replay path).
 *   isLocked()— returns true if any record exists (locked or done).
 *   clear()   — removes all lock records for a run (called at terminal state).
 */
import type { StepLockStore, StepLockEntry } from '@weaveintel/workflows';
import type { DatabaseAdapter } from '../db-types.js';
import type { WorkflowStepLockRow } from '../db-types/workflows.js';

type DB = { prepare(s: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };

function getDb(adapter: DatabaseAdapter): DB {
  return (adapter as unknown as { d: DB }).d;
}

function rowToEntry(row: WorkflowStepLockRow): StepLockEntry {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    state: row.state,
    lockedAt: row.locked_at,
    ...(row.done_at ? { doneAt: row.done_at } : {}),
    ...(row.output !== null ? { output: JSON.parse(row.output) as unknown } : {}),
  };
}

export class DbStepLockStore implements StepLockStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async lock(runId: string, stepId: string): Promise<void> {
    getDb(this.db).prepare(`
      INSERT INTO workflow_step_locks (run_id, step_id, state, locked_at)
      VALUES (?, ?, 'locked', ?)
      ON CONFLICT(run_id, step_id) DO NOTHING
    `).run(runId, stepId, new Date().toISOString());
  }

  async markDone(runId: string, stepId: string, output: unknown): Promise<void> {
    getDb(this.db).prepare(`
      INSERT INTO workflow_step_locks (run_id, step_id, state, locked_at, done_at, output)
      VALUES (?, ?, 'done', ?, ?, ?)
      ON CONFLICT(run_id, step_id) DO UPDATE SET
        state    = 'done',
        done_at  = excluded.done_at,
        output   = excluded.output
    `).run(
      runId,
      stepId,
      new Date().toISOString(),
      new Date().toISOString(),
      output !== undefined ? JSON.stringify(output) : null,
    );
  }

  async isDone(runId: string, stepId: string): Promise<{ done: boolean; output?: unknown }> {
    const row = getDb(this.db).prepare(
      "SELECT * FROM workflow_step_locks WHERE run_id = ? AND step_id = ? AND state = 'done'",
    ).get(runId, stepId) as WorkflowStepLockRow | undefined;
    if (!row) return { done: false };
    return {
      done: true,
      output: row.output !== null ? JSON.parse(row.output) as unknown : undefined,
    };
  }

  async isLocked(runId: string, stepId: string): Promise<boolean> {
    const row = getDb(this.db).prepare(
      'SELECT 1 FROM workflow_step_locks WHERE run_id = ? AND step_id = ?',
    ).get(runId, stepId);
    return row !== undefined;
  }

  async clear(runId: string): Promise<void> {
    getDb(this.db).prepare('DELETE FROM workflow_step_locks WHERE run_id = ?').run(runId);
  }
}
