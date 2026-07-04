// SPDX-License-Identifier: MIT
/**
 * SQL adapters for the core run-substrate ports (Collaboration Phase 0).
 *
 * geneWeave stores runs in `user_runs` and run events in `user_run_events`. Until
 * Phase 0 those tables were geneWeave's OWN parallel implementation of the run
 * registry + run journal that also (separately) lived in `@weaveintel/collab`.
 * Phase 0 makes the journal/registry a single CONTRACT in `@weaveintel/core`
 * (`RunJournal` / `RunRegistry` ports). These adapters make geneWeave's SQL
 * tables conform to that one contract — so the platform has one interface with
 * two interchangeable backends (the in-memory KV adapter in core, and this SQL
 * one), each proven by the same `runJournalContract` conformance suite.
 *
 * --- For someone new to this ---
 * A "port" is an interface (a list of methods); an "adapter" is a concrete
 * implementation of it. Here the port says "a run journal can append an event
 * and read events after a cursor"; this adapter makes those calls run against
 * SQLite instead of a key-value store. Swapping storage no longer means
 * rewriting callers — they only ever see the port.
 */
import { newUUIDv7, type RunJournal, type RunEventEnvelope, type RunEventCursor } from '@weaveintel/core';
import type { UserRunEventRow } from './db-types/adapter-me.js';

/** The slice of the geneWeave DB adapter the run-substrate SQL adapters use. */
export interface RunSubstrateDb {
  appendUserRunEvent(event: { id: string; run_id: string; sequence: number; kind: string; payload: string }): Promise<void>;
  listUserRunEvents(runId: string, afterSequence?: number): Promise<UserRunEventRow[]>;
  deleteUserRunEvents(runId: string): Promise<number>;
}

function rowToEnvelope(row: UserRunEventRow): RunEventEnvelope {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* tolerate */ }
  return {
    runId: row.run_id,
    sequence: row.sequence,
    kind: row.kind,
    payload,
    ...(row.created_at ? { timestamp: Date.parse(row.created_at) } : {}),
  };
}

/**
 * SQL-backed {@link RunJournal} over `user_run_events`.
 *
 * Conforms to the core `RunJournal` port (proven by `runJournalContract`). The
 * underlying `appendUserRunEvent` is `INSERT OR IGNORE` on `UNIQUE(run_id,
 * sequence)`, so re-appending the same sequence is idempotent — matching the
 * executor's gap-free, exactly-once append guarantee.
 */
export function createSqlRunJournal(db: RunSubstrateDb): RunJournal {
  return {
    async append(envelope, opts) {
      if (opts?.expectedSequence !== undefined && envelope.sequence !== opts.expectedSequence) {
        throw new Error(`Run '${envelope.runId}' sequence conflict: expected ${opts.expectedSequence}, got ${envelope.sequence}`);
      }
      await db.appendUserRunEvent({
        id: newUUIDv7(),
        run_id: envelope.runId,
        sequence: envelope.sequence,
        kind: envelope.kind,
        payload: JSON.stringify(envelope.payload ?? {}),
      });
      return { sequence: envelope.sequence };
    },

    async readAfter(cursor: RunEventCursor, opts) {
      const rows = await db.listUserRunEvents(cursor.runId, cursor.afterSequence);
      const limit = opts?.limit ?? 100;
      return rows.slice(0, limit).map(rowToEnvelope);
    },

    async purgeRun(runId) {
      await db.deleteUserRunEvents(runId);
    },
  };
}
