/**
 * @weaveintel/geneweave — Public API
 *
 * The single entry-point for consumers. Install the package, call
 * `createGeneWeave(config)`, and you have a running chat + dashboard server.
 *
 * @example
 * ```ts
 * import { createGeneWeave } from '@weaveintel/geneweave';
 *
 * const app = await createGeneWeave({
 *   port: 3000,
 *   jwtSecret: process.env.JWT_SECRET!,
 *   database: { type: 'sqlite', path: './geneweave.db' },
 *   providers: {
 *     anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
 *   },
 *   defaultModel: 'claude-sonnet-4-6',
 *   defaultProvider: 'anthropic',
 * });
 *
 * console.log(`geneWeave running → http://localhost:${app.port}`);
 * ```
 */

import type { Server } from 'node:http';
import { weaveSetDefaultTracer, weaveRuntime, envSecretResolver, weaveInMemoryPersistence, createLogger, weaveContext, type WeaveRuntime, type RuntimePersistenceSlot } from '@weaveintel/core';
import { createResilienceSignalBus, setDefaultSignalBus, createRuntimeResilienceAdapter } from '@weaveintel/resilience';
import { ModelHealthTracker, createRuntimeRoutingAdapter } from '@weaveintel/routing';
import { createDurableCostLedger, createRuntimeCostAdapter } from '@weaveintel/cost-governor';

const log = createLogger('geneweave');
import { weaveConsoleTracer, createOtelTracer } from '@weaveintel/observability';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveRedactor } from '@weaveintel/guardrails/redaction';
import { createDatabaseAdapter, type DatabaseAdapter, type DatabaseConfig } from './db.js';
import { ChatEngine, type ProviderConfig } from './chat.js';
import { createGeneWeaveServer } from './server.js';
import { syncModelPricing, type PricingSyncReport } from './pricing-sync.js';
import { syncToolCatalog } from './tools.js';
import { BUILTIN_TOOLS, setWorkflowEngineForTools } from './tools.js';
import {
  createGeneweaveWorkflowEngine,
  syncWorkflowHandlerKindsToDb,
  type WorkflowEngineHandle,
} from './workflow-engine.js';
import { startToolHealthJob } from './tool-health-job.js';
import { startArtifactRetentionJob } from './artifact-retention-job.js';
import { startNoteActivityRetentionJob } from './note-activity-retention-job.js';
import { startNoteScheduledAgentJob } from './note-scheduled-agent-job.js';
import { startNoteMemoryJob } from './note-memory-job.js';
import { createModelTextGenerator } from './note-ai-sql.js';
import {
  createTriggerDispatcher,
  createDurableTriggerRateLimiter,
  ManualSourceAdapter,
  MeshContractSourceAdapter,
  WebhookOutTargetAdapter,
  type TriggerDispatcher,
} from '@weaveintel/triggers';
import { OAuthClient, createDurableOAuthStateStore } from '@weaveintel/identity/oauth';
import { setOAuthClient } from './server-core.js';
import { createDbTriggerStore } from './triggers/db-trigger-store.js';
import { createWorkflowTargetAdapter, createContractTargetAdapter } from './triggers/target-adapters.js';
import { DbContractEmitter } from './contracts/db-contract-emitter.js';
import { EventEmitter } from 'node:events';
import { applyDbResilienceObserver } from './db-resilience-observer.js';
import { startRoutingRegressionJob } from './routing-feedback.js';
import { registerMCPGatewayInCatalog, loadGatewayConfigFromCatalog } from './mcp-gateway.js';
import { applySeed } from './seed/index.js';
import {
  initHandlerRegistry,
  syncHandlerKindsToDb,
} from './live-agents/handler-registry-boot.js';
import { startKaggleHeartbeat, type KaggleHeartbeatHandle } from './live-agents/kaggle/heartbeat-runner.js';
import { startGenericSupervisorIfEnabled } from './live-agents/generic-supervisor-boot.js';
import type { HeartbeatSupervisorHandle } from '@weaveintel/live-agents-runtime';

export type { PricingSyncReport };

// ─── Config ──────────────────────────────────────────────────

export interface GeneWeaveConfig {
  /** Port to listen on (default: 3500) */
  port?: number;
  /** Host to bind (default: '0.0.0.0') */
  host?: string;
  /** Secret for signing JWT tokens — MUST be a strong random string in production */
  jwtSecret: string;
  /** Database config — defaults to SQLite at ./geneweave.db */
  database?: DatabaseConfig;
  /** Provider API keys keyed by provider name */
  providers: Record<string, ProviderConfig>;
  /** Default provider key (must match a key in providers) */
  defaultProvider: string;
  /** Default model ID to use */
  defaultModel: string;
  /** CORS origin — set to your frontend URL in production */
  corsOrigin?: string;
  /** Absolute public origin used for OAuth callbacks when behind a proxy */
  publicBaseUrl?: string;
  /**
   * Custom runtime KV persistence slot. When omitted, geneWeave auto-selects
   * SQLite KV (co-located with the app DB) for SQLite deployments, or
   * in-memory KV for custom database adapters.
   *
   * Pass a Postgres-backed slot here when running with a custom Postgres
   * DatabaseAdapter to make compliance records, OAuth state, and workflow
   * checkpoints durable across replicas and restarts.
   *
   * @example
   * ```ts
   * import { weavePgPersistence } from '@weaveintel/persistence';
   * await createGeneWeave({
   *   database: { type: 'custom', adapter: myPgAdapter },
   *   persistence: weavePgPersistence({ connectionString: process.env.DATABASE_URL }),
   * });
   * ```
   */
  persistence?: import('@weaveintel/core').RuntimePersistenceSlot;
}

// ─── App handle ──────────────────────────────────────────────

