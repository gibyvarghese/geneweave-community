/**
 * Phase 5 — Optional generic supervisor boot.
 *
 * Wires `createHeartbeatSupervisor()` from `@weaveintel/live-agents-runtime`
 * into the GeneWeave process. Off by default — enable via:
 *
 *   LIVE_AGENTS_GENERIC_RUNTIME=1
 *
 * The Kaggle heartbeat (`startKaggleHeartbeat()`) keeps running unchanged
 * for backward compatibility. The two heartbeats coexist safely because
 * their tick ids and worker ids never overlap (Kaggle uses prefix
 * `geneweave-kaggle-worker`, generic uses `geneweave-live-worker`).
 *
 * The generic supervisor:
 *   - Ticks every active mesh's active agents (regardless of domain).
 *   - Dispatches via the `HandlerRegistry` set up at boot in
 *     `handler-registry-boot.ts`.
 *   - Mirrors per-agent backlog/inbox progress into `live_run_steps` /
 *     `live_run_events` so the admin Live Runs view updates in real time.
 *
 * Operators can roll a new mesh out of the database (admin POST
 * `/api/admin/live-meshes/provision`) and watch ticks start within a few
 * seconds without touching code or restarting the process.
 */

import {
  weaveLiveMeshFromDb,
  weaveDbLiveAgentPolicy,
  weaveDbModelResolver,
  createDurableLiveAgentCheckpointStore,
  type HeartbeatSupervisorHandle,
  type LiveAgentCheckpointStore,
} from '@weaveintel/live-agents-runtime';
import { emitLiveRunEvent } from './live-run-event-bus.js';
import type { Model, WeaveRuntime } from '@weaveintel/core';
import {
  resolveCostGovernorBundle,
  wrapModelWithCacheHints,
  RunCostStateTracker,
  weaveModelCascadeResolver,
  wrapAuditEmitterWithCascadeTracker,
} from '@weaveintel/cost-governor';
import type { DatabaseAdapter } from '../db.js';
import type { ProviderConfig } from '../chat.js';
import { getOrCreateModel } from '../chat-runtime.js';
import { routeModel } from '../chat-routing-utils.js';
import { getGenericLiveStore } from './generic-store.js';
import { getHandlerRegistry } from './handler-registry-boot.js';
import { newUUIDv7 } from '../lib/uuid.js';
import { DbToolPolicyResolver, DbToolRateLimiter } from '../tool-policy-resolver.js';
import { DbToolAuditEmitter } from '../tool-audit-emitter.js';
import { DbToolApprovalGate } from '../tool-approval-gate.js';
import { DbCostPolicyResolver } from '../cost/db-cost-policy-resolver.js';
import {
  createDbLiveRunEventReader,
  createDbLiveRunStepReader,
} from '../cost/db-live-trace-tools.js';
import { createLiveTraceTools } from '@weaveintel/live-agents/trace-tools';
import {
  getLlmEndpointPressure,
  isPressureBlocking,
  pressureStateKey,
  formatPressureReason,
} from './endpoint-pressure.js';

// Module-level dedupe: emit one deferral event per agent per state
// crossing, not on every 5 s schedule pass.
const lastDeferredKey = new Map<string, string>();

// Phase 4 — expose supervisor handle so routes can call cancelRun().
let activeSupervisorHandle: HeartbeatSupervisorHandle | null = null;

/** Returns the active supervisor handle, or null when the generic runtime is disabled. */
export function getGenericSupervisorHandle(): HeartbeatSupervisorHandle | null {
  return activeSupervisorHandle;
}

export interface StartGenericSupervisorOptions {
  db: DatabaseAdapter;
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
  /** DB attention policy key. Optional — when omitted the engine's standard
   *  policy is used. */
  attentionPolicyKey?: string;
  /**
   * Phase 0 — ambient cross-cutting runtime. When supplied, every tick
   * context inherits `ctx.runtime` so handlers reach egress hardening,
   * durable audit, resilience state, guardrails, and encryption through
   * the DI chain rather than process-global singletons.
   */
  runtime?: WeaveRuntime;
}

/**
 * Boot the generic supervisor when `LIVE_AGENTS_GENERIC_RUNTIME=1`. Returns
 * `null` (no-op) when the flag is absent or non-truthy. Failure inside the
 * supervisor itself is logged; this function never throws to the caller so
 * it can sit safely beside other boot tasks in `createGeneWeave()`.
 */
