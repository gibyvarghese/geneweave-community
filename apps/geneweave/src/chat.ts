/**
 * @weaveintel/geneweave — Chat engine
 *
 * Orchestrates weaveIntel models for chat. Supports three modes:
 *  - **direct**: model.generate / model.stream (default, original behavior)
 *  - **agent**: weaveAgent with tool-calling ReAct loop
 *  - **supervisor**: weaveAgent in supervisor mode with hierarchical worker delegation
 *
 * Integrates redaction (PII scrubbing), observability (trace spans),
 * and eval (response quality assertions) into the message flow.
 *
 * WeaveIntel packages integrated here:
 *   @weaveintel/core         — ExecutionContext, EventBus, Model/ToolRegistry types
 *   @weaveintel/agents       — weaveAgent (ReAct loop, with optional supervisor mode)
 *   @weaveintel/observability — weaveInMemoryTracer, weaveUsageTracker for spans
 *   @weaveintel/guardrails/redaction     — weaveRedactor for PII scrubbing before/after LLM
 *   @weaveintel/testing/evals         — weaveEvalRunner for response quality assertions
 *   @weaveintel/guardrails    — createGuardrailPipeline, risk classification
 *   @weaveintel/human-tasks   — PolicyEvaluator for automatic human-review triggers
 *   @weaveintel/prompts       — shared prompt record parsing + variable-substituted rendering
 *   @weaveintel/routing       — SmartModelRouter, ModelHealthTracker
 *   @weaveintel/cache         — weaveInMemoryCacheStore, semantic cache for responses
 */

import { newUUIDv7, createLogger } from '@weaveintel/core';
import type { DurableConsentManager } from '@weaveintel/guardrails/compliance';