export interface GeneWeaveApp {
  /** The port the server is listening on */
  port: number;
  /** Underlying Node.js HTTP server */
  server: Server;
  /** Database adapter (for advanced use / testing) */
  db: DatabaseAdapter;
  /** Chat engine (for programmatic use) */
  chatEngine: ChatEngine;
  /**
   * Ambient cross-cutting runtime constructed at boot (Phase 2). Carries
   * the hardened egress client, tracer, secret resolver, audit logger, and
   * (when configured) persistence/resilience slots. Pass this into any
   * `ExecutionContext` derived from this app so features inherit one
   * coherent set of cross-cutting concerns.
   */
  runtime: WeaveRuntime;
  /**
   * Workflow engine handle: registry, run repository, checkpoint store,
   * cost meter, and span emitter. Phase B exposes this so consumers and
   * tests can introspect cost totals (durable when runtime persistence is
   * configured) without reaching into server internals.
   */
  workflows: WorkflowEngineHandle;
  /** Sync model pricing from provider APIs into the database */
  syncPricing(): Promise<PricingSyncReport>;
  /** Gracefully stop the server and close the database */
  stop(): Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * Module-level handle to the per-tenant encryption key manager. Set during
 * `createGeneWeave()` boot when `WEAVE_ENCRYPTION_MASTER_KEY` is available;
 * stays `null` otherwise. Phase 3 consumer integration (chat/sv encrypted
 * columns) reads this lazily so encryption is opt-in per deployment.
 */
import type {
  CachedKmsResolver,
  InMemoryMetricsEmitter,
  KmsProviderRegistry,
  MetricsEmitter,
  TenantKeyManager,
} from '@weaveintel/encryption';
import { withTenantEncryptedMessages } from './encryption/db-encrypted-adapter.js';
import { geneweaveGuardrailsSlot } from './guardrails-slot.js';
import { resolveLimits } from './platform-limits.js';
import {
  getGuardrailJudgeModel, setActiveGuardrailJudgeModel,
  getGuardrailModerationModel, setActiveGuardrailModerationModel,
  getGuardrailEmbeddingModel, setActiveGuardrailEmbeddingModel,
} from './guardrail-judge.js';
import { initPgVectorSemanticMemory } from './memory-pgvector.js';
import { initMemoryConsolidation } from './memory-consolidation.js';
import { createGeneWeaveMemoryStore, createKeywordSemanticMemory } from './memory-store-adapter.js';
import { weaveSemanticMemory, weaveWorkingMemory, createRuntimeMemoryAdapter } from '@weaveintel/memory';
import { createRuntimeComplianceAdapter } from '@weaveintel/guardrails/compliance';
import { createRuntimeIdentityAdapter } from '@weaveintel/identity';
import { weaveInMemoryCacheStore, weaveRedisCacheStore, weaveTieredCacheStore, createRuntimeCacheAdapter, createCacheMetrics, withMetrics, weaveSemanticCache, createCacheInvalidator, createSingleflight } from '@weaveintel/cache';
import { setActiveCacheInvalidator, loadInvalidationRules } from './cache-invalidator.js';
import { setActiveToolCache } from './tool-cache-registry.js';
import { setActiveSingleflight } from './cache-stampede.js';
import { createAgentPlanCache, createPlanCacheMetrics } from '@weaveintel/agents';
import { setActivePlanCache } from './agent-plan-cache.js';
import { geneweaveEncryptionSlot, type GeneweaveEncryptionSlot } from './encryption-slot.js';
export let geneweaveEncryptionManager: TenantKeyManager | null = null;
/** Phase 7: KMS provider registry exposed for admin endpoints (list/health-check). */
export let geneweaveKmsRegistry: KmsProviderRegistry | null = null;
/** Phase 7: per-tenant KMS resolver exposed so admin code can invalidate cache on policy edits. */
export let geneweaveKmsResolver: CachedKmsResolver | null = null;
/** Phase 9: metrics emitter wired into the manager + resolver. Exposed so admin
 * observability endpoints can read its `snapshot()` (when it's the in-memory
 * default) without coupling to a singleton. */
export let geneweaveEncryptionMetrics: (MetricsEmitter & { snapshot?: InMemoryMetricsEmitter['snapshot'] }) | null = null;

/**
 * createGeneWeave() is the single entry-point for the entire application.
 * It wires together all WeaveIntel subsystems in order:
 *
 *  1. Database — SQLite adapter for persistence (users, sessions, chats, metrics)
 *  2. ChatEngine — orchestrates @weaveintel/core/models, @weaveintel/agents,
 *     @weaveintel/observability, @weaveintel/guardrails/redaction, @weaveintel/testing/evals,
 *     @weaveintel/guardrails, @weaveintel/routing, and @weaveintel/cache
 *  3. seedDefaultData — creates admin user and default settings on first run
 *  4. HTTP Server — zero-dependency router with auth, CORS, SSE streaming
 *  5. Returns a GeneWeaveApp handle with stop() for graceful shutdown
 */
export async function createGeneWeave(config: GeneWeaveConfig): Promise<GeneWeaveApp> {
  // A-5: Collect background handles so we can stop them on startup failure.
  // Each handle added here is torn down in the rollback() path when a later
  // init step throws — prevents orphaned timers/connections from leaking.
  const startedHandles: Array<{ stop(): Promise<void> | void }> = [];

  async function rollback(err: unknown): Promise<never> {
    log.error('Startup failed — rolling back started services', { reason: err instanceof Error ? err.message : String(err) });
    for (const handle of startedHandles.reverse()) {
      try { await handle.stop(); } catch { /* best-effort */ }
    }
    throw err;
  }

  // Validate critical env vars at boot; throws on fatal misconfigurations.
  const { validateEnv } = await import('./env-validation.js');
  const envResult = validateEnv({ jwtSecret: config.jwtSecret, redisUrl: process.env['REDIS_URL'] });
  for (const warning of envResult.warnings) {
    log.warn(warning);
  }

  // Construct exactly one ambient runtime for this app. Every feature that
  // needs egress / tracing / secrets / audit pulls them from here — no
  // call site reconstructs them. `weaveSetDefaultTracer` is kept for
  // back-compat with packages that read the process-wide default; the
  // runtime tracer is the same instance so the two never disagree.
  //
  // Phase 1 — OTel tracer: when OTEL_EXPORTER_OTLP_ENDPOINT is set, use the
  // GenAI-semantic-convention OTel tracer that exports spans to the OTLP
  // endpoint (Grafana Cloud, Honeycomb, Jaeger, etc.). Falls back to the
  // console tracer so dev setups need no collector.
  const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const consoleTracer = otlpEndpoint
    ? createOtelTracer({
        endpoint: otlpEndpoint,
        serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'geneweave',
        serviceVersion: process.env['OTEL_SERVICE_VERSION'],
        apiKey: process.env['OTEL_EXPORTER_OTLP_HEADERS_AUTHORIZATION'],
      })
    : weaveConsoleTracer();

  // Phase A: durable persistence slot. When the configured database is
  // SQLite we share its path so the runtime KV table (`runtime_kv`) lives
  // alongside the app's other tables and survives restarts. For custom
  // adapters (Postgres / Mongo / etc.) we fall back to the in-memory slot
  // — adopters can override by supplying their own runtime in future.
  const dbConfig = config.database ?? { type: 'sqlite' as const, path: './geneweave.db' };
  const persistenceSlot: RuntimePersistenceSlot = config.persistence
    ?? (dbConfig.type === 'sqlite'
      ? weaveSqlitePersistence({ path: dbConfig.path ?? './geneweave.db' })
      : weaveInMemoryPersistence());

  // Phase A: default redactor with built-in PII patterns. Wired into the
  // runtime so the auto-attached durable audit logger redacts entries
  // before they hit the KV store — no call site needs to opt in.
  const defaultRedactor = weaveRedactor({
    patterns: [
      { name: 'email', type: 'builtin', builtinType: 'email' },
      { name: 'phone', type: 'builtin', builtinType: 'phone' },
      { name: 'ssn', type: 'builtin', builtinType: 'ssn' },
      { name: 'credit_card', type: 'builtin', builtinType: 'credit_card' },
    ],
    reversible: false,
  });

  // Phase E: build the database adapter BEFORE the runtime so the
  // ambient guardrails slot can close over it. The slot reads enabled
  // rows from the `guardrails` table on each call, so operator edits
  // take effect without restart. Encryption wrapper still uses the
  // module-level live binding (assigned later in this function).
  const rawDb = await createDatabaseAdapter(config.database ?? { type: 'sqlite', path: './geneweave.db' }).catch(rollback);
  const db = withTenantEncryptedMessages(rawDb, () => geneweaveEncryptionManager);

  // Resolve the guardrail judge model once at boot. Uses a cheap/fast model
  // (claude-haiku or gpt-4o-mini) by default, or GUARDRAIL_JUDGE_MODEL env var.
  // Stored as a mutable ref so it can be lazily replaced without restarting.
  // Resolve the guardrail judge model. Sets the module-level singleton so
  // chat-guardrail-eval-utils.ts picks it up without threading through deps.
  const guardrailJudgeModel = await getGuardrailJudgeModel({
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  }).catch(() => undefined);
  setActiveGuardrailJudgeModel(guardrailJudgeModel);
  if (guardrailJudgeModel) {
    log.info('judge model ready', { provider: guardrailJudgeModel.info.provider, modelId: guardrailJudgeModel.info.modelId });
  } else {
    log.warn('no judge model available — model-graded checks will skip (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }

  // R2: Moderation model — OpenAI omni-moderation-latest
  const guardrailModerationModel = await getGuardrailModerationModel(config.providers).catch(() => undefined);
  setActiveGuardrailModerationModel(guardrailModerationModel);
  if (guardrailModerationModel) {
    log.info('moderation model ready', { modelId: 'openai:omni-moderation-latest' });
  } else {
    log.warn('no moderation model — content moderation check will skip (set OPENAI_API_KEY)');
  }

  // R3: Embedding model — OpenAI text-embedding-3-small for semantic grounding
  const guardrailEmbeddingModel = await getGuardrailEmbeddingModel(config.providers).catch(() => undefined);
  setActiveGuardrailEmbeddingModel(guardrailEmbeddingModel);
  if (guardrailEmbeddingModel) {
    log.info('embedding model ready', { modelId: 'openai:text-embedding-3-small', mode: 'semantic' });
  } else {
    log.warn('no embedding model — semantic grounding will use lexical fallback (set OPENAI_API_KEY)');
  }

  // Semantic memory backend — pgvector when PGVECTOR_URL is set, SQLite otherwise
  const pgVectorActive = initPgVectorSemanticMemory(db);
  if (pgVectorActive) {
    log.info('pgvector backend active', { table: 'geneweave_memory_vec', dimensions: Number(process.env['PGVECTOR_DIMENSIONS'] ?? 1536) });
  } else {
    log.info('SQLite semantic memory backend active (set PGVECTOR_URL to use pgvector)');
  }

  // Memory consolidation — cold-path pipeline: episodic → semantic
  initMemoryConsolidation({ db });

  // Phase 5: runtime memory slot — bridge the existing geneWeave DB schema to
  // the core MemoryStore / SemanticMemory interfaces so runtime.memory is
  // backed by the same data the chat pipeline writes. Live agents and tools
  // can now call ctx.runtime.memory.semantic.recall(ctx, query) and
  // ctx.runtime.memory.store (for fusedMemorySearch) without touching the DB
  // adapter directly.
  const runtimeMemoryStore = createGeneWeaveMemoryStore(db);
  const semanticMem = guardrailEmbeddingModel
    ? weaveSemanticMemory(guardrailEmbeddingModel, runtimeMemoryStore)
    : createKeywordSemanticMemory(runtimeMemoryStore);
  const workingMem = weaveWorkingMemory();
  const memoryAdapter = createRuntimeMemoryAdapter({
    semantic: semanticMem,
    working: workingMem,
    store: runtimeMemoryStore,
  });

  const startupLimits = await resolveLimits(db);
  const guardrailsSlot = geneweaveGuardrailsSlot(db, {
    getModel: () => guardrailJudgeModel,
    getModerationModel: () => guardrailModerationModel,
    getEmbeddingModel: () => guardrailEmbeddingModel,
    maxActionLen: startupLimits.guardrail_action_max_chars,
  });

  // Phase F: encryption slot with a mutable internal ref. Constructed BEFORE
  // the runtime so `runtime.has('runtime.encryption')` advertises at boot;
  // the underlying TenantKeyManager is assigned post-bootstrap below.
  // Consumers retrieve the live manager via `ctx.runtime?.encryption?.getManager()`.
  const encryptionSlot: GeneweaveEncryptionSlot = geneweaveEncryptionSlot();

  // Phase 0 (runtime): one shared signal bus for the entire process. Set as
  // the framework default so every resilience pipeline that calls
  // `getDefaultSignalBus()` emits here. The adapter exposes `getState()` and
  // latency percentiles so any consumer can query circuit state through
  // `ctx.runtime.resilience` without importing the global singleton.
  const signalBus = createResilienceSignalBus();
  setDefaultSignalBus(signalBus);
  const resilienceAdapter = createRuntimeResilienceAdapter(signalBus);

  // Phase 2 (runtime): one shared ModelHealthTracker for the entire process.
  // Both the chat path and the live-agent supervisor record outcomes into and
  // route using the same in-memory health state — no more per-instance tracker
  // drift where a rate-limit block in chat is invisible to the supervisor.
  const sharedHealthTracker = new ModelHealthTracker();
  // Phase 7 — pass multiModal: true since geneWeave's model pool includes
  // vision-capable models (GPT-4o, Claude 3.x). Handlers check
  // `runtime.routing.supportsMultiModal()` before logging routing hints.
  const routingAdapter = createRuntimeRoutingAdapter(sharedHealthTracker, { multiModal: true });

  // Phase 3 (runtime): per-user/tenant budget enforcement via shared cost ledger.
  // The ledger is backed by the same persistence slot so spend counters survive
  // restarts when a durable slot is configured. WEAVE_COST_LIMIT_USD sets the
  // global ceiling in USD; unset means no limit (gate always allows).
  const runtimeCostLedger = createDurableCostLedger({
    runtime: { persistence: persistenceSlot } as any,
    namespace: 'runtime-cost',
  });
  const globalCostLimitUsd = process.env['WEAVE_COST_LIMIT_USD']
    ? parseFloat(process.env['WEAVE_COST_LIMIT_USD'])
    : null;
  const costAdapter = createRuntimeCostAdapter({ ledger: runtimeCostLedger, globalLimitUsd: globalCostLimitUsd });

  // Phase 6 (runtime): compliance slot — all six durable managers wired via the
  // same persistence slot as the rest of the runtime. Consent, residency, deletion,
  // and GDPR helpers are now available at `ctx.runtime?.compliance` without
  // constructing per-chat or per-route manager instances.
  const complianceAdapter = createRuntimeComplianceAdapter({
    runtime: { persistence: persistenceSlot } as any,
  });

  // Phase 6 (runtime): identity slot — RBAC evaluation and delegation chain
  // validation available at `ctx.runtime?.identity` for auth middleware and
  // live-agent handlers.
  const identityAdapter = createRuntimeIdentityAdapter();

  // Phase 7 (runtime): shared response cache — a single in-process
  // `CacheStore` shared across the chat path, live-agent handlers, and tools
  // via `ctx.runtime?.cache`. This means a warm response in one subsystem
  // benefits all others in the same process without importing the singleton.
  //
  // Phase 0 hardening: the L1 store is bounded (it was previously unbounded —
  // an in-memory leak / DoS surface). LRU eviction keeps hot entries.
  //
  // Phase 1: the cache topology is admin-tunable via the `cache_settings` row.
  // When L2 is enabled (l2_provider='redis') and REDIS_URL is set, the shared
  // store becomes a tiered L1+L2 (in-process + distributed Redis) so a warm
  // response on one replica serves the same request on another. The
  // global_version_token is threaded into the cache key version so an admin can
  // invalidate every cache entry at once by bumping it.
  let cacheSettings: import('./db-types/admin.js').CacheSettingsRow | null = null;
  try { cacheSettings = await db.getCacheSettings(); } catch { /* table may not exist on a brand-new DB */ }

  let cacheMaxEntries = Number(process.env['GENEWEAVE_CACHE_MAX_ENTRIES'] ?? 0) || cacheSettings?.l1_max_entries || 0;
  let cacheMaxBytes = Number(process.env['GENEWEAVE_CACHE_MAX_BYTES'] ?? 0) || cacheSettings?.l1_max_bytes || 0;
  try {
    const cachePolicies = (await db.listCachePolicies()).filter((p) => p.enabled);
    if (!cacheMaxEntries) cacheMaxEntries = cachePolicies.reduce((m, p) => Math.max(m, p.max_entries ?? 0), 0);
    if (!cacheMaxBytes) cacheMaxBytes = cachePolicies.reduce((m, p) => Math.max(m, p.max_bytes ?? 0), 0);
  } catch { /* table may not exist yet on a brand-new DB — fall back to defaults */ }
  if (!cacheMaxEntries || cacheMaxEntries < 1) cacheMaxEntries = 5000;

  // Phase 3: live, process-wide cache metrics sink. The in-memory L1 reports
  // evictions into it; `withMetrics` (below) reports response-cache hits/misses
  // and sets. The chat path also records prompt-cache token savings, and a
  // durable per-turn rollup lives in the `cache_metrics` table.
  const cacheMetrics = createCacheMetrics();

  // Phase 7: eviction strategy is DB-tunable (cache_settings.l1_eviction_policy).
  // For the cost-aware `gdsf` policy, weight each entry by its response token
  // count so expensive answers are retained over cheap-to-recompute ones.
  const evictionPolicy = (cacheSettings?.l1_eviction_policy ?? 'lru') as import('@weaveintel/cache').CacheEvictionPolicy;
  const l1CacheStore = weaveInMemoryCacheStore({
    maxEntries: cacheMaxEntries,
    maxBytes: cacheMaxBytes,
    evictionPolicy,
    ...(evictionPolicy === 'gdsf' ? {
      costOf: (v: unknown) => {
        const u = (v as { usage?: { totalTokens?: number } })?.usage;
        return u && typeof u.totalTokens === 'number' && u.totalTokens > 0 ? u.totalTokens : 1;
      },
    } : {}),
    onEvict: () => cacheMetrics.onEvict(),
  });

  // Phase 1: optionally compose a distributed L2 (Redis) into a tiered store.
  const redisUrl = process.env['REDIS_URL'];
  const l2Enabled = !!cacheSettings?.l2_enabled && (cacheSettings?.l2_provider ?? 'none') === 'redis' && !!redisUrl;
  let baseCacheStore: import('@weaveintel/core').CacheStore = l1CacheStore;
  if (l2Enabled) {
    try {
      const l2 = weaveRedisCacheStore({ url: redisUrl!, keyPrefix: cacheSettings?.key_namespace ?? 'weave:cache' });
      baseCacheStore = weaveTieredCacheStore(l1CacheStore, l2, { l1TtlMs: cacheSettings?.l1_ttl_ms ?? 30_000 });
      console.log(`[cache] distributed L2 enabled (redis, prefix='${cacheSettings?.key_namespace}')`);
    } catch (err) {
      console.warn('[cache] failed to enable Redis L2 — falling back to in-memory L1 only:', (err as Error).message);
      baseCacheStore = l1CacheStore;
    }
  }
  // Phase 3: wrap the shared store so every response-cache lookup/write feeds the
  // live metrics sink (preserves scannable/closable capabilities).
  const sharedCacheStore = withMetrics(baseCacheStore, cacheMetrics);
  const cacheKeyVersion = cacheSettings?.global_version_token
    ?? process.env['GENEWEAVE_CACHE_KEY_VERSION'] ?? 'v1';

  // Phase 4: embedding-similarity (semantic) cache. Activates only when enabled
  // in semantic_cache_config AND an embedding model is available; otherwise
  // stays absent and the chat path simply skips semantic lookups.
  let semanticCache: import('@weaveintel/core').SemanticCache | undefined;
  try {
    const semCfg = await db.getSemanticCacheConfig();
    if (semCfg?.enabled && guardrailEmbeddingModel) {
      semanticCache = weaveSemanticCache({
        embed: async (text: string) => {
          const out = await guardrailEmbeddingModel.embed(
            weaveContext({ deadline: Date.now() + 30_000 }),
            { input: [text.slice(0, 4000)] },
          );
          return out.embeddings[0] ?? [];
        },
        defaultThreshold: semCfg.similarity_threshold ?? 0.92,
        maxEntries: semCfg.max_entries ?? 1000,
        ttlMs: semCfg.ttl_ms ?? 600_000,
        invalidationRadius: semCfg.invalidation_radius ?? 0.95,
      });
      console.log(`[cache] semantic cache enabled (model=${semCfg.embedding_model}, threshold=${semCfg.similarity_threshold}, scope=${semCfg.scope})`);
    }
  } catch { /* config table may not exist on a brand-new DB */ }

  const cacheAdapter = createRuntimeCacheAdapter(sharedCacheStore, semanticCache, cacheMetrics);

  // Phase 8: Agentic Plan Caching. A DEDICATED plan semantic cache (separate
  // partition from the response semantic cache) stores distilled plan templates;
  // a similar future agent/supervisor task reuses the template as planning
  // guidance. Activates only when enabled in agent_plan_cache_config AND an
  // embedding model is available.
  try {
    const planCfg = await db.getAgentPlanCacheConfig();
    if (planCfg?.enabled && guardrailEmbeddingModel) {
      const planSemanticCache = weaveSemanticCache({
        embed: async (text: string) => {
          const out = await guardrailEmbeddingModel.embed(
            weaveContext({ deadline: Date.now() + 30_000 }),
            { input: [text.slice(0, 4000)] },
          );
          return out.embeddings[0] ?? [];
        },
        defaultThreshold: planCfg.similarity_threshold ?? 0.86,
        maxEntries: planCfg.max_entries ?? 1000,
        ttlMs: planCfg.ttl_ms ?? 86_400_000,
      });
      const planMetrics = createPlanCacheMetrics();
      const planCache = createAgentPlanCache({
        semanticCache: planSemanticCache,
        threshold: planCfg.similarity_threshold ?? 0.86,
        ttlMs: planCfg.ttl_ms ?? 86_400_000,
        metrics: planMetrics,
      });
      setActivePlanCache(planCache, planMetrics);
      console.log(`[cache] agent plan cache enabled (threshold=${planCfg.similarity_threshold}, scope=${planCfg.scope}, minSteps=${planCfg.min_steps})`);
    }
  } catch { /* config table may not exist on a brand-new DB */ }

  // Phase 5: wire the (previously dead) invalidation engine into a live
  // invalidator over the shared store + semantic cache, driven by DB rules.
  // Real triggers (prompt/model/knowledge changes, session end) and the admin
  // "Invalidate Now" action clear the right entries via this instance.
  const cacheInvalidator = createCacheInvalidator({
    store: sharedCacheStore,
    semanticCache,
    getRules: () => loadInvalidationRules(db),
  });
  setActiveCacheInvalidator(cacheInvalidator);

  // Phase 6: tool-result caching. Reuses the SAME underlying store as the
  // response cache (baseCacheStore — pre-metrics, so tool lookups don't pollute
  // response-cache hit-rate, while a global clear / version bump still busts
  // tool entries since it's the same store) with a DEDICATED metrics sink. The
  // version token is folded into tool keys so a bump invalidates them too.
  const toolCacheMetrics = createCacheMetrics();
  setActiveToolCache({ store: baseCacheStore, metrics: toolCacheMetrics });

  // Phase 7: process-wide singleflight so concurrent identical response-cache
  // misses (across the send + stream chat paths) collapse to ONE model call.
  const singleflight = createSingleflight();
  setActiveSingleflight(singleflight);

  const runtime = weaveRuntime({
    tracer: consoleTracer,
    secrets: envSecretResolver(),
    persistence: persistenceSlot,
    redactor: defaultRedactor,
    guardrails: guardrailsSlot,
    encryption: encryptionSlot,
    resilience: resilienceAdapter,
    routing: routingAdapter,
    cost: costAdapter,
    memory: memoryAdapter,
    compliance: complianceAdapter,
    identity: identityAdapter,
    cache: cacheAdapter,
    installDefaultTracer: true,
  });
  // `installDefaultTracer: true` already wired the runtime's tracer as the
  // process default; explicit call here documents intent for readers.
  weaveSetDefaultTracer(consoleTracer);

  log.info('weaveRuntime ready', { capabilities: Array.from(runtime.capabilities) });

  // Phase G — swap the module-level OAuth client for one backed by the
  // durable state store so pending authorization-code exchanges survive a
  // restart. ESM live binding propagates the swap to `routes/auth.ts`.
  setOAuthClient(new OAuthClient(createDurableOAuthStateStore({ runtime, namespace: 'oauth-flow' })));

  const activeProviders = Object.fromEntries(
    Object.entries(config.providers).filter(([key, provider]) => {
      // Local providers (ollama, llamacpp) are valid without an apiKey.
      if (key === 'ollama' || key === 'llamacpp' || key === 'llama-cpp') return true;
      return Boolean(provider?.apiKey?.trim());
    }),
  );
  if (Object.keys(activeProviders).length === 0) {
    throw new Error('At least one provider with a non-empty apiKey is required.');
  }
  if (!activeProviders[config.defaultProvider]) {
    throw new Error(`Default provider "${config.defaultProvider}" is not configured with an apiKey.`);
  }

  const port = config.port ?? 3500;
  const host = config.host ?? '0.0.0.0';

  // 2. Chat engine
  const chatEngine = new ChatEngine(
    {
      providers: activeProviders,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      runtime,
      cacheKeyVersion,
      toolCache: { store: baseCacheStore, metrics: toolCacheMetrics, version: cacheKeyVersion },
    },
    db,
  );

  // 3. Seed all default configuration data (no-op if already seeded).
  await applySeed(db);

  // 3f. Phase M22 Phase 2: initialise the in-process handler-kind registry
  // (currently ships `agentic.react` and `deterministic.forward` as built-in
  // plugins) and sync registered kinds back into `live_handler_kinds` so the
  // admin UI's description / config schema fields stay in step with code.
  // Operator toggles such as `enabled` are never overwritten.
  const handlerRegistry = initHandlerRegistry();
  await syncHandlerKindsToDb(db, handlerRegistry);

  // 4. Sync BUILTIN_TOOLS into tool_catalog so operators can manage them
  await syncToolCatalog(db);

  // 4a. Self-register the internal MCP gateway in tool_catalog + tool_credentials
  // so operators discover it through the admin UI. Idempotent on every boot;
  // preserves operator-edited `enabled` and `config.exposed_classes`.
  await registerMCPGatewayInCatalog(db);

  // 4b. Phase 4: load operator-edited gateway exposure config so admin
  // toggles (enabled / exposed_classes) take effect on next boot.
  const gatewayConfig = await loadGatewayConfigFromCatalog(db);

  // 5. Start background tool health snapshot job (writes every 15 min)
  startToolHealthJob(db);

  // m77 Phase 1: Start artifact retention job (runs at startup + every 6 h)
  startArtifactRetentionJob(db);

  // weaveNotes Phase 0-B: prune note activity older than the configured retention horizon.
  startNoteActivityRetentionJob(db);

  // weaveNotes Phase 3: fire schedule-triggered workspace agents whose next run is due (polls 1/min).
  startNoteScheduledAgentJob(db, createModelTextGenerator({ providers: activeProviders, defaultProvider: config.defaultProvider, defaultModel: config.defaultModel, runtime }));

  // weaveNotes Phase 5: background memory ("second brain") — distil durable memories from changed notes.
  startNoteMemoryJob(db, createModelTextGenerator({ providers: activeProviders, defaultProvider: config.defaultProvider, defaultModel: config.defaultModel, runtime }));

  // 5-EN. Phase 1 (Tenant Encryption): bootstrap the per-tenant key
  // manager wired to SQLite-backed EncryptionStore + audit emitter.
  // Returns null and logs a single warning when WEAVE_ENCRYPTION_MASTER_KEY
  // is missing — encryption stays disabled but the server keeps booting.
  // The manager is exposed as `geneweaveEncryptionManager` for Phase 3
  // consumer integration (chat/sv encrypted columns).
  try {
    const { bootstrapEncryption } = await import('./encryption/bootstrap.js');
    const result = bootstrapEncryption(db);
    if (result) {
      geneweaveEncryptionManager = result.manager;
      encryptionSlot.setManager(result.manager);
      geneweaveKmsRegistry = result.registry;
      geneweaveKmsResolver = result.resolver;
      geneweaveEncryptionMetrics = result.metrics as typeof geneweaveEncryptionMetrics;
      // Phase 8: bootstrap the SYSTEM tenant whose BIK powers cross-tenant
      // equality lookups (login by users.email_bidx). Idempotent.
      try {
        const { bootstrapSystemTenant } = await import('./encryption/system-tenant.js');
        await bootstrapSystemTenant(db, result.manager);
      } catch (err) {
        log.error('system-tenant bootstrap failed (non-fatal)', { reason: String(err) });
      }
      // Phase 9: seed default fleet-wide alert rules so the operator dashboard
      // has data on first boot. Idempotent — preserves operator edits.
      try {
        const { seedDefaultAlertRules } = await import('./encryption/alert-store.js');
        const seeded = await seedDefaultAlertRules(db, { tenantId: null });
        log.info('alert rules seeded', { count: seeded });
      } catch (err) {
        log.error('alert seed failed (non-fatal)', { reason: String(err) });
      }
      // H-2: Bootstrap DEK+KEK for every tenant so m58 backfill can encrypt
      // existing credential rows. enable:false — creates keys without activating
      // per-field encryption; the flag flips automatically when a new credential
      // is written through db-sqlite.ts. Idempotent.
      try {
        const tenantRows = await db.listTenantConfigs();
        const uniqueTenantIds = [...new Set(tenantRows.map(r => r.tenant_id).filter(Boolean))];
        for (const tenantId of uniqueTenantIds) {
          await result.manager.bootstrapTenant({ tenantId, enable: false });
        }
        log.info('tenant DEK bootstrap complete', { count: uniqueTenantIds.length });
      } catch (err) {
        log.error('tenant DEK bootstrap failed (non-fatal)', { reason: String(err) });
      }
    }
  } catch (err) {
    log.error('encryption bootstrap failed (non-fatal)', { reason: String(err) });
  }

  // 5-EN-RS. Phase 5 (Tenant Encryption): start automated DEK rotation
  // scheduler. Honors `tenant_encryption_policy.rotation_schedule`
  // (monthly | quarterly | annual). Skipped silently when manager is
  // null. Default tick interval is 1 hour; uses `.unref()` so process
  // exit is unaffected.
  try {
    const { startEncryptionRotationScheduler } = await import(
      './encryption/rotation-scheduler.js'
    );
    startEncryptionRotationScheduler({
      db,
      getManager: () => geneweaveEncryptionManager,
    });
  } catch (err) {
    log.error('rotation scheduler startup failed (non-fatal)', { reason: String(err) });
  }

  // Client Phase 0 (run/stream): prune the `user_run_events` journal per the
  // `run_stream_config` row (retention horizon + per-run cap). One sweep on
  // boot + hourly thereafter; `.unref()` so it never blocks process exit. The
  // journal previously grew unbounded.
  try {
    const { loadRunStreamConfig } = await import('./chat-run-stream-utils.js');
    const sweepJournal = async () => {
      try {
        const cfg = await loadRunStreamConfig(db);
        const removed = await db.pruneUserRunEvents({
          olderThanHours: cfg.journalRetentionHours,
          maxEventsPerRun: cfg.journalMaxEvents,
        });
        if (removed > 0) log.info('run-event journal pruned', { removed });
      } catch (err) {
        log.error('run-event journal prune failed (non-fatal)', { reason: String(err) });
      }
    };
    void sweepJournal();
    const journalTimer = setInterval(() => { void sweepJournal(); }, 60 * 60 * 1000);
    if (typeof journalTimer.unref === 'function') journalTimer.unref();
  } catch (err) {
    log.error('journal prune scheduler startup failed (non-fatal)', { reason: String(err) });
  }

  // 5-EN-PS. Phase 6 (Tenant Encryption): start the GDPR purge scheduler.
  // Polls `tenant_deletion_requests` for rows whose retention window has
  // expired and calls `manager.hardShred(tenantId)` for each. Per-tenant
  // errors are isolated. Skipped silently when manager is null.
  try {
    const { weavePurgeScheduler } = await import('@weaveintel/encryption');
    weavePurgeScheduler({
      getManager: () => geneweaveEncryptionManager,
      listDuePurges: async (nowMs: number) => {
        const rows = await db.listDueTenantPurges(nowMs);
        return rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          requestedAt: r.requested_at,
          retentionUntil: r.retention_until,
        }));
      },
      markPurged: async (requestId: string, nowMs: number) => {
        await db.markTenantPurged(requestId, nowMs);
      },
    });
  } catch (err) {
    log.error('purge scheduler startup failed (non-fatal)', { reason: String(err) });
  }

