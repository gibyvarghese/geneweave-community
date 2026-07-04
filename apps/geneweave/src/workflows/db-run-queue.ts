/**
 * GeneWeave — DB-backed WorkflowRunQueue
 *
 * Implements `@weaveintel/workflows` `WorkflowRunQueue` over the SQLite
 * `workflow_run_queue` table (created by migration M26).
 *
 * Rows are ordered by priority DESC, queued_at ASC for fair dequeue within
 * the same priority band.  The DB index enforces this efficiently.
 */
import type { WorkflowRunQueue, RunQueueEntry } from '@weaveintel/workflows';
import type { DatabaseAdapter } from '../db-types.js';
import { newUUIDv7 } from '@weaveintel/core';

interface RunQueueRow {
  id: string;
  run_id: string;
  workflow_id: string;
  input: string;
  priority: number;
  queued_at: string;
  opts: string;
  created_at: string;
}

type DB = { prepare(s: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
function getDb(adapter: DatabaseAdapter): DB {
  return (adapter as unknown as { d: DB }).d;
}

function rowToEntry(row: RunQueueRow): RunQueueEntry {
  return {
    id: row.id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    input: JSON.parse(row.input) as Record<string, unknown>,
    priority: row.priority,
    queuedAt: row.queued_at,
    opts: JSON.parse(row.opts) as RunQueueEntry['opts'],
  };
}

export class DbRunQueue implements WorkflowRunQueue {
  constructor(private readonly db: DatabaseAdapter) {}

  async enqueue(entry: Omit<RunQueueEntry, 'id' | 'queuedAt'>): Promise<RunQueueEntry> {
    const id = newUUIDv7();
    const queuedAt = new Date().toISOString();
    getDb(this.db).prepare(`
      INSERT INTO workflow_run_queue (id, run_id, workflow_id, input, priority, queued_at, opts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entry.runId, entry.workflowId,
      JSON.stringify(entry.input),
      entry.priority,
      queuedAt,
      JSON.stringify(entry.opts),
    );
    return { id, queuedAt, ...entry };
  }

  async dequeue(workflowId: string): Promise<RunQueueEntry | null> {
    const db = getDb(this.db);
    const row = db.prepare(`
      SELECT * FROM workflow_run_queue
      WHERE workflow_id = ?
      ORDER BY priority DESC, queued_at ASC
      LIMIT 1
    `).get(workflowId) as RunQueueRow | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM workflow_run_queue WHERE id = ?').run(row.id);
    return rowToEntry(row);
  }

  async remove(entryId: string): Promise<void> {
    getDb(this.db).prepare('DELETE FROM workflow_run_queue WHERE id = ?').run(entryId);
  }

  async size(): Promise<number> {
    const row = getDb(this.db).prepare('SELECT COUNT(*) as n FROM workflow_run_queue').get() as { n: number };
    return row.n;
  }

  async sizeFor(workflowId: string): Promise<number> {
    const row = getDb(this.db).prepare(
      'SELECT COUNT(*) as n FROM workflow_run_queue WHERE workflow_id = ?',
    ).get(workflowId) as { n: number };
    return row.n;
  }

  async listFor(workflowId: string): Promise<RunQueueEntry[]> {
    const rows = getDb(this.db).prepare(`
      SELECT * FROM workflow_run_queue WHERE workflow_id = ?
      ORDER BY priority DESC, queued_at ASC
    `).all(workflowId) as RunQueueRow[];
    return rows.map(rowToEntry);
  }

  async listAll(): Promise<RunQueueEntry[]> {
    const rows = getDb(this.db).prepare(
      'SELECT * FROM workflow_run_queue ORDER BY priority DESC, queued_at ASC',
    ).all() as RunQueueRow[];
    return rows.map(rowToEntry);
  }
}
