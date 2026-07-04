/**
 * Phase 4 — RunApprovalCoordinator: the full pause → decide → resume cycle.
 *
 * Drives the REAL agent interrupt handler (createHumanTaskInterruptHandler)
 * against the run-aware queue, asserting the handler suspends until a posted
 * decision resolves it — emitting approval.request/approval.resolved and
 * persisting to the (mocked) HITL store. Positive, negative, security, stress.
 */
import { describe, it, expect, vi } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { createHumanTaskInterruptHandler } from '@weaveintel/agents';
import type { InterruptEvent } from '@weaveintel/agents';
import { RunApprovalCoordinator } from './me-run-approvals.js';

function mkEvent(tool = 'send_email'): InterruptEvent {
  return { type: 'tool_approval', toolName: tool, toolArgs: { to: 'x@y.dev' }, reason: 'gated tool', agentStep: 0, agentName: 'agent' };
}
function setup() {
  const emit = vi.fn(async () => {});
  const db = { createHitlInterrupt: vi.fn(async () => {}), resolveHitlInterrupt: vi.fn(async () => {}) };
  const coord = new RunApprovalCoordinator();
  coord.registerRun('run1', emit, db);
  coord.setRunChat('run1', 'chat1');
  const ctx = weaveContext({ userId: 'u1', metadata: { runId: 'run1' } });
  return { emit, db, coord, ctx };
}
function lastRequestTaskId(emit: ReturnType<typeof vi.fn>): string {
  const call = [...emit.mock.calls].reverse().find((c) => c[0] === 'approval.request');
  return (call?.[1] as { taskId: string }).taskId;
}

describe('RunApprovalCoordinator — pause/resume cycle', () => {
  it('approve resumes the agent with action=approve (positive, end-to-end)', async () => {
    const { emit, db, coord, ctx } = setup();
    const handler = createHumanTaskInterruptHandler(coord.queueFor('run1')!, { timeoutMs: 5000, pollIntervalMs: 5 });
    const resolutionP = handler(ctx, mkEvent());
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('approval.request', expect.objectContaining({ toolName: 'send_email' })));
    const taskId = lastRequestTaskId(emit);
    expect(db.createHitlInterrupt).toHaveBeenCalledTimes(1);

    expect(await coord.resolve(taskId, 'approve')).toBe(true);
    const resolution = await resolutionP;
    expect(resolution.action).toBe('approve');
    expect(emit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({ taskId, action: 'approve' }));
    expect(db.resolveHitlInterrupt).toHaveBeenCalledWith(taskId, expect.objectContaining({ status: 'approved', decision_action: 'approve' }));
  });

  it('reject resumes with action=reject (negative path)', async () => {
    const { emit, coord, ctx } = setup();
    const handler = createHumanTaskInterruptHandler(coord.queueFor('run1')!, { timeoutMs: 5000, pollIntervalMs: 5 });
    const resolutionP = handler(ctx, mkEvent());
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('approval.request', expect.anything()));
    const taskId = lastRequestTaskId(emit);
    expect(await coord.resolve(taskId, 'reject', { feedback: 'no' })).toBe(true);
    expect((await resolutionP).action).toBe('reject');
  });

  it('modify resumes with the modified args', async () => {
    const { emit, coord, ctx } = setup();
    const handler = createHumanTaskInterruptHandler(coord.queueFor('run1')!, { timeoutMs: 5000, pollIntervalMs: 5 });
    const resolutionP = handler(ctx, mkEvent());
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('approval.request', expect.anything()));
    const taskId = lastRequestTaskId(emit);
    await coord.resolve(taskId, 'modify', { modifiedArgs: { to: 'safe@y.dev' } });
    const r = await resolutionP;
    expect(r.action).toBe('modify');
    expect(r.modifiedArgs).toEqual({ to: 'safe@y.dev' });
  });
});

describe('RunApprovalCoordinator — negative / security', () => {
  it('resolve for an unknown task returns false', async () => {
    const { coord } = setup();
    expect(await coord.resolve('nope', 'approve')).toBe(false);
  });

  it('queueFor an unregistered run is null (no cross-run leakage)', () => {
    const { coord } = setup();
    expect(coord.queueFor('other-run')).toBeNull();
  });

  it('a second decision for the same task is rejected (no double-resolve)', async () => {
    const { emit, coord, ctx } = setup();
    const handler = createHumanTaskInterruptHandler(coord.queueFor('run1')!, { timeoutMs: 5000, pollIntervalMs: 5 });
    const resolutionP = handler(ctx, mkEvent());
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('approval.request', expect.anything()));
    const taskId = lastRequestTaskId(emit);
    expect(await coord.resolve(taskId, 'approve')).toBe(true);
    await resolutionP;
    expect(await coord.resolve(taskId, 'reject')).toBe(false); // already resolved
  });

  it('unregisterRun drops the run so later resolves fail closed', async () => {
    const { emit, coord, ctx } = setup();
    const handler = createHumanTaskInterruptHandler(coord.queueFor('run1')!, { timeoutMs: 1000, pollIntervalMs: 5 });
    const resolutionP = handler(ctx, mkEvent());
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('approval.request', expect.anything()));
    const taskId = lastRequestTaskId(emit);
    coord.unregisterRun('run1');
    expect(await coord.resolve(taskId, 'approve')).toBe(false);
    await resolutionP; // times out → reject (handler still settles)
  });
});

describe('RunApprovalCoordinator — stress (concurrent approvals)', () => {
  it('resolves 10 concurrent run approvals independently', async () => {
    const coord = new RunApprovalCoordinator();
    const handlers: Array<Promise<{ action: string }>> = [];
    const emits: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < 10; i++) {
      const emit = vi.fn(async () => {});
      emits.push(emit);
      coord.registerRun(`run${i}`, emit);
      coord.setRunChat(`run${i}`, `chat${i}`);
      const ctx = weaveContext({ userId: 'u1', metadata: { runId: `run${i}` } });
      handlers.push(createHumanTaskInterruptHandler(coord.queueFor(`run${i}`)!, { timeoutMs: 5000, pollIntervalMs: 5 })(ctx, mkEvent()));
    }
    await vi.waitFor(() => emits.forEach((e) => expect(e).toHaveBeenCalledWith('approval.request', expect.anything())));
    for (let i = 0; i < 10; i++) {
      const taskId = lastRequestTaskId(emits[i]!);
      await coord.resolve(taskId, i % 2 === 0 ? 'approve' : 'reject');
    }
    const results = await Promise.all(handlers);
    expect(results.filter((r) => r.action === 'approve')).toHaveLength(5);
    expect(results.filter((r) => r.action === 'reject')).toHaveLength(5);
  });
});
