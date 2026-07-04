/**
 * chat-session.ts — the pure, framework-agnostic "brain" of the M4 chat surface.
 *
 * A chat session is an ordered list of {@link ChatEntry}s (user messages and
 * assistant runs). It owns the full lifecycle of a turn:
 *
 *   send → startRun → attachRun (live SSE) → streamReducer → terminal
 *
 * plus send↔stop (cancelRun), edit-and-resend (supersede + new run),
 * regenerate, deep-link resume (`attachExisting`), and the "running in
 * background" detach window (background > {@link DETACH_BACKGROUND_MS}).
 *
 * It is a tiny observable store (`getState`/`subscribe`) — identical shape to
 * the auth store — so the native layer mirrors it with `useSyncExternalStore`
 * and stays declarative. No React / React Native / expo imports: the entire
 * controller is unit-testable in Node, including the golden resume test
 * (kill mid-run → relaunch → resume zero gap/dupe).
 *
 * The {@link GeneweaveClient} is injected (only the four run methods it needs),
 * so each session targets exactly the per-tenant client built at the
 * composition root — no module-level singletons, isolation per tenant/host.
 */

import {
  emptyRunViewModel,
  streamReducer,
  type RunEventEnvelope,
  type RunViewModel,
  type RunStatus,
} from '@weaveintel/api-client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version of the chat-session surface. */
export const CHAT_SESSION_SCHEMA_VERSION = 1 as const;

/**
 * How long a producing run may stay attached while the app is backgrounded
 * before we detach and surface "running in background". Re-attaches on
 * foreground via the persisted sequence cursor (zero gap/dupe).
 */
export const DETACH_BACKGROUND_MS = 20_000;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** A user-authored message bubble. */
export interface UserEntry {
  kind: 'user';
  /** Stable local id (not a server id). */
  id: string;
  text: string;
  createdAt: number;
  /** When set, this message was edited; the run id that supersedes it. */
  supersededByRunId?: string;
}

/** An assistant turn backed by a server run + its reduced view model. */
export interface AssistantEntry {
  kind: 'assistant';
  /** Stable local id. */
  id: string;
  /** The server run id (the SSE stream key). */
  runId: string;
  /** The accumulated view model for this run (text/widgets/tool-calls/status). */
  model: RunViewModel;
  createdAt: number;
  /** Local id of the user entry that prompted this run (for regenerate). */
  promptEntryId: string;
  /** The prompt text that produced this run (for regenerate). */
  promptText: string;
}

export type ChatEntry = UserEntry | AssistantEntry;

/** Composer + lifecycle phase. */
export type ChatPhase = 'idle' | 'starting' | 'streaming';

export interface ChatSessionState {
  /** Entries in chronological (oldest-first) order. */
  entries: ChatEntry[];
  /** The composer's current draft text. */
  composerText: string;
  /** The run currently producing (attached or detached), else null. */
  activeRunId: string | null;
  /** Lifecycle phase for the composer's send↔stop affordance. */
  phase: ChatPhase;
  /** True when a producing run was detached because the app is backgrounded. */
  runningInBackground: boolean;
  /** Last user-facing error message, if any. */
  error: string | null;
  /**
   * Widget ids with an in-flight action (optimistic). Keyed by widget id →
   * the submitted action id, so a renderer can disable the card and show which
   * choice is pending. Cleared when the server re-emits that widget (reconcile)
   * or the post fails.
   */
  pendingWidgetActions: Record<string, string>;
}

export function emptyChatSessionState(): ChatSessionState {
  return {
    entries: [],
    composerText: '',
    activeRunId: null,
    phase: 'idle',
    runningInBackground: false,
    error: null,
    pendingWidgetActions: {},
  };
}

// ---------------------------------------------------------------------------
// Dependencies (injected)
// ---------------------------------------------------------------------------

