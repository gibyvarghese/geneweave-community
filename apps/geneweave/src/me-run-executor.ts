/**
 * /api/me run executor + live SSE fan-out (SP3)
 *
 * Turns a `pending` user run into a *producing* run: it dispatches the run
 * through a pluggable agent function, persists every lifecycle event as an
 * ordered `user_run_events` row via `appendUserRunEvent`, flips run status via
 * `updateUserRunStatus`, and fans the same envelopes out live to every
 * attached SSE subscriber.
 *
 * Design contracts (durable):
 *   - Event sequences are gap-free and monotonic per run. All appends go
 *     through `appendEvent`, which is serialized per-run so concurrent writers
 *     (executor + client-posted events) never collide on a sequence number.
 *   - Exactly one terminal event per run. `appendEvent` is idempotent for
 *     terminal kinds, so an executor-driven completion and an operator-driven
 *     cancel can race without producing a duplicate terminal envelope.
 *   - Live fan-out is resumable + gap-free. A subscriber buffers live events
 *     while the initial DB replay catches up, then flushes; dedup-by-sequence
 *     makes replay/live overlap safe.
 *   - Graceful by construction. Executor failure emits a terminal `run.failed`
 *     event + status (it never crashes the process); fan-out errors are
 *     best-effort and swallowed.
 *
 * Vocabulary: no "chat", "conversation", "message" (HTTP sense), "turn".
 */

import { newUUIDv7, createLogger, weaveContext, formatSseFrame } from '@weaveintel/core';
import type { ExecutionContext, RunEventEnvelope, RunStep, RunUsage, RunCitation, RunArtifactRef, RunFilePart } from '@weaveintel/core';

const logger = createLogger('me-run-executor');
import type { ServerResponse } from 'node:http';
import type { DatabaseAdapter } from './db-types.js';
import { runApprovals } from './me-run-approvals.js';

// ─── Envelope ───────────────────────────────────────────────────────────────
// Canonical contract from @weaveintel/core (Client Phase 0) — the same type the
// browser client reducer consumes, so producer and consumer can never drift.
// Re-exported so existing `from './me-run-executor.js'` import sites keep working.
export type { RunEventEnvelope };

/** Event kinds that close a run. */
const TERMINAL_EVENT_KINDS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
/** Run statuses that are terminal. */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

// ─── Agent contract ─────────────────────────────────────────────────────────

/**
 * Emitter handed to a run-agent so it can stream domain output without knowing
 * about sequencing, persistence, or fan-out. Every method maps onto the
 * client reducer's event kinds (`text.delta`, `tool.invoked`, ...).
 */
export interface MeRunEmitter {
  text(delta: string, role?: string): Promise<void>;
  toolInvoked(tool: string, args?: Record<string, unknown>, toolCallId?: string): Promise<void>;
  toolCompleted(tool: string, result: unknown, toolCallId?: string): Promise<void>;
  toolErrored(tool: string, error: string, toolCallId?: string): Promise<void>;
  widget(id: string, payload: Record<string, unknown>, schemaVersion?: number): Promise<void>;
  // Phase 2 — streaming partial tool input (per-part state machine).
  /** A tool call's input args begin streaming. */
  toolInputStart(toolCallId: string, tool: string): Promise<void>;
  /** A partial chunk of a tool call's input args (JSON text). */
  toolInputDelta(toolCallId: string, delta: string): Promise<void>;
  // Phase 1 — parity: previously these channels were dropped by the bridge.
  /** Model thinking, as a DISTINCT channel (not folded into `text`). */
  reasoning(delta: string): Promise<void>;
  /** An agent / supervisor plan step. */
  step(step: RunStep): Promise<void>;
  /** Token usage / cost / latency / model for the run (from the chat `done` frame). */
  usage(usage: RunUsage): Promise<void>;
  /** A source / citation surfaced during the run. */
  citation(citation: RunCitation): Promise<void>;
  /** An artifact reference produced by the run. */
  artifact(artifact: RunArtifactRef): Promise<void>;
  /** A non-output diagnostic (guardrail / policy / eval / cognitive / ensemble). */
  diagnostic(channel: string, data?: unknown): Promise<void>;
  // Phase 7 — structured object streaming + multimodal file parts.
  /** An incremental chunk of a streamed structured (JSON) object. */
  objectDelta(delta: string): Promise<void>;
  /** The structured object finished (carries the final value, when parsed). */
  objectComplete(value?: unknown): Promise<void>;
  /** A multimodal file part (image / document) in/out of the run. */
  file(part: RunFilePart): Promise<void>;
}

