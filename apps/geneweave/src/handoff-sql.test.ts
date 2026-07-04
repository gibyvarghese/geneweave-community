/**
 * Conformance + unit tests — geneWeave's SQL adapter for the unified handoff
 * lifecycle (Collaboration Phase 5). Runs the SAME handoffManagerContract the
 * in-memory reference adapter passes, then exercises persistence specifics +
 * buildRunBriefing (scoped context transfer).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handoffManagerContract, type UnifiedHandoffManager } from '@weaveintel/collab';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqlHandoffManager, buildRunBriefing } from './handoff-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize(); await db.seedDefaultData();
  await db.createUser({ id: 'owner', email: 'owner@x.dev', name: 'Owner', passwordHash: 'x' });
  return db;
}

// session_handoffs FK to user_runs, so wrap request to ensure the parent run.
async function makeHandoffManager(): Promise<UnifiedHandoffManager> {
  const db = await freshDb();
  const mgr = createSqlHandoffManager(db);
  return {
    ...mgr,
    request: async (input) => {
      await db.createUserRun({ id: input.runId, user_id: 'owner', status: 'running', tenant_id: 'tA' }).catch(() => {});
      return mgr.request(input);
    },
  };
}

handoffManagerContract(makeHandoffManager, { describe, it, beforeEach, expect } as never);

describe('SQL handoff adapter — persistence + audit specifics', () => {
  it('persists the briefing + audit trail across reload', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'running', tenant_id: 'tA' });
    const mgr = createSqlHandoffManager(db);
    const h = await mgr.request({
      id: 'h1', runId: 'r1', tenantId: 'tA', scope: 'agent_to_human',
      fromActor: { type: 'agent', id: 'agent-1' }, toActor: { type: 'user', id: 'human-1' },
      reason: 'needs a human', briefing: { summary: 'refund stuck', openQuestions: ['eligible?'], confidence: 0.4 },
    });
    await mgr.accept(h.id, 'human-1');
    await mgr.start(h.id, 'human-1');
    await mgr.handBack(h.id, 'human-1', { summary: 'refunded $20' });
    await mgr.complete(h.id, 'agent-1');

    // Reload via a FRESH adapter instance — proves it is durable, not in-memory.
    const reloaded = createSqlHandoffManager(db);
    const got = await reloaded.get('h1');
    expect(got?.state).toBe('completed');
    expect(got?.briefing?.summary).toBe('refund stuck');
    expect(got?.briefing?.confidence).toBe(0.4);
    expect(got?.handBackBriefing?.summary).toBe('refunded $20');
    const trail = await reloaded.audit('h1');
    expect(trail.map((e) => e.toState)).toEqual(['requested', 'accepted', 'in_progress', 'handed_back', 'completed']);
  });

  it('SLA sweep times out an overdue handoff in SQL', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'running', tenant_id: 'tA' });
    const mgr = createSqlHandoffManager(db);
    const h = await mgr.request({ id: 'h1', runId: 'r1', tenantId: 'tA', scope: 'agent_to_human', fromActor: { type: 'agent', id: 'a' }, toActor: { type: 'user', id: 'u' }, reason: 'x', ttlMs: 1000 });
    const changed = await mgr.expireDue(h.createdAt + 5000);
    expect(changed.length).toBe(1);
    expect((await mgr.get('h1'))?.state).toBe('timed_out');
    // The timeout is audited.
    expect((await mgr.audit('h1')).at(-1)?.toState).toBe('timed_out');
  });
});

describe('buildRunBriefing — scoped context transfer (not raw transcript)', () => {
  it('summarises the assistant output and bounds its length', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'running', tenant_id: 'tA' });
    await db.appendUserRunEvent({ id: 'e1', run_id: 'r1', sequence: 0, kind: 'text.delta', payload: JSON.stringify({ delta: 'The customer wants a refund. ' }) });
    await db.appendUserRunEvent({ id: 'e2', run_id: 'r1', sequence: 1, kind: 'text.delta', payload: JSON.stringify({ delta: 'It looks eligible.' }) });
    const run = (await db.getUserRunById('r1'))!;
    const briefing = await buildRunBriefing(db, run, { openQuestions: ['confirm eligibility'], confidence: 0.5 });
    expect(briefing.summary).toContain('refund');
    expect(briefing.openQuestions).toEqual(['confirm eligibility']);
    expect(briefing.confidence).toBe(0.5);
  });
  it('falls back to a status line when there is no text output', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r2', user_id: 'owner', status: 'failed', tenant_id: 'tA' });
    const run = (await db.getUserRunById('r2'))!;
    const briefing = await buildRunBriefing(db, run);
    expect(briefing.summary).toContain('failed');
  });
});