  // 5-IR. Phase 8 (Cost Governor — Intent-RAG): warm tool description
  // embeddings so the per-step retrieval ranker has up-to-date vectors.
  // Best-effort + idempotent. No-op without OPENAI_API_KEY.
  try {
    const { createOpenAIEmbedder } = await import('./cost/openai-embedder.js');
    const { createDbToolEmbeddingStore } = await import('./cost/db-tool-embedding-store.js');
    const { warmToolEmbeddings } = await import('./cost/warm-tool-embeddings.js');
    const embedder = createOpenAIEmbedder();
    const store = createDbToolEmbeddingStore({ db, modelId: 'text-embedding-3-small' });
    await warmToolEmbeddings({
      embedder,
      store,
      log: (msg, meta) => log.info(msg, meta ? { meta } : undefined),
    });
  } catch (err) {
    log.warn('cost.intent-rag: warmer hook failed (non-fatal)', { reason: String(err) });
  }

  // 5-WF. Workflow Platform Phase 1: construct the singleton DB-driven
  // workflow engine and sync the resolver registry into the
  // `workflow_handler_kinds` catalog. The engine is reused by admin
  // routes (POST /api/admin/workflows/:id/run) and by other geneweave
  // subsystems that need to start runs from `workflow_defs` rows.
  // The `tool:` resolver is wired to BUILTIN_TOOLS so workflow steps
  // can call any in-process tool by key. Resolver registry sync is
  // best-effort and never blocks startup.
  // Phase 4 (DB-driven capability plan): build the in-process contract
  // bus + DB-backed emitter BEFORE the workflow engine so the engine
  // can publish typed completion contracts (`outputContract`) on every
  // run. The same bus feeds `MeshContractSourceAdapter` below so a
  // contract row in `mesh_contracts` doubles as a trigger source event.
  const contractBus = new EventEmitter();
  contractBus.setMaxListeners(0);
  const contractEmitter = new DbContractEmitter(db, contractBus);
  // Wire `prompt:<key>` resolver: render-only execution. Looks up the prompt
  // by id or name, renders the template via `executePromptRecord`, and
  // returns `{ promptKey, content, strategy }`. A future iteration may
  // forward the rendered text to a model client; for now this gives
  // workflows a deterministic templating step backed by the live prompt
  // registry, including fragment expansion and strategy overlays.
  const promptDeps = {
    async executePrompt(
      promptKey: string,
      variables: Record<string, unknown>,
      _config: Record<string, unknown>,
    ): Promise<unknown> {
      const { executePromptRecord, resolvePromptRecordForExecution } = await import(
        '@weaveintel/prompts'
      );
      const rows = await db.listPrompts();
      const match = rows.find(
        (r) => r.enabled && (r.id === promptKey || r.name === promptKey),
      );
      if (!match) throw new Error(`prompt resolver: no prompt found for key "${promptKey}"`);
      const versions = await db.listPromptVersions(match.id);
      const experiments = await db.listPromptExperiments(match.id);
      const resolved = resolvePromptRecordForExecution({
        prompt: match,
        versions,
        experiments,
        options: { assignmentKey: match.id },
      });
      const executed = executePromptRecord(resolved.record, variables);
      return {
        promptKey,
        promptId: match.id,
        version: resolved.meta.resolvedVersion,
        content: executed.content,
        strategy: executed.strategy.resolvedKey,
      };
    },
  };

