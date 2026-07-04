/**
 * @weaveintel/geneweave — Workflow Platform Phase 1 wiring
 *
 * Composes the package-level Phase 1 primitives from
 * `@weaveintel/workflows` (HandlerResolverRegistry, default resolvers,
 * WorkflowDefinitionStore, DefaultWorkflowEngine) into a runtime that:
 *
 *   1. Hydrates `workflow_defs` rows on demand via DbWorkflowDefinitionStore.
 *   2. Resolves handler refs (`tool:foo`, `script:`, `noop`, …) at run time
 *      using a registry seeded with the seven built-in resolvers.
 *   3. Syncs the registry back to the `workflow_handler_kinds` catalog so
 *      admin UIs can render handler-kind pickers without hardcoded enums.
 *
 * The engine is constructed once at startup and reused across admin
 * route handlers and other geneweave subsystems that need to start
 * workflow runs from DB definitions.
 */

import { newUUIDv7, createLogger, type WeaveRuntime } from '@weaveintel/core';

const logger = createLogger('workflow-engine');
import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  InMemoryCostMeter,
  InMemoryWorkflowDefinitionStore,
  createDurableCostMeter,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
  createPromptResolver,
  createAgentResolver,
  createMcpResolver,
  createSubWorkflowResolver,
  describeHandlerKinds,
  weaveSqliteIdempotencyStore,
  type CostMeter,
  type HandlerKindDescriptor,
  type WorkflowDefinitionStore,
  type WorkflowRunRepository,
  type CheckpointStore,
  type WorkflowSpanEmitter,
  type PayloadStore,
  type StepLockStore,
  type WorkflowRateLimiter,
  type WorkflowRunQueue,
  type StepIdempotencyStore,
  type PromptResolverDeps,
  type AgentResolverDeps,
  type McpResolverDeps,
  type SubWorkflowResolverDeps,
} from '@weaveintel/workflows';
import type {
  WorkflowDefinition,
  WorkflowStep,
  DurableSleepStore,
  WorkflowAuditLog,
} from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';
import { DbWorkflowRunRepository } from './workflows/db-workflow-run-repository.js';
import { DbCheckpointStore } from './workflows/db-checkpoint-store.js';
import { DbSpanEmitter } from './workflows/db-span-emitter.js';
import { DbPayloadStore } from './workflows/db-payload-store.js';
import { DbStepLockStore } from './workflows/db-step-lock-store.js';
import { DbSleepStore } from './workflows/db-sleep-store.js';
import { DbAuditLog } from './workflows/db-audit-log.js';
import { DbWorkflowRateLimiter } from './workflows/db-rate-limiter.js';
import { DbRunQueue } from './workflows/db-run-queue.js';

/**
 * DB-backed `WorkflowDefinitionStore` adapter.
 *
 * Marshals `workflow_defs` rows to/from `Workflow` shapes used by the
 * package-level engine. Keeps the package fully DB-agnostic: the
 * adapter lives in geneweave; the package only sees the interface.
 */
class DbWorkflowDefinitionStore implements WorkflowDefinitionStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async list(): Promise<WorkflowDefinition[]> {
    const rows = await this.db.listWorkflowDefs();
    return rows.filter(r => r.enabled !== 0).map(rowToWorkflow);
  }

  async get(idOrKey: string): Promise<WorkflowDefinition | null> {
    const row = await this.db.getWorkflowDef(idOrKey);
    if (!row) return null;
    return rowToWorkflow(row);
  }

  async save(def: WorkflowDefinition): Promise<WorkflowDefinition> {
    const existing = await this.db.getWorkflowDef(def.id);
    const stepsJson = JSON.stringify(def.steps ?? []);
    // Pack `outputContract` into metadata under a reserved key so the
    // existing `workflow_defs.metadata` JSON column carries it without
    // requiring a schema migration. `rowToWorkflow` unpacks it on read.
    const mergedMetadata: Record<string, unknown> | undefined = (def.metadata || def.outputContract)
      ? { ...(def.metadata ?? {}), ...(def.outputContract ? { __outputContract: def.outputContract } : {}) }
      : undefined;
    const metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : null;
    if (existing) {
      await this.db.updateWorkflowDef(def.id, {
        name: def.name,
        description: def.description ?? null,
        version: def.version ?? '1.0',
        steps: stepsJson,
        entry_step_id: def.entryStepId,
        metadata: metadataJson,
      });
    } else {
      await this.db.createWorkflowDef({
        id: def.id,
        name: def.name,
        description: def.description ?? null,
        version: def.version ?? '1.0',
        steps: stepsJson,
        entry_step_id: def.entryStepId,
        metadata: metadataJson,
        enabled: 1,
      });
    }
    return def;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteWorkflowDef(id);
  }
}

