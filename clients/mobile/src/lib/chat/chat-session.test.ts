/**
 * chat-session.test.ts — Node unit + golden tests for the pure chat session.
 *
 * No React / React Native / expo: the whole controller runs in Node with a
 * fake run client that lets the test drive SSE envelopes by hand.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RunEventEnvelope, RunStatus, RunViewModel } from '@weaveintel/api-client';
import {
  createChatSession,
  type ChatRunClient,
  type AssistantEntry,
} from './chat-session.js';

// ---------------------------------------------------------------------------
// Fake run client — records attach handlers so the test can push envelopes.
// ---------------------------------------------------------------------------

interface Attachment {
  runId: string;
  afterSequence: number;
  onEvent: (env: RunEventEnvelope) => void;
  onComplete?: (m: RunViewModel) => void;
  onError?: (e: Error) => void;
  detached: boolean;
}

function fakeClient() {
  let nextRun = 0;
  const attachments: Attachment[] = [];
  const cancelled: string[] = [];
  const startCalls: Array<{ idempotencyKey: string; input?: Record<string, unknown> }> = [];
  const postedEvents: Array<{ runId: string; kind?: string; payload?: Record<string, unknown> }> = [];
  let postEventImpl: (runId: string) => Promise<{ sequence: number }> = async () => ({ sequence: 1 });

  const client: ChatRunClient = {
    async startRun(input) {
      startCalls.push({ idempotencyKey: input.idempotencyKey, input: input.input });
      nextRun += 1;
      return { id: `run-${nextRun}`, status: 'pending' as RunStatus };
    },
    async cancelRun(id) {
      cancelled.push(id);
      return 'cancelled' as RunStatus;
    },
    async postEvent(runId, event) {
      postedEvents.push({ runId, ...event });
      return postEventImpl(runId);
    },
    attachRun(runId, opts) {
      const att: Attachment = {
        runId,
        afterSequence: opts.afterSequence ?? -1,
        onEvent: opts.onEvent ?? (() => {}),
        ...(opts.onComplete ? { onComplete: opts.onComplete } : {}),
        ...(opts.onError ? { onError: opts.onError } : {}),
        detached: false,
      };
      attachments.push(att);
      return {
        detach() {
          att.detached = true;
        },
      };
    },
  };

  /** Latest live (non-detached) attachment for a run. */
  const liveAttach = (runId: string): Attachment | undefined =>
    [...attachments].reverse().find((a) => a.runId === runId && !a.detached);

  /** Override the postEvent resolution (e.g. to reject). */
  const setPostEventImpl = (fn: (runId: string) => Promise<{ sequence: number }>): void => {
    postEventImpl = fn;
  };

  return { client, attachments, cancelled, startCalls, postedEvents, liveAttach, setPostEventImpl };
}

const ev = (runId: string, sequence: number, kind: string, payload: Record<string, unknown> = {}): RunEventEnvelope => ({
  runId,
  sequence,
  kind,
  payload,
  timestamp: 1000 + sequence,
});