  const workflowEngineHandle: WorkflowEngineHandle = createGeneweaveWorkflowEngine({
    db,
    toolGetter: (key: string) => BUILTIN_TOOLS[key],
    contractEmitter,
    runtime,
    promptDeps,
  });  try {
    await syncWorkflowHandlerKindsToDb(db, workflowEngineHandle.registry);
  } catch (err) {
    log.warn('failed to sync workflow handler kinds', { reason: String(err) });
  }
  // Wire the `workflow_run` built-in tool so any agent / chat session can
  // start a workflow run by id or name. Tool definition lives in
  // `tools.ts`; the engine reference is published here once available.
  setWorkflowEngineForTools({
    startRun: (id, input) => workflowEngineHandle.engine.startRun(id, input),
    async resolveByKey(key) {
      const direct = await db.getWorkflowDef(key);
      if (direct) return direct.id;
      const all = await db.listWorkflowDefs();
      return all.find((row) => row.name === key)?.id;
    },
  });

  // 5-TR. Phase 3 Unified Triggers: build the singleton dispatcher with
  // a DB-backed store, in-process manual + cron sources (cron sources
  // are spun up per-trigger by the dispatcher itself based on rows in
  // `triggers`), and target adapters for `webhook_out` and `workflow`.
  // The dispatcher reloads on every CRUD write (admin route handlers
  // call `dispatcher.reload()`), so cron schedules reflect DB state
  // without a server restart.
  const triggerStore = createDbTriggerStore(db);
  const manualSource = new ManualSourceAdapter();
  const meshContractSource = new MeshContractSourceAdapter(contractBus);
  // Phase G — durable per-trigger rate-limit windows. Backed by
  // `runtime.persistence.kv` so quotas survive process restart and
  // coordinate across nodes.
  const triggerRateLimiter = createDurableTriggerRateLimiter({ runtime, namespace: 'trigger-rate' });
  const triggerDispatcher: TriggerDispatcher = createTriggerDispatcher({
    store: triggerStore,
    sourceAdapters: [manualSource, meshContractSource],
    targetAdapters: [
      new WebhookOutTargetAdapter(),
      createWorkflowTargetAdapter(workflowEngineHandle),
      createContractTargetAdapter(contractEmitter),
    ],
    rateLimiter: triggerRateLimiter,
  });
  try {
    await triggerDispatcher.start();
    startedHandles.push(triggerDispatcher);
  } catch (err) {
    log.warn('failed to start trigger dispatcher', { reason: String(err) });
  }

