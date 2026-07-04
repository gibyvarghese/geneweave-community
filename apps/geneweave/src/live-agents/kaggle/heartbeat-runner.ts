/**
 * Kaggle live-agents global heartbeat runner.
 *
 * Wired once at server boot via `startKaggleHeartbeat()` in geneweave's
 * `createGeneWeave()` factory. A single shared heartbeat (workerId
 * `geneweave-kaggle-worker`) drives every active Kaggle competition run by
 * (a) scheduling pending ticks for any agent with work in inbox/backlog,
 * (b) calling `heartbeat.tick(ctx)` to execute claimed ticks, and (c)
 * mirroring the resulting agent state into the `kgl_run_step` /
 * `kgl_run_event` ledger so the admin UI's run-detail timeline updates in
 * near real-time.
 *
 * Concurrency is set high enough (default 8) that a single heartbeat covers
 * many Kaggle pipelines running in parallel — each pipeline has 6 roles, so
 * 8 means 1+ run can fully tick in a single interval pass.
 */

import { weaveContext, type Model } from '@weaveintel/core';
import {
  createHeartbeat,
  createActionExecutor,
  type Heartbeat,
  type AttentionPolicy,
  type TaskHandler,
} from '@weaveintel/live-agents';
// Phase 5 — model routing flows exclusively through `weaveDbModelResolver`
// from `@weaveintel/live-agents-runtime`. The legacy `buildPlannerModel`
// helper and `resolveModelForRole` callback have been removed.
import type { DatabaseAdapter } from '../../db.js';
import type { ProviderConfig } from '../../chat.js';
import { getOrCreateModel } from '../../chat-runtime.js';
import { routeModel } from '../../chat-routing-utils.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getKaggleLiveStore } from './store.js';
import { createDbKagglePlaybookResolver } from './playbook-resolver.js';
import { registerKaggleHandlerKinds } from './handler-kinds.js';
import { getHandlerRegistry, syncHandlerKindsToDb } from '../handler-registry-boot.js';
import { createKaggleAttentionPolicy } from './agents.js';
import {
  resolveAttentionPolicyFromDb,
  weaveDbLiveAgentPolicy,
  weaveDbModelResolver,
  weaveLiveAgentFromDb,
} from '@weaveintel/live-agents-runtime';
import { DbToolPolicyResolver, DbToolRateLimiter } from '../../tool-policy-resolver.js';
import { DbToolAuditEmitter } from '../../tool-audit-emitter.js';
import { DbToolApprovalGate } from '../../tool-approval-gate.js';
import { DbCostLedgerSink, DbPricingResolver, readCostBreakdown } from '../../cost/db-cost-ledger.js';
import { wrapKaggleResolversWithCostLedger } from '../../cost/kaggle-cost-wiring.js';
import { DbCostPolicyResolver } from '../../cost/db-cost-policy-resolver.js';
import { createDbIntelScoreProvider } from '../../cost/db-intel-score-provider.js';
import {
  resolveCostGovernorBundle,
  wrapModelWithCacheHints,
  RunCostStateTracker,
  weaveModelCascadeResolver,
  wrapAuditEmitterWithCascadeTracker,
  weaveIntelGate,
  weaveBudgetGate,
  weaveCostLedgerFromBreakdown,
  weaveToolOutputTruncator,
  weaveIntentRagToolSubsetFilter,
  type ReasoningEffort,
  type ToolOutputTruncator,
  type CostBudgetGate,
} from '@weaveintel/cost-governor';
import type { ModelResolver } from '@weaveintel/live-agents';
import { createOpenAIEmbedder } from '../../cost/openai-embedder.js';
import { createDbToolEmbeddingStore } from '../../cost/db-tool-embedding-store.js';
import {
  getLlmEndpointPressure,
  isPressureBlocking,
  pressureStateKey,
  formatPressureReason,
  type EndpointPressure,
} from '../endpoint-pressure.js';

export interface StartKaggleHeartbeatOptions {
  db: DatabaseAdapter;
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
  /** Schedule + bridge interval in milliseconds (default 5_000). */
  intervalMs?: number;
  /**
   * Number of parallel tick() workers. Each worker runs an independent
   * `heartbeat.tick()` loop with its own workerId so a long-running ReAct
   * loop on one agent doesn't block ticks for other runs.
   *
   * There is no cap on the number of concurrent competitions — workers
   * round-robin through all SCHEDULED ticks across all active runs. The
   * worker count only controls how many ticks execute in parallel per
   * interval; queued ticks pick up on subsequent intervals. Scale via the
   * `KAGGLE_HEARTBEAT_WORKERS` env var (default 32) for high-density
   * deployments — set to e.g. 64 or 128 if competitions arrive faster than
   * they drain.
   */
  workers?: number;
  workerIdPrefix?: string;
  /**
   * Phase 4: Optional DB key from `live_attention_policies.key`.
   * When set the heartbeat uses the DB-driven factory to resolve the
   * attention policy. When omitted (default) falls back to the Kaggle-
   * specific `createKaggleAttentionPolicy('discoverer')` heuristic.
   */
  attentionPolicyKey?: string;
}

export interface KaggleHeartbeatHandle {
  stop(): Promise<void>;
}

const KAGGLE_ROLE_TO_STEP: Record<string, string> = {
  discoverer: 'kaggle_discoverer',
  strategist: 'kaggle_strategist',
  implementer: 'kaggle_implementer',
  validator: 'kaggle_validator',
  submitter: 'kaggle_submitter',
  observer: 'kaggle_observer',
};

const NOOP_MODEL: Model = {
  id: 'noop-kaggle-heartbeat',
  call: async () => ({ text: '' }),
} as unknown as Model;

/**
 * Build the candidate model list the SmartModelRouter chooses from. Mirrors
 * `ChatEngine.getAvailableModels()` in `chat.ts` so the live-agents heartbeat
 * picks among the same enabled `model_pricing` rows + configured-provider
 * fallbacks the chat path uses. Keeping the logic here local avoids pulling
 * the whole ChatEngine into the heartbeat boot path.
 */
