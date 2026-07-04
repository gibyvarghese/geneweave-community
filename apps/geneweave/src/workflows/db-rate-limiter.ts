/**
 * GeneWeave — DB-backed WorkflowRateLimiter
 *
 * Implements `@weaveintel/workflows` `WorkflowRateLimiter` over the SQLite
 * `workflow_rate_limits` table (created by migration M26).
 *
 * Token-bucket state (tokens + lastRefillMs) is persisted per workflow so
 * the rate limit survives process restarts.  SQLite's synchronous write model
 * makes the compare-and-update atomic for single-process deployments.
 */
import type { WorkflowRateLimiter } from '@weaveintel/workflows';
import type { DatabaseAdapter } from '../db-types.js';

interface RateLimitRow {
  workflow_id: string;
  tokens: number;
  last_refill_ms: number;
  updated_at: string;
}

type DB = { prepare(s: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown } };
function getDb(adapter: DatabaseAdapter): DB {
  return (adapter as unknown as { d: DB }).d;
}

function refill(tokens: number, lastRefillMs: number, maxPerMinute: number, nowMs: number): { tokens: number; lastRefillMs: number } {
  const elapsedMinutes = (nowMs - lastRefillMs) / 60_000;
  const refilled = Math.min(maxPerMinute, tokens + elapsedMinutes * maxPerMinute);
  return { tokens: refilled, lastRefillMs: nowMs };
}

export class DbWorkflowRateLimiter implements WorkflowRateLimiter {
  constructor(private readonly db: DatabaseAdapter) {}

  async allow(workflowId: string, maxRunsPerMinute: number): Promise<boolean> {
    const now = Date.now();
    const db = getDb(this.db);
    const existing = db.prepare(
      'SELECT * FROM workflow_rate_limits WHERE workflow_id = ?',
    ).get(workflowId) as RateLimitRow | undefined;

    const raw = existing
      ? { tokens: existing.tokens, lastRefillMs: existing.last_refill_ms }
      : { tokens: maxRunsPerMinute, lastRefillMs: now };

    const { tokens, lastRefillMs } = refill(raw.tokens, raw.lastRefillMs, maxRunsPerMinute, now);

    const updatedAt = new Date().toISOString();
    if (tokens < 1) {
      db.prepare(`
        INSERT INTO workflow_rate_limits (workflow_id, tokens, last_refill_ms, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workflow_id) DO UPDATE SET tokens = excluded.tokens, last_refill_ms = excluded.last_refill_ms, updated_at = excluded.updated_at
      `).run(workflowId, tokens, lastRefillMs, updatedAt);
      return false;
    }

    db.prepare(`
      INSERT INTO workflow_rate_limits (workflow_id, tokens, last_refill_ms, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET tokens = excluded.tokens, last_refill_ms = excluded.last_refill_ms, updated_at = excluded.updated_at
    `).run(workflowId, tokens - 1, lastRefillMs, updatedAt);
    return true;
  }

  async remaining(workflowId: string, maxRunsPerMinute: number): Promise<number> {
    const now = Date.now();
    const existing = getDb(this.db).prepare(
      'SELECT * FROM workflow_rate_limits WHERE workflow_id = ?',
    ).get(workflowId) as RateLimitRow | undefined;
    if (!existing) return maxRunsPerMinute;
    const { tokens } = refill(existing.tokens, existing.last_refill_ms, maxRunsPerMinute, now);
    return Math.floor(tokens);
  }

  async reset(workflowId: string): Promise<void> {
    getDb(this.db).prepare('DELETE FROM workflow_rate_limits WHERE workflow_id = ?').run(workflowId);
  }
}