function idFactory() {
  let n = 0;
  return () => `id-${++n}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat session', () => {
  it('send appends a user entry + assistant run and streams text to completion', async () => {
    const f = fakeClient();
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k1', newId: idFactory(), now: () => 1 });

    s.setComposerText('Hello there');
    await s.send();

    // user + assistant entries, composer cleared, streaming.
    let st = s.getState();
    expect(st.entries).toHaveLength(2);
    expect(st.entries[0]).toMatchObject({ kind: 'user', text: 'Hello there' });
    expect(st.composerText).toBe('');
    expect(st.phase).toBe('streaming');
    expect(st.activeRunId).toBe('run-1');
    expect(f.startCalls[0]?.input).toEqual({ text: 'Hello there' });

    const a = f.liveAttach('run-1')!;
    a.onEvent(ev('run-1', 0, 'run.started'));
    a.onEvent(ev('run-1', 1, 'text.delta', { delta: 'Hi ' }));
    a.onEvent(ev('run-1', 2, 'text.delta', { delta: 'friend' }));
    a.onEvent(ev('run-1', 3, 'run.completed'));

    st = s.getState();
    const assistant = st.entries[1] as AssistantEntry;
    expect(assistant.model.fullText).toBe('Hi friend');
    expect(assistant.model.status).toBe('completed');
    expect(st.phase).toBe('idle');
    expect(st.activeRunId).toBeNull();
  });

  it('does not start a second run while one is producing', async () => {
    const f = fakeClient();
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k', newId: idFactory() });
    await s.send('first');
    await s.send('second'); // ignored — still streaming
    expect(f.startCalls).toHaveLength(1);
    expect(s.getState().entries.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('stop cancels the active run within the same tick and reflects locally', async () => {
    const f = fakeClient();
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k', newId: idFactory() });
    await s.send('long task');
    const a = f.liveAttach('run-1')!;
    a.onEvent(ev('run-1', 0, 'run.started'));
    a.onEvent(ev('run-1', 1, 'text.delta', { delta: 'working' }));

    await s.stop();

    expect(f.cancelled).toEqual(['run-1']);
    expect(a.detached).toBe(true);
    const st = s.getState();
    expect(st.phase).toBe('idle');
    expect(st.activeRunId).toBeNull();
    expect((st.entries[1] as AssistantEntry).model.status).toBe('cancelled');
  });

  it('GOLDEN: kill mid-run → resume from cursor with zero gap and zero dupe', async () => {
    let nowMs = 0;
    let fired: (() => void) | null = null;
    const f = fakeClient();
    const s = createChatSession({
      client: f.client,
      idempotencyKey: () => 'k',
      newId: idFactory(),
      now: () => nowMs,
      detachAfterMs: 20_000,
      setTimer: (fn) => {
        fired = fn;
        return 1;
      },
      clearTimer: () => {
        fired = null;
      },
    });

    await s.send('stream please');
    const a1 = f.liveAttach('run-1')!;
    a1.onEvent(ev('run-1', 0, 'run.started'));
    a1.onEvent(ev('run-1', 1, 'text.delta', { delta: 'Hello ' }));
    a1.onEvent(ev('run-1', 2, 'text.delta', { delta: 'world' }));

    // App backgrounds; the detach timer fires (simulated kill of the stream).
    s.onBackground();
    nowMs = 21_000;
    expect(fired).toBeTypeOf('function');
    fired!();
    expect(a1.detached).toBe(true);
    expect(s.getState().runningInBackground).toBe(true);

    // App foregrounds — re-attach must resume from the last seen sequence (2).
    s.onForeground();
    const a2 = f.liveAttach('run-1')!;
    expect(a2).toBeDefined();
    expect(a2.afterSequence).toBe(2);
    expect(s.getState().runningInBackground).toBe(false);

    // Server replays from > 2 (no re-delivery of 0..2); a duplicate seq 2 is
    // ignored by the reducer.
    a2.onEvent(ev('run-1', 2, 'text.delta', { delta: 'DUPLICATE' }));
    a2.onEvent(ev('run-1', 3, 'text.delta', { delta: '!' }));
    a2.onEvent(ev('run-1', 4, 'run.completed'));

    const assistant = s.getState().entries[1] as AssistantEntry;
    expect(assistant.model.fullText).toBe('Hello world!'); // no gap, no dupe
    expect(assistant.model.status).toBe('completed');
    expect(s.getState().phase).toBe('idle');
  });

  it('edit-and-resend supersedes the original and starts a new run', async () => {
    const f = fakeClient();
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k', newId: idFactory() });
    await s.send('teh quick fox');
    // Finish the first run so the session is idle.
    const a1 = f.liveAttach('run-1')!;
    a1.onEvent(ev('run-1', 0, 'run.started'));
    a1.onEvent(ev('run-1', 1, 'run.completed'));

    const originalUser = s.getState().entries.find((e) => e.kind === 'user')!;
    await s.editAndResend(originalUser.id, 'the quick fox');

    const st = s.getState();
    const supersededOriginal = st.entries.find((e) => e.kind === 'user' && e.id === originalUser.id);
    expect(supersededOriginal).toMatchObject({ supersededByRunId: 'run-2' });
    expect(f.startCalls).toHaveLength(2);
    expect(f.startCalls[1]?.input).toEqual({ text: 'the quick fox' });
  });

  it('regenerate re-runs the prompt that produced an assistant entry', async () => {
    const f = fakeClient();
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k', newId: idFactory() });
    await s.send('explain X');
    const a1 = f.liveAttach('run-1')!;
    a1.onEvent(ev('run-1', 0, 'run.completed'));

    const assistant = s.getState().entries.find((e) => e.kind === 'assistant')! as AssistantEntry;
    await s.regenerate(assistant.id);

    expect(f.startCalls).toHaveLength(2);
    expect(f.startCalls[1]?.input).toEqual({ text: 'explain X' });
  });

  it('attachExisting resumes a deep-linked run from a cursor', () => {
    const f = fakeClient();
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k', newId: idFactory() });
    s.attachExisting('run-deep', 5);
    const a = f.liveAttach('run-deep')!;
    expect(a.afterSequence).toBe(5);
    expect(s.getState().activeRunId).toBe('run-deep');
    a.onEvent(ev('run-deep', 6, 'text.delta', { delta: 'resumed' }));
    a.onEvent(ev('run-deep', 7, 'run.completed'));
    const assistant = s.getState().entries.find((e) => e.kind === 'assistant')! as AssistantEntry;
    expect(assistant.model.fullText).toBe('resumed');
    expect(assistant.model.status).toBe('completed');
  });

  it('start failure surfaces an error and returns to idle', async () => {
    const f = fakeClient();
    f.client.startRun = vi.fn(async () => {
      throw new Error('network down');
    });
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k', newId: idFactory() });
    await s.send('hi');
    const st = s.getState();
    expect(st.error).toBe('network down');
    expect(st.phase).toBe('idle');
    expect(st.activeRunId).toBeNull();
  });

  it('stamps per-send run metadata (mode/model/token hints) onto startRun', async () => {
    const f = fakeClient();
    const startSpy = vi.fn(f.client.startRun);
    f.client.startRun = startSpy;
    const s = createChatSession({
      client: f.client,
      idempotencyKey: () => 'k',
      newId: idFactory(),
      runMetadata: () => ({ mode: 'research', model: 'gpt-4o-mini' }),
    });
    await s.send('hi');
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { mode: 'research', model: 'gpt-4o-mini' } }),
    );
  });

  it('omits metadata when the provider returns nothing', async () => {
    const f = fakeClient();
    const startSpy = vi.fn(f.client.startRun);
    f.client.startRun = startSpy;
    const s = createChatSession({
      client: f.client,
      idempotencyKey: () => 'k',
      newId: idFactory(),
      runMetadata: () => undefined,
    });
    await s.send('hi');
    expect(startSpy.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
  });

  it('does not arm the detach timer when no run is producing', () => {
    let armed = false;
    const f = fakeClient();
    const s = createChatSession({
      client: f.client,
      idempotencyKey: () => 'k',
      newId: idFactory(),
      setTimer: () => {
        armed = true;
        return 1;
      },
      clearTimer: () => {},
    });
    s.onBackground();
    expect(armed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Widget actions (M5)
// ---------------------------------------------------------------------------

describe('chat session — widget actions', () => {
  async function streamingSession() {
    const f = fakeClient();
    const s = createChatSession({ client: f.client, idempotencyKey: () => 'k', newId: idFactory(), now: () => 1 });
    await s.send('approve please');
    const a = f.liveAttach('run-1')!;
    a.onEvent(ev('run-1', 0, 'run.started'));
    a.onEvent(ev('run-1', 1, 'widget.update', { id: 'w1', type: 'approval', data: { description: 'do it' } }));
    return { f, s, a };
  }

  it('optimistically marks a widget pending and posts a widget.action event', async () => {
    const { f, s } = await streamingSession();

    await s.submitWidgetAction('run-1', 'w1', 'approve', { note: 'ok' });

    expect(s.getState().pendingWidgetActions).toEqual({ w1: 'approve' });
    expect(f.postedEvents).toEqual([
      { runId: 'run-1', kind: 'widget.action', payload: { widgetId: 'w1', actionId: 'approve', value: { note: 'ok' } } },
    ]);
    expect(s.getState().error).toBeNull();
  });

  it('ignores a second action while one is in flight for the same widget', async () => {
    const { f, s } = await streamingSession();
    await s.submitWidgetAction('run-1', 'w1', 'approve');
    await s.submitWidgetAction('run-1', 'w1', 'deny');
    expect(f.postedEvents).toHaveLength(1);
    expect(s.getState().pendingWidgetActions).toEqual({ w1: 'approve' });
  });

  it('reconciles (clears pending) when the server re-emits the widget', async () => {
    const { s, a } = await streamingSession();
    await s.submitWidgetAction('run-1', 'w1', 'approve');
    expect(s.getState().pendingWidgetActions).toEqual({ w1: 'approve' });

    a.onEvent(ev('run-1', 2, 'widget.update', { id: 'w1', type: 'approval', data: { description: 'approved', resolved: true } }));

    expect(s.getState().pendingWidgetActions).toEqual({});
  });

  it('rolls back the optimistic flag and surfaces the error when the post fails', async () => {
    const { f, s } = await streamingSession();
    f.setPostEventImpl(async () => {
      throw new Error('network down');
    });

    await s.submitWidgetAction('run-1', 'w1', 'approve');

    expect(s.getState().pendingWidgetActions).toEqual({});
    expect(s.getState().error).toBe('network down');
  });
});