  // 5a. Resilience Phase 4: subscribe to the shared signal bus and
  // batch-write per-endpoint counters into `endpoint_health` every ~1s.
  // Pass the explicit bus so the observer and runtime.resilience share one
  // event source rather than each holding an independent reference.
  applyDbResilienceObserver(db, signalBus);

  // 5b. anyWeave Phase 5: daily regression detection on capability signals
  startRoutingRegressionJob(db);

  // 5c. M21: global Kaggle live-agents heartbeat — drives every active
  // competition run (concurrency 8 covers ~1 full pipeline of 6 roles per
  // tick). Failure here is non-fatal: the HTTP server still boots so
  // operators can inspect runs in the admin UI.
  let kaggleHeartbeat: KaggleHeartbeatHandle | null = null;
  try {
    kaggleHeartbeat = await startKaggleHeartbeat({
      db,
      providers: activeProviders,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
    });
    if (kaggleHeartbeat) startedHandles.push(kaggleHeartbeat);
  } catch (err) {
    log.error('Failed to start Kaggle heartbeat', { reason: err instanceof Error ? err.message : String(err) });
  }

  // 5d. Phase 5: optional generic supervisor (mesh-agnostic). Off by default;
  // enable with LIVE_AGENTS_GENERIC_RUNTIME=1. Coexists with the Kaggle
  // heartbeat; safe to leave off if no generic mesh has been provisioned.
  let genericSupervisor: HeartbeatSupervisorHandle | null = null;
  try {
    genericSupervisor = await startGenericSupervisorIfEnabled({
      db,
      providers: activeProviders,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      runtime,
    });
    if (genericSupervisor) startedHandles.push(genericSupervisor);
  } catch (err) {
    log.error('Failed to start generic supervisor', { reason: err instanceof Error ? err.message : String(err) });
  }