export interface MeRunAgentArgs {
  ctx: ExecutionContext;
  userId: string;
  runId: string;
  surface: string | undefined;
  input: Record<string, unknown>;
  metadata: Record<string, unknown> | undefined;
  /** Aborted when the run is cancelled. Agents must check it cooperatively. */
  signal: AbortSignal;
}

/**
 * A run-agent dispatches the actual work and streams output through `emit`.
 * The executor owns lifecycle (`run.started` / terminal events + status); the
 * agent only emits domain output and must honour `args.signal`.
 */
export type MeRunAgent = (args: MeRunAgentArgs, emit: MeRunEmitter) => Promise<void>;

export interface MeRunStartArgs {
  runId: string;
  userId: string;
  tenantId?: string | null;
  persona?: string | undefined;
  surface?: string | undefined;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown> | undefined;
}

// ─── SSE subscriber ──────────────────────────────────────────────────────────

/**
 * Per-connection SSE subscriber. During the initial DB replay it writes
 * directly; live events arriving in that window are buffered and flushed on
 * `activate()`. Dedup-by-sequence guarantees no gaps or duplicates across the
 * replay/live boundary, and terminal events close the stream.
 */
class SseSubscriber {
  #lastSeq: number;
  #buffering = true;
  #pending: RunEventEnvelope[] = [];
  #closed = false;
  /**
   * The authenticated user this live stream belongs to. Recorded so access can
   * be REVOKED mid-stream (CVE-2026-53843): an SSE read is authorized once at
   * connect, but a long-lived stream must be force-closed when the viewer is
   * later removed from the run's shared session. Identity is server-derived
   * (from auth), never client-supplied.
   */
  readonly userId: string;

  constructor(private readonly res: ServerResponse, afterSequence: number, userId: string) {
    this.#lastSeq = afterSequence;
    this.userId = userId;
  }

