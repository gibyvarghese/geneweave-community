import { newUUIDv7, createLogger } from '@weaveintel/core';

const logger = createLogger('chat-send-message');
import type { ExecutionContext, Message, AgentStep, ModelRequest } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import type { GuardrailCategorySummary } from '@weaveintel/guardrails';
import { applySkillsToPrompt } from '@weaveintel/skills';
import { shouldBypass, shouldBypassResponse, isCacheableTemperature, cacheScopeKey, cacheScopeKeyString, planPromptCacheBreakpoints } from '@weaveintel/cache';
import type { SemanticCache } from '@weaveintel/core';
import { semanticLookup, semanticStore, type SemanticConfig } from './chat-semantic-utils.js';
import { readResponseWithSwr, writeResponseWithSwr, readNegativeCache, writeNegativeCache } from './cache-stampede.js';
import type { RuntimeRoutingSlot } from '@weaveintel/core';
import type { DurableConsentManager } from '@weaveintel/guardrails/compliance';
import type { DatabaseAdapter } from './db.js';
import { normalizePersona } from './rbac.js';
import { buildReasoningRequestMetadata, reasoningAdjustedTemperature, reasoningAdjustedMaxTokens, type ReasoningRequestMetadata } from './chat-reasoning-utils.js';
import {
  calculateCost,
  getOrCreateModel,
  settingsFromRow,
  type ChatAttachment,
  type ChatEngineConfig,
  type ChatSettings,
  type WorkerDef,
} from './chat-runtime.js';
import { getDefaultToolsByMode } from './chat-policies.js';
import type { ModelPricing } from './chat-pricing-utils.js';
import {
  composeUserInput,
  hasTabularDataAttachments,
  normalizeAttachments,
  patchLatestUserMessage,
} from './chat-attachment-utils.js';
import {
  hasCodeExecutorDelegation,
  hasSuccessfulCseExecution,
} from './chat-cse-utils.js';
import { hasRenderableAttachmentAnalysisOutput } from './chat-output-guards.js';
import {
  validatePromptContractsAgainstDb,
  type PromptContractValidationReport,
} from './chat-prompt-contract-utils.js';
import { shouldForceWorkerDataAnalysis } from './chat-intent-utils.js';
import { discoverSkillsForInput } from './chat-skills-utils.js';
import { applyRedaction, runPostEval, SUPERVISOR_INTERNAL_TOOLS } from './chat-eval-utils.js';
import { historyToMessages, extractToolEvidence } from './chat-message-utils.js';
import { recordTraceSpans, withLLMSpan, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
import { evaluateGuardrails, evaluateTaskPolicies } from './chat-guardrail-eval-utils.js';
import {
  resolveSystemPrompt,
  buildCapabilityTelemetrySnapshots,
  type PromptStrategyInfo,
} from './chat-system-prompt-utils.js';
import { routeModel, resolveActiveCache } from './chat-routing-utils.js';
import {
  buildMemoryContext,
  resolveIdentityRecallFromMemory,
  saveToMemory,
  loadProceduralInstructions,
  buildEpisodicContext,
  buildWorkingMemoryContext,
} from './chat-memory-utils.js';
import { triggerConsolidationForUser } from './memory-consolidation.js';

export type CognitiveCheckSummary = GuardrailCategorySummary;

/**
 * M-16: Shape of values written to / read from the response cache.
 * Defined explicitly so the cache hit path is type-checked instead of
 * using `as any`, which would silently accept a malformed cache entry.
 */
export interface CachedResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
}

export type SendMessageResult = {
  assistantContent: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  cost: number;
  latencyMs: number;
  /** Phase 0/4: true when the response was served from cache (exact or semantic). */
  cached?: boolean;
  /** Phase 4: true when served from the semantic (embedding-similarity) cache. */
  semantic?: boolean;
  /** Phase 2: provider-native prompt-cache outcome for this turn (stable-prefix caching). */
  promptCache?: { readTokens: number; writeTokens: number; applied: boolean; ttl: '5m' | '1h' };
  redaction?: { count: number; types: string[] };
  eval?: { passed: number; failed: number; total: number; score: number };
  steps?: AgentStep[];
  traceId?: string;
  guardrail?: { decision: 'allow' | 'deny' | 'warn'; reason?: string };
  cognitive?: CognitiveCheckSummary;
  policyChecks?: Array<{ tool: string; policy: string; taskType: string; priority: string }>;
  routingDecision?: { provider: string; model: string; reason: string };
  activeSkills?: Array<{ id: string; name: string; category: string; score: number; tools: string[] }>;
  skillTools?: string[];
  enabledTools?: string[];
  skillPromptApplied?: boolean;
  contracts?: PromptContractValidationReport;
  promptStrategy?: PromptStrategyInfo;
  promptResolution?: {
    source: 'base_prompt' | 'prompt_version';
    resolvedVersion: string;
    selectedBy: 'requested_version' | 'experiment' | 'active_flag' | 'latest_published' | 'base_prompt';
    experimentId?: string;
    experimentVariantLabel?: string;
  };
};