function rowToWorkflow(row: {
  id: string;
  name: string;
  description: string | null;
  version: string;
  steps: string;
  entry_step_id: string;
  metadata: string | null;
}): WorkflowDefinition {
  let steps: WorkflowStep[] = [];
  try { steps = JSON.parse(row.steps) as WorkflowStep[]; } catch { /* leave empty */ }
  let metadata: Record<string, unknown> | undefined;
  let outputContract: WorkflowDefinition['outputContract'] | undefined;
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
      if (parsed['__outputContract']) {
        outputContract = parsed['__outputContract'] as WorkflowDefinition['outputContract'];
        const { __outputContract: _drop, ...rest } = parsed;
        void _drop;
        if (Object.keys(rest).length > 0) metadata = rest;
      } else {
        metadata = parsed;
      }
    } catch { /* ignore */ }
  }
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    version: row.version,
    steps,
    entryStepId: row.entry_step_id,
    ...(metadata ? { metadata } : {}),
    ...(outputContract ? { outputContract } : {}),
  };
}

/**
 * Build the geneweave-wide `HandlerResolverRegistry` for Phase 1.
 *
 * Seeds the registry with the seven built-in resolvers from
 * `@weaveintel/workflows` (noop, script, tool, prompt, agent, mcp,
 * subworkflow). The `tool:` resolver is wired against the in-process
 * BUILTIN_TOOLS map; later phases will swap this for a registry-backed
 * resolver that respects per-tenant tool catalog filtering.
 *
 * The remaining resolver kinds (prompt/agent/mcp/subworkflow) are
 * intentionally **not** wired in Phase 1 — they require runtime hooks
 * (model client, agent registry, MCP gateway, sub-engine) that are
 * better wired in Phase 2 once the catalog UI exists.
 */
export function buildWorkflowResolverRegistry(opts: {
  // Optional injection point for the tool resolver. If omitted, the
  // resolver is omitted entirely and steps that reference `tool:foo`
  // will fail at execution time with a clear error.
  //
  // The getter returns a tool-like object that exposes either a callable
  // (`(input) => result`) or an `execute(input)` method. Geneweave's
  // BUILTIN_TOOLS records expose the latter; the adapter below normalizes
  // both shapes into the `(input) => Promise<result>` contract that
  // `@weaveintel/workflows`'s `createToolResolver` expects.
  toolGetter?: (key: string) => unknown;
  /** Optional: wire `prompt:<key>` steps. */
  promptDeps?: PromptResolverDeps;
  /** Optional: wire `agent:<key>` steps. */
  agentDeps?: AgentResolverDeps;
  /** Optional: wire `mcp:<server>:<method>` steps. */
  mcpDeps?: McpResolverDeps;
  /** Optional: wire `subworkflow:<key>` steps. */
  subworkflowDeps?: SubWorkflowResolverDeps;
}): HandlerResolverRegistry {
  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  // The `script:` resolver evaluates admin-supplied JavaScript in-process via
  // `new Function(...)`. Any tenant_admin who can write to `workflow_defs`
  // can therefore execute arbitrary code on the server. Gate it behind an
  // explicit operator opt-in. Default OFF.
  if (process.env['GENEWEAVE_ENABLE_SCRIPT_RESOLVER'] === '1') {
    reg.register(createScriptResolver());
  }
  if (opts.toolGetter) {
    const getter = opts.toolGetter;
    reg.register(
      createToolResolver({
        async getTool(toolKey: string) {
          const tool = getter(toolKey);
          if (!tool) return undefined;
          if (typeof tool === 'function') {
            return tool as (input: Record<string, unknown>) => Promise<unknown>;
          }
          if (typeof tool === 'object' && tool !== null) {
            // weaveTool() / defineTool() shape: { schema, invoke(ctx, { arguments }) }
            // The workflow engine has no per-call ToolContext, so we pass an
            // empty stub. Tools that need chat/user/agent context must be
            // wrapped explicitly by Phase 2 catalog wiring.
            if ('invoke' in tool && typeof (tool as { invoke: unknown }).invoke === 'function') {
              const invoke = (tool as { invoke: (ctx: Record<string, unknown>, input: { arguments: Record<string, unknown> }) => Promise<unknown> }).invoke.bind(tool);
              return async (variables: Record<string, unknown>) => invoke({}, { arguments: variables });
            }
            // Alternate shape: { execute(args) }
            if ('execute' in tool && typeof (tool as { execute: unknown }).execute === 'function') {
              return (tool as { execute: (input: Record<string, unknown>) => Promise<unknown> }).execute.bind(tool);
            }
          }
          return undefined;
        },
      }),
    );
  }
  if (opts.promptDeps) reg.register(createPromptResolver(opts.promptDeps));
  if (opts.agentDeps) reg.register(createAgentResolver(opts.agentDeps));
  if (opts.mcpDeps) reg.register(createMcpResolver(opts.mcpDeps));
  if (opts.subworkflowDeps) reg.register(createSubWorkflowResolver(opts.subworkflowDeps));
  return reg;
}