  // 5a. Voice engine (requires OpenAI for Whisper STT + tts-1 TTS)
  const { createVoiceEngine } = await import('./voice-engine.js');
  const voiceEngine = await createVoiceEngine(db, chatEngine, activeProviders);
  if (voiceEngine) {
    log.info('Voice agent: enabled', { stt: 'openai:whisper', tts: 'openai:tts-1' });
  }

  // 5b. HTTP server
  const server = createGeneWeaveServer({
    db,
    chatEngine,
    voiceEngine: voiceEngine ?? undefined,
    jwtSecret: config.jwtSecret,
    corsOrigin: config.corsOrigin,
    providers: activeProviders,
    publicBaseUrl: config.publicBaseUrl,
    gatewayConfig,
    workflowEngine: workflowEngineHandle,
    triggerDispatcher: { dispatcher: triggerDispatcher, manualSource },
    runtime, // thread real runtime so admin weaveAudit writes to durable KV
  });

  // 5. Listen — on port binding failure, roll back all started services.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      log.info(`geneWeave running → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      resolve();
    });
  }).catch(rollback);

  return {
    port,
    server,
    db,
    chatEngine,
    runtime,
    workflows: workflowEngineHandle,
    async syncPricing() {
      return syncModelPricing(db, activeProviders);
    },
    async stop() {
      if (kaggleHeartbeat) {
        try { await kaggleHeartbeat.stop(); } catch { /* non-fatal */ }
      }
      if (genericSupervisor) {
        try { await genericSupervisor.stop(); } catch { /* non-fatal */ }
      }
      try { await triggerDispatcher.stop(); } catch { /* non-fatal */ }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await db.close();
      log.info('geneWeave stopped');
    },
  };
}

