import { createLogger } from '@weaveintel/core';
import type { Model, WeaveRuntime } from '@weaveintel/core';

const logger = createLogger('chat-runtime');
import type { ChatSettingsRow } from './db.js';
import { normalizePersona } from './rbac.js';
import { getDefaultToolsByMode } from './chat-policies.js';

export interface ChatAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64?: string;
  transcript?: string;
}

interface ModelPricing {
  input: number;
  output: number;
}

export const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':            { input: 15.00, output: 75.00 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'o3': { input: 2.00, output: 8.00 },
  'o4-mini': { input: 1.10, output: 4.40 },
};

export function calculateCost(modelId: string, promptTokens: number, completionTokens: number, pricingOverride?: ModelPricing): number {
  const pricing = pricingOverride ?? FALLBACK_PRICING[modelId];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

export interface ProviderConfig {
  /** API key for cloud providers. Optional for local providers (ollama, llamacpp). */
  apiKey?: string;
  /** Base URL override (used by ollama, llamacpp, and any provider that supports it). */
  baseUrl?: string;
  mockResponses?: string[];
  latencyMs?: number;
}

export interface ChatEngineConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
  /**
   * Phase D — the host's `weaveRuntime` instance, propagated into
   * `ToolRegistryOptions.runtime` so tool registration asserts each
   * tool's declared `requires:[...]` against the runtime's advertised
   * capabilities. Optional for back-compat.
   */
  runtime?: WeaveRuntime;
  /**
   * Phase 1 — cache key version segment, sourced from the `cache_settings`
   * global_version_token. Bumping it invalidates every response-cache entry at
   * once. Falls back to `'v1'` when unset.
   */
  cacheKeyVersion?: string;
  /**
   * Cache Phase 6 — tool-result caching wiring. `store` is the shared cache
   * store (same underlying store as the response cache, so a global clear /
   * version bump busts tool entries too); `metrics` is a DEDICATED sink kept
   * separate from the response-cache counters; `version` is the key prefix.
   * When set, the engine enables opt-in per-tool result caching driven by
   * `tool_cache_policies`.
   */
  toolCache?: {
    store: import('@weaveintel/core').CacheStore;
    metrics: import('@weaveintel/core').CacheMetrics;
    version?: string;
  };
}

// ── M-15: Typed provider module interfaces ───────────────────────────────────
//
// Each provider package exposes a single factory function. Previously these
// were called via `(mod as any).weaveXxxModel(...)` which silently breaks when
// a provider is renamed. Defining a minimal interface per module means a
// rename produces a TypeScript error at build time rather than a runtime crash.

interface AnthropicProviderModule {
  weaveAnthropicModel(modelId: string, opts: { apiKey?: string }): Model;
}
interface OpenAIProviderModule {
  weaveOpenAIModel(modelId: string, opts: { apiKey?: string }): Model;
}
interface GoogleProviderModule {
  weaveGoogleModel(modelId: string, opts: { apiKey?: string }): Model;
}
interface OllamaProviderModule {
  weaveOllamaModel(modelId: string, opts: { apiKey?: string; baseUrl?: string }): Model;
}
interface LlamaCppProviderModule {
  weaveLlamaCppModel(modelId: string, opts: { apiKey?: string; baseUrl?: string }): Model;
}
interface DevtoolsProviderModule {
  createMockModel(opts: { name: string; responses?: string[]; latencyMs?: number }): Model;
}

const modelCache = new Map<string, Model>();

