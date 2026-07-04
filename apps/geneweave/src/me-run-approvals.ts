/**
 * Run-path HITL approval coordinator (Client Phase 4).
 *
 * Bridges the agent loop's existing interrupt hook (`onInterrupt` →
 * `createHumanTaskInterruptHandler`, which pauses the agent in-process by
 * polling a `HumanTaskQueue`) to the run-event stream + the client `postEvent`
 * channel:
 *
 *   - When a gated tool needs approval the agent enqueues a task on the run's
 *     queue. Our wrapper ALSO: (a) emits an `approval.request` run event so the
 *     client sees a `requires-action` part, and (b) persists a pending row in
 *     `hitl_interrupt_requests` (run-scoped) so the approval survives a restart.
 *   - The client answers with `POST /api/me/runs/:id/events` kind
 *     `approval.decision`; the route calls `runApprovals.resolve(...)`, which
 *     completes/rejects the underlying task (unblocking the agent's poll) and
 *     emits `approval.resolved`.
 *
 * The run stays `running` while paused — the agent's async stack is simply
 * suspended at `await onInterrupt(...)`; no abort, no checkpoint. (Cross-restart
 * resume of a suspended generation is out of scope; the decision is persisted.)
 *
 * Reuses @weaveintel/human-tasks (InMemoryTaskQueue lifecycle) + the agent
 * interrupt handler; this module only adds the run-event + persistence bridge.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { HumanTask, HumanTaskQueue, HumanDecision, HumanTaskFilter } from '@weaveintel/core';
import { InMemoryTaskQueue } from '@weaveintel/human-tasks';

type EmitFn = (kind: string, payload: Record<string, unknown>) => Promise<void>;

interface HitlPersist {
  createHitlInterrupt(row: { id: string; chat_id: string; run_id?: string | null; agent_name: string; agent_step?: number; tool_name: string; tool_args_json?: string; interrupt_type?: string; reason?: string; expires_at?: string | null }): Promise<void>;
  resolveHitlInterrupt(id: string, fields: { status: string; decision_action?: string; modified_args_json?: string | null; feedback?: string | null; decided_by?: string | null }): Promise<void>;
}

interface RunState {
  emit: EmitFn;
  db?: HitlPersist;
  chatId?: string;
  inner: InMemoryTaskQueue;
}

export interface ResolveOptions {
  feedback?: string;
  modifiedArgs?: Record<string, unknown>;
  decidedBy?: string;
}

export class RunApprovalCoordinator {
  readonly #runs = new Map<string, RunState>();
  /** taskId → runId, so a posted decision finds its run + queue. */
  readonly #taskRun = new Map<string, string>();
  /**
   * chatId → runId for the currently-active run on that chat. The chat engine
   * keys the approval queue by chatId (which is always in scope there), since
   * the inner streamMessage ctx does not carry the runId.
   */
  readonly #chatRun = new Map<string, string>();

  /** Called by the executor when a producing run starts. */
  registerRun(runId: string, emit: EmitFn, db?: HitlPersist): void {
    this.#runs.set(runId, { emit, ...(db ? { db } : {}), inner: new InMemoryTaskQueue() });
  }

  /** Called by the run-agent once the run's chat id is known (FK row + chat keying). */
  setRunChat(runId: string, chatId: string): void {
    const st = this.#runs.get(runId);
    if (st) st.chatId = chatId;
    this.#chatRun.set(chatId, runId);
  }

  /** Cleanup when the run ends. Pending tasks + chat mapping for the run are dropped. */
  unregisterRun(runId: string): void {
    for (const [taskId, rid] of this.#taskRun) if (rid === runId) this.#taskRun.delete(taskId);
    for (const [chatId, rid] of this.#chatRun) if (rid === runId) this.#chatRun.delete(chatId);
    this.#runs.delete(runId);
  }

  /** Run-aware queue keyed by chatId (what the chat engine has in scope). */
  queueForChat(chatId: string): HumanTaskQueue | null {
    const runId = this.#chatRun.get(chatId);
    return runId ? this.queueFor(runId) : null;
  }

  /** True while a run is registered (i.e. HITL can be coordinated for it). */
  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  /**
   * A run-aware `HumanTaskQueue` for the agent's `onInterrupt` handler. Returns
   * null when the run isn't registered (caller falls back to a plain queue).
   */
  queueFor(runId: string): HumanTaskQueue | null {
    const st = this.#runs.get(runId);
    if (!st) return null;
    const inner = st.inner;
    return {
      enqueue: async (task: Omit<HumanTask, 'id' | 'createdAt'>): Promise<HumanTask> => {
        const created = await inner.enqueue(task);
        this.#taskRun.set(created.id, runId);
        // ApprovalTask carries tool details under `data`.
        const data = (task.data && typeof task.data === 'object') ? task.data as Record<string, unknown> : {};
        const toolName = typeof data['action'] === 'string' ? data['action'] as string : 'tool';
        const ctxObj = (data['context'] && typeof data['context'] === 'object') ? data['context'] as Record<string, unknown> : {};
        const args = (ctxObj['toolArgs'] && typeof ctxObj['toolArgs'] === 'object') ? ctxObj['toolArgs'] as Record<string, unknown> : undefined;
        const riskLevel = typeof data['riskLevel'] === 'string' ? data['riskLevel'] as string : undefined;
        // Persist (best-effort) so the approval survives a restart.
        if (st.db && st.chatId) {
          try {
            await st.db.createHitlInterrupt({
              id: created.id, chat_id: st.chatId, run_id: runId,
              agent_name: typeof ctxObj['agentName'] === 'string' ? ctxObj['agentName'] as string : 'agent',
              agent_step: typeof ctxObj['agentStep'] === 'number' ? ctxObj['agentStep'] as number : 0,
              tool_name: toolName, tool_args_json: JSON.stringify(args ?? {}),
              reason: typeof task.description === 'string' ? task.description : '',
              expires_at: task.slaDeadline ?? null,
            });
          } catch { /* persistence is best-effort; the in-process flow still works */ }
        }
        // Emit the approval-request run event for the client.
        await st.emit('approval.request', {
          taskId: created.id,
          toolName,
          ...(args ? { args } : {}),
          ...(typeof task.title === 'string' ? { title: task.title } : {}),
          ...(typeof task.description === 'string' ? { description: task.description } : {}),
          ...(riskLevel ? { riskLevel } : {}),
          actions: [
            { label: 'Approve', value: 'approve', style: 'primary' },
            { label: 'Deny', value: 'reject', style: 'danger' },
          ],
        }).catch(() => { /* best-effort */ });
        return created;
      },
      get: (taskId: string) => inner.get(taskId),
      dequeue: (assignee: string) => inner.dequeue(assignee),
      list: (filter?: HumanTaskFilter) => inner.list(filter),
      complete: (taskId: string, decision: HumanDecision) => inner.complete(taskId, decision),
      reject: (taskId: string, decision: HumanDecision) => inner.reject(taskId, decision),
      expire: (taskId: string) => inner.expire(taskId),
    };
  }

  /**
   * Apply a client decision (from POST /runs/:id/events approval.decision).
   * Completes/rejects the underlying task — unblocking the agent's poll — then
   * persists + emits `approval.resolved`. Returns false for an unknown task.
   */
  async resolve(taskId: string, action: 'approve' | 'reject' | 'modify', opts: ResolveOptions = {}): Promise<boolean> {
    const runId = this.#taskRun.get(taskId);
    if (!runId) return false;
    const st = this.#runs.get(runId);
    if (!st) return false;

    const decision: HumanDecision = {
      decision: action,
      ...(opts.feedback ? { reason: opts.feedback } : {}),
      data: {
        decision: action,
        ...(opts.feedback ? { feedback: opts.feedback } : {}),
        ...(opts.modifiedArgs ? { modifiedArgs: opts.modifiedArgs } : {}),
      },
      decidedAt: new Date().toISOString(),
    } as HumanDecision;

    try {
      if (action === 'reject') await st.inner.reject(taskId, decision);
      else await st.inner.complete(taskId, decision);
    } catch {
      return false; // already resolved / unknown
    }
    this.#taskRun.delete(taskId);

    if (st.db) {
      try {
        await st.db.resolveHitlInterrupt(taskId, {
          status: action === 'approve' ? 'approved' : action === 'modify' ? 'modified' : 'rejected',
          decision_action: action,
          ...(opts.modifiedArgs ? { modified_args_json: JSON.stringify(opts.modifiedArgs) } : {}),
          ...(opts.feedback ? { feedback: opts.feedback } : {}),
          ...(opts.decidedBy ? { decided_by: opts.decidedBy } : {}),
        });
      } catch { /* best-effort */ }
    }

    await st.emit('approval.resolved', { taskId, action, ...(opts.feedback ? { feedback: opts.feedback } : {}) }).catch(() => {});
    return true;
  }
}

/** Process-wide singleton — registered by the executor, consulted by chat.ts + the postEvent route. */
export const runApprovals = new RunApprovalCoordinator();