/**
 * Sync the in-process resolver registry into the
 * `workflow_handler_kinds` catalog table. Called once at startup.
 *
 * Behavior:
 *   - INSERT new kinds with `enabled=1, source='builtin'`.
 *   - UPDATE description/config_schema/source on existing rows.
 *   - Preserve operator-edited `enabled` flag (handled by the DB upsert).
 *
 * Best-effort: failures are logged and do not block startup.
 */
export async function syncWorkflowHandlerKindsToDb(
  db: DatabaseAdapter,
  registry: HandlerResolverRegistry,
): Promise<void> {
  const kinds: HandlerKindDescriptor[] = describeHandlerKinds(registry);
  for (const k of kinds) {
    try {
      const existing = await db.getWorkflowHandlerKind(k.kind);
      await db.upsertWorkflowHandlerKind({
        id: existing?.id ?? newUUIDv7(),
        kind: k.kind,
        description: k.description ?? null,
        config_schema: k.configSchema ? JSON.stringify(k.configSchema) : null,
        enabled: existing ? existing.enabled : 1,
        source: 'builtin',
      });
    } catch (err) {
      logger.warn(`failed to sync kind '${k.kind}'`, { err });
    }
  }
}

export interface WorkflowEngineHandle {
  engine: DefaultWorkflowEngine;
  registry: HandlerResolverRegistry;
  store: WorkflowDefinitionStore;
  /** Phase 5: in-memory cost meter (per-process). */
  costMeter: CostMeter;
  /** Phase 5: DB-backed run repository. */
  runRepository: WorkflowRunRepository;
  /** Phase 5: DB-backed checkpoint store. */
  checkpointStore: CheckpointStore;
  /** Phase W6: DB-backed span emitter for observability. */
  spanEmitter: WorkflowSpanEmitter;
  /** Phase W3: DB-backed payload store for large step outputs. */
  payloadStore: PayloadStore;
  /** Phase W4: DB-backed step lock store for exactly-once execution. */
  stepLockStore: StepLockStore;
  /** Phase W4: DB-backed durable sleep store for `wait` steps. */
  sleepStore: DurableSleepStore;
  /** Phase W4: DB-backed immutable audit log. */
  auditLog: WorkflowAuditLog;
  /** Phase W5: DB-backed token-bucket rate limiter. */
  rateLimiter: WorkflowRateLimiter;
  /** Phase W5: DB-backed run queue for concurrency buffering. */
  runQueue: WorkflowRunQueue;
  /** Phase W2: SQLite-backed step idempotency store (shared connection). */
  idempotencyStore: StepIdempotencyStore;
}

/**
 * Construct the geneweave singleton workflow engine.
 *
 * Caller wires this once at startup (in `index.ts` after
 * `seedDefaultData`) and passes the resulting handle to admin routes
 * that need to start runs from DB definitions.
 */