// ─── Re-exports for advanced usage ───────────────────────────

export type { DatabaseAdapter, DatabaseConfig, UserRow, SessionRow, ChatRow, MessageRow, MetricRow, EvalRow, MetricsSummary, ChatSettingsRow, TraceRow, PromptRow, GuardrailRow, RoutingPolicyRow, WorkflowDefRow, ToolCatalogRow, WorkflowRunRow, GuardrailEvalRow, ToolPolicyRow, ToolRateLimitBucketRow, ToolAuditEventRow, ToolHealthSnapshotRow, ToolCredentialRow } from './db.js';
export { SQLiteAdapter, createDatabaseAdapter } from './db.js';
export type { ProviderConfig, ChatEngineConfig, ChatSettings } from './chat.js';
export { ChatEngine, calculateCost } from './chat.js';
export { DashboardService } from './dashboard.js';
export type { AuthContext, JWTPayload } from './auth.js';
export { signJWT, verifyJWT, hashPassword, verifyPassword, generateCSRFToken } from './auth.js';
export { BUILTIN_TOOLS, createToolRegistry, getAvailableTools } from './tools.js';
export {
  MeRunExecutor,
  isTerminalRunStatus,
  type RunEventEnvelope,
  type MeRunEmitter,
  type MeRunAgent,
  type MeRunAgentArgs,
  type MeRunStartArgs,
  type MeRunExecutorOptions,
} from './me-run-executor.js';
export { createDefaultMeRunAgent } from './me-run-agent.js';
export { createLogger } from '@weaveintel/core';