export async function getOrCreateModel(
  provider: string,
  modelId: string,
  providerConfig: ProviderConfig,
): Promise<Model> {
  const bareModel = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  const cacheKey = `${provider}:${bareModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  let model: Model;
  switch (provider) {
    case 'anthropic': {
      const mod = await import('@weaveintel/provider-anthropic') as AnthropicProviderModule;
      model = mod.weaveAnthropicModel(bareModel, { apiKey: providerConfig.apiKey });
      break;
    }
    case 'openai': {
      const mod = await import('@weaveintel/provider-openai') as OpenAIProviderModule;
      model = mod.weaveOpenAIModel(bareModel, { apiKey: providerConfig.apiKey });
      break;
    }
    case 'google':
    case 'gemini': {
      const mod = await import('@weaveintel/provider-google') as GoogleProviderModule;
      model = mod.weaveGoogleModel(bareModel, { apiKey: providerConfig.apiKey });
      break;
    }
    case 'ollama': {
      const mod = await import('@weaveintel/provider-ollama') as OllamaProviderModule;
      model = mod.weaveOllamaModel(bareModel, {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
      });
      break;
    }
    case 'llamacpp':
    case 'llama-cpp': {
      const mod = await import('@weaveintel/provider-llamacpp') as LlamaCppProviderModule;
      model = mod.weaveLlamaCppModel(bareModel, {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
      });
      break;
    }
    case 'mock': {
      const mod = await import('@weaveintel/devtools') as DevtoolsProviderModule;
      model = mod.createMockModel({
        name: bareModel || 'mock-model',
        responses: providerConfig.mockResponses,
        latencyMs: providerConfig.latencyMs ?? 25,
      });
      break;
    }
    default:
      throw new Error(`Unsupported provider "${provider}". Install @weaveintel/provider-${provider}`);
  }

  modelCache.set(cacheKey, model);
  return model;
}

export interface ChatSettings {
  mode: 'direct' | 'agent' | 'supervisor' | 'ensemble';
  systemPrompt?: string;
  timezone?: string;
  enabledTools: string[];
  redactionEnabled: boolean;
  redactionPatterns: string[];
  workers: WorkerDef[];
  /** Phase 6: tool policy key from the top-matched active skill; overrides global tool policy */
  skillPolicyKey?: string;
  /**
   * Tools that the currently active skill(s) contribute. When non-empty, the
   * supervisor's default extra-tool set is filtered to exclude these tools so
   * the supervisor cannot short-circuit around the skill's intended worker
   * delegation. Purely data-driven from the `skills.tool_names` column.
   */
  skillContributedTools?: string[];
  // W1 — Reflection
  reflectEnabled?: boolean;
  reflectMaxRevisions?: number;
  reflectCriteria?: string;
  // W2 — Verify/regenerate
  verifyEnabled?: boolean;
  verifyMinScore?: number;
  verifyMaxAttempts?: number;
  // W3 — Supervisor options
  supervisorReplanOnFailure?: boolean;
  supervisorParallelDelegation?: boolean;
  // W5 — Ensemble mode
  ensembleAgents?: Array<{ name: string; model?: string; systemPrompt?: string }>;
  ensembleResolver?: 'vote' | 'judge' | 'arbiter';
  // P2-1 — Parallel tool execution
  parallelToolCalls?: boolean;
  // P2-3 — Context window management
  contextStrategy?: 'trim_oldest' | 'sliding_window' | 'summarize';
  contextMaxTokens?: number;
  contextWindowSize?: number;
  // P2-4 — Tool retry
  toolRetryMaxAttempts?: number;
  toolRetryBackoffMs?: number;
  toolRetryMaxBackoffMs?: number;
  // P3-1 — HITL interrupt
  hitlEnabled?: boolean;
  hitlRequireAll?: boolean;
  hitlTimeoutMs?: number;
  // P3-2 — Agent handoff
  handoffsEnabled?: boolean;
  // P4-3 — Knowledge graph memory
  graphEnabled?: boolean;
  graphMaxNodes?: number;
  graphPersistEnabled?: boolean;
  // P4-2 — Proactive memory context injection
  memoryContextEnabled?: boolean;
  memoryContextMaxChars?: number;
  // P5-1 — Agent checkpoint / resume
  checkpointEnabled?: boolean;
  checkpointIntervalSteps?: number;
  // P5-2 — Dynamic worker registry
  dynamicWorkersEnabled?: boolean;
  maxDynamicWorkers?: number;
  // P6-1 — Multi-tier eval pipeline
  evalPipelineEnabled?: boolean;
  evalPipelineStages?: string;
  evalPipelineFailFast?: boolean;
  // P6-3 — Cost governor
  costGovernorEnabled?: boolean;
  costGovernorPolicy?: string;
  // P6-4 — Compliance-aware tool execution
  complianceEnabled?: boolean;
  complianceSubjectIdField?: string;
  complianceEnforceConsent?: boolean;
  // P6-5 — Vision loop browser agent
  visionLoopEnabled?: boolean;
  // Reasoning request (m92) — request provider reasoning for reasoning-capable models.
  reasoningEnabled?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  reasoningBudgetTokens?: number;
}

export interface WorkerDef {
  name: string;
  description: string;
  tools: string[];
  persona?: string;
}

const DEFAULT_SETTINGS: ChatSettings = {
  mode: 'direct',
  enabledTools: getDefaultToolsByMode('direct'),
  redactionEnabled: true,
  redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
  workers: [],
};

export function settingsFromRow(row: ChatSettingsRow | null): ChatSettings {
  if (!row) return { ...DEFAULT_SETTINGS };

  // M-12: All JSON.parse calls on admin-configurable TEXT columns are wrapped
  // in try/catch so a single corrupt cell cannot crash an entire chat turn.
  // Each field falls back to its safe default on parse failure and logs a
  // warning so operators can identify and repair the corrupt row.
  function safeJsonParse<T>(raw: string | null | undefined, fallback: T, fieldName: string): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      logger.warn(`Failed to parse chat_settings.${fieldName} — using default`, { raw: raw.slice(0, 80) });
      return fallback;
    }
  }

  const mode = (row.mode as ChatSettings['mode']) || 'direct';
  // Empty array [] means "use mode defaults" — this handles chats auto-saved by the
  // UI before the user configures tools (createChat sends enabledTools:[] initially).
  const rawTools = safeJsonParse<string[]>(row.enabled_tools, [], 'enabled_tools');
  const enabledTools = rawTools.length > 0 ? rawTools : getDefaultToolsByMode(mode);

  return {
    mode,
    systemPrompt: row.system_prompt ?? undefined,
    timezone: row.timezone ?? undefined,
    enabledTools,
    redactionEnabled: !!row.redaction_enabled,
    redactionPatterns: safeJsonParse<string[]>(row.redaction_patterns, DEFAULT_SETTINGS.redactionPatterns, 'redaction_patterns'),
    workers: safeJsonParse<WorkerDef[]>(row.workers, [], 'workers').map((worker) => ({
      ...worker,
      tools: worker.tools ?? [],
      persona: normalizePersona(worker.persona, 'agent'),
    })),
    // W1 — Reflection
    reflectEnabled: row.reflect_enabled ? !!row.reflect_enabled : undefined,
    reflectMaxRevisions: row.reflect_max_revisions || undefined,
    reflectCriteria: row.reflect_criteria ?? undefined,
    // W2 — Verify/regenerate
    verifyEnabled: row.verify_enabled ? !!row.verify_enabled : undefined,
    verifyMinScore: row.verify_min_score || undefined,
    verifyMaxAttempts: row.verify_max_attempts || undefined,
    // W3 — Supervisor
    supervisorReplanOnFailure: row.supervisor_replan_on_failure ? !!row.supervisor_replan_on_failure : undefined,
    supervisorParallelDelegation: row.supervisor_parallel_delegation ? !!row.supervisor_parallel_delegation : undefined,
    // W5 — Ensemble
    ensembleAgents: safeJsonParse<ChatSettings['ensembleAgents']>(row.ensemble_agents, undefined, 'ensemble_agents'),
    ensembleResolver: (row.ensemble_resolver as ChatSettings['ensembleResolver']) ?? undefined,
    // P2-1 — Parallel tool execution (default true: 0=false, 1=true, NULL=true)
    parallelToolCalls: row.parallel_tool_calls !== 0,
    // P2-3 — Context management
    contextStrategy: (row.context_strategy as ChatSettings['contextStrategy']) ?? undefined,
    contextMaxTokens: row.context_max_tokens ?? undefined,
    contextWindowSize: row.context_window_size || 20,
    // P2-4 — Tool retry (0 = disabled)
    toolRetryMaxAttempts: row.tool_retry_max_attempts || undefined,
    toolRetryBackoffMs: row.tool_retry_backoff_ms || 200,
    toolRetryMaxBackoffMs: row.tool_retry_max_backoff_ms || 10_000,
    // P3-1 — HITL interrupt (default: disabled)
    hitlEnabled: row.hitl_enabled !== 0,
    hitlRequireAll: row.hitl_require_all !== 0,
    hitlTimeoutMs: row.hitl_timeout_ms || 300_000,
    // P3-2 — Agent handoff (default: disabled)
    handoffsEnabled: row.handoffs_enabled !== 0,
    // P4-3 — Knowledge graph memory (default: disabled)
    graphEnabled: row.graph_enabled !== 0,
    graphMaxNodes: row.graph_max_nodes || 500,
    graphPersistEnabled: row.graph_persist_enabled !== 0,
    // P4-2 — Proactive memory context injection (default: disabled)
    memoryContextEnabled: row.memory_context_enabled !== 0,
    memoryContextMaxChars: row.memory_context_max_chars || 4000,
    // P5-1 — Agent checkpoint / resume (default: disabled)
    checkpointEnabled: row.checkpoint_enabled !== 0,
    checkpointIntervalSteps: row.checkpoint_interval_steps || 1,
    // P5-2 — Dynamic worker registry (default: disabled)
    dynamicWorkersEnabled: row.dynamic_workers_enabled !== 0,
    maxDynamicWorkers: row.max_dynamic_workers || 20,
    // P6-1 — Multi-tier eval pipeline (default: disabled)
    evalPipelineEnabled: row.eval_pipeline_enabled !== 0,
    evalPipelineStages: row.eval_pipeline_stages ?? undefined,
    evalPipelineFailFast: row.eval_pipeline_fail_fast !== 0,
    // P6-3 — Cost governor (default: disabled)
    costGovernorEnabled: row.cost_governor_enabled !== 0,
    costGovernorPolicy: row.cost_governor_policy ?? undefined,
    // P6-4 — Compliance (default: disabled)
    complianceEnabled: row.compliance_enabled !== 0,
    complianceSubjectIdField: row.compliance_subject_id_field ?? undefined,
    complianceEnforceConsent: row.compliance_enforce_consent !== 0,
    // P6-5 — Vision loop (default: disabled)
    visionLoopEnabled: row.vision_loop_enabled !== 0,
    // Reasoning request (m92) — default: disabled.
    reasoningEnabled: !!row.reasoning_enabled,
    reasoningEffort: (row.reasoning_effort === 'low' || row.reasoning_effort === 'medium' || row.reasoning_effort === 'high') ? row.reasoning_effort : undefined,
    reasoningBudgetTokens: row.reasoning_budget_tokens || undefined,
  };
}
