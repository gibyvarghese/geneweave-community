/**
 * Conformance test — geneWeave's SQL PresenceManager adapter (Collaboration Phase 1).
 *
 * Runs the SAME `presenceManagerContract` from `@weaveintel/collab` that
 * the in-memory reference adapter passes, against the SQL adapter backed by the
 * `run_presence` table — proving geneWeave's presence storage is interchangeable
 * behind the one port. Plus the agent-as-peer synthesis helper.
 *
 * `run_presence.run_id` has a FK to `user_runs`, so each harness seeds its parent
 * runs; a fresh in-memory DB per test isolates state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { presenceManagerContract, type PresenceHarness } from '@weaveintel/collab';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqlPresenceManager, withAgentPeer } from './presence-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-presence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// The contract uses run-1 (tenant tA) and run-2 (tenant tB); both must exist (FK).
async function makeHarness(): Promise<PresenceHarness> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize();
  await db.seedDefaultData();
  await db.createUser({ id: 'u1', email: 'u1@x.dev', name: 'U1', passwordHash: 'x' });
  await db.createUserRun({ id: 'run-1', user_id: 'u1', status: 'running', tenant_id: 'tA' });
  await db.createUserRun({ id: 'run-2', user_id: 'u1', status: 'running', tenant_id: 'tB' });
  let clock = 1_000_000;
  const mgr = createSqlPresenceManager(db, { ttlMs: 30_000, now: () => clock });
  return { mgr, tick: (ms) => { clock += ms; } };
}

presenceManagerContract(makeHarness, { describe, it, beforeEach, expect } as unknown as Parameters<typeof presenceManagerContract>[1]);

describe('SqlPresenceManager — geneWeave specifics', () => {
  it('persists cursor + color and reads them back', async () => {
    const db = new SQLiteAdapter(tmpDb());
    await db.initialize(); await db.seedDefaultData();
    await db.createUser({ id: 'u1', email: 'u1@x.dev', name: 'U1', passwordHash: 'x' });
    await db.createUserRun({ id: 'run-1', user_id: 'u1', status: 'running', tenant_id: 'tA' });
    const mgr = createSqlPresenceManager(db);
    await mgr.heartbeat({ runId: 'run-1', tenantId: 'tA' }, { userId: 'u1', displayName: 'Alice', presence: 'typing', color: '#f00', cursor: { line: 3 } });
    const list = await mgr.list({ runId: 'run-1', tenantId: 'tA' });
    expect(list[0]).toMatchObject({ color: '#f00', cursor: { line: 3 }, presence: 'typing' });
    await db.close();
  });
});

describe('withAgentPeer — agent-as-peer synthesis', () => {
  it('adds an agent peer only while the run is running + enabled', () => {
    expect(withAgentPeer([], 'running', true).map((p) => p.userId)).toEqual(['__agent']);
    expect(withAgentPeer([], 'completed', true)).toEqual([]);   // not while terminal
    expect(withAgentPeer([], 'running', false)).toEqual([]);    // not when disabled
  });
  it('does not duplicate an existing agent peer', () => {
    const existing = [{ userId: '__agent', displayName: 'Agent', presence: 'working', peerType: 'agent' as const }];
    expect(withAgentPeer(existing, 'running', true).length).toBe(1);
  });
});
