/**
 * Example 140 — /api/me/runs executor + live SSE fan-out (SP3, server-side)
 *
 * Companion to example 139 (client-side detach/resume). This one drives the
 * *server-side* `MeRunExecutor` directly, in-process, with:
 *   - a tiny in-memory store (no SQLite),
 *   - a stub run-agent (no LLM, no network),
 *   - a fake SSE `ServerResponse` to observe live fan-out.
 *
 * It proves the SP3 contracts end-to-end without any external dependency:
 *   1. start() turns a pending run into run.started … run.completed with
 *      monotonic, gap-free sequences and a 'completed' status.
 *   2. An attached subscriber receives live post-attach events and the stream
 *      closes on the terminal event.
 *   3. Resume via a sequence cursor is gap-free + duplicate-free.
 *   4. cancel() halts the agent cooperatively (terminal run.cancelled, no more
 *      output), with exactly one terminal event.
 */

import assert from 'node:assert/strict';
import { MeRunExecutor, type MeRunAgent } from '@weaveintel/geneweave-api';

// ---------------------------------------------------------------------------
// Minimal in-memory store — just the methods the executor touches.
// ---------------------------------------------------------------------------

interface EventRow { id: string; run_id: string; sequence: number; kind: string; payload: string; created_at?: string }

function inMemoryStore() {
  const status = new Map<string, string>();
  const events = new Map<string, EventRow[]>();
  return {
    status,
    events,
    async updateUserRunStatus(id: string, _userId: string, s: string) { status.set(id, s); },
    async appendUserRunEvent(ev: EventRow) {
      const list = events.get(ev.run_id) ?? [];
      list.push({ ...ev, created_at: new Date().toISOString() });
      events.set(ev.run_id, list);
    },
    async listUserRunEvents(runId: string, afterSeq = -1) {
      return (events.get(runId) ?? []).filter((e) => e.sequence > afterSeq);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake SSE ServerResponse — records written frames.
// ---------------------------------------------------------------------------

function fakeSse() {
  const frames: string[] = [];
  let ended = false;
  const res = {
    write(chunk: string) { if (ended) return false; frames.push(chunk); return true; },
    end() { ended = true; },
    get writableEnded() { return ended; },
    get destroyed() { return false; },
  };
  const envelopes = () => frames
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6).trim()));
  return { res, envelopes, get ended() { return ended; } };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeout = 2000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > timeout) throw new Error('timeout'); await wait(5); }
}

async function main() {
  // ── 1. Lifecycle: start → run.started … run.completed ────────────────────
  {
    const store = inMemoryStore();
    const agent: MeRunAgent = async (_args, emit) => {
      await emit.text('Hello');
      await emit.text(' world');
    };
    const exec = new MeRunExecutor({ db: store as never, runAgent: agent });
    assert.equal(exec.canProduce, true, 'executor advertises producing capability');

    exec.start({ runId: 'r1', userId: 'u1', input: { text: 'hi' } });
    await until(() => (store.events.get('r1')?.some((e) => e.kind === 'run.completed')) ?? false);

    const evs = store.events.get('r1')!;
    assert.deepEqual(evs.map((e) => e.kind), ['run.started', 'text.delta', 'text.delta', 'run.completed']);
    assert.deepEqual(evs.map((e) => e.sequence), [0, 1, 2, 3], 'sequences are monotonic + gap-free');
    assert.equal(store.status.get('r1'), 'completed');
    console.log('  [1] lifecycle: run.started … run.completed, sequences 0..3, status completed ✓');
  }

  // ── 2. Live fan-out: attached subscriber sees post-attach events ─────────
  {
    const store = inMemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let armed!: () => void;
    const firstEmitted = new Promise<void>((r) => { armed = r; });
    const agent: MeRunAgent = async (_args, emit) => {
      await emit.text('A'); armed(); await gate; await emit.text('B');
    };
    const exec = new MeRunExecutor({ db: store as never, runAgent: agent });
    exec.start({ runId: 'r2', userId: 'u1', input: { text: 'hi' } });

    await firstEmitted;
    await until(() => (store.events.get('r2')?.length ?? 0) >= 2);

    // Attach from sequence 1 → only live events should arrive.
    const sse = fakeSse();
    const { subscriber } = exec.subscribe('r2', sse.res as never, 1, 'u1');
    for (const ev of await store.listUserRunEvents('r2', 1)) {
      subscriber.replay({ runId: 'r2', sequence: ev.sequence, kind: ev.kind, payload: JSON.parse(ev.payload), timestamp: Date.now() });
    }
    subscriber.activate();
    assert.equal(sse.envelopes().length, 0, 'nothing replayed after cursor');

    release();
    await until(() => sse.envelopes().some((e: any) => e.kind === 'run.completed'));
    assert.deepEqual(sse.envelopes().map((e: any) => e.sequence), [2, 3], 'live events 2,3 delivered post-attach');
    assert.equal(sse.ended, true, 'terminal event closed the stream');
    console.log('  [2] live fan-out: post-attach events 2,3 delivered, stream closed on terminal ✓');
  }

  // ── 3. Resumable: cursor replay is gap-free + duplicate-free ─────────────
  {
    const store = inMemoryStore();
    const agent: MeRunAgent = async (_args, emit) => { await emit.text('one'); await emit.text('two'); };
    const exec = new MeRunExecutor({ db: store as never, runAgent: agent });
    exec.start({ runId: 'r3', userId: 'u1', input: { text: 'hi' } });
    await until(() => (store.events.get('r3')?.some((e) => e.kind === 'run.completed')) ?? false);

    const sse = fakeSse();
    const { subscriber } = exec.subscribe('r3', sse.res as never, 1, 'u1');
    for (const ev of await store.listUserRunEvents('r3', 1)) {
      subscriber.replay({ runId: 'r3', sequence: ev.sequence, kind: ev.kind, payload: JSON.parse(ev.payload), timestamp: Date.now() });
    }
    assert.deepEqual(sse.envelopes().map((e: any) => e.sequence), [2, 3], 'resume from seq 1 yields 2,3 only');
    console.log('  [3] resume: cursor=1 → events 2,3 only (gap-free, no dupes) ✓');
  }

  // ── 4. Cancel: cooperative halt, exactly one terminal event ──────────────
  {
    const store = inMemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let armed!: () => void;
    const firstEmitted = new Promise<void>((r) => { armed = r; });
    const agent: MeRunAgent = async (_args, emit) => { await emit.text('A'); armed(); await gate; await emit.text('B'); };
    const exec = new MeRunExecutor({ db: store as never, runAgent: agent });
    exec.start({ runId: 'r4', userId: 'u1', input: { text: 'hi' } });
    await firstEmitted;

    const wasActive = exec.cancel('r4');
    assert.equal(wasActive, true, 'cancel aborts an active run');
    release();
    await until(() => (store.events.get('r4')?.some((e) => e.kind === 'run.cancelled')) ?? false);

    const kinds = store.events.get('r4')!.map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === 'run.cancelled').length, 1, 'exactly one terminal event');
    assert.equal(kinds.filter((k) => k === 'run.completed').length, 0, 'no completion after cancel');
    assert.equal(kinds.filter((k) => k === 'text.delta').length, 1, "post-cancel 'B' dropped");
    assert.equal(store.status.get('r4'), 'cancelled');
    console.log("  [4] cancel: cooperative halt, one run.cancelled, post-cancel output dropped ✓");
  }

  console.log('\n✅ Example 140 — /api/me/runs executor + live SSE fan-out: all assertions passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