export function createGeneweaveWorkflowEngine(opts: {
  db: DatabaseAdapter;
  toolGetter?: (key: string) => unknown;
  contractEmitter?: import('@weaveintel/workflows').ContractEmitter;
  /**
   * Phase B (Durable consumers): when supplied and the runtime carries a
   * `persistence` slot, workflow run cost totals survive process
   * restarts via `createDurableCostMeter`. Falls back to the legacy
   * in-memory meter when omitted.
   */
  runtime?: WeaveRuntime;
  /** Wire `prompt:<key>` resolver. Caller supplies the executor. */
  promptDeps?: PromptResolverDeps;
  /** Wire `agent:<key>` resolver. Caller supplies the executor. */
  agentDeps?: AgentResolverDeps;
  /** Wire `mcp:<server>:<method>` resolver. Caller supplies the gateway. */
  mcpDeps?: McpResolverDeps;
}): WorkflowEngineHandle {
  const store = new DbWorkflowDefinitionStore(opts.db);
  // We also wire an in-memory cache layer as the primary store: the
  // engine's built-in cache plus the DB fallback gives us the right
  // mix of speed and correctness for hot definitions.
  const memCache = new InMemoryWorkflowDefinitionStore();
  const layered: WorkflowDefinitionStore = {
    list: () => store.list(),
    async get(idOrKey: string) {
      const cached = await memCache.get(idOrKey);
      if (cached) return cached;
      const fromDb = await store.get(idOrKey);
      if (fromDb) await memCache.save(fromDb);
      return fromDb;
    },
    async save(def: WorkflowDefinition) {
      await store.save(def);
      await memCache.save(def);
      return def;
    },
    async delete(id: string) {
      await store.delete(id);
      await memCache.delete(id);
    },
  };
  const costMeter: CostMeter = opts.runtime
    ? createDurableCostMeter({ runtime: opts.runtime, namespace: 'cost-meter' })
    : new InMemoryCostMeter();
  const runRepository = new DbWorkflowRunRepository(opts.db);
  const checkpointStore = new DbCheckpointStore(opts.db);
  const spanEmitter = new DbSpanEmitter(opts.db);
  const payloadStore = new DbPayloadStore(opts.db);
  const stepLockStore = new DbStepLockStore(opts.db);
  const sleepStore = new DbSleepStore(opts.db);
  const auditLog = new DbAuditLog(opts.db);
  const rateLimiter = new DbWorkflowRateLimiter(opts.db);
  const runQueue = new DbRunQueue(opts.db);
  // Phase W2: share the geneweave SQLite connection so the idempotency
  // table lives in the same DB file as the rest of workflow state.
  // The workflows package creates `wf_idempotency` on first use.
  const rawSqlite = (opts.db as unknown as { d?: unknown }).d;
  const idempotencyStore = weaveSqliteIdempotencyStore(
    rawSqlite ? { database: rawSqlite as never } : {},
  );

  // Forward-reference: subworkflow resolver needs a handle to the engine
  // we are about to construct. Use a mutable holder + closure so the
  // resolver can be registered before the engine exists.
  let engineRef: DefaultWorkflowEngine | undefined;
  const subworkflowDeps: SubWorkflowResolverDeps = {
    async resolveWorkflowKey(key: string): Promise<string | undefined> {
      // Allow either workflow id (PK) or `name` lookup. The
      // definition store treats both as a get-by-id alias.
      const direct = await opts.db.getWorkflowDef(key);
      if (direct) return direct.id;
      const all = await opts.db.listWorkflowDefs();
      const byName = all.find((row) => row.name === key);
      return byName?.id;
    },
    async startRun(workflowId: string, input?: Record<string, unknown>) {
      if (!engineRef) {
        throw new Error('subworkflow resolver: engine not yet constructed');
      }
      return engineRef.startRun(workflowId, input ?? {});
    },
  };

  const registry = buildWorkflowResolverRegistry({
    ...(opts.toolGetter ? { toolGetter: opts.toolGetter } : {}),
    ...(opts.promptDeps ? { promptDeps: opts.promptDeps } : {}),
    ...(opts.agentDeps ? { agentDeps: opts.agentDeps } : {}),
    ...(opts.mcpDeps ? { mcpDeps: opts.mcpDeps } : {}),
    subworkflowDeps,
  });

  const engine = new DefaultWorkflowEngine({
    resolverRegistry: registry,
    definitionStore: layered,
    runRepository,
    checkpointStore,
    costMeter,
    spanEmitter,
    payloadStore,
    stepLockStore,
    sleepStore,
    auditLog,
    rateLimiter,
    runQueue,
    idempotencyStore,
    ...(opts.contractEmitter ? { contractEmitter: opts.contractEmitter } : {}),
  });
  engineRef = engine;
  return {
    engine,
    registry,
    store: layered,
    costMeter,
    runRepository,
    checkpointStore,
    spanEmitter,
    payloadStore,
    stepLockStore,
    sleepStore,
    auditLog,
    rateLimiter,
    runQueue,
    idempotencyStore,
  };
}

export { DbWorkflowDefinitionStore };
