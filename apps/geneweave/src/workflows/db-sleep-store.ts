/**
 * GeneWeave — DB-backed DurableSleepStore
 *
 * Implements `@weaveintel/core` `DurableSleepStore` over the SQLite
 * `workflow_sleeps` table (created by migration M25).
 *
 * The sleep scheduler polls `getDue()` and calls `engine.resumeRun()`
 * for each record whose `wakeAt` (epoch ms) has passed.
 */
import type { SleepRecord, DurableSleepStore } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db-types.js';
import type { WorkflowSleepRow } from '../db-types/workflows.js';

type DB = { prepare(s: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };

function getDb(adapter: DatabaseAdapter): DB {
  return (adapter as unknown as { d: DB }).d;
}

function rowToRecord(row: WorkflowSleepRow): SleepRecord {
  return { runId: row.run_id, wakeAt: row.wake_at, createdAt: row.created_at };
}

export class DbSleepStore implements DurableSleepStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async schedule(runId: string, wakeAt: number): Promise<void> {
    getDb(this.db).prepare(`
      INSERT INTO workflow_sleeps (run_id, wake_at)
      VALUES (?, ?)
      ON CONFLICT(run_id) DO UPDATE SET wake_at = excluded.wake_at
    `).run(runId, wakeAt);
  }

  async cancel(runId: string): Promise<void> {
    getDb(this.db).prepare('DELETE FROM workflow_sleeps WHERE run_id = ?').run(runId);
  }

  async getDue(now = Date.now()): Promise<SleepRecord[]> {
    const rows = getDb(this.db).prepare(
      'SELECT * FROM workflow_sleeps WHERE wake_at <= ?',
    ).all(now) as WorkflowSleepRow[];
    return rows.map(rowToRecord);
  }

  async list(): Promise<SleepRecord[]> {
    const rows = getDb(this.db).prepare(
      'SELECT * FROM workflow_sleeps ORDER BY wake_at ASC',
    ).all() as WorkflowSleepRow[];
    return rows.map(rowToRecord);
  }
}