export async function startGenericSupervisorIfEnabled(
  opts: StartGenericSupervisorOptions,
): Promise<HeartbeatSupervisorHandle | null> {
  const flag = (process.env['LIVE_AGENTS_GENERIC_RUNTIME'] ?? '').toLowerCase();
  if (flag !== '1' && flag !== 'true' && flag !== 'yes') {
    return null;
  }

  const store = await getGenericLiveStore();
  const registry = getHandlerRegistry();

  // ─── Phase 2 (live-agents capability parity) ────────────────────────
  // Per-tick model selection runs through `weaveDbModelResolver` from
  // `@weaveintel/live-agents-runtime`. The runtime resolver owns the
  // listCandidates → routeModel → getModel pipeline and emits per-tick
  // routing context; we only inject geneweave's:
  //   • `listAvailableModelsForRouting`-equivalent (model_pricing rows
  //     filtered to configured providers, with the default included).
  //   • `routeModel(...)` — the live SmartModelRouter brain.
  //   • `getOrCreateModel(...)` — the singleton-aware model factory.
  // The runtime layer never sees a DB type — only the injected functions.
  const modelResolver = weaveDbModelResolver({
    listCandidates: async () => {
      const out: Array<{ id: string; provider: string }> = [];
      const seen = new Set<string>();
      const configured = new Set(Object.keys(opts.providers));
      try {
        const rows = await opts.db.listModelPricing();
        for (const row of rows) {
          if (!row.enabled || !configured.has(row.provider)) continue;
          const k = `${row.provider}:${row.model_id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ id: row.model_id, provider: row.provider });
        }
      } catch {
        /* best-effort */
      }
      const defKey = `${opts.defaultProvider}:${opts.defaultModel}`;
      if (!seen.has(defKey) && configured.has(opts.defaultProvider)) {
        out.push({ id: opts.defaultModel, provider: opts.defaultProvider });
      }
      return out;
    },
    routeModel: async (cands, hints) => {
      const healthList = opts.runtime?.routing?.listHealth() ?? [];
      const blockedProviders = opts.runtime?.routing?.getBlockedProviders();
      const r = await routeModel(opts.db, cands, healthList, {
        taskType: hints.taskType ?? 'reasoning',
        prompt: hints.prompt ?? 'generic-supervisor-planner',
      }, blockedProviders);
      if (!r) return null;
      return {
        provider: r.provider,
        modelId: r.modelId,
        taskKey: r.taskKey,
        experimentName: r.experimentName,
      };
    },
    getOrCreateModel: async (provider, modelId) => {
      const cfg = opts.providers[provider];
      if (!cfg) throw new Error(`no provider config for ${provider}`);
      return getOrCreateModel(provider, modelId, cfg);
    },
    defaultTaskType: 'reasoning',
    log: (msg) => console.log('[generic-supervisor]', msg),
  });

  // Pinned fallback so handlers that read `ctx.model` (instead of
  // `ctx.modelResolver`) still work. Throws on failure so that the
  // mesh-startup path surfaces mis-configuration immediately rather than
  // silently returning `undefined` and letting handlers fail cryptically
  // at runtime when they read `ctx.model`.
  const modelFactory = async (): Promise<Model> => {
    const cfg = opts.providers[opts.defaultProvider];
    if (!cfg) throw new Error(`[generic-supervisor] No provider config for default provider '${opts.defaultProvider}'`);
    return getOrCreateModel(opts.defaultProvider, opts.defaultModel, cfg);
  };

  // DB-backed system-prompt resolver — looks up enabled prompts by key
  // (skill key / fragment key) so handlers stay grounded in the live
  // prompt registry rather than baking instructions into code.
  const resolveSystemPrompt = async (key: string): Promise<string | null> => {
    try {
      // Prefer prompt fragments (lightweight reusable blocks).
      const fragments = await opts.db.listPromptFragments();
      const f = fragments.find((row) => row.key === key && row.enabled === 1);
      if (f && typeof f.content === 'string' && f.content.length > 0) return f.content;
      // Fall back to a full prompt by name (legacy compatibility).
      const prompts = await opts.db.listPrompts();
      const p = prompts.find((row) => row.name === key);
      if (p && typeof p.template === 'string' && p.template.length > 0) return p.template;
    } catch {
      /* non-fatal — return null and let the handler use its config default */
    }
    return null;
  };

  // ─── Cost Governor Phase 2 — single shared resolver ────────────
  // Reusable across every tick of every agent in this supervisor.
  // The resolver is pure read-side (no internal state), so a single
  // instance is safe.
  const cachedCostPolicyResolver = new DbCostPolicyResolver(opts.db);

  // Cost enforcement status: Phase 3 (prompt caching) + Phase 4 (model cascade)
  // are active. Phases 5-7 levers (tool subset filter, prompt shaping, history
  // compaction, per-run budget gate) remain no-op stubs — cost_policies rows
  // that set these levers will have no effect until those phases land.
  console.log('[cost-governor] supervisor boot: prompt-caching (Phase 3) + model cascade (Phase 4) active; tool-filter / prompt-shaper / history-compactor levers are stubs');

  // ─── Cost Governor Phase 4 — cascade tracker (per-supervisor) ──
  // One in-memory tracker shared across all ticks of all agents in
  // this supervisor. Per-agent state is keyed by `agent.id` (used as
  // the synthetic runId for the cascade decision). 1-hour TTL evicts
  // stale agent state without ever growing unbounded.
  const cascadeTracker = new RunCostStateTracker({ ttlMs: 60 * 60 * 1000 });

  // ─── Cost Governor Phase 4 — model cascade wiring ──────────────
  // Reads `cost_policies.levers_json -> modelCascade` for the active
  // (mesh, agent) pair. When `modelCascade.cheap` is set we route
  // every tick through the cheap model by default; when an escalation
  // rule fires (tool failures, JSON parse failures, expensive step
  // kinds, low intel score) we promote to `expensive` for that tick.
  // Decision is best-effort — any failure falls through to the inner
  // DB-routed resolver so caching/base layers always see a Model when
  // one is available.
  const cascadeModelResolver = weaveModelCascadeResolver({
    base: modelResolver,
    resolveConfig: async (ctx) => {
      try {
        const { bundle } = await resolveCostGovernorBundle(
          cachedCostPolicyResolver,
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
    log: (msg) => console.log('[generic-supervisor]', msg),
  });

  // ─── Cost Governor Phase 3 — prompt-cache hint wiring ──────────
  // Wrap the per-tick model resolver so every Model returned to a
  // handler is decorated with prompt-caching hints derived from the
  // active CostPolicy for this (mesh, agent) pair. The wrapping is:
  //   1. Inner resolver returns a routed Model (or undefined).
  //   2. We resolve the cost bundle for the same (mesh, agent).
  //   3. If `bundle.cacheShaper` is non-noop, we wrap the Model with
  //      `wrapModelWithCacheHints` so subsequent `.generate`/`.stream`
  //      calls inject `prompt_cache_key` (OpenAI) or system content-
  //      block `cache_control` markers (Anthropic).
  // Provider-aware behaviour lives entirely in the cost-governor
  // wrapper. This file only plumbs the per-tick context.
  // Resolver chain: caching -> cascade -> base (DB routing).
  const innerResolver = {
    async resolve(ctx: Parameters<typeof modelResolver.resolve>[0]): Promise<Model | undefined> {
      // Synthesize runId from agentId so the cascade tracker has a
      // stable key per agent (the live-agents runtime does not stamp
      // a per-tick runId by default).
      const runId = ctx?.runId ?? ctx?.agentId;
      return cascadeModelResolver.resolve({
        ...(ctx ?? {}),
        ...(runId ? { runId } : {}),
      });
    },
  };
  const cachingModelResolver = {
    async resolve(ctx: Parameters<typeof innerResolver.resolve>[0]): Promise<Model | undefined> {
      const m = await innerResolver.resolve(ctx);
      if (!m) return undefined;
      let bundle;
      try {
        const resolved = await resolveCostGovernorBundle(cachedCostPolicyResolver, {
          ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
          ...(ctx?.meshId ? { meshId: ctx.meshId } : {}),
          ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
        });
        bundle = resolved.bundle;
      } catch {
        return m;
      }
      if (!bundle.policy.promptCaching.enabled) return m;
      const role = ctx?.role;
      const modelId = m.info?.modelId;
      return wrapModelWithCacheHints(m, bundle.cacheShaper, {
        resolveContext: () => ({
          provider: m.info.provider,
          ...(role ? { role } : {}),
          ...(modelId ? { modelId } : {}),
          ...(ctx?.meshId ? { meshId: ctx.meshId } : {}),
          ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
          ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
        }),
      });
    },
  };

  // ─── Phase 7 — Durable checkpoint store ─────────────────────
  // One store per supervisor, keyed by agent ID. When the runtime's
  // persistence slot is available we use a durable KV backend so
  // checkpoints survive process restarts. Falls back to null when no
  // persistence is wired (tests, edge deployments without KV).
  const checkpointStore: LiveAgentCheckpointStore | null =
    opts.runtime?.persistence?.kv
      ? createDurableLiveAgentCheckpointStore(opts.runtime.persistence.kv)
      : null;

  // ─── Phase 7 (live-agents capability parity) ────────────────
  // Single-call mesh hydration via `weaveLiveMeshFromDb` — replaces the
  // direct `createHeartbeatSupervisor` call. Same primitives, one entry
  // point. The runtime package owns composition order; this app only
  // injects geneweave-specific resolvers/factories.
  const meshHandle = await weaveLiveMeshFromDb(opts.db, {
    store,
    handlerRegistry: registry,
    modelFactory,
    modelResolver: cachingModelResolver,
    // Brand identity injected by the app: the framework now defaults these to
    // neutral 'weaveintel-*' values, so geneWeave passes its own to keep worker
    // ids and background-tick audit attribution exactly as before.
    workerIdPrefix: 'geneweave-live-worker',
    systemPrincipal: 'human:geneweave-system',
    // ─── Phase 3 (live-agents capability parity) ────────────────
    // First-class per-tick policy bundle. Mirrors the DB-backed
    // primitives already wired into ChatEngine.toolOptions so every
    // live-agent tool call (via `agentic.react`) is gated by the same
    // resolver/approval/rate-limit/audit pipeline operators administer
    // through the admin tabs. Adapter instances are stateless w.r.t.
    // each other (each holds only the DB ref), so reusing them across
    // chat + live-agents is safe.
    policy: weaveDbLiveAgentPolicy({
      policyResolver: new DbToolPolicyResolver(opts.db),
      approvalGate: new DbToolApprovalGate(opts.db),
      rateLimiter: new DbToolRateLimiter(opts.db),
      // Phase 4 — wrap the persistent audit emitter so every failed
      // tool call increments the cascade tracker. The emitter still
      // forwards every event to the DB first; tracker update is
      // best-effort and never blocks audit persistence.
      auditEmitter: wrapAuditEmitterWithCascadeTracker(
        new DbToolAuditEmitter(opts.db),
        cascadeTracker,
        // chatId === agent.id for live-agent tool calls (set by
        // weaveDbLiveAgentPolicy default resolution context).
        { resolveRunId: (e) => e.chatId ?? null },
      ),
    }),
    resolveSystemPrompt,
    // Phase 2 (DB-driven capability plan) — declarative `prepare()`
    // recipes loaded from `live_agents.prepare_config_json`. We delegate
    // prompt-text resolution to the same `resolveSystemPrompt` helper
    // above so a recipe `systemPrompt: { promptKey }` reaches the live
    // prompt registry exactly as a hand-written prepare() would. Missing
    // keys collapse to empty string; the recipe synthesiser then falls
    // back to its `defaultSystemPrompt` (per-handler default).
    prepareDeps: {
      resolvePromptText: async (promptKey: string) => {
        const text = await resolveSystemPrompt(promptKey);
        return text ?? '';
      },
      // ─── Phase 9 (cost control) — Lazy trace-tool retrieval ────
      // When a live agent's `prepare_config_json.tools` recipe contains
      // `traceTools: '$auto'`, this factory builds a fresh ToolRegistry
      // closure-bound to the active live_run for the agent's mesh. The
      // LLM never passes runId — the closure scope is the only source.
      // Returns null when no active run is found; the resolver treats
      // null as graceful pass-through (trace tools never load-bearing).
      traceToolsFactory: async ({ meshId, agentId }) => {
        if (!meshId) return null;
        try {
          const runs = await opts.db.listLiveRuns({
            meshId,
            status: 'RUNNING',
            limit: 1,
          });
          const run = runs[0];
          if (!run) return null;
          return createLiveTraceTools({
            runId: run.id,
            ...(agentId ? { agentId } : {}),
            eventReader: createDbLiveRunEventReader(opts.db),
            stepReader: createDbLiveRunStepReader(opts.db),
          });
        } catch (err) {
          console.warn('[live-agents] traceToolsFactory failed:', err);
          return null;
        }
      },
    },
    // Inject per-tick context extras for handlers that need DB access:
    //   - human.approval needs `approvalDb` + `newApprovalId`.
    //   - deterministic.* needs `resolveAgentByRole` (looks up the live
    //     agent uuid for a role inside the same mesh).
    extraContextFor: async (_binding, agent) => ({
      approvalDb: opts.db,
      newApprovalId: () => newUUIDv7(),
      // ─── Cost Governor Phase 2 — DB-driven cost policy resolver ────
      // Single resolver instance per supervisor; per-tick callers do
      // `await resolveCostGovernorBundle(ctx.costPolicyResolver, { meshId, agentId })`
      // to get the effective CostPolicy + bundle for this agent. Phase
      // 2 lever resolvers are no-op stubs so behavior is unchanged;
      // the wiring is in place for Phases 3-7 to hang real levers off.
      costPolicyResolver: cachedCostPolicyResolver,
      // ─── Phase 7 — durable checkpoint store ────────────────────────
      // Agents that set `config_json.checkpoint: true` on an `agentic.react`
      // binding will have their tick state saved to KV after each run and
      // loaded at the start of the next. The same store instance is shared
      // across all agents in this supervisor (each agent uses its own key).
      ...(checkpointStore ? { checkpoint: checkpointStore } : {}),
      resolveAgentByRole: async (roleKey: string) => {
        const peers = await opts.db.listLiveAgents({
          meshId: agent.meshId,
          status: 'ACTIVE',
        });
        const found = peers.find((p) => p.role_key === roleKey);
        return found ? found.id : null;
      },
    }),
    ...(opts.attentionPolicyKey ? { attentionPolicyKey: opts.attentionPolicyKey } : {}),
    ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
    // Pre-schedule gate — consult `endpoint_health` once per pass and
    // skip scheduling when an LLM provider is circuit-open or 429
    // cooling-down. Mirrors the kaggle heartbeat behaviour so chat,
    // SV, and live-agents all back off in unison when upstream is
    // under pressure (see RESILIENCE_PLAN gap #2).
    preScheduleGate: async () => {
      const pressure = await getLlmEndpointPressure(opts.db);
      if (!isPressureBlocking(pressure)) {
        // Clear dedupe so the next deferral re-emits.
        lastDeferredKey.clear();
        return { defer: false };
      }
      const key = pressureStateKey(pressure);
      return {
        defer: true,
        reason: formatPressureReason('agent', pressure),
        emitForAgent: async (mesh, agent) => {
          if (lastDeferredKey.get(agent.id) === key) return;
          lastDeferredKey.set(agent.id, key);
          try {
            // live_run_events requires a run_id — best-effort find the
            // latest RUNNING run for this mesh. If none exists, skip
            // emission (the supervisor logger still records the defer).
            const runs = await opts.db.listLiveRuns({
              meshId: mesh.id,
              status: 'RUNNING',
              limit: 1,
            });
            const runId = runs[0]?.id;
            if (!runId) return;
            await opts.db.appendLiveRunEvent({
              id: newUUIDv7(),
              run_id: runId,
              step_id: null,
              kind: pressure.openEndpoints.length > 0
                ? 'endpoint_circuit_open'
                : 'endpoint_rate_limited',
              agent_id: agent.id,
              tool_key: null,
              summary: formatPressureReason(agent.role_key, pressure),
              payload_json: JSON.stringify({
                openEndpoints: pressure.openEndpoints,
                rateLimitedEndpoint: pressure.rateLimitedEndpoint,
                rateLimitedUntil: pressure.rateLimitedUntil?.toISOString() ?? null,
              }),
            });
          } catch {
            /* best-effort */
          }
        },
      };
    },
    logger: (msg) => console.log('[live-supervisor]', msg),
    // Phase 4 — fan-out live run events to in-process SSE subscribers.
    onEvent: (runId, event) => {
      try {
        emitLiveRunEvent(runId, event);
      } catch {
        /* best-effort */
      }
    },
  });

  activeSupervisorHandle = meshHandle.supervisor;
  console.log('[live-supervisor] generic runtime enabled (LIVE_AGENTS_GENERIC_RUNTIME=1)');
  return meshHandle.supervisor;
}