async function listAvailableModelsForRouting(
  db: DatabaseAdapter,
  providers: Record<string, ProviderConfig>,
): Promise<Array<{ id: string; provider: string }>> {
  const seen = new Set<string>();
  const out: Array<{ id: string; provider: string }> = [];
  const configured = new Set(Object.keys(providers));
  try {
    const rows = await db.listModelPricing();
    for (const row of rows) {
      if (!row.enabled || !configured.has(row.provider)) continue;
      const key = `${row.provider}:${row.model_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: row.model_id, provider: row.provider });
    }
  } catch {
    /* DB lookup is best-effort */
  }
  // Same fallback list as ChatEngine — ensures routing has candidates even
  // when the operator hasn't seeded model_pricing yet.
  const FALLBACK_MODELS: Record<string, string[]> = {
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
    google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    ollama: ['llama3.1', 'qwen2.5', 'mistral'],
    llamacpp: ['local'],
    'llama-cpp': ['local'],
    mock: ['mock-model'],
  };
  for (const provider of configured) {
    const fb = FALLBACK_MODELS[provider];
    if (!fb) continue;
    for (const id of fb) {
      const key = `${provider}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, provider });
    }
  }
  return out;
}


/**
 * Scan every kaggle agent across active runs and ensure a SCHEDULED tick
 * row exists for any agent with pending inbox or open backlog. Without this
 * the heartbeat would have nothing to claim. Idempotent per-agent.
 *
 * Filters out paused/archived meshes and non-ACTIVE agents so operator pause
 * actions stop new work immediately (in-flight ticks still drain naturally).
 *
 * No cap on concurrent competitions — runs are paged in batches of
 * RUN_PAGE_SIZE and every page is processed in parallel. Scheduling cost
 * scales linearly with the active-run count; SQLite + Promise.all keep this
 * sub-second well into the thousands of agents.
 */
const RUN_PAGE_SIZE = 200;

// ─── Backoff / circuit-breaker on consecutive tick failures ──────────────
//
// When an agent tick keeps failing (e.g. OpenAI returns 429 quota-exceeded
// on every model call), the scheduler used to keep emitting a fresh tick
// every 30s forever. That burns rate-limit budget and floods the logs.
//
// Now: count trailing FAILED ticks since the last SUCCESS, and push the
// next attempt out exponentially. After CIRCUIT_OPEN_AT consecutive
// failures the agent is "circuit open" — no new ticks scheduled until an
// operator pauses/resumes the mesh or fixes the upstream and at least one
// tick succeeds. The current state is mirrored to `kgl_run_event` so the
// run-detail UI shows _why_ a step looks frozen.
//
// Backoff schedule indexed by trailing failure count (ms):
//   1  → 1 min       2  → 5 min       3  → 15 min
//   4  → 30 min      5+ → 60 min      10+ → circuit open
const FAILURE_BACKOFF_MS = [
  0,            // 0 failures — schedule normally
  60_000,       // 1 failure  — wait 1 min
  5 * 60_000,   // 2 failures — wait 5 min
  15 * 60_000,  // 3 failures — wait 15 min
  30 * 60_000,  // 4 failures — wait 30 min
];
const STEADY_STATE_BACKOFF_MS = 60 * 60_000; // 5+ failures — wait 1 h
const CIRCUIT_OPEN_AT = 10;

function pickBackoffMs(consec: number): number {
  if (consec <= 0) return 0;
  if (consec < FAILURE_BACKOFF_MS.length) return FAILURE_BACKOFF_MS[consec] ?? 0;
  return STEADY_STATE_BACKOFF_MS;
}

interface AgentBackoffState {
  consecutiveFailures: number;
  lastFailedAt: Date | null;
  lastError: string | null;
  circuitOpen: boolean;
}

async function getAgentBackoffState(
  db: DatabaseAdapter,
  agentId: string,
): Promise<AgentBackoffState> {
  const recent = await db.listRecentHeartbeatTicksForAgent(agentId, 20);
  let consec = 0;
  let lastFailedAt: Date | null = null;
  let lastError: string | null = null;
  for (const t of recent) {
    if (t.status !== 'COMPLETED') continue; // ignore SCHEDULED / IN_PROGRESS
    if (t.actionOutcomeStatus === 'FAILED') {
      if (consec === 0) {
        if (t.completedAt) lastFailedAt = new Date(t.completedAt);
        lastError = t.actionOutcomeProse;
      }
      consec++;
    } else {
      // First non-FAILED COMPLETED tick — chain ends.
      break;
    }
  }
  return {
    consecutiveFailures: consec,
    lastFailedAt,
    lastError,
    circuitOpen: consec >= CIRCUIT_OPEN_AT,
  };
}

// Module-level dedupe so we only emit one `agent_backoff` / `agent_circuit_open`
// run-event per escalation step (when the trailing failure count crosses to a
// higher value), not on every 5 s schedule pass.
const lastNotifiedFailureCount = new Map<string, number>();

// ─── Phase 5: Cross-process endpoint-health gate ─────────────────────────
//
// The per-agent trailing-FAILED counter (above) only sees this process'
// tick history. The shared resilience pipeline (Phase 2-4) records every
// LLM/HTTP call's success/429/5xx/circuit state into the global
// `endpoint_health` table — that's the cross-cutting "is upstream healthy?"
// view. If `openai:rest` has its circuit open, every Kaggle agent on the
// box should pause, not just the ones whose recent ticks happened to fail.
//
// The provider endpoint id list and the read+classify logic now live in the
// shared `endpoint-pressure.ts` so the kaggle heartbeat and the generic
// supervisor stay in sync.

// Module-level dedupe for endpoint-pressure events (one per state crossing,
// not per 5 s schedule pass).
const lastNotifiedEndpointState = new Map<string, string>();

async function getEndpointPressure(db: DatabaseAdapter): Promise<EndpointPressure> {
  return getLlmEndpointPressure(db);
}

