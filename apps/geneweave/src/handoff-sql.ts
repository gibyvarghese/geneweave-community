/**
 * geneWeave SQL adapter for Collaboration Phase 5 — the unified handoff lifecycle.
 * The SQL implementation of the `@weaveintel/collab` `UnifiedHandoffManager`
 * PORT; passes the SAME `handoffManagerContract` the in-memory adapter passes
 * (the Phase 0–4 pattern). State-machine validity, actor authorization, and the
 * append-only audit trail are enforced here exactly as in the reference adapter.
 *
 * Plus `buildRunBriefing` — the context-transfer helper that turns a run into a
 * SCOPED structured briefing (a summary + status), never the raw transcript
 * (the strongest mid-2026 consensus: full transcripts blow up tokens + bury signal).
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  canTransition,
  isTerminalHandoffState,
  type UnifiedHandoffManager,
  type Handoff,
  type HandoffEvent,
  type HandoffState,
  type HandoffActor,
  type HandoffBriefing,
} from '@weaveintel/collab';
import type { DatabaseAdapter } from './db-types.js';
import type { SessionHandoffRow, HandoffEventRow, UserRunRow } from './db-types/adapter-me.js';

const GLOBAL_TENANT = '__global__';

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function rowToHandoff(r: SessionHandoffRow): Handoff {
  return {
    id: r.id, runId: r.run_id, tenantId: r.tenant_id ?? GLOBAL_TENANT, scope: r.scope,
    fromActor: { type: r.from_actor_type, id: r.from_actor_id },
    toActor: { type: r.to_actor_type, id: r.to_actor_id },
    state: r.state as HandoffState, reason: r.reason,
    briefing: parseJson<HandoffBriefing | null>(r.briefing_json, null),
    rejectionReason: r.rejection_reason,
    handBackBriefing: parseJson<HandoffBriefing | null>(r.hand_back_briefing_json, null),
    depth: r.depth, parentHandoffId: r.parent_handoff_id,
    referenceTaskIds: parseJson<string[]>(r.reference_task_ids_json, []),
    createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at, expiresAt: r.expires_at,
  };
}

type HandoffDb = Pick<DatabaseAdapter,
  'insertSessionHandoff' | 'getSessionHandoff' | 'updateSessionHandoff' |
  'listSessionHandoffsForRun' | 'listSessionHandoffsForActor' | 'listDueSessionHandoffs' |
  'insertHandoffEvent' | 'listHandoffEvents'>;

export function createSqlHandoffManager(db: HandoffDb, opts: { now?: () => number } = {}): UnifiedHandoffManager {
  const now = opts.now ?? (() => Date.now());

  async function audit(handoffId: string, actorId: string, fromState: HandoffState | null, toState: HandoffState, note: string | null): Promise<void> {
    const row: HandoffEventRow = { id: newUUIDv7(), handoff_id: handoffId, at: now(), actor_id: actorId, from_state: fromState, to_state: toState, note };
    await db.insertHandoffEvent(row);
  }

  /** Guarded transition mirroring the in-memory adapter: validate + authorize + persist + audit. */
  async function transition(id: string, byActorId: string, to: HandoffState, who: 'from' | 'to' | 'either', extra: Partial<Pick<SessionHandoffRow, 'rejection_reason' | 'hand_back_briefing_json'>>, note: string | null): Promise<Handoff> {
    const r = await db.getSessionHandoff(id);
    if (!r) throw new Error(`handoff '${id}' not found`);
    if (!canTransition(r.state as HandoffState, to)) throw new Error(`illegal transition ${r.state} → ${to}`);
    const allowed = who === 'from' ? [r.from_actor_id] : who === 'to' ? [r.to_actor_id] : [r.from_actor_id, r.to_actor_id];
    if (!allowed.includes(byActorId)) {
      const label = who === 'from' ? 'requester' : who === 'to' ? 'recipient' : 'participant';
      throw new Error(`forbidden: only the ${label} may perform this transition`);
    }
    const ts = now();
    await db.updateSessionHandoff(id, { state: to, updated_at: ts, ...(isTerminalHandoffState(to) ? { resolved_at: ts } : {}), ...extra });
    await audit(id, byActorId, r.state as HandoffState, to, note);
    return rowToHandoff((await db.getSessionHandoff(id))!);
  }

  return {
    async request(input) {
      const depth = (() => 0)(); // computed below from the parent
      void depth;
      let resolvedDepth = 0;
      if (input.parentHandoffId) {
        const parent = await db.getSessionHandoff(input.parentHandoffId);
        resolvedDepth = parent ? parent.depth + 1 : 0;
      }
      const maxDepth = input.maxDepth ?? 5;
      if (resolvedDepth > maxDepth) throw new Error(`handoff chain too deep (> ${maxDepth}) — refusing to avoid a handoff loop`);
      if (!input.reason?.trim()) throw new Error('a handoff requires a reason');
      const ts = now();
      const row: SessionHandoffRow = {
        id: input.id, run_id: input.runId, tenant_id: input.tenantId === GLOBAL_TENANT ? null : input.tenantId, scope: input.scope,
        from_actor_type: input.fromActor.type, from_actor_id: input.fromActor.id,
        to_actor_type: input.toActor.type, to_actor_id: input.toActor.id,
        state: 'requested', reason: input.reason,
        briefing_json: input.briefing ? JSON.stringify(input.briefing) : null,
        rejection_reason: null, hand_back_briefing_json: null,
        depth: resolvedDepth, parent_handoff_id: input.parentHandoffId ?? null,
        reference_task_ids_json: JSON.stringify(input.referenceTaskIds ?? []),
        created_at: ts, updated_at: ts, resolved_at: null,
        expires_at: input.ttlMs ? ts + input.ttlMs : null,
      };
      await db.insertSessionHandoff(row);
      await audit(row.id, input.fromActor.id, null, 'requested', input.reason);
      return rowToHandoff(row);
    },
    async accept(id, byActorId, note) { return transition(id, byActorId, 'accepted', 'to', {}, note ?? null); },
    async reject(id, byActorId, reason) {
      if (!reason?.trim()) throw new Error('a rejection requires a reason');
      return transition(id, byActorId, 'rejected', 'to', { rejection_reason: reason }, reason);
    },
    async cancel(id, byActorId, note) { return transition(id, byActorId, 'cancelled', 'from', {}, note ?? null); },
    async start(id, byActorId, note) { return transition(id, byActorId, 'in_progress', 'to', {}, note ?? null); },
    async handBack(id, byActorId, briefing, note) {
      return transition(id, byActorId, 'handed_back', 'to', { hand_back_briefing_json: briefing ? JSON.stringify(briefing) : null }, note ?? null);
    },
    async complete(id, byActorId, note) { return transition(id, byActorId, 'completed', 'either', {}, note ?? null); },
    async fail(id, byActorId, reason) { return transition(id, byActorId, 'failed', 'either', { rejection_reason: reason }, reason); },
    async get(id) {
      const r = await db.getSessionHandoff(id);
      return r ? rowToHandoff(r) : null;
    },
    async listForRun(runId) { return (await db.listSessionHandoffsForRun(runId)).map(rowToHandoff); },
    async listForActor(actorId) { return (await db.listSessionHandoffsForActor(actorId)).map(rowToHandoff); },
    async audit(id) {
      return (await db.listHandoffEvents(id)).map((e): HandoffEvent => ({
        id: e.id, handoffId: e.handoff_id, at: e.at, actorId: e.actor_id,
        fromState: e.from_state as HandoffState | null, toState: e.to_state as HandoffState, note: e.note,
      }));
    },
    async expireDue(nowMs) {
      const due = await db.listDueSessionHandoffs(nowMs);
      const changed: Handoff[] = [];
      for (const r of due) {
        await db.updateSessionHandoff(r.id, { state: 'timed_out', updated_at: nowMs, resolved_at: nowMs });
        await audit(r.id, 'system', r.state as HandoffState, 'timed_out', 'SLA expired');
        changed.push(rowToHandoff({ ...r, state: 'timed_out', resolved_at: nowMs, updated_at: nowMs }));
      }
      return changed;
    },
  };
}

