/**
 * Shared utilities used by every Kaggle role handler.
 *
 * Pulled out of the original monolithic `role-handlers.ts` so each role file
 * stays focused on its own logic. No business decisions live here — only
 * pure helpers (id parsing, slug normalization, kernel polling, inbound
 * loading, message dispatch).
 */

import type {
  ActionExecutionContext,
  LiveAgentPolicy,
  ModelResolver,
  TaskHandler,
} from '@weaveintel/live-agents';
import {
  type KaggleAdapter,
  type KaggleCredentials,
} from '../../../kaggle/index.js';
import type { Model } from '@weaveintel/core';
import type { KaggleAgentRole } from '../account-bindings.js';
import type {
  KagglePlaybook,
  KagglePlaybookResolver,
} from '../playbook-resolver.js';
import type { DatabaseAdapter } from '../../../db.js';

export const DEFAULT_MAX_ITERATIONS = 8;

export interface KaggleRoleHandlersOptions {
  /** Override the kaggle adapter (defaults to the live REST adapter). */
  adapter?: KaggleAdapter;
  /** Override credential resolution (defaults to KAGGLE_USERNAME/KAGGLE_KEY env). */
  credentials?: KaggleCredentials;
  /** Optional console.log replacement. */
  log?: (msg: string) => void;
  /** LLM used by the strategist to plan each iteration. If absent, deterministic mode is used. */
  plannerModel?: Model;
  /**
   * Phase 5 (live-agents capability parity) — first-class per-tick model
   * resolver. The strategist rebuilds its inner ReAct handler on every tick
   * with whatever model the resolver picks (typically backed by
   * `weaveDbModelResolver` from `@weaveintel/live-agents-runtime`). Falls
   * back to `plannerModel` when the resolver returns `undefined` or throws.
   *
   * The Phase 1 alias `resolveModelForRole?: (role, hint) => Promise<Model>`
   * was removed in Phase 5 — pass a `ModelResolver` directly. To wrap an
   * existing per-role callback, lift it via `weaveModelResolverFromFn(...)`.
   */
  modelResolver?: ModelResolver;
  /**
   * Default iteration cap when no playbook matches (deterministic mode only).
   * The matched playbook's `examples.maxIterations` overrides this when present.
   */
  maxIterations?: number;
  /** DB-backed playbook resolver. REQUIRED for production. */
  playbookResolver?: KagglePlaybookResolver;
  /** DB adapter for Phase K7d submission-validation persistence. */
  db?: DatabaseAdapter;
  /** Tenant id for rubric scoping (Phase K7d). Defaults to null (global). */
  tenantId?: string | null;
  /**
   * Phase 3 (live-agents capability parity) — first-class per-tick policy
   * bundle forwarded to every agentic role handler that wraps `weaveLiveAgent`
   * (currently the strategist). Typically supplied as
   * `weaveDbLiveAgentPolicy({ policyResolver, approvalGate, rateLimiter, auditEmitter })`
   * from the heartbeat boot path so kaggle tool calls share the same DB-backed
   * gating pipeline operators administer for chat + the generic supervisor.
   */
  policy?: LiveAgentPolicy;
  /**
   * Best-effort observer for every successful `kaggle_push_kernel` performed
   * by the strategist's ReAct loop. Wired by the heartbeat boot path to
   * persist a structured `kgl_run_event` (kind=`kernel_pushed`) so we have
   * a queryable ledger of canonical Kaggle-returned kernelRefs per run —
   * instead of relying on unstructured `tool_audit_events.output_preview`
   * JSON. Throws are swallowed by the underlying tool; a failing observer
   * never blocks the push.
   */
  onKernelPushed?: (record: import('../kaggle-tools.js').KernelPushRecord) => Promise<void> | void;
  /**
   * Best-effort observer fired the FIRST time any kaggle_* tool returns a
   * structured `rate_limited` rejection within a tick. Boot path wires this
   * to insert a `kgl_run_event` (kind=`tool_blocked`) so the operator-facing
   * run-detail surfaces Kaggle account pressure as a first-class signal
   * (separate from generic `tool_audit_events`). Throws are swallowed.
   */
  onToolBlocked?: (record: import('../kaggle-tools.js').ToolBlockedRecord) => Promise<void> | void;
  /**
   * Per-tick factory that returns a registry of read-only trace-retrieval
   * tools scoped to the strategist's CURRENT competition run only. Boot
   * path wires this so the LLM can introspect its own prior steps,
   * failed tool calls, and pushed kernels via cheap DB reads instead of
   * relying on full ReAct history. The factory's closure binds one
   * runId; tools never accept a runId argument.
   */
  traceToolsFactory?: (ctx: {
    meshId: string;
    agentId?: string;
  }) => Promise<import('@weaveintel/core').ToolRegistry | null>;
  /**
   * Cost Governor Phase 5 (lever L3 — dynamic tool subset). Boot path wires
   * a per-tick async closure that resolves the effective `CostPolicy` via
   * `DbCostPolicyResolver`, derives a logical `phase` from the active kgl
   * run state, and calls `bundle.toolFilter(toolKeys, ctx)` from
   * `@weaveintel/cost-governor`. Returning `null` means pass-through (keep
   * everything). NEVER load-bearing — throws and zero-overlap return the
   * full kaggle registry so the agent always has tools to call.
   */
  costToolFilter?: (ctx: {
    meshId: string;
    agentId?: string;
    toolKeys: readonly string[];
    /** Phase 8: per-step user/agent goal text used by the intent-RAG ranker. */
    goal?: string;
  }) => Promise<readonly string[] | null>;
  /**
   * Cost Governor Phase 6 (lever L4 — intel-gated prompt sections). Boot
   * path wires a per-tick closure that resolves the effective `CostPolicy`
   * via `DbCostPolicyResolver`, computes the mesh's intel-maturity score
   * via `DbIntelScoreProvider`, and returns an `IntelGatingDecision`
   * describing which prepare() sections (`intel_header`, `intel_snippets`)
   * the strategist may drop. Returning `null` means "no shape change"
   * (keep everything). NEVER load-bearing — throws return null and the
   * strategist keeps the full prepare(). When omitted entirely, the
   * strategist behaves as if the gate always returned null.
   */
  intelGate?: (ctx: {
    meshId: string;
    agentId?: string;
  }) => Promise<import('@weaveintel/cost-governor').PromptShape | null>;
  /**
   * Cost Governor Phase 6 (lever L5 — history compaction). Boot path wires
   * a per-tick closure that delegates to `bundle.historyCompactor` from
   * `@weaveintel/cost-governor`. Strategist applies it to the conversation
   * history fed to the model. NEVER load-bearing — throws return the
   * original history unchanged.
   */
  historyCompactor?: (
    history: ReadonlyArray<import('@weaveintel/cost-governor').HistoryItem>,
    ctx: { meshId: string; agentId?: string },
  ) => Promise<ReadonlyArray<import('@weaveintel/cost-governor').HistoryItem>>;
  /**
   * Cost Governor Phase 7 (lever L6 — max-steps cap). Effective cap on the
   * strategist's per-tick ReAct iteration count. Sourced per-tick by the
   * boot path from `bundle.maxStepsCap` and clamped against the operator's
   * `opts.maxIterations`. NEVER load-bearing — when omitted the strategist
   * falls back to the playbook / default.
   */
  maxStepsCap?: number;
  /**
   * Cost Governor Phase 7 (lever L7 — reasoning effort hint). When set,
   * the strategist wraps its inner model with
   * `wrapModelWithStaticReasoningEffort` so OpenAI o-series / Anthropic
   * extended-thinking calls receive the hint. Sourced from
   * `bundle.reasoningEffort`. Provider-agnostic — providers that ignore
   * the metadata field see no behaviour change.
   */
  reasoningEffortHint?: import('@weaveintel/cost-governor').ReasoningEffort;
  /**
   * Cost Governor Phase 7 (lever L8 — tool output truncation). When
   * provided, the boot path wraps the kaggle ToolRegistry with
   * `wrapToolRegistryWithOutputTruncation` so each tool's
   * `ToolOutput.content` is capped to the configured byte budget. Sourced
   * from `bundle.toolOutputTruncator`. NEVER load-bearing — pass-through
   * when the bundle's truncator is the no-op.
   */
  toolOutputTruncator?: import('@weaveintel/cost-governor').ToolOutputTruncator;
  /**
   * Cost Governor Phase 7 (lever L9 — budget gate). Per-tick check that
   * raises `CostCeilingExceededError` when the run's total USD exceeds
   * the policy's `budgetCeilingUsd`. Strategist invokes between ReAct
   * iterations; on breach it injects a final-submit notice and emits
   * a `live_run_events.kind='cost.exceeded'` audit row. Sourced from
   * `bundle.budgetGate`. NEVER load-bearing — when omitted the strategist
   * skips the check entirely.
   */
  budgetGate?: import('@weaveintel/cost-governor').CostBudgetGate;
  /**
   * Cost Governor — per-tick L6/L7/L8/L9 resolver. When provided, the
   * strategist invokes this on every tick with the live `(meshId, agentId)`
   * to get a fresh `{ maxStepsCap, reasoningEffortHint, toolOutputTruncator,
   * budgetGate }` bundle. Resolver output OVERRIDES the boot-time scalar
   * fields above (which remain valid fallbacks for tests / single-tier
   * deployments). NEVER load-bearing — throws are logged and the strategist
   * falls back to the boot-time scalars (or no-op when those are also
   * unset). Keeps the cost-governor `agent → mesh → workflow → tenant`
   * binding chain authoritative for L6-L9 the same way `costToolFilter`
   * and `intelGate` are for L3 and L4.
   */
  phase7Resolver?: (ctx: { meshId: string; agentId?: string }) => Promise<{
    maxStepsCap?: number;
    reasoningEffortHint?: import('@weaveintel/cost-governor').ReasoningEffort;
    toolOutputTruncator?: import('@weaveintel/cost-governor').ToolOutputTruncator;
    budgetGate?: import('@weaveintel/cost-governor').CostBudgetGate;
  }>;
}

