/**
 * GeneWeave — DB-backed PayloadStore
 *
 * Implements `@weaveintel/workflows` `PayloadStore` over the SQLite
 * `workflow_payloads` table (created by migration M24).
 *
 * Each row stores one offloaded step output as JSON.  Rows are keyed by
 * `${runId}:${stepId}` matching the format used by the engine.
 */
import type { PayloadStore } from '@weaveintel/workflows';
import type { DatabaseAdapter } from '../db-types.js';

export class DbPayloadStore implements PayloadStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async put(key: string, data: unknown): Promise<void> {
    const [runId = '', stepId = ''] = key.split(':');
    const dataJson = JSON.stringify(data);
    const sql = `
      INSERT INTO workflow_payloads (key, run_id, step_id, data)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET data = excluded.data
    `;
    (this.db as unknown as { d: { prepare(s: string): { run(...args: unknown[]): void } } })
      .d.prepare(sql).run(key, runId, stepId, dataJson);
  }

  async get(key: string): Promise<unknown | undefined> {
    const row = (this.db as unknown as { d: { prepare(s: string): { get(...args: unknown[]): unknown } } })
      .d.prepare('SELECT data FROM workflow_payloads WHERE key = ?').get(key) as { data: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.data) as unknown;
  }

  async delete(key: string): Promise<void> {
    (this.db as unknown as { d: { prepare(s: string): { run(...args: unknown[]): void } } })
      .d.prepare('DELETE FROM workflow_payloads WHERE key = ?').run(key);
  }

  async deleteRun(runId: string): Promise<void> {
    (this.db as unknown as { d: { prepare(s: string): { run(...args: unknown[]): void } } })
      .d.prepare('DELETE FROM workflow_payloads WHERE run_id = ?').run(runId);
  }
}