export type SendMessageDeps = {
  config: ChatEngineConfig;
  db: DatabaseAdapter;
  healthTracker: RuntimeRoutingSlot;
  responseCache: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown, ttlMs: number) => Promise<void>;
  };
  cacheKeyBuilder: { build: (input: Record<string, string | number | boolean>) => string };
  getAvailableModels: () => Promise<Array<{ id: string; provider: string }>>;
  withResponseCardFormatPolicy: (basePrompt: string | undefined) => Promise<string | undefined>;
  runAgent: (
    ctx: ExecutionContext,
    model: any,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
    tenantId?: string | null,
  ) => Promise<AgentRunTelemetry>;
  loadPricing: () => Promise<Map<string, ModelPricing>>;
  recordModelOutcome: (modelId: string, providerId: string, latencyMs: number, success: boolean, errorMessage?: string) => void;
  safeParseJson: (text: string) => unknown;
  consentManager?: DurableConsentManager | null;
  /** Phase 3 — record this turn's cache effectiveness into the live sink + durable rollup. */
  recordCacheMetrics?: (turn: CacheTurnMetrics) => void;
  /** Phase 4 — scoped embedding-similarity cache (from the runtime cache slot). */
  semanticCache?: SemanticCache;
  /** Phase 4 — resolve the DB-driven semantic cache config (60s cached). */
  loadSemanticConfig?: () => Promise<SemanticConfig | null>;
  /** Phase 5 — resolve the dynamic cache-key version token (60s cached). */
  loadCacheVersion?: () => Promise<string>;
  /** Phase 7 — process-wide singleflight to coalesce concurrent identical misses. */
  singleflight?: import('@weaveintel/cache').Singleflight;
  /** Phase 7 — resolve the DB-driven stampede config (enabled + negative TTL, 60s cached). */
  loadStampedeConfig?: () => Promise<{ enabled: boolean; negativeTtlMs: number }>;
};

/** Per-turn cache outcome fed to the Phase 3 observability recorder. */
export type CacheTurnMetrics = {
  /** True when the response cache served this turn (no LLM call). */
  responseHit: boolean;
  /** True when a response-cache lookup occurred (an active policy applied). */
  responseEligible: boolean;
  promptCacheReadTokens: number;
  promptCacheWriteTokens: number;
  provider: string;
  inputCostPer1M: number;
};

async function isAnalyticsAllowed(consentManager: DurableConsentManager | null | undefined, userId: string): Promise<boolean> {
  if (!consentManager) return true;
  try {
    const flags = await consentManager.listBySubject(userId);
    const flag = flags.find(f => f.purpose === 'analytics');
    if (!flag) return true;
    return consentManager.isGranted(userId, 'analytics');
  } catch { return true; }
}