const log = createLogger('chat');
import type { ServerResponse } from 'node:http';
import type {
  Model, ModelRequest, ModelResponse, StreamChunk, ExecutionContext, Message,
  Tool, ToolRegistry, AgentStepEvent, AgentStep, AgentResult, EventBus, Agent,
  CacheStore, CacheKeyBuilder,
} from '@weaveintel/core';
import { weaveContext, weaveEventBus, EventTypes } from '@weaveintel/core';
import { weaveAgent, weaveEnsemble, createVoteResolver, createArbiterResolver, createHumanTaskInterruptHandler, createWorkerRegistry } from '@weaveintel/agents';
import type { EvalStageConfig } from '@weaveintel/agents';
import { weaveCostGovernor, createInMemoryCostLedger } from '@weaveintel/cost-governor';
import type { CostPolicy } from '@weaveintel/cost-governor';
import { createSQLiteCheckpointStoreForChat } from './checkpoint-store.js';
import { InMemoryTaskQueue } from '@weaveintel/human-tasks';
import { runApprovals } from './me-run-approvals.js';
import {
  weaveInMemoryTracer,
  weaveUsageTracker,
} from '@weaveintel/observability';
import type { GuardrailCategorySummary } from '@weaveintel/guardrails';
import type { DatabaseAdapter, MessageRow, ChatSettingsRow, GuardrailRow, HumanTaskPolicyRow, PromptRow, RoutingPolicyRow } from './db.js';
import { BUILTIN_TOOLS, createToolRegistry, type ToolRegistryOptions } from './tools.js';
import { makeToolCachePolicyResolver } from './tool-cache-registry.js';
import { getActiveSingleflight, loadStampedeConfig } from './cache-stampede.js';
import { planCacheLookupGuidance, planCacheStoreFromResult } from './agent-plan-cache.js';
import { DbToolPolicyResolver, DbToolRateLimiter, consoleAuditEmitter } from './tool-policy-resolver.js';
import { DbToolAuditEmitter } from './tool-audit-emitter.js';
import { DbToolApprovalGate } from './tool-approval-gate.js';
import { createTemporalStore } from './temporal-store.js';
import { createNoteAiService, createModelTextGenerator, agentCreateNote, agentNewFromTemplate, agentRecentNotes, agentExportNote } from './note-ai-sql.js';
import { createColorizeTools } from './note-colorize-sql.js';
import { createCreativeTools, createModelImageGenerator, createModelVisionVerifier } from './note-creative-sql.js';
import { createStudyTool } from './note-study-sql.js';
import { createTranslateTool } from './note-translate-sql.js';
import { createScheduledAgentTool } from './note-scheduled-agent-sql.js';
import { withAiPresence } from './note-ai-presence.js';
import { createNotePublishService } from './note-publish-sql.js';
import { createNoteGraphService } from './note-graph-sql.js';
import { createNoteDbService } from './note-db-sql.js';
import { createNoteCaptureService } from './note-capture-sql.js';
import { createNoteMeetingService } from './note-meeting-sql.js';
import { createNoteMemoryService } from './note-memory-sql.js';
import { createTenantAppearanceService } from './tenant-appearance-sql.js';
import { createAccountService } from './account-sql.js';
import { createAnswerFeedbackService } from './answer-feedback-sql.js';
import { createChatCitationsService } from './chat-citations-sql.js';
import { createWorkspaceAccessService } from './workspace-access-sql.js';
import { createTranslateUiTool } from './i18n-sql.js';
import { createSuggestPromptsTool } from './suggested-prompts-sql.js';
import { createNoteWorkspaceService } from './note-workspace-sql.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import {
  applySkillsToPrompt,
  type SkillMatch,
} from '@weaveintel/skills';
import { createContract, DefaultCompletionValidator } from '@weaveintel/core/contracts';
import { ModelHealthTracker, createRuntimeRoutingAdapter } from '@weaveintel/routing';
import type { RuntimeRoutingSlot } from '@weaveintel/core';
import {
  getP99Latency,
  getLatencySnapshot,
  DEGRADATION_MULTIPLIER,
  MIN_DEGRADATION_LATENCY_MS,
  DEGRADATION_BLOCK_MS,
} from '@weaveintel/resilience';
import { weaveInMemoryCacheStore } from '@weaveintel/cache';
import { weaveCacheKeyBuilder } from '@weaveintel/cache';
import { estimatePromptCacheSavingsUsd } from '@weaveintel/cache';
import type { CacheTurnMetrics } from './chat-send-message.js';
import { loadSemanticConfig } from './chat-semantic-utils.js';
import { loadCacheKeyVersion } from './cache-invalidator.js';
import { shouldBypass } from '@weaveintel/cache';
import { loadEnterpriseTools, loadEnterpriseToolGroups, type EnterpriseToolGroup } from './chat-enterprise-tools-utils.js';
import {
  loadExtractionRules,
  extractEntitiesWithModel,
  classifyIdentityRecallIntent,
  isIdentityRecallQuery,
  resolveIdentityRecallFromMemory,
  buildMemoryContext,
  buildEpisodicContext,
  saveToMemory,
  applyGovernanceCheck,
} from './chat-memory-utils.js';
import { getActiveSemanticMemoryBackend } from './memory-pgvector.js';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import { triggerConsolidationForUser } from './memory-consolidation.js';
import { createSQLiteGraphMemoryStore } from './chat-graph-store.js';
import { SQLiteAdapter } from './db-sqlite.js';
import { createGraphMemoryStore } from '@weaveintel/memory';
import { normalizePersona } from './rbac.js';
import {
  TEMPORAL_TOOL_POLICY,
  POLICY_PROMPT_RESPONSE_CARD_FORMAT,
  POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM,
  POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
  POLICY_PROMPT_HARD_EXECUTION_GUARD,
  FORCED_WORKER_REQUIREMENT,
  HARD_EXECUTION_GUARD_POLICY,
  ENTERPRISE_WORKER_SYSTEM_PROMPT,
  RESPONSE_CARD_FORMAT_POLICY,
} from './chat-policies.js';
import {
  FALLBACK_PRICING,
  calculateCost,
  getOrCreateModel,
  settingsFromRow,
  type ChatAttachment,
  type ChatEngineConfig,
  type ChatSettings,
  type ProviderConfig,
  type WorkerDef,
} from './chat-runtime.js';
import {
  loadModelPricing,
  type ModelPricing,
  type PricingCache,
} from './chat-pricing-utils.js';
import {
  buildAttachmentContext,
  composeUserInput,
  normalizeAttachments,
  patchLatestUserMessage,
} from './chat-attachment-utils.js';
import {
  countWorkerDelegations,
  evaluateSkillExecutionContracts,
  formatExecutionContractFailures,
  hasCodeExecutorDelegation,
  hasSuccessfulCseExecution,
} from './chat-cse-utils.js';
import { extractSkillExecutionContractsFromPrompt, type ResolvedSkillExecutionContract } from '@weaveintel/skills';
import { hasRenderableAttachmentAnalysisOutput } from './chat-output-guards.js';
import {
  extractFieldValue,
  outputContainsField,
  runWithContractGuard as runWithContractGuardHelper,
} from './chat-contract-guard-utils.js';
import {
  loadPolicyPromptTemplates,
  renderNamedPolicyPromptTemplate,
  type PolicyPromptCache,
} from './chat-policy-prompt-utils.js';
import {
  validatePromptContractsAgainstDb,
  type PromptContractValidationReport,
} from './chat-prompt-contract-utils.js';
import { buildSupervisorInstructionsPrompt } from './chat-supervisor-policy-utils.js';
import { applyTemporalToolPolicy } from './chat-policy-format-utils.js';
import { shouldForceWorkerDataAnalysis } from './chat-intent-utils.js';
import { discoverSkillsForInput } from './chat-skills-utils.js';
import { applyRedaction, runPostEval } from './chat-eval-utils.js';
import { observeToolCallEvents, recordTraceSpans, computePromptFingerprint, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
import { evaluateGuardrails, evaluateTaskPolicies } from './chat-guardrail-eval-utils.js';
import {
  resolveSystemPrompt,
  buildCapabilityTelemetrySnapshots,
  type PromptStrategyInfo,
  type ResolvedSystemPrompt,
} from './chat-system-prompt-utils.js';
import { routeModel, resolveActiveCache } from './chat-routing-utils.js';
import {
  sendMessageImpl,
  type SendMessageDeps,
  type SendMessageResult,
} from './chat-send-message.js';
import { streamMessageImpl } from './chat-stream-message.js';
import { resolveLimits } from './platform-limits.js';

export { calculateCost, getOrCreateModel, settingsFromRow } from './chat-runtime.js';
export type { ChatAttachment, ProviderConfig, ChatEngineConfig, ChatSettings, WorkerDef } from './chat-runtime.js';

// ─── Chat engine ─────────────────────────────────────────────

type CognitiveCheckSummary = GuardrailCategorySummary;

/**
 * Phase 2 — exported for unit tests. Build a ToolRegistry from a resolved
 * supervisor agent's `agent_tools` allocations (skipping `forbidden`).
 * Returns `undefined` when there is nothing to allocate.
 */
export async function buildSupervisorAdditionalTools(
  resolved: import('./db-types.js').ResolvedSupervisorAgent | null,
  toolOptions: ToolRegistryOptions,
): Promise<ToolRegistry | undefined> {
  if (!resolved || !resolved.tools.length) return undefined;
  const toolNames = Array.from(new Set(
    resolved.tools
      .filter((t) => (t.allocation ?? 'default') !== 'forbidden')
      .map((t) => t.tool_name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  ));
  if (!toolNames.length) return undefined;
  try {
    return await createToolRegistry(toolNames, undefined, { ...toolOptions, actorPersona: 'agent_supervisor' });
  } catch (err) {
    log.warn('buildSupervisorAdditionalTools failed; supervisor will use defaults only', { err: String(err) });
    return undefined;
  }
}

export class ChatEngine {
  private readonly healthTracker: RuntimeRoutingSlot;
  // Phase 1: the shared store may be a tiered L1+L2 (Redis) store — typed as the
  // base CacheStore since the chat path only needs get/set.
  private readonly responseCache: CacheStore;
  // Phase 0: salted SHA-256 keys so raw prompts (PII, unbounded length,
  // delimiter-injection collisions) never appear in cache keys. The salt comes
  // from GENEWEAVE_CACHE_KEY_SALT (falls back to JWT_SECRET, then a constant).
  // Phase 1: the version segment is the DB-driven global_version_token
  // (config.cacheKeyVersion) — bumping it invalidates every cache key at once.
  private readonly cacheKeyBuilder: CacheKeyBuilder;
  private pricingCache: PricingCache | null = null;
  private policyPromptCache: PolicyPromptCache | null = null;
  // Phase 3 — whether to write the durable cache_metrics rollup (admin-tunable
  // via cache_settings.metrics_enabled; defaults on, refreshed at construction).
  private metricsEnabled = true;
  private readonly toolOptions: ToolRegistryOptions;

  private async getPolicyPromptTemplates(): Promise<Map<string, string>> {
    const result = await loadPolicyPromptTemplates(this.db, this.policyPromptCache);
    this.policyPromptCache = result.cache;
    return result.prompts;
  }

  private async getPolicyPromptTemplate(name: string, fallback: string): Promise<string> {
    const prompts = await this.getPolicyPromptTemplates();
    return prompts.get(name) ?? fallback;
  }

  private async renderPolicyPromptTemplate(
    name: string,
    fallbackTemplate: string,
    vars: Record<string, unknown>,
  ): Promise<string> {
    const template = await this.getPolicyPromptTemplate(name, fallbackTemplate);
    return renderNamedPolicyPromptTemplate(name, template, fallbackTemplate, vars);
  }

  private async withResponseCardFormatPolicy(basePrompt: string | undefined): Promise<string | undefined> {
    const policy = await this.getPolicyPromptTemplate(POLICY_PROMPT_RESPONSE_CARD_FORMAT, RESPONSE_CARD_FORMAT_POLICY);
    const base = basePrompt?.trim();
    return base ? `${base}\n\n${policy}` : policy;
  }

  private async writeSseEvent(res: ServerResponse, payload: Record<string, unknown>): Promise<boolean> {
    if (res.writableEnded || res.destroyed) {
      return false;
    }

    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    const canContinue = res.write(frame);
    if (canContinue) {
      return !(res.writableEnded || res.destroyed);
    }

    await new Promise<void>((resolve) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        res.off('drain', onDrain);
        res.off('close', onClose);
      };

      res.on('drain', onDrain);
      res.on('close', onClose);
    });

    return !(res.writableEnded || res.destroyed);
  }

  private endSse(res: ServerResponse): void {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }

  // M5-3: consent manager for gating AI-derived memory writes.
  // Permit-if-no-record — only blocks when an explicit consent flag has expired.
  private readonly consentManager: DurableConsentManager | null;

  constructor(
    private readonly config: ChatEngineConfig,
    private readonly db: DatabaseAdapter,
  ) {
    // Phase 2: use the shared routing slot from the runtime when available so
    // both the chat path and the live-agent supervisor observe the same health
    // state. Fall back to a local tracker when no runtime is wired (tests, etc.).
    this.healthTracker = config.runtime?.routing
      ?? createRuntimeRoutingAdapter(new ModelHealthTracker());
    // Phase 6: pull from the runtime compliance slot (shared across all chat engines)
    // rather than creating a per-engine manager. Structurally compatible with
    // DurableConsentManager — cast is safe at runtime.
    this.consentManager = (config.runtime?.compliance?.consent ?? null) as DurableConsentManager | null;
    // Phase 7: share the runtime's warm response cache so all subsystems
    // (live-agent handlers, tools, chat path) benefit from the same entries.
    this.responseCache = config.runtime?.cache?.store ?? weaveInMemoryCacheStore();
    this.cacheKeyBuilder = weaveCacheKeyBuilder({
      namespace: 'gw-chat',
      hash: 'sha256',
      salt: process.env['GENEWEAVE_CACHE_KEY_SALT'] ?? process.env['JWT_SECRET'] ?? 'gw-cache-v1',
      version: config.cacheKeyVersion ?? process.env['GENEWEAVE_CACHE_KEY_VERSION'] ?? 'v1',
    });
    // Phase 3: refresh the metrics-enabled flag from cache_settings (best-effort).
    this.db.getCacheSettings?.().then((s) => { if (s) this.metricsEnabled = s.metrics_enabled !== 0; }).catch(() => { /* default on */ });
    // Scope isolation: load policies once per ChatEngine instance and cache.
    // callerScope is always overridden per-worker in buildWorkersFromDb();
    // the 'system' default covers the supervisor and all non-DB-worker contexts.
    let _cachedPolicies: import('./db-types/scopes.js').ScopeCrossPolicyRow[] | null = null;
    let _cachedScopes: Map<string, import('./db-types/scopes.js').AgentScopeRow> | null = null;

    const scopeGuard: import('./scope-guard-registry.js').ScopeGuardCallbacks = {
      callerScope: 'system',
      getToolScope: (toolName: string) => db.getScopeForTool(toolName),
      checkPolicy: async (fromScope: string, toScope: string) => {
        if (!_cachedPolicies) _cachedPolicies = await db.listScopePolicies();
        if (!_cachedScopes) {
          const scopes = await db.listScopes();
          _cachedScopes = new Map(scopes.map(s => [s.id, s]));
        }
        const policy = _cachedPolicies.find(
          p => p.from_scope === fromScope && (p.to_scope === toScope || p.to_scope === '*'),
        );
        if (!policy) return null;
        const callerScopeRow = _cachedScopes.get(fromScope);
        return {
          allowed: policy.allowed === 1,
          requiresA2a: policy.requires_a2a === 1,
          sandboxed: callerScopeRow?.sandboxed === 1,
        };
      },
      logEvent: (event) => db.logScopeEvent(event as Parameters<typeof db.logScopeEvent>[0]),
    };

    this.toolOptions = {
      temporalStore: createTemporalStore(db),
      policyResolver: new DbToolPolicyResolver(db),
      rateLimiter: new DbToolRateLimiter(db),
      auditEmitter: new DbToolAuditEmitter(db),
      // Phase 6: gate tool calls that require operator approval
      approvalGate: new DbToolApprovalGate(db),
      // Phase 4: credential and catalog injection
      credentialResolver: (id: string) => db.getToolCredential(id),
      // Phase D: runtime propagation for capability requires assertion
      ...(config.runtime ? { runtime: config.runtime } : {}),
      // Scope isolation: enforce cross-scope tool access policies.
      scopeGuard,
      // Cache Phase 6: opt-in tool-result caching driven by tool_cache_policies.
      // Shares the response-cache store (unified invalidation) but a dedicated
      // metrics sink. callerScope/version are stable for the engine's lifetime.
      ...(config.toolCache ? {
        toolResultCache: {
          store: config.toolCache.store,
          getPolicy: makeToolCachePolicyResolver(db),
          ...(config.toolCache.version ? { keyPrefix: config.toolCache.version } : {}),
          metrics: config.toolCache.metrics,
        } as import('./tool-cache-registry.js').ToolResultCacheCallbacks,
      } : {}),
      // m77: Wire artifact persistence so emit_artifact tool can persist outputs.
      ...(db.saveArtifact ? {
        artifactSave: async (input: import('./db-types/artifacts.js').ArtifactSaveInput) => {
          const row = await db.saveArtifact!(input);
          return { id: row.id, version: row.version };
        },
      } : {}),
      // m79 / Phase 4: Wire artifact update for streaming mode.
      ...(db.updateArtifact ? {
        artifactUpdate: async (id: string, patch: import('./db-types/artifacts.js').ArtifactUpdateInput, changelog?: string) => {
          const row = await db.updateArtifact!(id, patch, changelog);
          return { id: row.id, version: row.version };
        },
      } : {}),
      // weaveNotes Phase 3: wire the `note_edit` tool so the agent can co-author the
      // user's notes (direct or as a suggestion). Shares the engine's model config for
      // generation; resolves the user's note access itself (no privilege escalation).
      noteEdit: (a: { userId: string; noteId: string; markdown: string; mode: 'direct' | 'suggest' }) =>
        withAiPresence(db, a.noteId, () => createNoteAiService(db, createModelTextGenerator(config)).agentEdit(a)),
      // weaveNotes: wire the `restructure_note` tool so the agent can reorganise a whole note
      // (reorder/group sections, fix hierarchy) and stage it as one suggestion. Resolves access itself.
      noteRestructure: (a: { userId: string; noteId: string; outline?: string }) =>
        withAiPresence(db, a.noteId, () => createNoteAiService(db, createModelTextGenerator(config)).agentRestructure(a)),
      // weaveNotes Phase 4: wire the `note_publish` tool so the agent can publish a note
      // as an artifact (privately — never auto-public). Resolves the user's note access +
      // the sensitivity gate itself (no privilege escalation; restricted refused).
      notePublish: (a: { userId: string; noteId: string; format?: 'markdown' | 'html' }) =>
        createNotePublishService(db).agentPublish(a),
      // weaveNotes Phase 3.1: wire the `create_note` tool so the agent can create a new
      // note and fill it with content it produced (research / summary / plan / to-dos).
      createNote: (a: { userId: string; tenantId?: string | null; title: string; markdown?: string }) =>
        agentCreateNote(db, a),
      // weaveNotes Phase 6: wire the `new_from_template` tool — start a note from a ready-made template.
      noteNewFromTemplate: (a: { userId: string; tenantId?: string | null; templateKey: string; title?: string }) =>
        agentNewFromTemplate(db, a),
      // weaveNotes Phase 8: wire the `recent_notes` tool — what has the user recently worked on.
      noteRecentNotes: (a: { userId: string; tenantId?: string | null; limit?: number }) =>
        agentRecentNotes(db, a),
      // weaveNotes Phase 10: wire the `export_note` tool — export a note (Markdown/HTML/Word/JSON).
      // Records an AI-actor activity entry on success, so the note's history shows the assistant
      // exported it (and the change is understandable to later tools like read_note_activity).
      noteExport: async (a: { userId: string; tenantId?: string | null; noteId: string; format?: string }) => {
        const r = await agentExportNote(db, a);
        if (r.ok) void createNoteSettingsService(db).recordActivity({ noteId: a.noteId, userId: a.userId, tenantId: a.tenantId ?? null, action: 'updated', actor: 'ai', summary: `Exported as ${r.format} (assistant)` });
        return r;
      },
      // Answer feedback (m137): wire the `review_answer_feedback` tool — an aggregate, privacy-safe
      // read-out of how the assistant's answers have been rated, so it can understand where it falls short.
      reviewAnswerFeedback: (a: { tenantId: string | null; limit?: number }) =>
        createAnswerFeedbackService(db).agentReviewFeedback(a),
      // Answer citations (m138): wire the `cite_sources` tool — a grounded, verified-citation answer over
      // the user's own workspace, so the assistant can back a claim with a real, checkable source.
      citeSources: (a: { userId: string; tenantId?: string | null; question: string; limit?: number }) =>
        createChatCitationsService(db, { aiGenerate: createModelTextGenerator(config) }).agentCiteSources(a),
      // Workspace roles (m143): wire the `list_workspace_members` tool — a read-only, tenant-scoped team
      // read-out so the assistant can answer "who's on my team / who are the admins?".
      listWorkspaceMembers: (a: { userId: string; tenantId?: string | null; persona?: string | null }) =>
        createWorkspaceAccessService(db).agentListMembers(a),
      // Internationalisation (m145): wire the `translate_ui` tool — translate the whole app UI into a new
      // language (an AI locale pack), reusing the notes faithful-translation engine.
      translateUi: (a: { targetLanguage: string; tenantId?: string | null; userId?: string }) =>
        createTranslateUiTool(db, createModelTextGenerator(config)).translateUi(a),
      // Suggested/starter prompts (m146): wire the `suggest_prompts` tool — generate personalised conversation
      // starters from the user's own recent notes + chats and cache them for the empty chat.
      suggestPrompts: (a: { userId: string; tenantId?: string | null; count?: number }) =>
        createSuggestPromptsTool(db, createModelTextGenerator(config)).suggestPrompts(a),
      // weaveNotes Phase 5: wire the `find_related_notes` tool (semantic note search).
      notesSearch: (a: { userId: string; tenantId?: string | null; query: string; limit?: number }) =>
        createNoteGraphService(db).searchNotes({ userId: a.userId, tenantId: a.tenantId ?? null }, a.query, a.limit ?? 5),
      // geneWeave UI rebuild: wire the `set_workspace_appearance` tool (white-label branding). Admin-gated:
      // only a workspace admin (tenant/platform admin persona) may change the workspace look.
      setWorkspaceAppearance: async (a: { userId: string; tenantId?: string | null; colorScheme?: string; variant?: string; accent?: string; cornerStyle?: string; density?: string }) => {
        const persona = (await db.getUserById?.(a.userId))?.persona ?? '';
        if (!['tenant_admin', 'platform_admin'].includes(persona)) return { ok: false, error: 'Only a workspace admin can change the workspace appearance.' };
        return createTenantAppearanceService(db).agentSetAppearance({ tenantId: a.tenantId ?? '', ...(a.colorScheme ? { colorScheme: a.colorScheme } : {}), ...(a.variant ? { variant: a.variant } : {}), ...(a.accent ? { accent: a.accent } : {}), ...(a.cornerStyle ? { cornerStyle: a.cornerStyle } : {}), ...(a.density ? { density: a.density } : {}) });
      },
      // geneWeave UI rebuild: wire the `update_account_profile` tool. Always scoped to the signed-in user
      // (userId comes from the session) — the assistant can never change another person's account.
      updateAccountProfile: (a: { userId: string; profile?: Record<string, unknown>; notification?: { event: string; in_app?: boolean; email?: boolean; push?: boolean } }) =>
        createAccountService(db).agentUpdateAccount(a),
      // weaveNotes Phase 5: wire the `recall_second_brain` tool — temporally-aware memory recall.
      notesRecallMemory: async (a: { userId: string; tenantId?: string | null; query: string; limit?: number }) => {
        const cfg = await createNoteSettingsService(db).getConfig();
        if (!cfg.backgroundMemoryEnabled) return { ok: true, count: 0, memories: [] };
        return createNoteMemoryService(db, {
          generate: createModelTextGenerator(config),
          config: async () => ({ enabled: cfg.backgroundMemoryEnabled, importanceThreshold: cfg.memoryImportanceThreshold, maxPerNote: cfg.memoryMaxPerNote, recallCount: cfg.memoryRecallCount, decayHalfLifeDays: cfg.memoryDecayHalfLifeDays }),
        }).agentRecall(a);
      },
      // weaveNotes Phase 4: wire the `summarize_meeting` tool — pasted transcript → structured note.
      notesSummarizeMeeting: async (a: { userId: string; tenantId?: string | null; transcript: string; title?: string }) => {
        const cfg = await createNoteSettingsService(db).getConfig();
        if (!cfg.voiceCaptureEnabled) return { ok: false, error: 'Voice capture is disabled' };
        return createNoteMeetingService(db, { generate: createModelTextGenerator(config) }).agentSummarizeMeeting(a);
      },
      // weaveNotes Phase 3: wire the `suggest_links` tool (proactive linking) — gated by the Builder dial.
      notesLinkSuggest: async (a: { userId: string; tenantId?: string | null; noteId: string; apply?: string; max?: number }) => {
        const cfg = await createNoteSettingsService(db).getConfig();
        if (!cfg.proactiveLinkingEnabled) return { applied: { ok: false, error: 'Proactive linking is disabled' }, suggestions: [] };
        const graph = createNoteGraphService(db);
        const access = { noteId: a.noteId, ownerId: a.userId, tenantId: a.tenantId ?? null, role: 'owner' as const };
        if (a.apply) return { applied: await graph.applyLink(a.noteId, access, a.apply) };
        return { suggestions: await graph.linkSuggestions(a.noteId, access, { max: a.max ?? 8 }) };
      },
      // weaveNotes Phase 6: wire the `autofill_database` tool (AI fills a table column w/ citations).
      dbAutofill: (a: { userId: string; tenantId?: string | null; databaseId: string; propertyKey: string; useWeb?: boolean }) =>
        createNoteDbService(db, { generate: createModelTextGenerator(config) }).agentAutofill(a),
      // weaveNotes Phase 7: wire the `capture_web_page` tool (clip a public page → structured note).
      captureWeb: (a: { userId: string; tenantId?: string | null; url: string }) =>
        createNoteCaptureService(db).agentCaptureWeb(a),
      // weaveNotes Phase 8: wire the `workspace_search` tool (cited RAG over the user's notes + runs).
      workspaceSearch: (a: { userId: string; tenantId?: string | null; query: string; limit?: number }) =>
        createNoteWorkspaceService(db).agentWorkspaceSearch(a),
      // weaveNotes Phase 0: wire the `read_note_activity` tool (recent change history → AI awareness).
      readNoteActivity: (a: { userId: string; tenantId?: string | null; noteId: string; limit?: number }) =>
        createNoteSettingsService(db).agentReadActivity(a),
      // weaveNotes Phase 2: wire the AI selection card's colour tools. Each stages a
      // track-changes suggestion (never a silent repaint); the AI picks a semantic label and
      // the code maps it to a pre-validated WCAG-AA colour. Resolves note access itself.
      noteApplyHighlight: (a: { userId: string; noteId: string; phrase: string; color?: string }) =>
        createColorizeTools(db, createModelTextGenerator(config)).applyHighlight(a),
      noteApplyTextColor: (a: { userId: string; noteId: string; phrase: string; color?: string }) =>
        createColorizeTools(db, createModelTextGenerator(config)).applyTextColor(a),
      noteColorize: (a: { userId: string; noteId: string; scheme: string; instruction?: string }) =>
        createColorizeTools(db, createModelTextGenerator(config)).colorizeSemantic(a),
      // weaveNotes Phase 4: wire the AI creative tools (diagram + ink). Each emits native,
      // editable content as a track-changes suggestion + mirrors its SVG to an artifact.
      noteCreateDiagram: (a: { userId: string; noteId: string; instruction: string }) =>
        createCreativeTools(db, createModelTextGenerator(config), { generateImage: createModelImageGenerator(config) }).createDiagram(a),
      noteDrawInk: (a: { userId: string; noteId: string; instruction: string }) =>
        createCreativeTools(db, createModelTextGenerator(config), { generateImage: createModelImageGenerator(config) }).drawInk(a),
      // weaveNotes Phase 4 (creative expansion): illustrations, generated images, and the
      // one-stop auto-routing visual tool — so the agent can make ANY kind of picture.
      noteCreateIllustration: (a: { userId: string; noteId: string; instruction: string }) =>
        createCreativeTools(db, createModelTextGenerator(config), { generateImage: createModelImageGenerator(config) }).createIllustration(a),
      noteGenerateImage: (a: { userId: string; noteId: string; instruction: string }) =>
        createCreativeTools(db, createModelTextGenerator(config), { generateImage: createModelImageGenerator(config) }).generateImage(a),
      noteCreateVisual: (a: { userId: string; noteId: string; instruction: string; kind?: string }) =>
        createCreativeTools(db, createModelTextGenerator(config), { generateImage: createModelImageGenerator(config) }).createVisual(a as { userId: string; noteId: string; instruction: string; kind?: 'auto' | 'diagram' | 'ink' | 'illustration' | 'image' }),
      // weaveNotes: wire the find_image tool — source a real, free-to-use image from the web (hardened fetch).
      noteFindImage: (a: { userId: string; noteId: string; query: string }) =>
        createCreativeTools(db, createModelTextGenerator(config), { generateImage: createModelImageGenerator(config), verifyVision: createModelVisionVerifier(config) }).findImage(a),
      // weaveNotes Phase 5: wire the make_flashcards tool — turn a note into a spaced-repetition deck.
      noteMakeFlashcards: (a: { userId: string; noteId: string; count?: number }) =>
        createStudyTool(db, createModelTextGenerator(config)).makeFlashcards(a),
      // weaveNotes Phase 2: wire the translate_note tool — translate a note into another language (new note).
      noteTranslate: (a: { userId: string; noteId: string; targetLanguage: string; formality?: 'default' | 'formal' | 'informal'; glossary?: string[] }) =>
        createTranslateTool(db, createModelTextGenerator(config)).translateNote(a),
      // weaveNotes Phase 3: wire the manage_scheduled_agent tool — set up / run a recurring note task.
      noteScheduledAgent: (a: { userId: string; op: 'create' | 'list' | 'run'; agentId?: string; name?: string; recipe?: string; cron?: string; timezone?: string; scope?: string; taskPrompt?: string }) =>
        createScheduledAgentTool(db, createModelTextGenerator(config)).manageScheduledAgent(a),
    };
  }

  /** Permit-if-no-record consent check. Returns true when writing is allowed. */
  private async isPersonalizationAllowed(userId: string): Promise<boolean> {
    if (!this.consentManager) return true;
    try {
      const flags = await this.consentManager.listBySubject(userId);
      const flag = flags.find(f => f.purpose === 'personalization');
      if (!flag) return true; // no record → allow
      return this.consentManager.isGranted(userId, 'personalization');
    } catch { return true; } // fail-open on transient KV error
  }

  /**
   * Public, read-only view of the model configuration (providers + default
   * provider/model + runtime). Consumed by the `/api/me/runs` executor to
   * resolve the default model without re-deriving provider wiring.
   */
  get modelConfig(): ChatEngineConfig {
    return this.config;
  }

  private async getDisabledBuiltinToolKeys(): Promise<Set<string>> {
    const enabledCatalogRows = await this.db.listEnabledToolCatalog();
    const enabledKeys = new Set(
      enabledCatalogRows
        .map((row) => row.tool_key)
        .filter((toolKey): toolKey is string => Boolean(toolKey)),
    );
    return new Set(Object.keys(BUILTIN_TOOLS).filter((toolKey) => !enabledKeys.has(toolKey)));
  }

  /**
   * Build supervisor worker definitions from DB `worker_agents` rows.
   */
  private async buildWorkersFromDb(
    workerRows: import('./db-types.js').WorkerAgentRow[],
    model: Model,
    toolOptions: ToolRegistryOptions,
    customTools?: import('@weaveintel/core').Tool[],
  ): Promise<Array<{ name: string; description: string; systemPrompt?: string; model: Model; tools?: ToolRegistry }>> {
    const sorted = [...workerRows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return Promise.all(sorted.map(async (row) => {
      const toolNamesRaw = this.safeParseJson(row.tool_names);
      const toolNames = Array.isArray(toolNamesRaw) ? (toolNamesRaw as string[]) : [];
      const displayName = (row.display_name?.trim() || row.name).trim();
      const jobProfile = (row.job_profile?.trim() || 'Worker Agent').trim();
      const workerDescription = [
        `Display Name: ${displayName}`,
        `Job Profile: ${jobProfile}`,
        row.description,
      ].filter(Boolean).join('\n');
      const systemPrompt = applyTemporalToolPolicy({
        basePrompt: row.system_prompt ?? undefined,
        toolNames,
        temporalToolPolicy: TEMPORAL_TOOL_POLICY,
      });
      const persona = normalizePersona(row.persona ?? undefined, 'agent');
      // Scope guard: each worker gets its own scope context derived from its
      // agentic_scope column so the guard enforces per-domain tool access.
      const workerScope = row.agentic_scope ?? 'system';
      const workerToolOpts = {
        ...toolOptions,
        actorPersona: persona,
        ...(toolOptions.scopeGuard && {
          scopeGuard: { ...toolOptions.scopeGuard, callerScope: workerScope },
        }),
      };
      const tools = toolNames.length
        ? await createToolRegistry(toolNames, customTools, workerToolOpts)
        : customTools?.length
          ? await createToolRegistry([], customTools, workerToolOpts)
          : undefined;

      return {
        name: row.name,
        description: workerDescription,
        systemPrompt,
        model,
        tools,
      };
    }));
  }

  /**
   * Generic contract-based execution guard. Delegates to a specific worker and validates
   * the output against the worker's task contract. Retries up to max_retries times.
   */
  private async runWithContractGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    workerRow: import('./db-types.js').WorkerAgentRow,
  ): Promise<AgentResult> {
    return runWithContractGuardHelper({
      agent,
      ctx,
      messages,
      goal,
      workerRow,
      getTaskContract: async (id: string) => this.db.getTaskContract(id),
      parseJson: (text: string) => this.safeParseJson(text),
      validateAgainstContract: async (result: AgentResult, contractRow: import('./db-types.js').TaskContractRow) =>
        this.validateAgainstContract(result, contractRow),
    });
  }

  /**
   * Validate an agent result against a task contract's acceptance criteria.
   */
  private async validateAgainstContract(
    result: AgentResult,
    contractRow: import('./db-types.js').TaskContractRow,
  ): Promise<boolean> {
    const output = String(result.output ?? '');
    const criteria: Array<{ id: string; description: string; type: string; config: Record<string, unknown>; required: boolean }> =
      (this.safeParseJson(contractRow.acceptance_criteria) as Array<{ id: string; description: string; type: string; config: Record<string, unknown>; required: boolean }>) ?? [];

    // Build signal object from output using each criterion's field config
    const signal: Record<string, unknown> = {};
    for (const c of criteria) {
      const field = String(c.config?.['field'] ?? '');
      const operator = String(c.config?.['operator'] ?? '');
      if (operator === 'exists') {
        // Check if the field name appears meaningfully in the output
        signal[field] = outputContainsField(output, field);
      } else {
        signal[field] = extractFieldValue(output, field);
      }
    }

    const validator = new DefaultCompletionValidator();
    const contract = createContract({
      name: contractRow.name,
      acceptanceCriteria: criteria.map((c) => ({
        id: c.id,
        description: c.description,
        type: c.type as 'assertion',
        required: c.required,
        config: c.config,
      })),
    });
    const report = await validator.validate(signal, contract);
    return report.status === 'fulfilled';
  }

  private async buildSupervisorInstructions(
    basePrompt: string | undefined,
    forceWorkerDataAnalysis: boolean,
    workerRows?: import('./db-types.js').WorkerAgentRow[],
  ): Promise<string> {
    const prompts = await this.getPolicyPromptTemplates();
    const hasActiveMandatorySkillPlan = extractSkillExecutionContractsFromPrompt(basePrompt).length > 0;
    return buildSupervisorInstructionsPrompt({
      basePrompt,
      forceWorkerDataAnalysis,
      workerRows,
      prompts,
      hasActiveMandatorySkillPlan,
    });
  }

  /**
   * Phase 1B — resolve which DB-backed supervisor agent row applies to the
   * current chat. Errors are non-fatal: when resolution fails the runtime
   * falls back to the package defaults (geneweave-supervisor + utility tools).
   */
  private async resolveSupervisorContext(category: string): Promise<import('./db-types.js').ResolvedSupervisorAgent | null> {
    try {
      return await this.db.resolveSupervisorAgent({ category });
    } catch (err) {
      log.warn('resolveSupervisorAgent failed; using package defaults', { err: String(err) });
      return null;
    }
  }

  /**
   * Phase 2 — build a ToolRegistry of supervisor "additionalTools" from the
   * resolved agent's `agent_tools` allocations. These tools are exposed to
   * the supervisor directly (alongside utility tools and delegate_to_worker).
   * Workers' tool allocations are NOT included here (workers manage their own
   * tools). Returns `undefined` when there are no allocations or all fail.
   */
  /** Public entry-point for A2A task execution — delegates to the internal agent runner. */
  async runAgentTask(
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
    tenantId?: string | null,
  ): Promise<AgentRunTelemetry> {
    return this.runAgent(ctx, model, userId, chatId, userPersona, messages, userContent, settings, attachments, tenantId);
  }

  private async runWithCseSuccessGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    enforce: boolean,
    skillExecutionContracts: readonly ResolvedSkillExecutionContract[] = [],
  ): Promise<AgentResult> {
    const enforceContracts = skillExecutionContracts.length > 0;
    // When an active skill defines its own executionContract, that contract is
    // the source of truth for delegation requirements. The legacy
    // `hasCodeExecutorDelegation` check is bypassed because some skills (e.g.
    // skill-data-analysis-execution) intentionally execute CSE tools directly
    // without going through the code_executor worker. We still enforce
    // hasSuccessfulCseExecution + hasRenderableAttachmentAnalysisOutput.
    const first = await agent.run(ctx, { messages, goal });
    const firstPassesExecutionGuard = !enforce || (
      hasSuccessfulCseExecution(first)
      && (enforceContracts || hasCodeExecutorDelegation(first))
      && hasRenderableAttachmentAnalysisOutput(first, goal)
    );
    const firstContractEval = enforceContracts
      ? evaluateSkillExecutionContracts(first, skillExecutionContracts)
      : { ok: true, failures: [] };
    if (firstPassesExecutionGuard && firstContractEval.ok) return first;

    const guardPolicy = await this.getPolicyPromptTemplate(POLICY_PROMPT_HARD_EXECUTION_GUARD, HARD_EXECUTION_GUARD_POLICY);
    const contractRetryHints = enforceContracts && !firstContractEval.ok
      ? `\n\nSKILL EXECUTION CONTRACT — concrete failures from your previous attempt that you must fix:\n${formatExecutionContractFailures(firstContractEval.failures)}\nProduce a complete final response that satisfies every item above.`
      : '';
    const retryGoal = `${goal}\n\n${guardPolicy}${contractRetryHints}`;
    const second = await agent.run(ctx, { messages, goal: retryGoal });
    const secondPassesExecutionGuard =
      hasSuccessfulCseExecution(second)
      && (enforceContracts || hasCodeExecutorDelegation(second))
      && hasRenderableAttachmentAnalysisOutput(second, goal); // use original goal — retryGoal contains policy text with "chart"/"visualization" that would falsely require chart JSON
    const secondContractEval = enforceContracts
      ? evaluateSkillExecutionContracts(second, skillExecutionContracts)
      : { ok: true, failures: [] };
    if (secondPassesExecutionGuard && secondContractEval.ok) return second;

    if (enforceContracts && !secondContractEval.ok) {
      return {
        ...second,
        output: `[Execution guard failure] The skill execution contract was not satisfied after retry:\n${formatExecutionContractFailures(secondContractEval.failures)}`,
      };
    }

    return {
      ...second,
      output: '[Execution guard failure] The workflow did not satisfy required execution constraints. A successful CSE run (`cse_run_code` or `cse_run_data_analysis`) through delegated worker "code_executor" is required, and the final result must be renderable (no sandbox-local file paths, no incomplete insights). Please retry.',
    };
  }

  /** Load pricing from DB, cache for 60 s */
  private async loadPricing(): Promise<Map<string, ModelPricing>> {
    const result = await loadModelPricing(this.db, this.pricingCache);
    this.pricingCache = result.cache;
    return result.pricing;
  }

  /**
   * Phase 3 — record a turn's cache effectiveness. Feeds the live, process-wide
   * metrics sink (response hit/miss are counted automatically by `withMetrics`;
   * here we add the prompt-cache token savings) and the durable per-window
   * `cache_metrics` rollup that the admin dashboard reads. Best-effort.
   */
  private recordCacheMetrics(turn: CacheTurnMetrics): void {
    const costSaved = estimatePromptCacheSavingsUsd(turn.provider, turn.promptCacheReadTokens, turn.inputCostPer1M);
    try {
      this.config.runtime?.cache?.metrics?.recordPromptCache({
        readTokens: turn.promptCacheReadTokens,
        writeTokens: turn.promptCacheWriteTokens,
        costSavedUsd: costSaved,
      });
    } catch { /* live sink is best-effort */ }
    if (this.metricsEnabled) {
      this.db.recordCacheMetrics({
        responseHits: turn.responseHit ? 1 : 0,
        responseMisses: turn.responseEligible && !turn.responseHit ? 1 : 0,
        promptCacheReadTokens: turn.promptCacheReadTokens,
        promptCacheWriteTokens: turn.promptCacheWriteTokens,
        costSavedUsd: costSaved,
      }).catch(() => { /* durable rollup is best-effort — never block the turn */ });
    }
  }

  /**
   * Shared implementation for the `memory_forget` tool callback.
   * Removes the named entity from entity memory AND any semantic memory
   * entry whose stored text contains `entityName` (case-insensitive
   * substring). Returns per-store deletion counts; never throws.
   */
  private async forgetMemoryForUser(
    ctx: ExecutionContext,
    userId: string,
    entityName: string,
  ): Promise<{ ok: boolean; deletedEntities: number; deletedSemantic: number }> {
    let entityError = false;
    let deletedEntities = 0;
    try { deletedEntities = await this.db.deleteEntity(userId, entityName); }
    catch (err) { log.warn('memory_forget entity delete failed', { err: String(err) }); entityError = true; }
    let semanticError = false;
    let deletedSemantic = 0;
    try {
      const memBackend = getActiveSemanticMemoryBackend();
      if (memBackend) {
        const r = await memBackend.forget(ctx, { userId, needle: entityName });
        deletedSemantic = r.deleted;
      } else {
        const rows = await this.db.listSemanticMemory(userId, 1000);
        const needle = entityName.toLowerCase();
        for (const row of rows) {
          if (row.content.toLowerCase().includes(needle)) {
            try { await this.db.deleteSemanticMemory(row.id, userId); deletedSemantic += 1; }
            catch { /* best-effort */ }
          }
        }
      }
    } catch (err) {
      log.warn('memory_forget semantic delete failed', { err: String(err) });
      semanticError = true;
    }
    return { ok: !(entityError && semanticError), deletedEntities, deletedSemantic };
  }

  // ── Direct mode: send ───────────────────────────────────────

  async sendMessage(
    userId: string,
    chatId: string,
    content: string,
    opts?: {
      provider?: string;
      model?: string;
      maxTokens?: number;
      temperature?: number;
      attachments?: ChatAttachment[];
      /** Override the agent execution mode regardless of DB settings.
       *  Used by A2A and programmatic callers. Never 'direct'. */
      modeOverride?: 'agent' | 'supervisor' | 'ensemble';
      /** Explicit tool list from A2A skill config (a2a_skills.agent_tools).
       *  Replaces mode-policy defaults when set. */
      toolsOverride?: string[];
      /** Explicit worker topology from A2A skill config (a2a_skills.agent_workers).
       *  Injected into supervisor/ensemble tasks without a chat_settings row. */
      workersOverride?: WorkerDef[];
    },
  ): Promise<SendMessageResult> {
    const deps: SendMessageDeps = {
      config: this.config,
      db: this.db,
      healthTracker: this.healthTracker,
      responseCache: this.responseCache,
      cacheKeyBuilder: this.cacheKeyBuilder,
      getAvailableModels: () => this.getAvailableModels(),
      withResponseCardFormatPolicy: (basePrompt) => this.withResponseCardFormatPolicy(basePrompt),
      runAgent: (ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg) =>
        this.runAgent(ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg),
      loadPricing: () => this.loadPricing(),
      recordModelOutcome: (modelIdArg, providerIdArg, latencyMsArg, successArg, errMsg) =>
        this.recordModelOutcome(modelIdArg, providerIdArg, latencyMsArg, successArg, errMsg),
      safeParseJson: (text) => this.safeParseJson(text),
      consentManager: this.consentManager,
      recordCacheMetrics: (turn) => this.recordCacheMetrics(turn),
      semanticCache: this.config.runtime?.cache?.semanticStore,
      loadSemanticConfig: () => loadSemanticConfig(this.db),
      loadCacheVersion: () => loadCacheKeyVersion(this.db),
      // Phase 7: stampede protection + DB-driven stampede/negative config.
      singleflight: getActiveSingleflight(),
      loadStampedeConfig: () => loadStampedeConfig(this.db),
    };

    return sendMessageImpl(deps, userId, chatId, content, opts);
  }

  // ── Stream mode ─────────────────────────────────────────────

  /** Optional hook registered by the routes layer to react to policy checks post-stream. */
  onPolicyChecks?: (userId: string, checks: Array<{ tool: string; policy: string; taskType: string; priority: string }>) => Promise<void>;

  async streamMessage(
    res: ServerResponse,
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
  ): Promise<void> {
    return streamMessageImpl(
      {
        config: this.config,
        db: this.db,
        healthTracker: this.healthTracker,
        responseCache: this.responseCache,
        cacheKeyBuilder: this.cacheKeyBuilder,
        getAvailableModels: () => this.getAvailableModels(),
        withResponseCardFormatPolicy: (basePrompt) => this.withResponseCardFormatPolicy(basePrompt),
        streamAgent: (resArg, ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg) =>
          this.streamAgent(resArg, ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg),
        writeSseEvent: (resArg, payload) => this.writeSseEvent(resArg, payload),
        endSse: (resArg) => this.endSse(resArg),
        loadPricing: () => this.loadPricing(),
        recordModelOutcome: (modelIdArg, providerIdArg, latencyMsArg, successArg) =>
          this.recordModelOutcome(modelIdArg, providerIdArg, latencyMsArg, successArg),
        safeParseJson: (text) => this.safeParseJson(text),
        onPolicyChecks: this.onPolicyChecks,
        consentManager: this.consentManager,
        recordCacheMetrics: (turn) => this.recordCacheMetrics(turn),
        semanticCache: this.config.runtime?.cache?.semanticStore,
        loadSemanticConfig: () => loadSemanticConfig(this.db),
        loadCacheVersion: () => loadCacheKeyVersion(this.db),
        // Phase 7: stampede protection + DB-driven stampede/negative config.
        singleflight: getActiveSingleflight(),
        loadStampedeConfig: () => loadStampedeConfig(this.db),
      },
      res,
      userId,
      chatId,
      content,
      opts,
    );
  }

  // ── Enterprise tools loader ─────────────────────────────────

  // ── Memory query helper (M-17) ──────────────────────────────────────────────
  // Shared by memoryRecall and memorySearch callbacks — differs only in return shape.

  private async executeMemoryQuery(
    ctx: ExecutionContext,
    userId: string,
    query: string,
    limit: number | undefined,
    callerLabel: string,
  ): Promise<{
    semantic: Array<{ content: string; source: string; memory_type?: string }>;
    entities: Array<{ entity_type: string; entity_name: string; facts: string }>;
  }> {
    const boundedLimit = Math.max(1, Math.min(20, limit ?? 5));
    const memBackend = getActiveSemanticMemoryBackend();
    let queryEmbedding: number[] | undefined;
    try {
      const embModel = getActiveGuardrailEmbeddingModel();
      if (embModel) {
        const embRes = await embModel.embed(ctx, { input: [query.slice(0, 2000)] });
        queryEmbedding = embRes.embeddings[0] as number[] | undefined;
      }
    } catch (embErr) {
      // L-17: log embedding failures so operators can diagnose model outages;
      // best-effort fallback to text-only search is correct here.
      log.warn(`${callerLabel} embedding failed`, { err: embErr instanceof Error ? embErr.message : String(embErr) });
    }
    const [semantic, entityRows] = await Promise.all([
      memBackend
        ? memBackend.search(ctx, { userId, query, limit: boundedLimit, queryEmbedding })
        : this.db.searchSemanticMemory({ userId, query, limit: boundedLimit, queryEmbedding }),
      this.db.searchEntities(userId, query),
    ]);
    return {
      semantic: semantic.map((m) => ({ content: m.content, source: m.source, memory_type: m.memory_type })),
      entities: entityRows,
    };
  }

  // ── Memory tool callbacks (5.4) ───────────────────────────────────────────
  // Extracted from buildAgentToolOptions so each concern lives in one place.

  private buildMemoryToolCallbacks(ctx: ExecutionContext): Pick<ToolRegistryOptions,
    'memoryRecall' | 'memorySearch' | 'memoryRemember' | 'memoryForget' |
    'memoryListEntities' | 'memoryListEpisodes' | 'memoryGetProfile' |
    'memorySaveSnapshot' | 'memoryLoadSnapshot' | 'memoryProposeInstruction'
  > {
    return {
      memoryRecall: async ({ userId: recallUserId, query, limit }) => {
        // M-17: delegates to executeMemoryQuery() — avoids duplicating the
        // embedding + dual-store search logic that memorySearch shares.
        const { semantic, entities } = await this.executeMemoryQuery(ctx, recallUserId, query, limit, 'memoryRecall');
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source })),
          entities: entities.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
      memorySearch: async ({ userId: searchUserId, query, limit }) => {
        // M-17: delegates to executeMemoryQuery(); returns memoryType which recall omits.
        const { semantic, entities } = await this.executeMemoryQuery(ctx, searchUserId, query, limit, 'memorySearch');
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source, memoryType: m.memory_type ?? '' })),
          entities: entities.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
      memoryRemember: async ({ userId: rememberUserId, content, memoryType, source }) => {
        const { newUUIDv7 } = await import('@weaveintel/core');
        const memBackend = getActiveSemanticMemoryBackend();
        const trimmedContent = content.slice(0, 600);
        const govResult = await applyGovernanceCheck(this.db, ctx, trimmedContent, 'semantic');
        if (govResult.blocked) {
          throw new Error('Memory governance policy blocked this content from being stored.');
        }
        const safeContent = govResult.content;
        const id = newUUIDv7();
        let embedding: number[] | undefined;
        try {
          const embModel = getActiveGuardrailEmbeddingModel();
          if (embModel) {
            const embRes = await embModel.embed(ctx, { input: [safeContent] });
            embedding = Array.from(embRes.embeddings[0] ?? []) as number[];
            if (embedding.length === 0) embedding = undefined;
          }
        } catch (embErr) {
          log.warn('memory_remember embedding failed', { err: String(embErr) });
        }
        const saveOpts = { id, userId: rememberUserId, content: safeContent, memoryType: memoryType ?? 'user_fact', source: source ?? 'user_requested', embedding };
        await (memBackend ? memBackend.save(ctx, saveOpts) : this.db.saveSemanticMemory(saveOpts));
        return { id };
      },
      memoryForget: async ({ userId: forgetUserId, entityName }) => {
        return await this.forgetMemoryForUser(ctx, forgetUserId, entityName);
      },
      memoryListEntities: async ({ userId: listUserId }) => {
        const rows = await this.db.listEntities(listUserId);
        return {
          entities: rows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
            confidence: e.confidence,
          })),
        };
      },
      memoryListEpisodes: async ({ userId: epUserId, limit }) => {
        const rows = await this.db.listEpisodicMemory(epUserId, Math.min(30, limit ?? 10));
        return {
          episodes: rows.map((r) => ({
            id: r.id,
            messageRole: r.message_role,
            content: r.content,
            importance: r.importance,
            createdAt: r.created_at,
          })),
        };
      },
      memoryGetProfile: async ({ userId: profUserId }) => {
        const [entityRows, semanticRows, episodicRows, proceduralRows] = await Promise.all([
          this.db.listEntities(profUserId),
          this.db.listSemanticMemory(profUserId, 20),
          this.db.listEpisodicMemory(profUserId, 10),
          this.db.listAppliedProcedural(profUserId),
        ]);
        return {
          entities: entityRows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
            confidence: e.confidence,
          })),
          semantic: semanticRows.map((m) => ({ content: m.content, memoryType: m.memory_type, source: m.source })),
          episodic: episodicRows.map((ep) => ({ messageRole: ep.message_role, content: ep.content, createdAt: ep.created_at })),
          procedural: proceduralRows.map((p) => ({ instructionDelta: p.instruction_delta, appliedAt: p.applied_at ?? '' })),
        };
      },
      memorySaveSnapshot: async ({ userId: snapUserId, chatId: snapChatId, agentId: snapAgentId, state }) => {
        const { newUUIDv7 } = await import('@weaveintel/core');
        const id = newUUIDv7();
        await this.db.saveWorkingMemorySnapshot({ id, userId: snapUserId, chatId: snapChatId, agentId: snapAgentId ?? 'default', content: state });
        return { id };
      },
      memoryLoadSnapshot: async ({ userId: snapUserId, agentId: snapAgentId }) => {
        const snapshot = await this.db.getLatestWorkingMemory(snapUserId, snapAgentId ?? 'default');
        if (!snapshot) return { snapshot: null, id: null, savedAt: null };
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(snapshot.content) as Record<string, unknown>; } catch { parsed = { raw: snapshot.content }; }
        return { snapshot: parsed, id: snapshot.id, savedAt: snapshot.created_at };
      },
      memoryProposeInstruction: async ({ userId: propUserId, agentId: propAgentId, instruction, reason, confidence }) => {
        // M5-3: check personalization consent before AI-derived memory write.
        if (!(await this.isPersonalizationAllowed(propUserId))) {
          return { id: 'consent-denied' };
        }
        const { newUUIDv7 } = await import('@weaveintel/core');
        const id = `proc-${newUUIDv7().slice(-8)}`;
        await this.db.createProceduralMemory({
          id,
          user_id: propUserId,
          agent_id: propAgentId ?? 'default',
          instruction_delta: reason ? `${instruction}\n\nReason: ${reason}` : instruction,
          proposed_by: 'agent',
          status: 'proposed',
          confidence: confidence ?? 0.75,
          human_task_id: null,
          applied_at: null,
        });
        return { id };
      },
    };
  }

  // ── Agenda tool callbacks (5.4) ───────────────────────────────────────────

  private buildAgendaToolCallbacks(): Pick<ToolRegistryOptions,
    'agendaList' | 'agendaFindSimilar' | 'agendaCreate' | 'agendaUpdate' | 'agendaDelete'
  > {
    return {
      agendaList: async ({ userId: agendaUserId, startAt, endAt, kind, limit, search }) => {
        const items = await this.db.listAgendaItems(agendaUserId, {
          startAt,
          endAt,
          kind: kind as import('./db-types/adapter-agenda-notes.js').AgendaItemKind | undefined,
          limit: limit ?? 10,
          search,
        });
        return items.map((item) => ({
          id: item.id,
          title: item.title,
          kind: item.kind,
          status: item.status,
          start_at: item.start_at,
          end_at: item.end_at,
          all_day: item.all_day,
          location: item.location,
          description: item.description,
          created_at: item.created_at,
        }));
      },
      agendaFindSimilar: async ({ userId: agendaUserId, title, dateBucket }) => {
        const similar = await this.db.findSimilarAgendaItems(agendaUserId, title, dateBucket);
        return similar.map(item => ({ id: item.id, title: item.title, kind: item.kind, start_at: item.start_at }));
      },
      agendaCreate: async ({ userId: agendaUserId, title, kind, startAt, endAt, allDay, location, description }) => {
        if (!(await this.isPersonalizationAllowed(agendaUserId))) {
          return { id: 'consent-denied', title, kind: kind ?? 'event', start_at: startAt ?? null };
        }
        const { newUUIDv7 } = await import('@weaveintel/core');
        const id = newUUIDv7();
        await this.db.createAgendaItem({
          id,
          user_id: agendaUserId,
          tenant_id: null,
          title,
          kind: (kind ?? 'event') as import('./db-types/adapter-agenda-notes.js').AgendaItemKind,
          category_id: null,
          start_at: startAt ?? null,
          end_at: endAt ?? null,
          all_day: allDay ? 1 : 0,
          location: location ?? null,
          description: description ?? null,
          recurrence_rule: null,
          status: 'confirmed',
          sensitivity: 'normal',
          amount: null,
          currency: null,
          provenance: JSON.stringify({ source: 'agent' }),
        });
        const item = await this.db.getAgendaItem(id, agendaUserId);
        return { id, title: item?.title ?? title, kind: item?.kind ?? (kind ?? 'event'), start_at: item?.start_at ?? startAt ?? null };
      },
      agendaUpdate: async ({ userId: agendaUserId, id, title, kind, startAt, endAt, allDay, location, description, status }) => {
        const patch: Record<string, unknown> = {};
        if (title !== undefined) patch['title'] = title;
        if (kind !== undefined) patch['kind'] = kind;
        if (startAt !== undefined) patch['start_at'] = startAt;
        if (endAt !== undefined) patch['end_at'] = endAt;
        if (allDay !== undefined) patch['all_day'] = allDay ? 1 : 0;
        if (location !== undefined) patch['location'] = location;
        if (description !== undefined) patch['description'] = description;
        if (status !== undefined) patch['status'] = status;
        await this.db.updateAgendaItem(id, agendaUserId, patch as Parameters<typeof this.db.updateAgendaItem>[2]);
        const item = await this.db.getAgendaItem(id, agendaUserId);
        if (!item) return null;
        return { id: item.id, title: item.title, start_at: item.start_at };
      },
      agendaDelete: async ({ userId: agendaUserId, id }) => {
        const deleted = await this.db.deleteAgendaItem(id, agendaUserId);
        return { deleted: !!deleted };
      },
    };
  }

  // ── Shared tool options builder (R-2: deduplicates runAgent / streamAgent) ──

  private buildAgentToolOptions(
    ctx: ExecutionContext,
    userId: string,
    chatId: string,
    userPersona: string,
    settings: ChatSettings,
    attachments: ChatAttachment[] | undefined,
    disabledToolKeys: ReadonlySet<string>,
    catalogEntries: import('./db-types.js').ToolCatalogRow[],
    tenantId?: string | null,
  ): ToolRegistryOptions {
    // P4-3: Build graph store when graph tools are enabled.
    // Use SQLite-backed store when persist is enabled and raw DB is accessible.
    let graphStore: import('@weaveintel/memory').GraphMemoryStore | undefined;
    if (settings.graphEnabled) {
      if (settings.graphPersistEnabled && this.db instanceof SQLiteAdapter) {
        graphStore = createSQLiteGraphMemoryStore(this.db.rawDb, chatId, userId);
      } else {
        graphStore = createGraphMemoryStore();
      }
    }

    return {
      ...this.toolOptions,
      defaultTimezone: settings.timezone,
      currentUserId: userId,
      ...(tenantId != null ? { currentTenantId: tenantId } : {}),
      ...(userPersona ? { currentPersona: userPersona } : {}),
      currentChatId: chatId,
      // Phase 3: run-scope artifacts produced via /api/me/runs (the executor
      // stamps ctx.metadata.runId) so `artifacts.run_id` is populated.
      currentRunId: typeof ctx.metadata?.['runId'] === 'string' ? ctx.metadata['runId'] as string : undefined,
      currentAttachments: attachments,
      actorPersona: userPersona,
      ...this.buildMemoryToolCallbacks(ctx),
      ...this.buildAgendaToolCallbacks(),
      disabledToolKeys,
      catalogEntries,
      skillPolicyKey: settings.skillPolicyKey,
      explicitEnabledTools: settings.enabledTools,
      // P4-3: Knowledge graph store (undefined when graph is disabled)
      ...(graphStore && { graphStore }),
      // Scope guard: stamp session + user context for log entries.
      ...(this.toolOptions.scopeGuard && {
        scopeGuard: { ...this.toolOptions.scopeGuard, sessionId: chatId, userId },
      }),
      // m77/m81: Artifact persistence — stamp session + user + tenant on each save.
      ...(this.toolOptions.artifactSave && {
        artifactSave: (input: import('./db-types/artifacts.js').ArtifactSaveInput) =>
          this.toolOptions.artifactSave!({ ...input, sessionId: chatId, userId, ...(tenantId != null ? { tenantId } : {}) }),
      }),
    };
  }

  // ── Shared agent instance builder (H-12) ─────────────────────────────────
  // Extracted from the ~250-line duplicated block that existed verbatim in both
  // runAgent() and streamAgent(). Both callers now share one code path for:
  //   - forceWorkerDataAnalysis / skill contract detection
  //   - effectiveGoal / routedGoal construction
  //   - dbWorkerRows loading
  //   - supervisor / ensemble / single-agent construction
  // The agentBus is passed in because streamAgent wires screenshot events on it
  // before calling this method.

  private async buildAgentInstance(opts: {
    ctx: ExecutionContext;
    model: Model;
    userId: string;
    chatId: string;
    userContent: string;
    settings: ChatSettings;
    attachments: ChatAttachment[] | undefined;
    limits: Awaited<ReturnType<typeof resolveLimits>>;
    tools: ToolRegistry | undefined;
    customTools: Tool[] | undefined;
    enterpriseToolGroups: EnterpriseToolGroup[];
    toolOptions: ReturnType<ChatEngine['buildAgentToolOptions']>;
    agentBus: EventBus;
    hasEnterprise: boolean;
  }): Promise<{
    agent: Agent;
    systemPromptSha256: string;
    routedGoal: string;
    forceWorkerDataAnalysis: boolean;
    skillExecutionContracts: ResolvedSkillExecutionContract[];
  }> {
    const { ctx, model, userId, chatId, userContent, settings, attachments, limits, tools, customTools, enterpriseToolGroups, toolOptions, agentBus, hasEnterprise } = opts;

    const forceWorkerDataAnalysis = shouldForceWorkerDataAnalysis(userContent, attachments);
    const skillExecutionContracts = extractSkillExecutionContractsFromPrompt(settings.systemPrompt);
    const hasActiveMandatorySkillPlan = skillExecutionContracts.length > 0;
    const forceWorkerRequirement = await this.getPolicyPromptTemplate(
      POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
      FORCED_WORKER_REQUIREMENT,
    );
    const effectiveGoal = forceWorkerDataAnalysis && !hasActiveMandatorySkillPlan
      ? `${userContent}\n\n${forceWorkerRequirement}`
      : userContent;
    const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
      ? await this.db.listEnabledWorkerAgents()
      : [];
    const routedGoal = effectiveGoal;

    let agent: Agent;
    let systemPromptSha256 = '';

    if (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise)) {
      const baseWorkers = settings.workers.length > 0
        ? await Promise.all(settings.workers.map(async (w) => ({
            name: w.name,
            description: w.description,
            systemPrompt: applyTemporalToolPolicy({
              basePrompt: undefined,
              toolNames: w.tools,
              temporalToolPolicy: TEMPORAL_TOOL_POLICY,
            }),
            model,
            tools: w.tools.length
              ? await createToolRegistry(w.tools, customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
              : customTools?.length
                ? await createToolRegistry([], customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                : undefined,
          })))
        : await this.buildWorkersFromDb(dbWorkerRows, model, toolOptions, customTools);
      const enterpriseWorkers = await Promise.all(enterpriseToolGroups.map(async (g) => {
        const registry = await createToolRegistry([], g.tools, { ...toolOptions, actorPersona: 'agent_researcher' });
        return {
          name: g.name,
          description: g.description,
          systemPrompt: await this.renderPolicyPromptTemplate(
            POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM,
            ENTERPRISE_WORKER_SYSTEM_PROMPT,
            { description: g.description },
          ),
          model,
          tools: registry,
        };
      }));
      const allWorkers = [...baseWorkers, ...enterpriseWorkers];
      log.info('supervisor ready', { workers: allWorkers.length, baseWorkers: baseWorkers.length, enterpriseWorkers: enterpriseWorkers.length });

      const resolvedSupervisor = await this.resolveSupervisorContext('general');
      const supervisorBasePrompt = [
        resolvedSupervisor?.agent.system_prompt,
        settings.systemPrompt,
      ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
      const supervisorInstructions = await this.buildSupervisorInstructions(supervisorBasePrompt, forceWorkerDataAnalysis, dbWorkerRows);
      const supervisorAdditionalTools = (await buildSupervisorAdditionalTools(resolvedSupervisor, toolOptions)) ?? tools;
      systemPromptSha256 = computePromptFingerprint(supervisorInstructions);

      agent = weaveAgent({
        model,
        workers: allWorkers,
        maxSteps: limits.chat_max_steps,
        name: resolvedSupervisor?.agent.name ?? 'geneweave-supervisor',
        systemPrompt: supervisorInstructions,
        defaultTimezone: resolvedSupervisor?.agent.default_timezone ?? settings.timezone,
        includeUtilityTools: resolvedSupervisor ? resolvedSupervisor.agent.include_utility_tools !== 0 : true,
        additionalTools: supervisorAdditionalTools,
        bus: agentBus,
        replanOnFailure: settings.supervisorReplanOnFailure,
        parallelDelegation: settings.supervisorParallelDelegation,
        // P2-1: parallel tool calls
        parallelToolCalls: settings.parallelToolCalls,
        // P2-3: context management
        ...(settings.contextStrategy && {
          contextManagement: {
            strategy: settings.contextStrategy,
            maxTokens: settings.contextMaxTokens,
            slidingWindowSize: settings.contextWindowSize,
          },
        }),
        // P2-4: tool retry
        ...(settings.toolRetryMaxAttempts && {
          toolRetry: {
            maxAttempts: settings.toolRetryMaxAttempts,
            backoffMs: settings.toolRetryBackoffMs,
            maxBackoffMs: settings.toolRetryMaxBackoffMs,
          },
        }),
        // P3-1: HITL interrupt — uses an in-process queue backed by geneWeave's
        // hitl_interrupt_requests table (via the shared human task queue).
        ...(settings.hitlEnabled && {
          // On the /api/me/runs path the run-aware queue emits approval.request +
          // persists + resumes via postEvent; off-run (web chat) falls back to
          // an in-process queue.
          onInterrupt: createHumanTaskInterruptHandler(
            runApprovals.queueForChat(chatId) ?? new InMemoryTaskQueue(),
            { timeoutMs: settings.hitlTimeoutMs },
          ),
          requireApproval: settings.hitlRequireAll,
        }),
        ...(settings.reflectEnabled && {
          reflect: {
            maxRevisions: settings.reflectMaxRevisions,
            criteria: settings.reflectCriteria,
          },
        }),
        // P4-2: Proactive memory context injection — retrieves semantic + episodic
        // context before each model.generate() call and prepends it ephemerally.
        ...(settings.memoryContextEnabled && {
          memoryContext: {
            retrieve: async (agentCtx: import('@weaveintel/core').ExecutionContext, userText: string) => {
              const uid = toolOptions.currentUserId ?? '';
              const [semantic, episodic] = await Promise.all([
                buildMemoryContext(this.db, agentCtx, model, uid, userText).catch(() => null),
                buildEpisodicContext(this.db, uid, 4).catch(() => null),
              ]);
              const parts = [semantic, episodic].filter(Boolean);
              return parts.length > 0 ? parts.join('\n\n') : null;
            },
            maxChars: settings.memoryContextMaxChars,
          },
        }),
        // P5-1: Agent checkpoint — persist run state every N steps.
        ...(settings.checkpointEnabled && this.db instanceof SQLiteAdapter && {
          checkpoint: {
            store: createSQLiteCheckpointStoreForChat(this.db.rawDb, chatId, userId),
            intervalSteps: settings.checkpointIntervalSteps,
          },
        }),
        // P5-2: Dynamic worker registry — builds a mutable WorkerRegistry so
        // operators can add/remove workers at runtime via the admin API.
        ...(settings.dynamicWorkersEnabled && {
          workerRegistry: createWorkerRegistry(allWorkers),
        }),
      });
    } else {
      const policyPrompt = await this.withResponseCardFormatPolicy(applyTemporalToolPolicy({
        basePrompt: settings.systemPrompt,
        toolNames: settings.enabledTools,
        temporalToolPolicy: TEMPORAL_TOOL_POLICY,
      }));
      systemPromptSha256 = computePromptFingerprint(policyPrompt);
      if (settings.mode === 'ensemble' && settings.ensembleAgents?.length) {
        const ensembleAgents = await Promise.all(
          settings.ensembleAgents.map(async (def) => {
            const agentModel = def.model
              ? await getOrCreateModel(
                  this.config.defaultProvider,
                  def.model,
                  this.config.providers[this.config.defaultProvider] ?? {},
                )
              : model;
            return weaveAgent({
              model: agentModel,
              tools,
              systemPrompt: def.systemPrompt ?? policyPrompt,
              maxSteps: limits.chat_max_steps,
              name: def.name,
              bus: agentBus,
            });
          }),
        );
        const resolver = settings.ensembleResolver === 'arbiter'
          ? createArbiterResolver({ model })
          : createVoteResolver();
        agent = weaveEnsemble({ agents: ensembleAgents, resolver, parallel: true, name: 'geneweave-ensemble' });
      } else {
        agent = weaveAgent({
          model,
          tools,
          systemPrompt: policyPrompt,
          maxSteps: limits.chat_max_steps,
          name: 'geneweave-agent',
          bus: agentBus,
          // P2-1: parallel tool calls
          parallelToolCalls: settings.parallelToolCalls,
          // P2-3: context management
          ...(settings.contextStrategy && {
            contextManagement: {
              strategy: settings.contextStrategy,
              maxTokens: settings.contextMaxTokens,
              slidingWindowSize: settings.contextWindowSize,
            },
          }),
          // P2-4: tool retry
          ...(settings.toolRetryMaxAttempts && {
            toolRetry: {
              maxAttempts: settings.toolRetryMaxAttempts,
              backoffMs: settings.toolRetryBackoffMs,
              maxBackoffMs: settings.toolRetryMaxBackoffMs,
            },
          }),
          // P3-1: HITL interrupt
          ...(settings.hitlEnabled && {
            // Run-aware approval queue on the run path (emit + persist + resume);
            // in-process fallback for web chat.
            onInterrupt: createHumanTaskInterruptHandler(
              runApprovals.queueForChat(chatId) ?? new InMemoryTaskQueue(),
              { timeoutMs: settings.hitlTimeoutMs },
            ),
            requireApproval: settings.hitlRequireAll,
          }),
          ...(settings.reflectEnabled && {
            reflect: {
              maxRevisions: settings.reflectMaxRevisions,
              criteria: settings.reflectCriteria,
            },
          }),
          // P4-2: Proactive memory context injection
          ...(settings.memoryContextEnabled && {
            memoryContext: {
              retrieve: async (agentCtx: import('@weaveintel/core').ExecutionContext, userText: string) => {
                const uid = toolOptions.currentUserId ?? '';
                const [semantic, episodic] = await Promise.all([
                  buildMemoryContext(this.db, agentCtx, model, uid, userText).catch(() => null),
                  buildEpisodicContext(this.db, uid, 4).catch(() => null),
                ]);
                const parts = [semantic, episodic].filter(Boolean);
                return parts.length > 0 ? parts.join('\n\n') : null;
              },
              maxChars: settings.memoryContextMaxChars,
            },
          }),
          // P5-1: Agent checkpoint — persist run state every N steps.
          ...(settings.checkpointEnabled && this.db instanceof SQLiteAdapter && {
            checkpoint: {
              store: createSQLiteCheckpointStoreForChat(this.db.rawDb, chatId, userId),
              intervalSteps: settings.checkpointIntervalSteps,
            },
          }),
          // P6-1: Multi-tier eval pipeline — schema-check → rubric critic → verifier → ensemble.
          ...(settings.evalPipelineEnabled && settings.evalPipelineStages && (() => {
            try {
              const stages = JSON.parse(settings.evalPipelineStages!) as EvalStageConfig[];
              return { evalPipeline: { stages, failFast: settings.evalPipelineFailFast !== false } };
            } catch { return {}; }
          })()),
          // P6-3: Cost governor — history compaction + budget gate.
          ...(settings.costGovernorEnabled && (() => {
            const policy = (() => {
              try { return settings.costGovernorPolicy ? JSON.parse(settings.costGovernorPolicy) as CostPolicy : { tier: 'balanced' as const }; }
              catch { return { tier: 'balanced' as const }; }
            })();
            const ledger = createInMemoryCostLedger();
            const bundle = weaveCostGovernor(policy);
            return { costGovernor: { bundle, ledger } };
          })()),
          // P6-4: Compliance-aware tool execution — consent check at tool call time.
          ...(settings.complianceEnabled && {
            complianceTools: {
              subjectId: settings.complianceSubjectIdField,
              purpose: 'geneweave.agent',
              enforceConsent: settings.complianceEnforceConsent,
            },
          }),
          // P6-5: Vision loop — detect screenshot tool outputs and inject as ImageContent.
          visionLoop: settings.visionLoopEnabled,
        });
      }
    }

    return { agent, systemPromptSha256, routedGoal, forceWorkerDataAnalysis, skillExecutionContracts };
  }

  // ── Agent execution (non-streaming) ─────────────────────────

  private async runAgent(
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
    tenantId?: string | null,
  ): Promise<AgentRunTelemetry> {
    const limits = await resolveLimits(this.db, tenantId);
    const enterpriseToolGroups = await loadEnterpriseToolGroups(this.db);
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const [disabledToolKeys, catalogEntries] = await Promise.all([
      this.getDisabledBuiltinToolKeys(),
      this.db.listEnabledToolCatalog(),
    ]);
    // Flat enterprise tools for backward compat (base tools only, no extended)
    const enterpriseTools = hasEnterprise ? await loadEnterpriseTools(this.db) : [];
    const toolOptions = this.buildAgentToolOptions(ctx, userId, chatId, userPersona, settings, attachments, disabledToolKeys, catalogEntries, tenantId);
    // m78: Resolve effective tenant artifact settings for emit_artifact type enforcement
    if (tenantId && this.toolOptions.artifactSave) {
      const dbEx = this.db as unknown as { getEffectiveTenantArtifactSettings?: (tid: string) => Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow | null> };
      if (dbEx.getEffectiveTenantArtifactSettings) {
        const row = await dbEx.getEffectiveTenantArtifactSettings(tenantId).catch(() => null);
        if (row) {
          toolOptions.resolvedArtifactSettings = {
            allowed_types: row.allowed_types ? (JSON.parse(row.allowed_types) as string[]) : null,
            max_size_bytes: row.max_size_bytes,
            emit_enabled: Boolean(row.emit_enabled),
            preview_enabled: Boolean(row.preview_enabled),
            sandbox_html: Boolean(row.sandbox_html),
          };
        }
      }
    }
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? await createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? await createToolRegistry([], customTools, toolOptions) : undefined;

    const agentBus = weaveEventBus();
    const toolCallObserver = observeToolCallEvents(agentBus);

    // Phase 8: Agentic Plan Caching — reuse a structured plan template from a
    // semantically-similar past agent/supervisor task as planning guidance.
    const planGuidance = await planCacheLookupGuidance(this.db, userContent, settings.mode, tenantId, userId);

    try {
      // H-12: delegate shared agent construction to buildAgentInstance().
      const { agent, systemPromptSha256, routedGoal, forceWorkerDataAnalysis, skillExecutionContracts } =
        await this.buildAgentInstance({
          ctx, model, userId, chatId, userContent, settings, attachments, limits, tools, customTools,
          enterpriseToolGroups, toolOptions, agentBus, hasEnterprise,
        });

      const goalForRun = planGuidance ? `${planGuidance}\n\n${routedGoal}` : routedGoal;
      const result = await this.runWithCseSuccessGuard(
        agent,
        ctx,
        messages,
        goalForRun,
        forceWorkerDataAnalysis,
        skillExecutionContracts,
      );
      // Phase 8: distill + store this run's plan for future similar tasks.
      await planCacheStoreFromResult(this.db, userContent, result, settings.mode, tenantId, userId);
      return { result, toolCallEvents: toolCallObserver.events, systemPromptSha256 };
    } finally {
      toolCallObserver.dispose();
    }
  }

  // ── Agent streaming ─────────────────────────────────────────

  private async streamAgent(
    res: ServerResponse,
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
    tenantId?: string | null,
  ): Promise<AgentRunTelemetry> {
    const limits = await resolveLimits(this.db, tenantId);
    const enterpriseToolGroups = await loadEnterpriseToolGroups(this.db);
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const enterpriseTools = hasEnterprise ? await loadEnterpriseTools(this.db) : [];
    const [disabledToolKeys, catalogEntries] = await Promise.all([
      this.getDisabledBuiltinToolKeys(),
      this.db.listEnabledToolCatalog(),
    ]);
    const toolOptions = this.buildAgentToolOptions(ctx, userId, chatId, userPersona, settings, attachments, disabledToolKeys, catalogEntries, tenantId);
    // m78: Resolve effective tenant artifact settings for emit_artifact type enforcement
    if (tenantId && this.toolOptions.artifactSave) {
      const dbEx = this.db as unknown as { getEffectiveTenantArtifactSettings?: (tid: string) => Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow | null> };
      if (dbEx.getEffectiveTenantArtifactSettings) {
        const row = await dbEx.getEffectiveTenantArtifactSettings(tenantId).catch(() => null);
        if (row) {
          toolOptions.resolvedArtifactSettings = {
            allowed_types: row.allowed_types ? (JSON.parse(row.allowed_types) as string[]) : null,
            max_size_bytes: row.max_size_bytes,
            emit_enabled: Boolean(row.emit_enabled),
            preview_enabled: Boolean(row.preview_enabled),
            sandbox_html: Boolean(row.sandbox_html),
          };
        }
      }
    }
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? await createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? await createToolRegistry([], customTools, toolOptions) : undefined;

    // Create event bus to capture sub-agent events (e.g. screenshots from workers)
    const agentBus = weaveEventBus();
    const toolCallObserver = observeToolCallEvents(agentBus);
    let screenshotUnsub: (() => void) | undefined;

    // Listen for browser_screenshot tool results from any worker and forward via SSE
    screenshotUnsub = agentBus.on(EventTypes.ToolCallEnd, (event) => {
      if (event.data['tool'] === 'browser_screenshot' && typeof event.data['result'] === 'string') {
        try {
          const parsed = JSON.parse(event.data['result'] as string);
          if (parsed.base64) {
            void this.writeSseEvent(res, { type: 'screenshot', base64: parsed.base64, format: parsed.format || 'png' });
          }
        } catch { /* not JSON or no base64 — ignore */ }
      }
    });

    // Phase 8: Agentic Plan Caching — reuse a plan template from a similar past
    // agent/supervisor task as planning guidance (both streaming + fallback).
    const planGuidance = await planCacheLookupGuidance(this.db, userContent, settings.mode, tenantId, userId);

    try {
      // H-12: delegate shared agent construction to buildAgentInstance().
      const { agent, systemPromptSha256, routedGoal, forceWorkerDataAnalysis, skillExecutionContracts: skillExecutionContractsStream } =
        await this.buildAgentInstance({
          ctx, model, userId, chatId, userContent, settings, attachments, limits, tools, customTools,
          enterpriseToolGroups, toolOptions, agentBus, hasEnterprise,
        });

    const goalForRun = planGuidance ? `${planGuidance}\n\n${routedGoal}` : routedGoal;

    if (forceWorkerDataAnalysis) {
      const guarded = await this.runWithCseSuccessGuard(agent, ctx, messages, goalForRun, true, skillExecutionContractsStream);
      await this.writeSseEvent(res, { type: 'text', text: guarded.output });
      for (const step of guarded.steps) {
        await this.writeSseEvent(res, {
          type: 'step',
          step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
          phase: 'step_end',
        });
      }
      await planCacheStoreFromResult(this.db, userContent, guarded, settings.mode, tenantId, userId);
      return { result: guarded, toolCallEvents: toolCallObserver.events, systemPromptSha256 };
    }

    // Try streaming mode first
    if (agent.runStream) {
      const stream = agent.runStream(ctx, { messages, goal: goalForRun });
      let finalResult: AgentResult | undefined;

      for await (const event of stream) {
        switch (event.type) {
          case 'step_start':
          case 'step_end':
            if (event.step) {
              await this.writeSseEvent(res, {
                type: 'step',
                step: {
                  index: event.step.index,
                  type: event.step.type,
                  content: event.step.content,
                  toolCall: event.step.toolCall,
                  delegation: event.step.delegation,
                  durationMs: event.step.durationMs,
                },
                phase: event.type,
              });
            }
            break;
          case 'text_chunk':
            if (event.text) {
              await this.writeSseEvent(res, { type: 'text', text: event.text });
            }
            break;
          case 'tool_start':
            if (event.step?.toolCall) {
              await this.writeSseEvent(res, {
                type: 'tool_start',
                name: event.step.toolCall.name,
                arguments: event.step.toolCall.arguments,
              });
            }
            break;
          case 'tool_end':
            if (event.step?.toolCall) {
              await this.writeSseEvent(res, {
                type: 'tool_end',
                name: event.step.toolCall.name,
                result: event.step.toolCall.result,
                durationMs: event.step.durationMs,
              });
            }
            break;
          case 'done':
            finalResult = event.result;
            break;
        }
      }

      if (finalResult) {
        await planCacheStoreFromResult(this.db, userContent, finalResult, settings.mode, tenantId, userId);
        return { result: finalResult, toolCallEvents: toolCallObserver.events };
      }
      // Stream ended without a 'done' event — log and fall through to the
      // non-streaming path rather than silently returning undefined output.
      log.warn('stream agent ended without done event, falling back to agent.run()');
    }

    // Fallback: non-streaming agent run, send result as single text event
    const result = await agent.run(ctx, { messages, goal: goalForRun });
    await this.writeSseEvent(res, { type: 'text', text: result.output });

    // Send step summaries
    for (const step of result.steps) {
      await this.writeSseEvent(res, {
        type: 'step',
        step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
        phase: 'step_end',
      });
    }

    await planCacheStoreFromResult(this.db, userContent, result, settings.mode, tenantId, userId);
    return { result, toolCallEvents: toolCallObserver.events };
    } finally {
      screenshotUnsub?.();
      toolCallObserver.dispose();
    }
  }

  /** Available models based on configured providers + DB pricing table */
  async getAvailableModels(): Promise<Array<{ id: string; provider: string }>> {
    const seen = new Set<string>();
    const models: Array<{ id: string; provider: string }> = [];
    const configuredProviders = new Set(Object.keys(this.config.providers));

    // First, pull enabled models from the DB pricing table
    try {
      const rows = await this.db.listModelPricing();
      for (const row of rows) {
        if (row.enabled && configuredProviders.has(row.provider)) {
          const key = `${row.provider}:${row.model_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            models.push({ id: row.model_id, provider: row.provider });
          }
        }
      }
    } catch {
      // DB lookup is best-effort; fall through to hardcoded fallback
    }

    // Merge hardcoded fallback models (for providers with no DB rows yet)
    const FALLBACK_MODELS: Record<string, string[]> = {
      anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
      google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
      gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
      ollama: ['llama3.1', 'llama3', 'qwen2.5', 'qwen3', 'mistral', 'phi3', 'gemma2', 'deepseek-r1', 'llava'],
      llamacpp: ['local'],
      'llama-cpp': ['local'],
      mock: ['mock-model'],
    };
    for (const provider of configuredProviders) {
      const fallback = FALLBACK_MODELS[provider];
      if (fallback) {
        for (const id of fallback) {
          const key = `${provider}:${id}`;
          if (!seen.has(key)) {
            seen.add(key);
            models.push({ id, provider });
          }
        }
      }
    }
    return models;
  }

  private safeParseJson(text: string): unknown {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const raw = fenced?.[1] ?? trimmed;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Record model outcome for health tracking.
   * When errorMessage indicates a rate limit (429), immediately marks the
   * provider unavailable so the next request routes away from it.
   */
  recordModelOutcome(modelId: string, providerId: string, latencyMs: number, success: boolean, errorMessage?: string): void {
    this.healthTracker.recordOutcome(modelId, providerId, latencyMs, success);

    if (!success && errorMessage && isRateLimitError(errorMessage)) {
      this.healthTracker.blockProvider(providerId, 5 * 60_000);
      return;
    }

    // Phase 3: latency-percentile degradation detection.
    // Trip a short soft block when a successful call takes ≥ P99×3 AND exceeds
    // the minimum threshold. This catches a provider that is still responding
    // but severely degraded, routing traffic away before users hit full timeouts.
    // (Industry standard: P99 × 3 multiplier, 30-second soft block.)
    if (success && latencyMs >= MIN_DEGRADATION_LATENCY_MS) {
      const endpointId = `${providerId}:rest`;
      const p99 = getP99Latency(endpointId);
      if (p99 !== undefined && latencyMs > p99 * DEGRADATION_MULTIPLIER) {
        log.warn('provider_degraded', {
          providerId,
          modelId,
          latencyMs,
          p99,
          threshold: p99 * DEGRADATION_MULTIPLIER,
          blockMs: DEGRADATION_BLOCK_MS,
        });
        this.healthTracker.blockProvider(providerId, DEGRADATION_BLOCK_MS);
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('rate limit') || lower.includes('rate_limit') ||
         lower.includes('quota') || lower.includes('too many requests') ||
         lower.includes('429');
}