  /**
   * Force-close this stream because the viewer lost access (was removed from the
   * shared session, or the session was ended). Emits a final `access.revoked`
   * ephemeral event so the client can show "you no longer have access" and stop
   * retrying, then ends the socket. CVE-2026-53843 remediation.
   */
  revoke(reason: string): void {
    if (this.#closed || this.res.writableEnded) { this.#closed = true; return; }
    try {
      this.res.write(formatSseFrame({ data: { runId: '', sequence: -1, kind: 'access.revoked', payload: { reason }, timestamp: Date.now() } }));
    } catch { /* best-effort */ }
    this.#closed = true;
    try { if (!this.res.writableEnded) this.res.end(); } catch { /* broken pipe */ }
  }

  /** Write a replayed (catch-up) envelope immediately. */
  replay(env: RunEventEnvelope): void {
    this.#emit(env);
  }

  /** Receive a live envelope from the bus (buffered until activated). */
  deliver(env: RunEventEnvelope): void {
    if (this.#buffering) this.#pending.push(env);
    else this.#emit(env);
  }

  /** Flush the buffered live events and switch to live delivery. */
  activate(): void {
    this.#buffering = false;
    const pending = this.#pending;
    this.#pending = [];
    for (const env of pending) this.#emit(env);
  }

  get closed(): boolean {
    return this.#closed || this.res.writableEnded || this.res.destroyed;
  }

  #emit(env: RunEventEnvelope): void {
    // Ephemeral events (Collaboration Phase 1 presence) carry `sequence: -1` —
    // they are not journaled and must bypass the monotonic dedup (which would
    // always drop a negative sequence). Pass them through without advancing the
    // resume cursor.
    if (env.sequence >= 0) {
      if (env.sequence <= this.#lastSeq) return; // dedup / monotonic guard
      this.#lastSeq = env.sequence;
    }
    try {
      if (!this.res.writableEnded) {
        // Collaboration Phase 6 — emit a resumable SSE frame via the canonical
        // core writer. Journaled events carry `id: <sequence>` so a browser
        // EventSource auto-resumes from `Last-Event-ID` after a drop; ephemeral
        // events (sequence < 0) carry no id (they must not move the resume cursor).
        this.res.write(formatSseFrame(env.sequence >= 0 ? { id: env.sequence, data: env } : { data: env }));
      }
      if (TERMINAL_EVENT_KINDS.has(env.kind) && !this.res.writableEnded) {
        this.#closed = true;
        this.res.end();
      }
    } catch {
      this.#closed = true; // best-effort; broken pipe etc.
    }
  }
}

// ─── Executor ────────────────────────────────────────────────────────────────

export interface MeRunExecutorOptions {
  db: DatabaseAdapter;
  /**
   * The agent that produces run output. Injectable so tests can stub it
   * without an LLM. When omitted, the executor advertises no producing
   * capability and `start()` immediately completes runs with no output.
   */
  runAgent?: MeRunAgent;
  /**
   * Collaboration Phase 3 — called once per run the moment it reaches a terminal
   * state (a NEW terminal event was just persisted). The host wires this to the
   * durable notification outbox (enqueue subscribers + kick the relay). Fired
   * fire-and-forget AFTER the terminal event is committed, so a slow/failing
   * notification path can never stall or break the run itself.
   */
  onTerminal?: (runId: string) => void;
}

export class MeRunExecutor {
  readonly #db: DatabaseAdapter;
  readonly #runAgent: MeRunAgent | undefined;
  readonly #onTerminal: ((runId: string) => void) | undefined;
  /** Active run controllers keyed by runId — used for cooperative cancel. */
  readonly #active = new Map<string, AbortController>();
  /** Per-run append serialization (gap-free, monotonic sequences). */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** SSE subscribers keyed by runId. */
  readonly #subscribers = new Map<string, Set<SseSubscriber>>();

  constructor(opts: MeRunExecutorOptions) {
    this.#db = opts.db;
    this.#runAgent = opts.runAgent;
    this.#onTerminal = opts.onTerminal;
  }

  /** True when a producing agent is wired (runs actually generate output). */
  get canProduce(): boolean {
    return this.#runAgent !== undefined;
  }

  // ── Fan-out ────────────────────────────────────────────────────────────

  /** True when at least one live SSE subscriber is attached to `runId`. */
  hasSubscriber(runId: string): boolean {
    const set = this.#subscribers.get(runId);
    return set !== undefined && set.size > 0;
  }

  /**
   * Attach an SSE response to a run's live stream. The caller is responsible
   * for replaying historical events through the returned subscriber, then
   * calling `activate()`. Returns a detach function.
   */
  subscribe(runId: string, res: ServerResponse, afterSequence: number, userId: string): {
    subscriber: SseSubscriber;
    detach: () => void;
  } {
    const subscriber = new SseSubscriber(res, afterSequence, userId);
    let set = this.#subscribers.get(runId);
    if (!set) { set = new Set(); this.#subscribers.set(runId, set); }
    set.add(subscriber);
    const detach = () => {
      const s = this.#subscribers.get(runId);
      if (!s) return;
      s.delete(subscriber);
      if (s.size === 0) this.#subscribers.delete(runId);
    };
    return { subscriber, detach };
  }

  /**
   * Force-close every live SSE stream on `runId` belonging to a user for whom
   * `stillHasAccess(userId)` returns false. Called after an access mutation
   * (member removed, session ended, token revoked-with-kick) so a viewer cannot
   * keep watching a stream that was authorized only at connect time
   * (CVE-2026-53843). Returns the number of streams closed. Owner streams (and
   * any still-authorized viewer) are never touched.
   */
  disconnectUnauthorized(runId: string, stillHasAccess: (userId: string) => boolean, reason = 'access revoked'): number {
    const set = this.#subscribers.get(runId);
    if (!set || set.size === 0) return 0;
    let closed = 0;
    for (const sub of [...set]) {
      if (stillHasAccess(sub.userId)) continue;
      sub.revoke(reason);
      set.delete(sub);
      closed++;
    }
    if (set.size === 0) this.#subscribers.delete(runId);
    return closed;
  }

  #broadcast(env: RunEventEnvelope): void {
    const set = this.#subscribers.get(env.runId);
    if (!set || set.size === 0) return;
    for (const sub of [...set]) {
      sub.deliver(env);
      if (sub.closed) set.delete(sub);
    }
    if (set.size === 0) this.#subscribers.delete(env.runId);
  }

  /**
   * Broadcast an EPHEMERAL event to a run's live subscribers WITHOUT writing it
   * to the journal (Collaboration Phase 1). Used for presence (`presence.update`),
   * which is high-churn, last-write-wins, and disposable — it only ever means
   * "current", so journaling it would bloat the durable log with zero replay
   * value. Ephemeral events carry `sequence: -1` so the client reducer applies
   * them without participating in the journal's sequence dedup.
   */
  broadcastEphemeral(runId: string, kind: string, payload: Record<string, unknown>): void {
    this.#broadcast({ runId, sequence: -1, kind, payload, timestamp: Date.now() });
  }

  // ── Append + serialization ───────────────────────────────────────────────

  /**
   * Append a run event (persist + broadcast) under a per-run lock. Sequence is
   * the count of existing events (gap-free, monotonic). Terminal kinds are
   * idempotent: if a terminal event already exists, this is a no-op returning
   * the existing terminal sequence.
   */
  async appendEvent(runId: string, kind: string, payload: Record<string, unknown>): Promise<number> {
    return this.#withRunLock(runId, async () => {
      const existing = await this.#db.listUserRunEvents(runId);
      if (TERMINAL_EVENT_KINDS.has(kind)) {
        const terminal = existing.find((e) => TERMINAL_EVENT_KINDS.has(e.kind));
        if (terminal) return terminal.sequence; // exactly-one terminal event
      }
      const sequence = existing.length;
      await this.#db.appendUserRunEvent({
        id: newUUIDv7(),
        run_id: runId,
        sequence,
        kind,
        payload: JSON.stringify(payload),
      });
      this.#broadcast({ runId, sequence, kind, payload, timestamp: Date.now() });
      // Collaboration Phase 3 — a NEW terminal event just committed: hand off to
      // the durable notification outbox (fire-and-forget; never blocks the run).
      if (TERMINAL_EVENT_KINDS.has(kind) && this.#onTerminal) {
        try { this.#onTerminal(runId); } catch { /* notification path must not break the run */ }
      }
      return sequence;
    });
  }

  async #withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(runId) ?? Promise.resolve();
    // Run fn after prev settles (regardless of prev outcome) to keep the chain
    // moving. Errors in fn propagate to the caller; the lock chain itself only
    // sees the settled promise so one failure doesn't poison subsequent appends.
    const run = prev.then(fn, fn);
    this.#locks.set(runId, run.then(
      () => {},
      (err) => { logger.error(`lock chain error for run ${runId}`, { err }); },
    ));
    return run;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Dispatch a run non-blocking. Returns immediately; the run executes in the
   * background, emitting events + flipping status. Idempotent: starting an
   * already-active run is a no-op.
   */
  start(args: MeRunStartArgs): void {
    if (!this.#runAgent) return;
    if (this.#active.has(args.runId)) return;
    const controller = new AbortController();
    this.#active.set(args.runId, controller);
    void this.#execute(args, controller).finally(() => {
      this.#active.delete(args.runId);
      this.#locks.delete(args.runId);
      runApprovals.unregisterRun(args.runId);
    });
  }

  /** True when a run is actively executing. */
  isActive(runId: string): boolean {
    return this.#active.has(runId);
  }

  /**
   * Cancel a run cooperatively. Aborts the in-flight agent (if active) so it
   * stops emitting. Returns true when an active run was aborted. The caller is
   * responsible for flipping DB status; the executor emits `run.cancelled`
   * either from the aborted loop or — when no loop is active — the caller
   * should append it.
   */
  cancel(runId: string): boolean {
    const controller = this.#active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async #execute(args: MeRunStartArgs, controller: AbortController): Promise<void> {
    const { runId, userId } = args;
    const runAgent = this.#runAgent!;
    try {
      // Re-verify ownership at execution time. The run may have been created
      // by a different principal or the runId may have been tampered with
      // between dispatch and execution in the background queue.
      const ownedRun = await this.#db.getUserRun(runId, userId);
      if (!ownedRun) {
        logger.error(`run ${runId} not found for user ${userId} — aborting`);
        return;
      }
      await this.#db.updateUserRunStatus(runId, userId, 'running');
      await this.appendEvent(runId, 'run.started', {
        ...(args.surface !== undefined ? { surface: args.surface } : {}),
      });

      // Phase 4: register the run for HITL approvals so a gated tool can pause
      // it (emit approval.request + persist) and a posted decision can resume it.
      runApprovals.registerRun(runId, async (kind, payload) => { await this.appendEvent(runId, kind, payload); }, this.#db);

      const emit: MeRunEmitter = {
        text: async (delta, role) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'text.delta', {
            delta,
            ...(role !== undefined ? { role } : {}),
          });
        },
        toolInvoked: async (tool, toolArgs, toolCallId) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'tool.invoked', {
            tool,
            ...(toolArgs !== undefined ? { args: toolArgs } : {}),
            ...(toolCallId !== undefined ? { toolCallId } : {}),
          });
        },
        toolCompleted: async (tool, result, toolCallId) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'tool.completed', { tool, result, ...(toolCallId !== undefined ? { toolCallId } : {}) });
        },
        toolErrored: async (tool, error, toolCallId) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'tool.errored', { tool, error, ...(toolCallId !== undefined ? { toolCallId } : {}) });
        },
        toolInputStart: async (toolCallId, tool) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'tool.input.start', { toolCallId, tool });
        },
        toolInputDelta: async (toolCallId, delta) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'tool.input.delta', { toolCallId, delta });
        },
        widget: async (id, payload, schemaVersion) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'widget.update', {
            id,
            payload,
            ...(schemaVersion !== undefined ? { schemaVersion } : {}),
          });
        },
        reasoning: async (delta) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'reasoning.delta', { delta });
        },
        step: async (step) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'step.update', { ...step });
        },
        usage: async (usage) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'usage.update', { ...usage });
        },
        citation: async (citation) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'citation.add', { ...citation });
        },
        artifact: async (artifact) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'artifact.update', { ...artifact });
        },
        diagnostic: async (channel, data) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'diagnostic', { channel, ...(data !== undefined ? { data } : {}) });
        },
        objectDelta: async (delta) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'object.delta', { delta });
        },
        objectComplete: async (value) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'object.complete', { ...(value !== undefined ? { value } : {}) });
        },
        file: async (part) => {
          if (controller.signal.aborted) return;
          await this.appendEvent(runId, 'file.part', { ...part });
        },
      };

      const ctx = weaveContext({
        userId,
        ...(args.tenantId ? { tenantId: args.tenantId } : {}),
        metadata: {
          runId,
          ...(args.persona !== undefined ? { persona: args.persona } : {}),
          ...(args.surface !== undefined ? { surface: args.surface } : {}),
        },
      });

      await runAgent(
        {
          ctx,
          userId,
          runId,
          surface: args.surface,
          input: args.input,
          metadata: args.metadata,
          signal: controller.signal,
        },
        emit,
      );

      if (controller.signal.aborted) {
        await this.#finishCancelled(runId, userId);
        return;
      }

      await this.#db.updateUserRunStatus(runId, userId, 'completed');
      await this.appendEvent(runId, 'run.completed', {});
    } catch (err) {
      if (controller.signal.aborted) {
        await this.#finishCancelled(runId, userId).catch(() => {});
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      try { await this.#db.updateUserRunStatus(runId, userId, 'failed'); } catch { /* best-effort */ }
      await this.appendEvent(runId, 'run.failed', { message }).catch(() => { /* best-effort */ });
    }
  }

  async #finishCancelled(runId: string, userId: string): Promise<void> {
    try { await this.#db.updateUserRunStatus(runId, userId, 'cancelled'); } catch { /* best-effort */ }
    await this.appendEvent(runId, 'run.cancelled', {}).catch(() => { /* best-effort */ });
  }
}