// ─── SLA sweeper ─────────────────────────────────────────────────────────────

/**
 * Periodically flip overdue `requested`/`accepted` handoffs to `timed_out` (an
 * unbounded human wait would deadlock the run — the Temporal HITL pattern). On
 * each timeout it broadcasts a live `handoff.update` so watchers see it resolve.
 * Returns a stop function. The timer is `unref`'d so it never holds the process open.
 */
export function startHandoffSweeper(
  db: HandoffDb,
  broadcast: (runId: string, kind: string, payload: Record<string, unknown>) => void,
  opts: { intervalMs?: number } = {},
): () => void {
  const mgr = createSqlHandoffManager(db);
  const interval = Math.max(5_000, opts.intervalMs ?? 60_000);
  const timer = setInterval(() => {
    void (async () => {
      try {
        const timedOut = await mgr.expireDue(Date.now());
        for (const h of timedOut) broadcast(h.runId, 'handoff.update', { handoff: h });
      } catch { /* best-effort — retry next tick */ }
    })();
  }, interval);
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  return () => clearInterval(timer);
}

// ─── Context transfer: build a SCOPED briefing from a run ────────────────────────

/**
 * Turn a run into a scoped {@link HandoffBriefing} — a short summary + status,
 * NOT the raw transcript. We take a bounded slice of the assistant text output so
 * the recipient gets "here is where things stand" without a token blow-up. The
 * caller may override/extend any field (open questions, next action, confidence).
 */
export async function buildRunBriefing(
  db: Pick<DatabaseAdapter, 'listUserRunEvents'>,
  run: UserRunRow,
  overrides: Partial<HandoffBriefing> = {},
): Promise<HandoffBriefing> {
  let text = '';
  try {
    const events = await db.listUserRunEvents(run.id);
    for (const ev of events) {
      if (ev.kind !== 'text.delta') continue;
      try {
        const p = JSON.parse(ev.payload) as { delta?: unknown };
        if (typeof p.delta === 'string') text += p.delta;
      } catch { /* skip */ }
    }
  } catch { /* best-effort */ }
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const summary = trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : (trimmed || `Run is ${run.status}.`);
  return {
    summary: overrides.summary ?? summary,
    ...(overrides.decisions ? { decisions: overrides.decisions } : {}),
    ...(overrides.openQuestions ? { openQuestions: overrides.openQuestions } : {}),
    ...(overrides.nextAction ? { nextAction: overrides.nextAction } : {}),
    ...(overrides.artifacts ? { artifacts: overrides.artifacts } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
}