export async function sendMessageImpl(
  deps: SendMessageDeps,
  userId: string,
  chatId: string,
  content: string,
  opts?: {
    provider?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    attachments?: ChatAttachment[];
    /** A2A / programmatic callers can override the agent mode after settings are loaded from DB.
     *  Never 'direct' — that mode bypasses the agent loop and must not be available remotely. */
    modeOverride?: 'agent' | 'supervisor' | 'ensemble';
    /**
     * Explicit tool list — overrides the mode-default tools and any chat_settings.enabled_tools.
     * Used by A2A to apply the per-skill agent_tools config from a2a_skills.
     * When absent the mode-policy defaults are used (or the DB settings row if one exists).
     */
    toolsOverride?: string[];
    /**
     * Explicit worker definitions — overrides chat_settings.workers.
     * Used by A2A supervisor-mode skills to inject code_executor + analyst workers
     * without requiring a saved chat_settings row on the synthetic A2A chat.
     */
    workersOverride?: WorkerDef[];
  },
): Promise<SendMessageResult> {
  let provider = opts?.provider ?? deps.config.defaultProvider;
  let modelId = opts?.model ?? deps.config.defaultModel;
  let providerCfg = deps.config.providers[provider];
  let routingInfo: { provider: string; model: string; reason: string } | undefined;

  const routed = await routeModel(deps.db, await deps.getAvailableModels(), deps.healthTracker.listHealth(), { ...opts, prompt: content }, deps.healthTracker.getBlockedProviders());
  if (routed && deps.config.providers[routed.provider]) {
    provider = routed.provider;
    modelId = routed.modelId;
    providerCfg = deps.config.providers[provider];
    routingInfo = { provider, model: modelId, reason: 'Selected by routing policy' };
  }

  if (!providerCfg) {
    provider = deps.config.defaultProvider;
    modelId = deps.config.defaultModel;
    providerCfg = deps.config.providers[provider];
  }
  if (!providerCfg) {
    const first = Object.entries(deps.config.providers)[0];
    if (!first) throw new Error('No providers configured');
    [provider, providerCfg] = first;
    modelId = deps.config.defaultModel;
  }

  const model = await getOrCreateModel(provider, modelId, providerCfg);
  const actor = await deps.db.getUserById(userId);
  const userPersona = normalizePersona(actor?.persona, 'user');
  const tenantId = actor?.tenant_id ?? null;
  const chatSettingsRow = await deps.db.getChatSettings(chatId);
  const settings = settingsFromRow(chatSettingsRow);
  // Programmatic callers (A2A, automation) can override the mode after settings are
  // loaded, bypassing whatever the DB row says. 'direct' is never allowed remotely.
  if (opts?.modeOverride) {
    settings.mode = opts.modeOverride;
    // Layer 1: when there is no saved chat_settings row the mode defaulted to 'direct'
    // with empty tools. Bootstrap enabledTools from the overridden mode's policy so
    // A2A / programmatic callers get the full default tool set (CSE, web search, memory,
    // etc.) without needing a pre-created chat_settings row.
    if (!chatSettingsRow) settings.enabledTools = getDefaultToolsByMode(opts.modeOverride);
  }
  // Layer 2: apply explicit per-skill overrides supplied by A2A (from a2a_skills rows).
  // toolsOverride replaces the mode defaults when the skill defines a specific tool list.
  // workersOverride injects the skill's worker topology (code_executor, analyst, etc.)
  // into supervisor/ensemble tasks without requiring a saved chat_settings row.
  if (opts?.toolsOverride) settings.enabledTools = opts.toolsOverride;
  if (opts?.workersOverride) settings.workers = opts.workersOverride;
  const resolvedSystemPrompt = await resolveSystemPrompt(deps.db, settings);
  const resolvedPrompt = await deps.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
  const traceId = newUUIDv7();
  const ctx = weaveContext({ runtime: deps.config.runtime, userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });
  const startMs = Date.now();

  const attachments = normalizeAttachments(opts?.attachments);
  const contentWithAttachments = composeUserInput(content, attachments);

  let processedContent = contentWithAttachments;
  let redactionInfo: { count: number; types: string[] } | undefined;
  if (settings.redactionEnabled) {
    const rd = await applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
    if (rd.error) {
      const denyContent = 'Your message could not be processed safely because redaction failed before execution.';
      const assistMsgId = newUUIDv7();
      await deps.db.addMessage({
        id: assistMsgId,
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({
          guardrail: { decision: 'deny', reason: denyContent },
          redaction: { error: rd.error },
          traceId,
        }),
      });
      return {
        assistantContent: denyContent,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs: Date.now() - startMs,
        guardrail: { decision: 'deny', reason: denyContent },
      };
    }
    processedContent = rd.redacted;
    if (rd.wasModified) {
      redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
    }
  }

  // Phase 0: pre-LLM input guardrail gate. Runs on the post-redaction content
  // so PII-stripped text is evaluated. Fail-open: a missing slot or thrown
  // check is treated as allow (guardrails are never load-bearing).
  if (deps.config.runtime?.guardrails?.checkInput) {
    try {
      const inputCheck = await deps.config.runtime.guardrails.checkInput(ctx, processedContent);
      if (!inputCheck.allow) {
        const denyContent = inputCheck.reason ?? 'Your message was blocked by a content guardrail.';
        const assistMsgId = newUUIDv7();
        await deps.db.addMessage({
          id: assistMsgId, chatId, role: 'assistant', content: denyContent,
          metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: denyContent }, traceId }),
        });
        return {
          assistantContent: denyContent,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cost: 0, latencyMs: Date.now() - startMs,
          guardrail: { decision: 'deny', reason: denyContent },
        };
      }
    } catch {
      // fail-open on check error
    }
  }

  // Phase 3: per-user/tenant budget gate. Checked after guardrails so we skip
  // the ledger read for messages that would be blocked anyway. Fail-open.
  if (deps.config.runtime?.cost) {
    try {
      const budgetCheck = await deps.config.runtime.cost.gate({ userId, tenantId });
      if (!budgetCheck.allowed) {
        const denyContent = budgetCheck.reason ?? 'Your spending limit has been reached.';
        const assistMsgId = newUUIDv7();
        await deps.db.addMessage({
          id: assistMsgId, chatId, role: 'assistant', content: denyContent,
          metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: denyContent }, traceId }),
        });
        return {
          assistantContent: denyContent,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cost: 0, latencyMs: Date.now() - startMs,
          guardrail: { decision: 'deny', reason: denyContent },
        };
      }
    } catch {
      // fail-open on gate error
    }
  }

  const skillContext = await discoverSkillsForInput(
    deps.db,
    processedContent,
    model,
    ctx,
    settings.mode,
    (t) => deps.safeParseJson(t),
    { hasTabularAttachment: hasTabularDataAttachments(attachments) },
  );
  const skillPrompt = applySkillsToPrompt(
    resolvedPrompt,
    skillContext.matches,
    settings.mode === 'direct' ? 'advisory' : 'tool_assisted',
    processedContent,
  );
  const skillPolicyKey = skillContext.matches[0]?.skill.toolPolicyKey;

  const enabledTools = Array.from(new Set([...settings.enabledTools, ...skillContext.toolNames]));
  const skillTools = enabledTools.filter((tool) => !settings.enabledTools.includes(tool));
  const activeSkills = skillContext.matches.map((m) => ({
    id: m.skill.id,
    name: m.skill.name,
    description: m.skill.description ?? m.skill.summary,
    category: m.skill.category ?? 'general',
    score: Number(m.score.toFixed(3)),
    tools: [...(m.skill.toolNames ?? [])],
  }));

  const userMsgId = newUUIDv7();
  const userMetadata = redactionInfo || attachments.length > 0
    ? JSON.stringify({
        redaction: redactionInfo,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    : undefined;
  // CR-1: Always persist the post-redaction form of the message so PII that was
  // scrubbed from `processedContent` is never written to the messages table.
  // `content` (the raw input) is used only for in-memory processing above this
  // point and must not reach the database when redaction is enabled.
  await deps.db.addMessage({ id: userMsgId, chatId, role: 'user', content: processedContent, metadata: userMetadata });

  // Load history now so turn number is available for condition context.
  // (This is the same query made later for model context; moved up to avoid drift.)
  const history = await deps.db.getMessages(chatId);
  const turnNumber = Math.ceil(history.length / 2);

  const preGuardrail = await evaluateGuardrails(
    deps.db, chatId, userMsgId, processedContent, 'pre-execution',
    undefined,
    { persona: userPersona, chatMode: settings.mode, turnNumber, tenantId },
  );
  if (preGuardrail.decision === 'deny') {
    const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
    const assistMsgId = newUUIDv7();
    await deps.db.addMessage({
      id: assistMsgId,
      chatId,
      role: 'assistant',
      content: denyContent,
      metadata: JSON.stringify({
        guardrail: { decision: 'deny', reason: preGuardrail.reason },
        cognitive: preGuardrail.cognitive,
      }),
    });
    // Episodic logging: always capture the turn even when guardrail blocks LLM processing.
    // Memory governance will redact any PII before the entry is persisted.
    try {
      await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, denyContent, tenantId ?? undefined);
    } catch { /* episodic capture is best-effort */ }
    return {
      assistantContent: denyContent,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cost: 0,
      latencyMs: Date.now() - startMs,
      redaction: redactionInfo,
      guardrail: { decision: 'deny', reason: preGuardrail.reason },
      cognitive: preGuardrail.cognitive as CognitiveCheckSummary,
    };
  }

  const identityRecall = await resolveIdentityRecallFromMemory(deps.db, userId, processedContent);
  if (identityRecall) {
    const latencyMs = Date.now() - startMs;
    const assistMsgId = newUUIDv7();
    await deps.db.addMessage({
      id: assistMsgId,
      chatId,
      role: 'assistant',
      content: identityRecall,
      metadata: JSON.stringify({
        model: 'memory-recall',
        provider: 'local',
        mode: settings.mode,
        memoryRecall: { deterministic: true, identity: true },
        traceId,
      }),
      tokensUsed: 0,
      cost: 0,
      latencyMs,
    });

    if (await isAnalyticsAllowed(deps.consentManager, userId)) {
      await deps.db.recordMetric({
        id: newUUIDv7(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
      });
    }

    return {
      assistantContent: identityRecall,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cost: 0,
      latencyMs,
      redaction: redactionInfo,
    };
  }

  const messages = historyToMessages(history);
  patchLatestUserMessage(messages, processedContent);

  const [memoryContext, proceduralInstructions, episodicContext, workingMemoryContext] = await Promise.all([
    buildMemoryContext(deps.db, ctx, model, userId, processedContent),
    loadProceduralInstructions(deps.db, userId),
    buildEpisodicContext(deps.db, userId, 6),
    buildWorkingMemoryContext(deps.db, userId),
  ]);
  const contextParts: string[] = [];
  if (skillPrompt) contextParts.push(skillPrompt);
  if (proceduralInstructions) contextParts.push(proceduralInstructions);
  if (workingMemoryContext) contextParts.push(workingMemoryContext);
  if (memoryContext) contextParts.push(memoryContext);
  if (episodicContext) contextParts.push(episodicContext);
  const augmentedPrompt = contextParts.length > 0 ? contextParts.join('\n\n---\n') : undefined;
  const memorySettings = {
    ...settings,
    enabledTools,
    systemPrompt: augmentedPrompt,
    skillPolicyKey,
    skillContributedTools: skillTools,
  };

  let assistantContent = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let steps: AgentStep[] | undefined;
  let toolCallEvents: ToolCallObservableEvent[] | undefined;
  let cacheHit = false;
  let semanticHit = false;
  let contractInfo: PromptContractValidationReport | undefined;
  let telemetry: AgentRunTelemetry | undefined;
  let promptCacheInfo: { readTokens: number; writeTokens: number; applied: boolean; ttl: '5m' | '1h' } | undefined;

  const allowResponseCache = attachments.length === 0;
  const cachePolicy = allowResponseCache ? await resolveActiveCache(deps.db, settings.mode) : null;
  // Phase 0: scope-isolated, salted-SHA-256 key. cacheScopeKey folds the tenant
  // id (cross-tenant isolation) and user id (no personalised answer is ever
  // served to a different user) into the key; the builder hashes the whole set
  // so the raw prompt never appears in the key (PII / log / collision safety).
  // Phase 5: VISIBLE scope prefix + hashed prompt so a per-user/tenant prefix can
  // be invalidated (GDPR erasure). The dynamic `_gv` version token (bumpable by an
  // admin) is folded into the hash, so bumping it invalidates every key at once.
  const scopePrefix = cacheScopeKeyString({
    tenantId,
    userId,
    scope: cachePolicy?.scope,
    tenantIsolation: cachePolicy?.tenantIsolation,
  });
  const cacheVersion = deps.loadCacheVersion ? await deps.loadCacheVersion() : 'v1';
  const cacheKey = (scopePrefix ? scopePrefix + '||' : '') + deps.cacheKeyBuilder.build({
    model: modelId,
    prompt: processedContent,
    _gv: cacheVersion,
  });
  // Phase 7 — resolve stampede config + effective negative-cache TTL once.
  const stampedeCfg = (cachePolicy && deps.loadStampedeConfig) ? await deps.loadStampedeConfig() : { enabled: false, negativeTtlMs: 0 };
  const swrMs = cachePolicy?.swrMs ?? 0;
  const negativeTtlMs = cachePolicy?.negativeTtlMs || stampedeCfg.negativeTtlMs || 0;
  let staleRefresh = false;
  let negativeHit = false;

  if (cachePolicy && !shouldBypass(cachePolicy, processedContent)) {
    // Phase 7 negative cache: if this exact request just failed, shield the
    // backend from a retry storm (gated by negative_ttl_ms; default off).
    if (negativeTtlMs > 0 && await readNegativeCache(deps.responseCache, cacheKey)) {
      negativeHit = true;
    } else {
      // Phase 7 SWR: serve fresh OR stale (within swr window); a stale hit also
      // triggers a single-flighted background refresh below.
      const swrRead = await readResponseWithSwr(deps.responseCache, cacheKey, { ttlMs: cachePolicy.ttlMs, swrMs });
      if (swrRead.value) {
        assistantContent = typeof swrRead.value.content === 'string' ? swrRead.value.content : '';
        usage = swrRead.value.usage ?? usage;
        cacheHit = true;
        staleRefresh = swrRead.state === 'stale';
      }
    }
  }

  // Phase 4: on an exact-match miss, try the scoped semantic cache (paraphrase
  // match). Time-sensitive prompts are bypassed; scope isolates tenants/users.
  // Phase 7 negative cache: an identical request that recently failed is
  // shielded — surface a graceful retry notice without re-calling the backend.
  if (negativeHit) {
    assistantContent = 'This request recently failed and is being rate-limited briefly to protect the service. Please try again shortly.';
    usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  const semanticCfg = (!cacheHit && !negativeHit && deps.semanticCache && deps.loadSemanticConfig)
    ? await deps.loadSemanticConfig()
    : null;
  if (!cacheHit && !negativeHit) {
    const semHit = await semanticLookup(deps.semanticCache, semanticCfg, processedContent, tenantId, userId);
    if (semHit) {
      assistantContent = semHit.content;
      usage = semHit.usage ?? usage;
      semanticHit = true;
    }
  }

  // Phase 7: the model/agent computation, extracted into a closure so it can be
  // (a) coalesced across concurrent identical requests via singleflight and
  // (b) reused for an SWR background refresh of a stale entry.
  type ProduceSide = {
    telemetry?: AgentRunTelemetry;
    steps?: AgentStep[];
    toolCallEvents?: ToolCallObservableEvent[];
    promptCacheInfo?: { readTokens: number; writeTokens: number; applied: boolean; ttl: '5m' | '1h' };
  };
  const produce = async (): Promise<{ content: string; usage: typeof usage; side: ProduceSide }> => {
    if (settings.mode === 'agent' || settings.mode === 'supervisor') {
      const tel = await deps.runAgent(ctx, model, userId, chatId, userPersona, messages, processedContent, memorySettings, attachments, tenantId);
      // H-4: Propagate the true prompt/completion split from AgentResult.usage.
      return {
        content: tel.result.output ?? '',
        usage: {
          promptTokens: tel.result.usage.promptTokens,
          completionTokens: tel.result.usage.completionTokens,
          totalTokens: tel.result.usage.totalTokens,
        },
        side: { telemetry: tel, steps: [...tel.result.steps], toolCallEvents: tel.toolCallEvents },
      };
    }
    // Phase 2: provider-native prompt caching — cache the stable prefix
    // (system prompt) so repeated turns pay the discounted cache-read rate.
    const planPricing = (await deps.loadPricing()).get(modelId);
    const cachePlan = planPromptCacheBreakpoints({
      systemText: augmentedPrompt ?? '',
      minTokens: planPricing?.promptCacheMinTokens ?? 1024,
      ttl: planPricing?.promptCacheTtl ?? '5m',
      enabled: planPricing?.promptCacheEnabled ?? true,
      providerSupported: provider === 'anthropic',
    });
    // Reasoning request (m92) — same gating as the streaming path.
    const baseMaxTokens = opts?.maxTokens ?? 4096;
    let reasoningMeta: ReasoningRequestMetadata | undefined;
    if (settings.reasoningEnabled) {
      const caps = await deps.db.listCapabilityScores({ provider, modelId }).catch(() => []);
      reasoningMeta = buildReasoningRequestMetadata({
        provider,
        supportsThinking: caps.some((c) => c.supports_thinking === 1),
        enabled: true,
        effort: settings.reasoningEffort ?? null,
        budgetTokens: settings.reasoningBudgetTokens ?? null,
        maxTokens: baseMaxTokens,
      });
    }
    const sendMetadata: Record<string, unknown> = {};
    if (provider === 'openai') sendMetadata['promptCacheKey'] = `gw:${tenantId ?? 'global'}:${chatId}`;
    if (reasoningMeta?.thinking) sendMetadata['thinking'] = reasoningMeta.thinking;
    if (reasoningMeta?.reasoningEffort) sendMetadata['reasoningEffort'] = reasoningMeta.reasoningEffort;

    const request: ModelRequest = {
      messages: augmentedPrompt
        ? [{ role: 'system' as const, content: augmentedPrompt }, ...messages]
        : messages,
      maxTokens: reasoningAdjustedMaxTokens(reasoningMeta, baseMaxTokens),
      temperature: reasoningAdjustedTemperature(reasoningMeta, opts?.temperature),
      ...(cachePlan.enabled ? { promptCache: { ttl: cachePlan.ttl } } : {}),
      ...(Object.keys(sendMetadata).length ? { metadata: sendMetadata } : {}),
    };
    // Phase 1: wrap in an OTel GenAI span so LLM calls are visible in any
    // OTLP-compatible backend (Grafana Cloud, Honeycomb, Jaeger).
    const { result: response } = await withLLMSpan(
      ctx,
      { provider, modelId, operation: 'chat', maxTokens: request.maxTokens, temperature: request.temperature },
      () => model.generate(ctx, request),
    );
    return {
      content: response.content ?? '',
      usage: { ...response.usage },
      side: {
        promptCacheInfo: {
          readTokens: response.usage.cacheReadTokens ?? 0,
          writeTokens: response.usage.cacheWriteTokens ?? 0,
          applied: cachePlan.enabled || provider === 'openai',
          ttl: cachePlan.ttl,
        },
      },
    };
  };

  if (!cacheHit && !semanticHit && !negativeHit) {
    // Phase 7 stampede protection: coalesce concurrent identical misses so only
    // ONE model call runs; followers replay the leader's result.
    const useSingleflight = !!(deps.singleflight && stampedeCfg.enabled && cachePolicy);
    let produced: { content: string; usage: typeof usage; side: ProduceSide };
    try {
      produced = useSingleflight
        ? (await deps.singleflight!.run(cacheKey, produce)).value
        : await produce();
    } catch (err) {
      // Phase 7 negative cache: remember the failure briefly to shield the backend.
      if (negativeTtlMs > 0) await writeNegativeCache(deps.responseCache, cacheKey, negativeTtlMs);
      throw err;
    }
    assistantContent = produced.content;
    usage = produced.usage;
    if (produced.side.telemetry) telemetry = produced.side.telemetry;
    if (produced.side.steps) steps = produced.side.steps;
    if (produced.side.toolCallEvents) toolCallEvents = produced.side.toolCallEvents;
    if (produced.side.promptCacheInfo) promptCacheInfo = produced.side.promptCacheInfo;
  }

  // Phase 7 SWR: a stale entry was served above — refresh it in the background
  // (single-flighted) so the next caller gets a fresh value without waiting.
  if (staleRefresh && cachePolicy && deps.singleflight) {
    const sf = deps.singleflight, ck = cacheKey, ttl = cachePolicy.ttlMs;
    void sf.run('swr-refresh::' + ck, produce)
      .then((r) => writeResponseWithSwr(deps.responseCache, ck, { content: r.value.content, usage: r.value.usage }, { ttlMs: ttl, swrMs }))
      .catch(() => { /* background refresh is best-effort */ });
  }

  // Phase 0 write gating:
  //  - determinism gate: only cache when the effective temperature is within
  //    the policy's temperatureGate (default 0 → deterministic responses only),
  //    so a high-temperature creative answer is not frozen and replayed;
  //  - output bypass: never cache a response that matches the policy's
  //    bypass / output-bypass patterns (e.g. a leaked secret in the answer);
  //  - never cache an execution-guard failure.
  const responseStoreOk =
    !cacheHit &&
    !negativeHit &&
    cachePolicy != null &&
    isCacheableTemperature(cachePolicy, opts?.temperature) &&
    !assistantContent.includes('[Execution guard failure]') &&
    !shouldBypassResponse(cachePolicy, assistantContent);
  if (responseStoreOk) {
    // Phase 7: SWR-aware write (sidecar timestamp + extended TTL when swr_ms>0).
    await writeResponseWithSwr(deps.responseCache, cacheKey, { content: assistantContent, usage }, { ttlMs: cachePolicy!.ttlMs, swrMs });
  }
  // Phase 4: also persist to the semantic cache on a genuine LLM miss (not a
  // semantic replay), under the same determinism/secret gating so a paraphrase
  // can hit next time. Best-effort.
  if (responseStoreOk && !semanticHit) {
    await semanticStore(deps.semanticCache, semanticCfg, processedContent, { content: assistantContent, usage }, tenantId, userId);
  }

  contractInfo = await validatePromptContractsAgainstDb(assistantContent, deps.db);

  const latencyMs = Date.now() - startMs;
  const dbPricing = await deps.loadPricing();
  const cost = calculateCost(modelId, usage.promptTokens, usage.completionTokens, dbPricing.get(modelId));

  deps.recordModelOutcome(modelId, provider, latencyMs, true);

  // Phase 3: record this turn's cache effectiveness (response hit/miss + prompt-
  // cache token savings) into the live metrics sink and the durable rollup.
  deps.recordCacheMetrics?.({
    // A semantic hit also avoids the LLM call — count it as a cache hit.
    responseHit: cacheHit || semanticHit,
    responseEligible: !!cachePolicy || semanticHit,
    promptCacheReadTokens: promptCacheInfo?.readTokens ?? 0,
    promptCacheWriteTokens: promptCacheInfo?.writeTokens ?? 0,
    provider,
    inputCostPer1M: dbPricing.get(modelId)?.input ?? 0,
  });

  // Phase 3: record observed cost into the runtime ledger for future budget checks.
  if (deps.config.runtime?.cost && cost > 0) {
    deps.config.runtime.cost.record({
      userId, tenantId,
      model: modelId, provider,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      costUsd: cost,
    }).catch(() => {});
  }

  const policyChecks = steps ? await evaluateTaskPolicies(deps.db, steps) : undefined;

  if (!assistantContent.trim()) {
    const hadExecutionActivity = Boolean(steps?.length);
    assistantContent = hadExecutionActivity
      ? 'I completed execution steps but could not produce a final response text. Please retry this request; if this repeats, check the trace for this run.'
      : 'I could not produce a response text for this request. Please retry.';
  }

  // M-18: extracted to chat-message-utils.extractToolEvidence — shared with stream path
  const toolEvidence = extractToolEvidence(steps);
  const postGuardrail = await evaluateGuardrails(deps.db, chatId, null, assistantContent, 'post-execution',
    { userInput: processedContent, assistantOutput: assistantContent, toolEvidence },
    {
      persona: userPersona,
      chatMode: settings.mode,
      turnNumber,
      tenantId,
      steps: steps ?? [],
      priorGuardrailResults: preGuardrail.results,
    },
  );
  const guardrailInfo = preGuardrail.decision !== 'allow'
    ? { decision: preGuardrail.decision as 'allow' | 'deny' | 'warn', reason: preGuardrail.reason }
    : postGuardrail.decision !== 'allow'
    ? { decision: postGuardrail.decision as 'allow' | 'deny' | 'warn', reason: postGuardrail.reason }
    : undefined;

  const overallGuardrailDecision = guardrailInfo?.decision ?? 'allow';
  let evalInfo: { passed: number; failed: number; total: number; score: number } | undefined;
  let evalError: string | undefined;
  const evalResult = await runPostEval(deps.db, ctx, userId, chatId, processedContent, assistantContent, latencyMs, cost, overallGuardrailDecision);
  if ('error' in evalResult) {
    evalError = evalResult.error;
  } else {
    evalInfo = evalResult;
  }

  const assistMsgId = newUUIDv7();
  await deps.db.addMessage({
    id: assistMsgId,
    chatId,
    role: 'assistant',
    content: assistantContent,
    metadata: JSON.stringify({
      model: modelId, provider,
      mode: settings.mode,
      agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
      systemPromptSha256: telemetry?.systemPromptSha256,
      enabledTools: memorySettings.enabledTools.length ? memorySettings.enabledTools : undefined,
      activeSkills: activeSkills.length ? activeSkills : undefined,
      skillTools: skillTools.length ? skillTools : undefined,
      skillPromptApplied: activeSkills.length > 0 ? true : undefined,
      redactionEnabled: settings.redactionEnabled || undefined,
      steps: steps ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
      eval: evalInfo,
      evalError,
      guardrail: guardrailInfo,
      guardrailError: preGuardrail.error ?? postGuardrail.error,
      cognitive: postGuardrail.cognitive,
      policyChecks: policyChecks?.length ? policyChecks : undefined,
      promptContracts: contractInfo,
      promptStrategy: resolvedSystemPrompt.strategy,
      promptResolution: resolvedSystemPrompt.resolution,
      traceId,
    }),
    tokensUsed: usage.totalTokens,
    cost,
    latencyMs,
  });

  try {
    await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, assistantContent, tenantId ?? undefined);
    triggerConsolidationForUser(userId, chatId);
  } catch (memErr) {
    // L-16: Log memory save / consolidation failures so operators can detect
    // memory backend outages without impacting the chat success path.
    logger.warn('memory save / consolidation failed', { err: memErr instanceof Error ? memErr.message : String(memErr) });
  }

  if (await isAnalyticsAllowed(deps.consentManager, userId)) {
    await deps.db.recordMetric({
      id: newUUIDv7(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens, cost, latencyMs,
    });
  }

  await recordTraceSpans(
    deps.db,
    userId,
    chatId,
    assistMsgId,
    traceId,
    settings.mode,
    startMs,
    latencyMs,
    steps,
    toolCallEvents,
    buildCapabilityTelemetrySnapshots(
      settings.mode,
      resolvedSystemPrompt.telemetry,
      activeSkills,
      memorySettings.enabledTools,
    ),
    telemetry?.systemPromptSha256,
  );

  return {
    assistantContent,
    usage,
    cost,
    latencyMs,
    cached: cacheHit || semanticHit,
    semantic: semanticHit,
    promptCache: promptCacheInfo,
    redaction: redactionInfo,
    eval: evalInfo,
    steps,
    traceId,
    guardrail: guardrailInfo,
    cognitive: postGuardrail.cognitive as CognitiveCheckSummary,
    policyChecks,
    routingDecision: routingInfo,
    activeSkills,
    skillTools,
    enabledTools: memorySettings.enabledTools,
    skillPromptApplied: activeSkills.length > 0,
    contracts: contractInfo,
    promptStrategy: resolvedSystemPrompt.strategy,
    promptResolution: resolvedSystemPrompt.resolution,
  };
}

// H-15: historyToMessages moved to chat-message-utils.ts — imported above