async function maybeEmitEndpointPressureEvent(
  db: DatabaseAdapter,
  runId: string,
  agentId: string,
  roleSlug: string,
  pressure: EndpointPressure,
): Promise<void> {
  const stateKey = pressureStateKey(pressure);
  if (!stateKey) return;
  if (lastNotifiedEndpointState.get(agentId) === stateKey) return;
  lastNotifiedEndpointState.set(agentId, stateKey);
  const summary = formatPressureReason(roleSlug, pressure);
  try {
    const steps = await db.listKglRunSteps(runId);
    const stepRole = KAGGLE_ROLE_TO_STEP[roleSlug];
    const step = steps.find((s) => s.role === stepRole);
    await db.appendKglRunEvent({
      id: newUUIDv7(),
      run_id: runId,
      step_id: step?.id ?? null,
      kind: pressure.openEndpoints.length > 0 ? 'endpoint_circuit_open' : 'endpoint_rate_limited',
      agent_id: agentId,
      tool_key: null,
      summary,
      payload_json: JSON.stringify({
        openEndpoints: pressure.openEndpoints,
        rateLimitedEndpoint: pressure.rateLimitedEndpoint,
        rateLimitedUntil: pressure.rateLimitedUntil?.toISOString() ?? null,
      }),
    });
  } catch (err) {
    console.warn(
      '[kaggle-heartbeat] failed to emit endpoint-pressure event:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function maybeEmitBackoffEvent(
  db: DatabaseAdapter,
  runId: string,
  agentId: string,
  roleSlug: string,
  state: AgentBackoffState,
  nextAttemptAt: Date | null,
): Promise<void> {
  const last = lastNotifiedFailureCount.get(agentId) ?? 0;
  if (state.consecutiveFailures <= last) return;
  lastNotifiedFailureCount.set(agentId, state.consecutiveFailures);
  const errSnippet = (state.lastError ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 180);
  const nextStr = nextAttemptAt ? nextAttemptAt.toISOString() : 'manual resume';
  const summary = state.circuitOpen
    ? `${roleSlug} circuit open: ${state.consecutiveFailures} consecutive failures. No further ticks scheduled until mesh paused/resumed or upstream fixed. Last error: ${errSnippet}`
    : `${roleSlug} backing off: ${state.consecutiveFailures} consecutive failures. Next attempt: ${nextStr}. Last error: ${errSnippet}`;
  try {
    const steps = await db.listKglRunSteps(runId);
    const stepRole = KAGGLE_ROLE_TO_STEP[roleSlug];
    const step = steps.find((s) => s.role === stepRole);
    await db.appendKglRunEvent({
      id: newUUIDv7(),
      run_id: runId,
      step_id: step?.id ?? null,
      kind: state.circuitOpen ? 'agent_circuit_open' : 'agent_backoff',
      agent_id: agentId,
      tool_key: null,
      summary,
      payload_json: JSON.stringify({
        consecutiveFailures: state.consecutiveFailures,
        lastFailedAt: state.lastFailedAt?.toISOString() ?? null,
        nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
        lastError: state.lastError,
        circuitOpen: state.circuitOpen,
      }),
    });
  } catch (err) {
    console.warn(
      '[kaggle-heartbeat] failed to emit backoff event:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function listAllRunningRuns(db: DatabaseAdapter): Promise<Array<Awaited<ReturnType<DatabaseAdapter['listKglCompetitionRuns']>>[number]>> {
  const out: Array<Awaited<ReturnType<DatabaseAdapter['listKglCompetitionRuns']>>[number]> = [];
  let offset = 0;
  for (;;) {
    const page = await db.listKglCompetitionRuns({ status: 'running', limit: RUN_PAGE_SIZE, offset });
    out.push(...page);
    if (page.length < RUN_PAGE_SIZE) break;
    offset += RUN_PAGE_SIZE;
  }
  return out;
}

async function scheduleDueTicks(db: DatabaseAdapter, workerId: string): Promise<number> {
  const store = await getKaggleLiveStore();
  const runs = await listAllRunningRuns(db);
  if (runs.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const bucket = Math.floor(Date.now() / 30_000); // 30s dedupe window

  // Phase 5 — one global endpoint-health snapshot per scheduling pass.
  // If any LLM provider's circuit is open, no kaggle agent should be
  // ticked regardless of its own recent history. Computed once and
  // shared across every scheduleRun call below.
  const endpointPressure = await getEndpointPressure(db);
  const endpointBlocked = endpointPressure.openEndpoints.length > 0
    || (endpointPressure.rateLimitedUntil !== null && endpointPressure.rateLimitedUntil.getTime() > Date.now());

  const scheduleAgent = async (agentId: string): Promise<number> => {
    const [inbox, backlog] = await Promise.all([
      store.listMessagesForRecipient('AGENT', agentId),
      store.listBacklogForAgent(agentId),
    ]);
    const hasPendingMsg = inbox.some(
      (m) => m.status === 'PENDING' || m.status === 'DELIVERED' || m.status === 'READ',
    );
    const hasOpenBacklog = backlog.some(
      (b) => b.status === 'PROPOSED' || b.status === 'ACCEPTED' || b.status === 'IN_PROGRESS',
    );
    if (!hasPendingMsg && !hasOpenBacklog) return 0;
    // Deterministic tick id per agent per bucket — upserts on PK so repeated
    // scheduling within the same bucket replaces the same row. Once a worker
    // claims it, the next bucket's SCHEDULED upsert won't override an
    // in-flight claim (claimNextTicks filters status=SCHEDULED only).
    const tickId = `tick:${agentId}:${bucket}`;
    const existing = await store.loadHeartbeatTick(tickId);
    if (existing && existing.status !== 'SCHEDULED') return 0;
    await store.saveHeartbeatTick({
      id: tickId,
      agentId,
      scheduledFor: nowIso,
      pickedUpAt: null,
      completedAt: null,
      workerId: '',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    });
    return 1;
  };

  const scheduleRun = async (run: { id: string; mesh_id: string | null }): Promise<number> => {
    if (!run.mesh_id) return 0;
    const meshId = run.mesh_id;
    // Skip meshes operator has paused/archived. Defense-in-depth: even if a
    // kgl_competition_run row is still 'running', a paused mesh means
    // "operator wants no new work" — honor that here so ticks don't pile up.
    const mesh = await store.loadMesh(meshId);
    if (!mesh || mesh.status !== 'ACTIVE') return 0;
    const agents = await store.listAgents(meshId);
    const activeAgents = agents.filter((a) => a.status === 'ACTIVE');
    if (activeAgents.length === 0) return 0;
    const counts = await Promise.all(
      activeAgents.map(async (a) => {
        // Phase 5 — cross-process endpoint-health gate. Honored before the
        // local trailing-FAILED check so a global provider outage skips
        // every agent in one pass without polluting their per-agent backoff
        // chains.
        if (endpointBlocked) {
          await maybeEmitEndpointPressureEvent(db, run.id, a.id, a.role, endpointPressure);
          return 0;
        } else {
          // Healthy provider — clear the dedupe so the next pressure event
          // re-emits at the first crossing.
          lastNotifiedEndpointState.delete(a.id);
        }
        // Backoff / circuit-breaker — skip ticks for agents whose recent
        // history is all failures. Without this a permanently-broken upstream
        // (OpenAI 429, network outage, etc.) gets retried every 30s forever.
        const backoff = await getAgentBackoffState(db, a.id);
        if (backoff.consecutiveFailures > 0) {
          if (backoff.circuitOpen) {
            await maybeEmitBackoffEvent(db, run.id, a.id, a.role, backoff, null);
            return 0;
          }
          const backoffMs = pickBackoffMs(backoff.consecutiveFailures);
          if (backoff.lastFailedAt) {
            const nextAttemptAt = new Date(backoff.lastFailedAt.getTime() + backoffMs);
            if (Date.now() < nextAttemptAt.getTime()) {
              await maybeEmitBackoffEvent(db, run.id, a.id, a.role, backoff, nextAttemptAt);
              return 0;
            }
          }
        } else {
          // Healthy tick chain — reset notification dedupe so the next time
          // failures recur we re-emit the first backoff event.
          lastNotifiedFailureCount.delete(a.id);
        }
        return scheduleAgent(a.id);
      }),
    );
    return counts.reduce((s, n) => s + n, 0);
  };

  const perRun = await Promise.all(runs.map((r) => scheduleRun(r)));
  void workerId;
  return perRun.reduce((s, n) => s + n, 0);
}

/**
 * After each tick, mirror live-agents state (per role agent backlog/inbox)
 * into the `kgl_run_step` ledger so the admin UI's pipeline timeline reflects
 * real progress. Idempotent — only writes when the step status would change.
 */
async function bridgeRunState(db: DatabaseAdapter): Promise<void> {
  const store = await getKaggleLiveStore();
  const runs = await listAllRunningRuns(db);
  await Promise.all(runs.map((run) => bridgeOneRun(db, store, run)));
}

async function bridgeOneRun(
  db: DatabaseAdapter,
  store: Awaited<ReturnType<typeof getKaggleLiveStore>>,
  run: { id: string; mesh_id: string | null; status: string; summary?: string | null },
): Promise<void> {
  if (!run.mesh_id) return;
  const meshId = run.mesh_id;
  const steps = await db.listKglRunSteps(run.id);
  const stepByRole = new Map(steps.map((s) => [s.role, s] as const));
  // Provisioned meshes give every agent a UUID id, not a synthetic
  // `${meshId}::${role}` id. Resolve by role from the StateStore so the
  // bridge actually finds the correct agent. Legacy template-based meshes
  // (now removed) used the synthetic id; we keep the lookup robust either way.
  const meshAgents = await store.listAgents(meshId);
  const agentByRole = new Map(meshAgents.map((a) => [a.role, a] as const));
  for (const [roleSlug, stepRole] of Object.entries(KAGGLE_ROLE_TO_STEP)) {
    const step = stepByRole.get(stepRole);
    if (!step) continue;
    const liveAgent = agentByRole.get(roleSlug);
    if (!liveAgent) continue;
    const agentId = liveAgent.id;
    const [backlog, inbox] = await Promise.all([
      store.listBacklogForAgent(agentId),
      store.listMessagesForRecipient('AGENT', agentId),
    ]);
    const inProgress = backlog.find((b) => b.status === 'IN_PROGRESS');
    const completed = backlog.filter((b) => b.status === 'COMPLETED').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
    const open = backlog.find((b) => b.status === 'PROPOSED' || b.status === 'ACCEPTED');
    // Inbox-driven activity: roles after the discoverer (strategist,
    // implementer, validator, submitter, observer) typically receive
    // TASK messages from upstream agents and may execute via ReAct loops
    // without ever creating a backlog item. Treat any pending/delivered
    // inbox or any handled inbox message as evidence the step is active.
    const hasOpenInbox = inbox.some((m) => m.status === 'PENDING' || m.status === 'DELIVERED' || m.status === 'READ');
    const hasHandledInbox = inbox.some((m) => m.status === 'PROCESSED');
    // running: in-progress backlog OR open backlog OR open inbox OR
    // already-handled inbox (means the agent has at least started work).
    if (step.status === 'pending' && (inProgress || open || hasOpenInbox || hasHandledInbox)) {
      await db.updateKglRunStep(step.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        agent_id: agentId,
      });
      await db.appendKglRunEvent({
        id: newUUIDv7(),
        run_id: run.id,
        step_id: step.id,
        kind: 'step_started',
        agent_id: agentId,
        tool_key: null,
        summary: `${roleSlug} agent picked up work.`,
        payload_json: null,
      });
    }
    // completed: latest backlog item is COMPLETED and no remaining open work
    if ((step.status === 'pending' || step.status === 'running') && completed && !inProgress && !open && !hasOpenInbox) {
      const summary = (completed.title || completed.description || `${roleSlug} step complete`).slice(0, 240);
      await db.updateKglRunStep(step.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        summary,
        agent_id: agentId,
      });
      await db.appendKglRunEvent({
        id: newUUIDv7(),
        run_id: run.id,
        step_id: step.id,
        kind: 'step_completed',
        agent_id: agentId,
        tool_key: null,
        summary,
        payload_json: null,
      });
    }
  }
  // If the submitter step is completed, mark the whole run completed.
  const submitterStep = stepByRole.get('kaggle_submitter');
  if (submitterStep && submitterStep.status === 'completed' && run.status === 'running') {
    await db.updateKglCompetitionRun(run.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      summary: submitterStep.summary ?? 'Pipeline reached submitter step.',
    });
  }
}

/**
 * Boot the global Kaggle live-agents heartbeat. Returns a handle whose
 * `stop()` clears the interval and stops the heartbeat. Safe to call once
 * at server startup; failure inside any single tick is logged and the
 * loop continues.
 */
export async function startKaggleHeartbeat(opts: StartKaggleHeartbeatOptions): Promise<KaggleHeartbeatHandle> {
  const intervalMs = opts.intervalMs ?? 5_000;
  // No cap on concurrent competitions — workers process the global queue
  // of SCHEDULED ticks round-robin. Worker count only controls per-interval
  // parallelism; pending ticks naturally roll forward. Default 32 is a sane
  // out-of-the-box value; operators set `KAGGLE_HEARTBEAT_WORKERS` to scale
  // arbitrarily (e.g. 128 or 256) when many competitions run simultaneously.
  const envWorkers = Number(process.env['KAGGLE_HEARTBEAT_WORKERS'] ?? '');
  const workerCount = Math.max(
    1,
    opts.workers ?? (Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : 32),
  );
  const workerIdPrefix = opts.workerIdPrefix ?? 'geneweave-kaggle-worker';

  const store = await getKaggleLiveStore();
  const playbookResolver = createDbKagglePlaybookResolver(opts.db);

  // ---------------------------------------------------------------------
  // Per-tick model routing — Phase 5 (live-agents capability parity).
  //
  // All routing flows through `weaveDbModelResolver` from
  // `@weaveintel/live-agents-runtime`. The runtime resolver owns the
  // listCandidates → routeModel → getModel pipeline; we inject geneweave's:
  //   • candidate enumerator (`listAvailableModelsForRouting`)
  //   • routing brain (`routeModel`)
  //   • model factory (`getOrCreateModel`)
  // so no DB types leak into the package.
  //
  // The legacy `buildPlannerModel()` and `resolveModelForRole(role, hint)`
  // shim were removed in Phase 5 — `createKaggleRoleHandlers` now consumes
  // `modelResolver` exclusively.
  // ---------------------------------------------------------------------
  const dbModelResolver = weaveDbModelResolver({
    listCandidates: () => listAvailableModelsForRouting(opts.db, opts.providers),
    routeModel: async (cands, hints) => {
      const routed = await routeModel(opts.db, cands, [], {
        taskType: hints.taskType,
        prompt: hints.prompt,
      });
      if (!routed) return null;
      return {
        provider: routed.provider,
        modelId: routed.modelId,
        taskKey: routed.taskKey,
        experimentName: routed.experimentName,
      };
    },
    getOrCreateModel: async (provider, modelId) => {
      const cfg = opts.providers[provider];
      if (!cfg) throw new Error(`no provider config for ${provider}`);
      return getOrCreateModel(provider, modelId, cfg);
    },
    roleTaskMap: {
      strategist: 'reasoning',
      validator: 'analysis',
      observer: 'analysis',
      discoverer: 'reasoning',
    },
    log: (msg) => console.log('[kaggle-heartbeat]', msg),
  });

  // Build the shared DB-backed policy bundle once. Both the handler-kind
  // registration (Phase A) and the per-tick handler resolution (Phase C)
  // reuse it so chat / generic-supervisor / kaggle paths share identical
  // gating and audit semantics.
  //
  // Phase 1 (COST_CONTROL_PLAN.md): wrap the model resolver and audit
  // emitter with the cost ledger so every model call and tool invocation
  // emits a `cost.tick` row keyed by the active kaggle competition run.
  // Behaviour is unchanged — only telemetry is added.
  const costLedgerSink = new DbCostLedgerSink(opts.db);
  const pricingResolver = new DbPricingResolver(opts.db);
  const innerAuditEmitter = new DbToolAuditEmitter(opts.db);
  const wrapped = wrapKaggleResolversWithCostLedger({
    db: opts.db,
    baseResolver: dbModelResolver,
    auditInner: innerAuditEmitter,
    sink: costLedgerSink,
    pricing: pricingResolver,
  });
  const costAwareModelResolver = wrapped.modelResolver;

  // Phase 4 (COST_CONTROL_PLAN.md §5.1): wire model cascade between the
  // cost-ledger resolver and the prompt-caching wrapper. Resolver chain:
  //   caching -> cascade -> cost-ledger -> base (DB routing)
  // Per-supervisor in-memory tracker; per-agent state keyed by `agent.id`
  // (synthesized as runId). 1-hour TTL evicts stale agent state.
  const cascadeTracker = new RunCostStateTracker({ ttlMs: 60 * 60 * 1000 });
  const cascadeModelResolver = weaveModelCascadeResolver({
    base: costAwareModelResolver,
    resolveConfig: async (ctx) => {
      try {
        const { bundle } = await resolveCostGovernorBundle(
          new DbCostPolicyResolver(opts.db),
          {
            ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
            ...(ctx?.meshId ? { meshId: ctx.meshId } : {}),
            ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
          },
        );
        return bundle.policy.modelCascade ?? null;
      } catch {
        return null;
      }
    },
    loadModel: async (ref) => {
      const provider = ref.provider ?? opts.defaultProvider;
      const cfg = opts.providers[provider];
      if (!cfg) return undefined;
      try {
        return await getOrCreateModel(provider, ref.modelId, cfg);
      } catch {
        return undefined;
      }
    },
    tracker: cascadeTracker,
    log: (msg) => console.log('[kaggle-heartbeat]', msg),
  });

  // Phase 3 (COST_CONTROL_PLAN.md §5.3): layer prompt-caching cache-key
  // hints on top of the cost-ledger-wrapped resolver. Each tick resolves
  // the effective `CostPolicy` via `DbCostPolicyResolver` and, when
  // `promptCaching.enabled`, wraps the returned Model with
  // `wrapModelWithCacheHints` so providers receive a stable
  // `prompt_cache_key` (OpenAI) or system-prompt cache_control block
  // (Anthropic). Falls through to the unwrapped model on any error.
  const cachedCostPolicyResolver = new DbCostPolicyResolver(opts.db);
  const cachingModelResolver: ModelResolver = {
    async resolve(ctx) {
      // Synthesize runId for the cascade tracker when not present.
      const runId = ctx?.runId ?? ctx?.agentId;
      const m = await cascadeModelResolver.resolve({
        ...(ctx ?? {}),
        ...(runId ? { runId } : {}),
      });
      if (!m) return undefined;
      try {
        const tenantId = ctx?.tenantId;
        const meshId = ctx?.meshId;
        const agentId = ctx?.agentId;
        const { bundle } = await resolveCostGovernorBundle(cachedCostPolicyResolver, {
          ...(tenantId ? { tenantId } : {}),
          ...(meshId ? { meshId } : {}),
          ...(agentId ? { agentId } : {}),
        });
        if (!bundle.policy.promptCaching.enabled) return m;
        const role = ctx?.role;
        const modelId = m.info?.modelId;
        return wrapModelWithCacheHints(m, bundle.cacheShaper, {
          resolveContext: () => ({
            provider: m.info.provider,
            ...(role ? { role } : {}),
            ...(modelId ? { modelId } : {}),
            ...(meshId ? { meshId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(tenantId ? { tenantId } : {}),
          }),
        });
      } catch {
        return m;
      }
    },
  };

  const liveAgentPolicy = weaveDbLiveAgentPolicy({
    policyResolver: new DbToolPolicyResolver(opts.db),
    approvalGate: new DbToolApprovalGate(opts.db),
    rateLimiter: new DbToolRateLimiter(opts.db),
    // Phase 4 — wrap the ledger-decorated audit emitter so every failed
    // tool call increments the cascade tracker. Forwarding to the inner
    // emitter is best-effort and unaffected by tracker updates.
    auditEmitter: wrapAuditEmitterWithCascadeTracker(
      wrapped.auditEmitter,
      cascadeTracker,
      // chatId === agent.id for live-agent tool calls (set by
      // weaveDbLiveAgentPolicy default resolution context).
      { resolveRunId: (e) => e.chatId ?? null },
    ),
  });

  // Best-effort observer: every successful `kaggle_push_kernel` from the
  // strategist's ReAct loop persists a structured `kgl_run_event` row
  // (kind=`kernel_pushed`) capturing the canonical Kaggle-returned
  // `kernelRef`, version, requested slug/title, codeBytes, pushedAt — so
  // operators have a queryable ledger of which kernels were pushed for
  // each run instead of having to scrape `tool_audit_events.output_preview`
  // JSON. Strategist's prepare() decorates each record with meshId/agentId
  // before we see it. Throws are swallowed by the underlying tool.
  const onKernelPushed = async (
    record: import('./kaggle-tools.js').KernelPushRecord,
  ): Promise<void> => {
    try {
      const meshId = record.meshId;
      if (!meshId) return;
      const runs = await opts.db.listKglCompetitionRuns({ status: 'running' });
      const run = runs.find((r) => r.mesh_id === meshId);
      if (!run) return;
      await opts.db.appendKglRunEvent({
        id: newUUIDv7(),
        run_id: run.id,
        step_id: null,
        kind: 'kernel_pushed',
        agent_id: record.agentId ?? null,
        tool_key: 'kaggle_push_kernel',
        summary: `Pushed ${record.kernelRef} v${record.versionNumber ?? '?'}`,
        payload_json: JSON.stringify({
          kernelRef: record.kernelRef,
          kernelUrl: record.kernelUrl,
          versionNumber: record.versionNumber,
          competitionRef: record.competitionRef,
          requestedSlug: record.requestedSlug,
          requestedTitle: record.requestedTitle,
          codeBytes: record.codeBytes,
          pushedAt: record.pushedAt,
          ...(record.localArtifactPath ? { localArtifactPath: record.localArtifactPath } : {}),
          ...(record.localArtifactError ? { localArtifactError: record.localArtifactError } : {}),
        }),
      });
    } catch (err) {
      console.error(
        '[kaggle-heartbeat] onKernelPushed persistence failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Best-effort observer: every kaggle_* tool that throws KaggleRateLimitError
  // (per-account 429 or open circuit breaker) fires this once per tick. We
  // persist a `kgl_run_event` (kind=`tool_blocked`) so operator-facing
  // run-detail surfaces the Kaggle account-pressure pause as a first-class
  // signal — separate from generic `tool_audit_events` rows. Subsequent
  // tools in the same tick short-circuit with `tick_blocked` and do NOT
  // re-fire this observer (single-shot per tick is enforced upstream).
  const onToolBlocked = async (
    record: import('./kaggle-tools.js').ToolBlockedRecord,
  ): Promise<void> => {
    try {
      const meshId = record.meshId;
      if (!meshId) return;
      const runs = await opts.db.listKglCompetitionRuns({ status: 'running' });
      const run = runs.find((r) => r.mesh_id === meshId);
      if (!run) return;
      await opts.db.appendKglRunEvent({
        id: newUUIDv7(),
        run_id: run.id,
        step_id: null,
        kind: 'tool_blocked',
        agent_id: record.agentId ?? null,
        tool_key: record.toolName,
        summary:
          `Kaggle tool ${record.toolName} blocked: account "${record.account}" rate-limited ` +
          `(retryAfter=${record.retryAfterSeconds}s, breakerOpen=${record.breakerOpen})`,
        payload_json: JSON.stringify({
          toolName: record.toolName,
          reason: record.reason,
          account: record.account,
          retryAfterSeconds: record.retryAfterSeconds,
          breakerOpen: record.breakerOpen,
          message: record.message,
          blockedAt: record.blockedAt,
        }),
      });
    } catch (err) {
      console.error(
        '[kaggle-heartbeat] onToolBlocked persistence failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Per-tick factory for read-only run-scoped trace tools. Resolves the
  // strategist's CURRENT competition run from its mesh id (same pattern
  // as the two observers above) and constructs a fresh ToolRegistry
  // bound to that single runId. The LLM cannot pass a runId argument to
  // any of the tools — every read is structurally scoped to the current
  // run only, so parallel competition runs on other meshes are never
  // visible.
  const traceToolsFactory = async ({
    meshId,
  }: {
    meshId: string;
    agentId?: string;
  }): Promise<import('@weaveintel/core').ToolRegistry | null> => {
    try {
      const runs = await opts.db.listKglCompetitionRuns({ status: 'running' });
      const run = runs.find((r) => r.mesh_id === meshId);
      if (!run) return null;
      const { createKaggleTraceTools } = await import('./trace-tools.js');
      return createKaggleTraceTools({
        runId: run.id,
        db: opts.db,
        log: (m) => console.log('[kaggle-trace-tools]', m),
      });
    } catch (err) {
      console.error(
        '[kaggle-heartbeat] traceToolsFactory failed:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  };

  // Cost Governor Phase 5 (lever L3 — dynamic tool subset). Per-tick async
  // closure invoked by the strategist `prepare()` AFTER the full kaggle +
  // trace tool registry is assembled. Resolves the effective `CostPolicy`
  // via the cached resolver, derives a logical `phase` from the active
  // `kgl_competition_run` row (no kernel pushed yet → 'discovery'; one
  // kernel pushed → 'kernel'; two or more pushes → 'improvement'), then
  // calls `bundle.toolFilter(toolKeys, ctx)` which reads operator-edited
  // `cost_policies.levers_json.toolSubset.phases` to decide which tool keys
  // to keep this tick. NEVER load-bearing — every error path returns null
  // (pass-through) so the kaggle agent always has its full tool registry.
  const costToolFilter = async (ctx: {
    meshId: string;
    agentId?: string;
    toolKeys: readonly string[];
    goal?: string;
  }): Promise<readonly string[] | null> => {
    try {
      const { bundle } = await resolveCostGovernorBundle(cachedCostPolicyResolver, {
        meshId: ctx.meshId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      });

      // Phase 8: intent-RAG branch. When the resolved policy selects the
      // 'intent-rag' tool-subset strategy, swap the deterministic phase
      // map for cosine-similarity ranking against pre-warmed embeddings.
      // No embedder (e.g. missing OPENAI_API_KEY) → graceful pass-through.
      if (bundle.policy.toolSubset.strategy === 'intent-rag') {
        const embedder = createOpenAIEmbedder();
        if (!embedder) return null;
        const store = createDbToolEmbeddingStore({ db: opts.db, modelId: embedder.modelId });
        const irFilter = weaveIntentRagToolSubsetFilter({
          config: bundle.policy.toolSubset,
          embedder,
          embeddingStore: store,
          goalResolver: (c) => (typeof (c as { goal?: unknown }).goal === 'string' ? ((c as { goal: string }).goal) : null),
        });
        return await irFilter(ctx.toolKeys, {
          ...(ctx.goal ? { goal: ctx.goal } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          meshId: ctx.meshId,
          agentRole: 'strategist',
        });
      }

      // Default (Phase 5) path: deterministic phase map.
      let phase: string | undefined;
      try {
        const runs = await opts.db.listKglCompetitionRuns({ status: 'running' });
        const run = runs.find((r) => r.mesh_id === ctx.meshId);
        if (run) {
          const events = await opts.db.listKglRunEvents(run.id, { limit: 500 });
          const pushCount = events.filter((e) => e.kind === 'kernel_pushed').length;
          phase = pushCount === 0 ? 'discovery' : pushCount === 1 ? 'kernel' : 'improvement';
        }
      } catch {
        /* phase undefined — filter will treat as missing-phase pass-through */
      }
      return await bundle.toolFilter(ctx.toolKeys, {
        ...(phase ? { phase } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        meshId: ctx.meshId,
        agentRole: 'strategist',
      });
    } catch (err) {
      console.warn(
        '[kaggle-heartbeat] costToolFilter failed; pass-through:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  };

  // Cost Governor Phase 6 (lever L4 — intel-gated prompt sections). Per-tick
  // closure invoked by the strategist `prepare()` to decide whether to drop
  // the CV_SCORES addendum (`intel_header` section key) or truncate the
  // verbatim operator-seed body (`intel_snippets` section key). Resolves
  // the effective `CostPolicy` via the cached resolver, gets the run-state
  // intel score from `DbIntelScoreProvider` (signals: objective set, title
  // set, step_completed events, kernel_pushed events, step_count >= 3),
  // and translates the score into a `PromptShape` via `weaveIntelGate`.
  // NEVER load-bearing — every error path returns null (keep all sections).
  const dbIntelScoreProvider = createDbIntelScoreProvider({ db: opts.db });
  const intelGate = async (ctx: {
    meshId: string;
    agentId?: string;
  }): Promise<import('@weaveintel/cost-governor').PromptShape | null> => {
    try {
      const { bundle } = await resolveCostGovernorBundle(cachedCostPolicyResolver, {
        meshId: ctx.meshId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      });
      if (!bundle.policy.intelGating.enabled) return null;
      const shaper = weaveIntelGate(bundle.policy.intelGating, dbIntelScoreProvider);
      return await shaper({
        meshId: ctx.meshId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      });
    } catch (err) {
      console.warn(
        '[kaggle-heartbeat] intelGate failed; pass-through:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  };

  // Cost Governor — per-tick L6/L7/L8/L9 resolver. Replaces the prior
  // boot-time bundle resolution so that mesh- and agent-scoped
  // `capability_policy_bindings` rows (the same chain used by per-tick
  // L1/L2/L3/L4 levers) authoritatively override workflow / tenant defaults
  // for max-steps, reasoning-effort, tool-output truncation, and the
  // budget gate. Strategist invokes this on every tick with the live
  // `(meshId, agentId)`. Throws fall back to no overrides — never
  // load-bearing.
  const phase7Resolver = async (
    ctx: { meshId: string; agentId?: string },
  ): Promise<{
    maxStepsCap?: number;
    reasoningEffortHint?: ReasoningEffort;
    toolOutputTruncator?: ToolOutputTruncator;
    budgetGate?: CostBudgetGate;
  }> => {
    const { bundle } = await resolveCostGovernorBundle(cachedCostPolicyResolver, {
      meshId: ctx.meshId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      workflowId: 'kaggle',
    });
    const out: {
      maxStepsCap?: number;
      reasoningEffortHint?: ReasoningEffort;
      toolOutputTruncator?: ToolOutputTruncator;
      budgetGate?: CostBudgetGate;
    } = {};
    if (bundle.policy.maxStepsCap !== undefined) out.maxStepsCap = bundle.policy.maxStepsCap;
    if (bundle.policy.reasoningEffort) out.reasoningEffortHint = bundle.policy.reasoningEffort;
    if (bundle.policy.toolOutputTruncation) {
      out.toolOutputTruncator = weaveToolOutputTruncator(bundle.policy.toolOutputTruncation);
    }
    const ceiling = bundle.policy.budgetCeilingUsd;
    if (ceiling && Number.isFinite(ceiling) && ceiling > 0) {
      const ledger = weaveCostLedgerFromBreakdown({
        readBreakdown: (runId) => readCostBreakdown(opts.db, runId),
      });
      out.budgetGate = weaveBudgetGate({
        ledger,
        ceilingUsd: ceiling,
        // Same convention as Phase 4 cascade tracker — strategist
        // synthesizes runId=agentId before invoking the gate.
        runIdResolver: (gctx) => gctx.runId ?? null,
        log: (m) => console.warn('[kaggle-heartbeat:budget-gate]', m),
      });
    }
    return out;
  };

  // Phase A — register the 10 kaggle handler kinds against the shared
  // registry so the action executor can resolve a `TaskHandler` purely from
  // a `live_agent_handler_bindings` row. Idempotent: silently skips kinds
  // already registered. Re-runs syncHandlerKindsToDb so the rows reach
  // `live_handler_kinds` for admin visibility.
  const handlerRegistry = getHandlerRegistry();
  try {
    registerKaggleHandlerKinds(handlerRegistry, {
      modelResolver: cachingModelResolver,
      playbookResolver,
      db: opts.db,
      log: (msg) => console.log('[kaggle-handler-kinds]', msg),
      policy: liveAgentPolicy,
      onKernelPushed,
      onToolBlocked,
      traceToolsFactory,
      costToolFilter,
      intelGate,
      phase7Resolver,
    });
    await syncHandlerKindsToDb(opts.db, handlerRegistry);
  } catch (err) {
    console.error(
      '[kaggle-heartbeat] handler-kind registration failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Phase C — per-tick handler resolution from DB bindings.
  //
  // For each StartTask/ContinueTask action the action executor dispatches by
  // `agent.role` to a TaskHandler. The shim below ignores in-code role
  // tables and instead resolves the agent's enabled `live_agent_handler_bindings`
  // row, looks up the handler kind in the shared registry, and invokes it.
  // This makes the kaggle pipeline behavior fully DB-driven: operators can
  // swap an agent between e.g. `kaggle.strategist.agentic` and
  // `kaggle.strategist.deterministic` purely via the admin UI.
  //
  // The shim is registered under all 6 kaggle role keys so the dispatcher
  // routes every kaggle agent to it.
  const dbDrivenHandler: TaskHandler = async (action, execCtx, ctx) => {
    const agentId = execCtx.agent.id;
    // Defense-in-depth: the scheduler already filters PAUSED meshes/agents
    // when emitting NEW ticks, but stale SCHEDULED ticks can persist across
    // server restarts (the la_entities table outlives the in-process loop)
    // and operator pause actions can land between claim and execute. Re-check
    // status here so a paused agent or paused mesh drops the tick instantly
    // without invoking the model — critical for not burning paid quota on
    // abandoned/paused work.
    const liveAgent = await store.loadAgent(agentId);
    if (!liveAgent || liveAgent.status !== 'ACTIVE') {
      return { completed: false, summaryProse: `Agent status=${liveAgent?.status ?? 'missing'} — skipping tick.` };
    }
    const mesh = await store.loadMesh(liveAgent.meshId);
    if (!mesh || mesh.status !== 'ACTIVE') {
      return { completed: false, summaryProse: `Mesh status=${mesh?.status ?? 'missing'} — skipping tick.` };
    }
    const { handler } = await weaveLiveAgentFromDb(opts.db, agentId, {
      modelResolver: cachingModelResolver,
      policy: liveAgentPolicy,
      handlerRegistry,
      logger: (msg) => console.log('[kaggle-heartbeat][db-handler]', msg),
    });
    return handler(action, execCtx, ctx);
  };
  const taskHandlers: Record<string, TaskHandler> = {
    discoverer: dbDrivenHandler,
    strategist: dbDrivenHandler,
    implementer: dbDrivenHandler,
    validator: dbDrivenHandler,
    submitter: dbDrivenHandler,
    observer: dbDrivenHandler,
  };
  const actionExecutor = createActionExecutor({ taskHandlers });

  // Phase 4: Resolve attention policy from DB when a key is configured;
  // otherwise fall back to the Kaggle-specific discoverer heuristic for
  // full backward compatibility. This lets operators switch to any DB-driven
  // policy (e.g. 'heuristic.inbox-first', 'cron.hourly') via the admin UI
  // without touching code.
  const attentionPolicy: AttentionPolicy = opts.attentionPolicyKey
    ? await resolveAttentionPolicyFromDb(opts.db, opts.attentionPolicyKey, {
        logger: (msg) => console.log('[kaggle-heartbeat][attention-factory]', msg),
      })
    : createKaggleAttentionPolicy('discoverer');

  // Build N independent heartbeat workers. Each has its own workerId so the
  // claimNextTicks lease isolates them — a long-running ReAct loop in worker
  // 0 can't block ticks on workers 1..N-1, giving us real parallel pipeline
  // execution across many concurrent Kaggle competition runs.
  const workers: Array<{ id: string; heartbeat: Heartbeat; busy: boolean }> = [];
  for (let i = 0; i < workerCount; i++) {
    const id = `${workerIdPrefix}-${i}`;
    workers.push({
      id,
      busy: false,
      heartbeat: createHeartbeat({
        stateStore: store,
        workerId: id,
        concurrency: 1, // one tick per worker; parallelism comes from N workers
        model: NOOP_MODEL,
        attentionPolicy,
        actionExecutor,
      }),
    });
  }

  let stopped = false;
  let scheduleInFlight = false;

  // Schedule + bridge runs every interval. Cheap, must not block tick loops.
  const scheduleAndBridge = async (): Promise<void> => {
    if (stopped || scheduleInFlight) return;
    scheduleInFlight = true;
    try {
      await scheduleDueTicks(opts.db, workerIdPrefix);
      await bridgeRunState(opts.db);
    } catch (err) {
      console.error('[kaggle-heartbeat] schedule/bridge failed:', err instanceof Error ? err.message : String(err));
    } finally {
      scheduleInFlight = false;
    }
  };

  // Each worker independently calls heartbeat.tick() in a loop. Workers are
  // not blocked by other workers — only by their own currently-running tick.
  const runWorker = async (w: { id: string; heartbeat: Heartbeat; busy: boolean }): Promise<void> => {
    if (stopped || w.busy) return;
    w.busy = true;
    try {
      await w.heartbeat.tick(weaveContext({ userId: 'human:geneweave-system' }));
    } catch (err) {
      console.error(`[kaggle-heartbeat] worker ${w.id} tick failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      w.busy = false;
    }
  };

  const ticker = setInterval(() => {
    void scheduleAndBridge();
    for (const w of workers) {
      void runWorker(w);
    }
  }, intervalMs);
  ticker.unref();

  console.log(
    `[kaggle-heartbeat] started (workers=${workerCount} intervalMs=${intervalMs} planner=agentic[modelResolver])`,
  );

  return {
    async stop() {
      stopped = true;
      clearInterval(ticker);
      await Promise.all(workers.map((w) => w.heartbeat.stop()));
    },
  };
}