export interface OperationalDefaults {
  topNAgentic: number;
  topNDeterministic: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

/** Map of role label → TaskHandler. Keys MUST match the role labels used by
 *  the mesh template (`mesh-template.ts`). */
export type KaggleHandlerMap = Record<string, TaskHandler>;

/** Bundle of shared per-tick resources passed into every per-role factory. */
export interface SharedHandlerContext {
  opts: KaggleRoleHandlersOptions;
  adapter: KaggleAdapter;
  log: (m: string) => void;
  /** Lazy-resolved catch-all playbook defaults (top-N, poll cadence). */
  getOpDefaults: () => Promise<OperationalDefaults>;
}

export const noopHandler: TaskHandler = async () => ({
  completed: true,
  summaryProse: 'no-op',
});

/** Kaggle's pushKernel returns a ref like '/code/<owner>/<slug>' but its
 * status/output endpoints expect '<owner>/<slug>'. Normalize. */
export function normalizeKernelRef(rawRef: string, kernelUrl: string): string {
  if (rawRef && !rawRef.startsWith('/')) return rawRef;
  const url = kernelUrl || rawRef;
  const m = url.match(/(?:code|kernels)\/([^/]+)\/([^/?#]+)/);
  if (m && m[1] && m[2]) return `${m[1]}/${m[2]}`;
  return rawRef;
}

export async function pollKernelUntilTerminal(
  adapter: KaggleAdapter,
  creds: KaggleCredentials,
  kernelRef: string,
  log: (m: string) => void,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<{ status: string; failureMessage: string | null; logExcerpt: string; outputFiles: string[] }> {
  const terminal = new Set(['complete', 'error', 'cancelled', 'cancelAcknowledged']);
  const maxAttempts = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
  let status = 'unknown';
  let failureMessage: string | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const st = await adapter.getKernelStatus(creds, kernelRef);
      status = st.status;
      failureMessage = st.failureMessage;
      log(`poll[${i}] ref=${kernelRef} status=${status}`);
      if (terminal.has(status)) break;
    } catch (err) {
      log(`poll[${i}] error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  let logExcerpt = '';
  let outputFiles: string[] = [];
  try {
    const out = await adapter.getKernelOutput(creds, kernelRef);
    outputFiles = out.files.map((f) => f.fileName);
    if (out.log) logExcerpt = out.log.slice(-2000);
  } catch (err) {
    log(`output fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status, failureMessage, logExcerpt, outputFiles };
}

export function resolveCreds(opts: KaggleRoleHandlersOptions): KaggleCredentials {
  if (opts.credentials) return opts.credentials;
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    throw new Error(
      'Kaggle credentials missing: set KAGGLE_USERNAME and KAGGLE_KEY in env or pass credentials to createKaggleRoleHandlers.',
    );
  }
  return { username, key };
}

async function nextAgentId(
  context: ActionExecutionContext,
  nextRole: KaggleAgentRole,
): Promise<string> {
  // Legacy mesh-template.ts agents used `${meshId}::${role}` ids. Provisioned
  // meshes (provisionMesh) issue plain UUIDs, so look the sibling up by role
  // in the StateStore. Fall back to the legacy shape only when the current
  // agent id matches it.
  const currentAgentId = context.agent.id;
  const idx = currentAgentId.lastIndexOf('::');
  if (idx >= 0) return `${currentAgentId.slice(0, idx)}::${nextRole}`;
  const siblings = await context.stateStore.listAgents(context.agent.meshId);
  const target = siblings.find((a) => a.role === nextRole);
  if (!target) {
    throw new Error(
      `No sibling agent with role '${nextRole}' in mesh ${context.agent.meshId} (current=${currentAgentId})`,
    );
  }
  return target.id;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize whatever the Discoverer/Strategist embedded as competitionId
 * (slug, ref, or full Kaggle URL) into the slug Kaggle's API expects. */
export function competitionSlugFrom(value: string): string {
  if (!value) return '';
  const m = value.match(/competitions\/([^/?#]+)/);
  if (m && m[1]) return m[1];
  return value.replace(/^\/+|\/+$/g, '');
}

export async function emitToNextAgent(
  context: ActionExecutionContext,
  nextRole: KaggleAgentRole,
  subject: string,
  body: string,
  topic: string,
): Promise<{ messageId: string; backlogId: string; nextAgentId: string }> {
  const toId = await nextAgentId(context, nextRole);
  const messageId = makeId('msg');
  const backlogId = makeId('backlog');
  const nowIso = context.nowIso;

  await context.stateStore.saveMessage({
    id: messageId,
    meshId: context.agent.meshId,
    fromType: 'AGENT',
    fromId: context.agent.id,
    fromMeshId: context.agent.meshId,
    toType: 'AGENT',
    toId,
    topic,
    kind: 'TASK',
    replyToMessageId: null,
    threadId: messageId,
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'DELIVERED',
    deliveredAt: nowIso,
    readAt: null,
    processedAt: null,
    createdAt: nowIso,
    subject,
    body,
  });

  await context.stateStore.saveBacklogItem({
    id: backlogId,
    agentId: toId,
    priority: 'NORMAL',
    status: 'PROPOSED',
    originType: 'MESSAGE',
    originRef: messageId,
    blockedOnMessageId: null,
    blockedOnGrantRequestId: null,
    blockedOnPromotionRequestId: null,
    blockedOnAccountBindingRequestId: null,
    estimatedEffort: 'PT15M',
    deadline: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: nowIso,
    title: subject,
    description: body,
  });

  return { messageId, backlogId, nextAgentId: toId };
}

/** Read the most-recent inbound TASK message for this agent (any status). */
export async function loadInboundTask(
  context: ActionExecutionContext,
): Promise<{ subject: string; body: string } | null> {
  const inbox = await context.stateStore.listMessagesForRecipient('AGENT', context.agent.id);
  // Pick the most recent TASK (handlers run after ProcessMessage marks it PROCESSED).
  const tasks = inbox.filter((m) => m.kind === 'TASK').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const m = tasks[0];
  return m ? { subject: m.subject, body: m.body } : null;
}

/** Best-effort JSON parse for inbound task bodies. Returns {} on parse error. */
export function parseInboundJson(body: string | undefined | null): Record<string, unknown> {
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve a playbook for the given slug, returning null when no resolver is
 *  configured or no playbook matches. Logs failures non-fatally. */
export async function tryResolvePlaybook(
  resolver: KagglePlaybookResolver | undefined,
  slug: string,
  presetIndex: number,
  variables: Record<string, unknown>,
  log: (m: string) => void,
): Promise<KagglePlaybook | null> {
  if (!resolver) return null;
  try {
    return await resolver(slug, { presetIndex, variables });
  } catch (err) {
    log(`playbookResolver threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Resolve the catch-all (`*`) playbook ONCE at handler creation and return
 *  its operational defaults (top-N picks, kernel poll cadence). Falls back
 *  to historical hard-coded values when no resolver is wired or no catch-all
 *  matches — keeps tests/examples that don't seed the DB working. */
export async function loadOperationalDefaults(
  resolver: KagglePlaybookResolver | undefined,
  log: (m: string) => void,
): Promise<OperationalDefaults> {
  const HARD_DEFAULTS: OperationalDefaults = {
    topNAgentic: 5,
    topNDeterministic: 3,
    pollIntervalMs: 10_000,
    pollTimeoutMs: 300_000,
  };
  if (!resolver) return HARD_DEFAULTS;
  try {
    const pb = await resolver('');
    const cfg = pb?.config ?? {};
    return {
      topNAgentic: cfg.topNAgentic ?? HARD_DEFAULTS.topNAgentic,
      topNDeterministic: cfg.topNDeterministic ?? HARD_DEFAULTS.topNDeterministic,
      pollIntervalMs: (cfg.pollIntervalSec ?? 10) * 1000,
      pollTimeoutMs: (cfg.pollTimeoutSec ?? 300) * 1000,
    };
  } catch (err) {
    log(`loadOperationalDefaults failed: ${err instanceof Error ? err.message : String(err)}`);
    return HARD_DEFAULTS;
  }
}
