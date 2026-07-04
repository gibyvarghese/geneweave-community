/**
 * GeneWeave — guardrail-revision-store.ts
 *
 * SQLite-backed implementation of `GuardrailRevisionStore` (W7).
 * Adapts the DatabaseAdapter's new revision CRUD methods to the package
 * interface so `trackGuardrailChange` can persist revisions durably.
 *
 * Every guardrail create / update / delete in the admin API calls
 * `trackGuardrailChange`, which:
 *   1. Persists a `guardrail_revisions` row via this store.
 *   2. Emits a `weaveAudit` entry into the durable KV audit log.
 *
 * Use `listGuardrailRevisions` to replay the full change history for a rule,
 * or `getGuardrailRevisionAtTime` to reconstruct its state at any past time.
 */
import type { ExecutionContext, GuardrailRevision, GuardrailRevisionStore } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';
import { trackGuardrailChange, type TrackGuardrailChangeOptions } from '@weaveintel/guardrails';

export class SqliteGuardrailRevisionStore implements GuardrailRevisionStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async record(revision: GuardrailRevision): Promise<void> {
    await this.db.createGuardrailRevision({
      id: revision.id,
      guardrail_id: revision.guardrailId,
      version: revision.version,
      snapshot: JSON.stringify(revision.snapshot),
      before: revision.before !== undefined ? JSON.stringify(revision.before) : null,
      actor: revision.actor,
      reason: revision.reason,
      created_at: revision.timestamp, // use JS timestamp for consistent ISO ordering
    });
  }

  async list(guardrailId: string): Promise<GuardrailRevision[]> {
    const rows = await this.db.listGuardrailRevisions(guardrailId);
    return rows.map(r => ({
      id: r.id,
      guardrailId: r.guardrail_id,
      version: r.version,
      snapshot: JSON.parse(r.snapshot) as GuardrailRevision['snapshot'],
      before: r.before !== null ? JSON.parse(r.before) as GuardrailRevision['before'] : undefined,
      actor: r.actor,
      reason: r.reason,
      timestamp: r.created_at,
    }));
  }

  async atTime(guardrailId: string, timestamp: string): Promise<GuardrailRevision | undefined> {
    const row = await this.db.getGuardrailRevisionAtTime(guardrailId, timestamp);
    if (!row) return undefined;
    return {
      id: row.id,
      guardrailId: row.guardrail_id,
      version: row.version,
      snapshot: JSON.parse(row.snapshot) as GuardrailRevision['snapshot'],
      before: row.before !== null ? JSON.parse(row.before) as GuardrailRevision['before'] : undefined,
      actor: row.actor,
      reason: row.reason,
      timestamp: row.created_at,
    };
  }
}

export function createSqliteRevisionStore(db: DatabaseAdapter): SqliteGuardrailRevisionStore {
  return new SqliteGuardrailRevisionStore(db);
}

/**
 * Convenience wrapper: record a guardrail change to both the revision store
 * and the durable audit log. This is the single call site for admin mutations.
 */
export async function recordGuardrailChange(
  store: GuardrailRevisionStore,
  ctx: ExecutionContext,
  opts: TrackGuardrailChangeOptions,
): Promise<void> {
  await trackGuardrailChange(store, ctx, opts);
}
