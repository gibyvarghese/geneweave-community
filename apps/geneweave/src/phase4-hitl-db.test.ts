/**
 * Phase 4 — HITL persistence: m93 run-scoped hitl_interrupt_requests +
 * saveChatSettings HITL toggles. Positive, negative, security.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { settingsFromRow } from './chat-runtime.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-phase4-hitl-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('Phase 4 — HITL settings + interrupt persistence', () => {
  let db: SQLiteAdapter;
  beforeEach(async () => {
    db = new SQLiteAdapter(tmpDb()); await db.initialize(); await db.seedDefaultData();
    await db.createUser({ id: 'u1', email: 'u1@x.dev', name: 'U1', passwordHash: 'x' });
    await db.createChat({ id: 'c1', userId: 'u1', title: 't', model: 'gpt-4o-mini', provider: 'openai' });
  });
  afterEach(async () => { await db.close(); });

  it('saveChatSettings persists + reflects the HITL toggles (positive)', async () => {
    await db.saveChatSettings({ chatId: 'c1', mode: 'agent', hitlEnabled: true, hitlRequireAll: true, hitlTimeoutMs: 60000 });
    const row = await db.getChatSettings('c1');
    expect(row!.hitl_enabled).toBe(1);
    expect(row!.hitl_require_all).toBe(1);
    expect(row!.hitl_timeout_ms).toBe(60000);
    const settings = settingsFromRow(row);
    expect(settings.hitlEnabled).toBe(true);
    expect(settings.hitlRequireAll).toBe(true);
  });

  it('defaults HITL off when not requested (negative)', async () => {
    await db.saveChatSettings({ chatId: 'c1', mode: 'agent' });
    const row = await db.getChatSettings('c1');
    expect(row!.hitl_enabled).toBe(0);
  });

  it('persists a pending interrupt, lists it by run, then resolves it', async () => {
    await db.createHitlInterrupt({ id: 'h1', chat_id: 'c1', run_id: 'run-1', agent_name: 'agent', tool_name: 'send_email', tool_args_json: '{"to":"x"}', reason: 'gated' });
    let pending = await db.listPendingHitlInterruptsByRun('run-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: 'h1', tool_name: 'send_email', status: 'pending' });

    await db.resolveHitlInterrupt('h1', { status: 'approved', decision_action: 'approve', decided_by: 'u1' });
    pending = await db.listPendingHitlInterruptsByRun('run-1');
    expect(pending).toHaveLength(0); // no longer pending
  });

  it('isolates pending approvals per run (security: no cross-run bleed)', async () => {
    await db.createHitlInterrupt({ id: 'hA', chat_id: 'c1', run_id: 'run-A', agent_name: 'a', tool_name: 't' });
    await db.createHitlInterrupt({ id: 'hB', chat_id: 'c1', run_id: 'run-B', agent_name: 'a', tool_name: 't' });
    expect(await db.listPendingHitlInterruptsByRun('run-A')).toHaveLength(1);
    expect(await db.listPendingHitlInterruptsByRun('run-B')).toHaveLength(1);
    await db.resolveHitlInterrupt('hA', { status: 'rejected', decision_action: 'reject' });
    expect(await db.listPendingHitlInterruptsByRun('run-A')).toHaveLength(0);
    expect(await db.listPendingHitlInterruptsByRun('run-B')).toHaveLength(1); // unaffected
  });
});
