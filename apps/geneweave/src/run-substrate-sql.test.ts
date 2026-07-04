/**
 * Conformance test — geneWeave's SQL RunJournal adapter (Collaboration Phase 0).
 *
 * Runs the SAME `runJournalContract` from `@weaveintel/core` that the in-memory
 * KV adapter passes, against the SQL adapter backed by `user_run_events`. This is
 * the proof that geneWeave's storage and the core reference adapter are truly
 * interchangeable behind the one `RunJournal` port — i.e. geneWeave "runs through
 * the core interface" with the same observable behaviour.
 *
 * `user_run_events.run_id` has a FK to `user_runs` (ON DELETE CASCADE), so each
 * fresh journal seeds its parent runs; a fresh in-memory DB per test isolates
 * sequences (UNIQUE(run_id, sequence)).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runJournalContract, type RunJournal } from '@weaveintel/core';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqlRunJournal } from './run-substrate-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-runsub-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// The runIds the journal contract appends to (parents must exist for the FK).
const PARENT_RUNS = ['r1', 'rA', 'rB'];

async function makeJournal(): Promise<RunJournal> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  await db.createUser({ id: 'u1', email: 'u1@x.dev', name: 'U1', passwordHash: 'x' });
  for (const id of PARENT_RUNS) {
    await db.createUserRun({ id, user_id: 'u1', status: 'running', tenant_id: 'tA', surface: 'web' });
  }
  return createSqlRunJournal(db);
}

// Every adapter passes the same suite — this is the SQL one.
runJournalContract(makeJournal, { describe, it, beforeEach, expect } as unknown as Parameters<typeof runJournalContract>[1]);

// SQL-specific: idempotent append (INSERT OR IGNORE on UNIQUE(run_id,sequence)).
describe('SqlRunJournal — geneWeave specifics', () => {
  it('re-appending the same sequence is idempotent (matches the executor)', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize(); await db.seedDefaultData();
    await db.createUser({ id: 'u1', email: 'u1@x.dev', name: 'U1', passwordHash: 'x' });
    await db.createUserRun({ id: 'r1', user_id: 'u1', status: 'running' });
    const jr = createSqlRunJournal(db);
    await jr.append({ runId: 'r1', sequence: 0, kind: 'text.delta', payload: { a: 1 } } as never);
    await jr.append({ runId: 'r1', sequence: 0, kind: 'text.delta', payload: { a: 2 } } as never); // dup seq → ignored
    const events = await jr.readAfter({ runId: 'r1', afterSequence: -1 });
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { a: number }).a).toBe(1); // first write wins
    await db.close();
  });
});