/** The run-surface subset of the geneWeave client the session needs. */
export interface ChatRunClient {
  startRun(input: {
    idempotencyKey: string;
    surface?: string;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; status: RunStatus }>;
  cancelRun(id: string): Promise<RunStatus>;
  /**
   * Post an out-of-band event into a run — a widget action tap ("a tap is a
   * turn"). The server folds it into the run and may resume producing.
   */
  postEvent(
    runId: string,
    event: { kind?: string; payload?: Record<string, unknown> },
  ): Promise<{ sequence: number }>;
  attachRun(
    runId: string,
    opts: {
      afterSequence?: number;
      onEvent?: (envelope: RunEventEnvelope) => void;
      onComplete?: (model: RunViewModel) => void;
      onError?: (err: Error) => void;
      signal?: AbortSignal;
    },
  ): { detach(): void };
}

export interface ChatSessionOptions {
  /** The per-tenant run client. */
  client: ChatRunClient;
  /** Surface hint sent on every run start. Defaults to `'mobile'`. */
  surface?: string;
  /** Generates a fresh idempotency key per send. */
  idempotencyKey: () => string;
  /** Generates a stable local entry id. */
  newId: () => string;
  /**
   * Optional per-send run metadata stamped onto `startRun.metadata`. Called
   * once per run start, so the composition root can attach the currently
   * selected mode / model / skill (resolved per-tenant from the catalog) or any
   * per-tenant token hints without the controller knowing about them.
   */
  runMetadata?: () => Record<string, unknown> | undefined;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Backgrounded-detach window in ms. Defaults to {@link DETACH_BACKGROUND_MS}. */
  detachAfterMs?: number;
  /** Timer seam, injectable for tests. Defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Initial state (for resume / tests). */
  initial?: ChatSessionState;
}

export type ChatSessionListener = (state: ChatSessionState) => void;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ChatSession {
  getState(): ChatSessionState;
  subscribe(listener: ChatSessionListener): () => void;

  /** Update the composer draft. */
  setComposerText(text: string): void;

  /**
   * Send the composer's text (or `text` if given) as a new turn. No-op when a
   * run is already producing or the text is blank. Resolves once the run has
   * been started and attached (not when it completes).
   */
  send(text?: string): Promise<void>;

  /** Cancel the active run (the Stop affordance). Idempotent. */
  stop(): Promise<void>;

  /**
   * Submit a widget action (e.g. an approval tap) for a run. Optimistically
   * marks the widget pending (the card disables), posts a `widget.action`
   * event, and reconciles when the server re-emits the widget. No-op when the
   * widget already has an action in flight. On post failure the optimistic
   * state rolls back and `error` is surfaced.
   */
  submitWidgetAction(
    runId: string,
    widgetId: string,
    actionId: string,
    value?: unknown,
  ): Promise<void>;

  /**
   * Edit a previous user message and resend it as a *new* run. The original
   * user entry is marked superseded (the native layer dims it). No-op while a
   * run is producing.
   */
  editAndResend(userEntryId: string, newText: string): Promise<void>;

  /** Re-run the prompt that produced an assistant entry. No-op while producing. */
  regenerate(assistantEntryId: string): Promise<void>;

  /**
   * Attach to an already-started run (e.g. a deep link `geneweave://run/:id`),
   * resuming from `afterSequence`. Adds an assistant entry if absent.
   */
  attachExisting(runId: string, afterSequence?: number): void;

  /**
   * Seed the transcript with prior turns when re-opening a saved conversation.
   * No-op unless the session is empty and idle, so it can never clobber an
   * in-progress conversation or a turn the user already started. Safe to call
   * after an async history fetch resolves.
   */
  hydrateHistory(entries: ChatEntry[]): void;

  /** OS app-state hooks for the detach window. */
  onBackground(): void;
  onForeground(): void;

  /** Detach any live stream and clear timers. Idempotent. */
  dispose(): void;
}

export function createChatSession(opts: ChatSessionOptions): ChatSession {
  const surface = opts.surface ?? 'mobile';
  const now = opts.now ?? (() => Date.now());
  const detachAfterMs = opts.detachAfterMs ?? DETACH_BACKGROUND_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let state: ChatSessionState = opts.initial ?? emptyChatSessionState();
  const listeners = new Set<ChatSessionListener>();

  /** The live attach handle for the active run, if attached. */
  let handle: { detach(): void } | null = null;
  /** Background-detach timer handle. */
  let bgTimer: unknown = null;

  function emit(next: ChatSessionState): void {
    state = next;
    for (const l of listeners) l(state);
  }

  function patch(p: Partial<ChatSessionState>): void {
    emit({ ...state, ...p });
  }

  /** Replace the assistant entry for `runId` with `model`. */
  function applyModel(runId: string, model: RunViewModel): void {
    const entries = state.entries.map((e) =>
      e.kind === 'assistant' && e.runId === runId ? { ...e, model } : e,
    );
    const stillProducing = !isTerminalStatus(model.status);
    emit({
      ...state,
      entries,
      ...(stillProducing
        ? {}
        : { activeRunId: state.activeRunId === runId ? null : state.activeRunId, phase: 'idle', runningInBackground: false }),
    });
  }

  function detachLive(): void {
    if (handle) {
      handle.detach();
      handle = null;
    }
  }

  function clearBgTimer(): void {
    if (bgTimer !== null) {
      clearTimer(bgTimer);
      bgTimer = null;
    }
  }

  /**
   * Attach a live stream for `runId`, reducing envelopes into the assistant
   * entry. `afterSequence` resumes mid-run with zero gap/dupe (the reducer
   * only advances on a strictly greater sequence).
   */
  function attach(runId: string, afterSequence: number): void {
    detachLive();
    handle = opts.client.attachRun(runId, {
      afterSequence,
      onEvent(envelope) {
        // Reconcile optimistic widget actions: once the server re-emits a
        // widget we had marked pending, drop the pending flag so the card
        // reflects server truth on the next render.
        if (envelope.kind === 'widget.update') {
          const wid =
            typeof envelope.payload?.['id'] === 'string'
              ? (envelope.payload['id'] as string)
              : undefined;
          if (wid && state.pendingWidgetActions[wid] !== undefined) {
            const { [wid]: _resolved, ...rest } = state.pendingWidgetActions;
            state = { ...state, pendingWidgetActions: rest };
          }
        }
        const entry = currentAssistant(runId);
        const base = entry?.model ?? withSequence(emptyRunViewModel(), afterSequence);
        applyModel(runId, streamReducer(base, envelope));
      },
      onComplete(model) {
        applyModel(runId, model);
      },
      onError(err) {
        patch({ error: err.message });
      },
    });
  }

  function currentAssistant(runId: string): AssistantEntry | undefined {
    return state.entries.find(
      (e): e is AssistantEntry => e.kind === 'assistant' && e.runId === runId,
    );
  }

  /** Begin a brand-new run for `text`, appending user + assistant entries. */
  async function beginRun(text: string, promptEntryId: string): Promise<void> {
    patch({ phase: 'starting', error: null });
    let started: { id: string; status: RunStatus };
    const metadata = opts.runMetadata?.();
    try {
      started = await opts.client.startRun({
        idempotencyKey: opts.idempotencyKey(),
        surface,
        input: { text },
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    } catch (err) {
      patch({ phase: 'idle', error: (err as Error).message });
      return;
    }

    const assistant: AssistantEntry = {
      kind: 'assistant',
      id: opts.newId(),
      runId: started.id,
      model: withSequence(emptyRunViewModel(), -1, started.status),
      createdAt: now(),
      promptEntryId,
      promptText: text,
    };
    emit({
      ...state,
      entries: [...state.entries, assistant],
      activeRunId: started.id,
      phase: 'streaming',
    });
    attach(started.id, -1);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setComposerText(text) {
      patch({ composerText: text });
    },

    hydrateHistory(entries) {
      if (entries.length === 0) return;
      // Only seed an untouched, idle session — never overwrite a live or
      // already-started conversation.
      if (state.entries.length > 0 || state.activeRunId !== null || state.phase !== 'idle') return;
      patch({ entries });
    },

    async send(text) {
      const body = (text ?? state.composerText).trim();
      if (!body) return;
      if (state.phase !== 'idle') return;
      const userEntry: UserEntry = { kind: 'user', id: opts.newId(), text: body, createdAt: now() };
      emit({ ...state, entries: [...state.entries, userEntry], composerText: '' });
      await beginRun(body, userEntry.id);
    },

    async stop() {
      const runId = state.activeRunId;
      if (!runId) return;
      detachLive();
      clearBgTimer();
      try {
        await opts.client.cancelRun(runId);
      } catch (err) {
        patch({ error: (err as Error).message });
      }
      // Reflect the cancel locally even if the server event is slow to arrive.
      const entries = state.entries.map((e) =>
        e.kind === 'assistant' && e.runId === runId
          ? { ...e, model: { ...e.model, status: 'cancelled' as RunStatus } }
          : e,
      );
      emit({ ...state, entries, activeRunId: null, phase: 'idle', runningInBackground: false });
    },

    async submitWidgetAction(runId, widgetId, actionId, value) {
      // Ignore a double-tap while the same widget has an action in flight.
      if (state.pendingWidgetActions[widgetId] !== undefined) return;
      // Optimistic: disable the card and remember the chosen action.
      emit({
        ...state,
        error: null,
        pendingWidgetActions: { ...state.pendingWidgetActions, [widgetId]: actionId },
      });
      try {
        await opts.client.postEvent(runId, {
          kind: 'widget.action',
          payload: { widgetId, actionId, ...(value !== undefined ? { value } : {}) },
        });
      } catch (err) {
        // Roll back the optimistic flag and surface the failure.
        const { [widgetId]: _failed, ...rest } = state.pendingWidgetActions;
        emit({ ...state, pendingWidgetActions: rest, error: (err as Error).message });
      }
    },

    async editAndResend(userEntryId, newText) {
      const body = newText.trim();
      if (!body) return;
      if (state.phase !== 'idle') return;
      const edited: UserEntry = {
        kind: 'user',
        id: opts.newId(),
        text: body,
        createdAt: now(),
      };
      // Mark the original superseded (the new run id is filled in after start).
      const entries = state.entries.map((e) =>
        e.kind === 'user' && e.id === userEntryId ? { ...e, supersededByRunId: 'pending' } : e,
      );
      emit({ ...state, entries: [...entries, edited] });
      await beginRun(body, edited.id);
      // Stamp the superseding run id now that we have it.
      if (state.activeRunId) {
        const stamped = state.entries.map((e) =>
          e.kind === 'user' && e.supersededByRunId === 'pending'
            ? { ...e, supersededByRunId: state.activeRunId! }
            : e,
        );
        emit({ ...state, entries: stamped });
      }
    },

    async regenerate(assistantEntryId) {
      if (state.phase !== 'idle') return;
      const entry = state.entries.find(
        (e): e is AssistantEntry => e.kind === 'assistant' && e.id === assistantEntryId,
      );
      if (!entry) return;
      await beginRun(entry.promptText, entry.promptEntryId);
    },

    attachExisting(runId, afterSequence = -1) {
      if (!currentAssistant(runId)) {
        const assistant: AssistantEntry = {
          kind: 'assistant',
          id: opts.newId(),
          runId,
          model: withSequence(emptyRunViewModel(), afterSequence),
          createdAt: now(),
          promptEntryId: '',
          promptText: '',
        };
        emit({ ...state, entries: [...state.entries, assistant], activeRunId: runId, phase: 'streaming' });
      } else {
        patch({ activeRunId: runId, phase: 'streaming' });
      }
      attach(runId, afterSequence);
    },

    onBackground() {
      // Only arm when a run is actually producing.
      if (state.phase !== 'streaming' || !state.activeRunId) return;
      clearBgTimer();
      bgTimer = setTimer(() => {
        bgTimer = null;
        if (state.phase === 'streaming' && state.activeRunId) {
          detachLive();
          patch({ runningInBackground: true });
        }
      }, detachAfterMs);
    },

    onForeground() {
      clearBgTimer();
      if (state.runningInBackground && state.activeRunId) {
        const entry = currentAssistant(state.activeRunId);
        const resumeFrom = entry?.model.sequence ?? -1;
        patch({ runningInBackground: false });
        attach(state.activeRunId, resumeFrom);
      }
    },

    dispose() {
      detachLive();
      clearBgTimer();
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a shallow copy of `vm` with an overridden sequence (+ optional status). */
function withSequence(vm: RunViewModel, sequence: number, status?: RunStatus): RunViewModel {
  return { ...vm, sequence, ...(status !== undefined ? { status } : {}) };
}
