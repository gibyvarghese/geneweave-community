/**
 * GeneWeave — guardrail-judge.ts
 *
 * Model and agent resolution for guardrail evaluation.
 *
 * Two modes:
 *
 * 1. Direct model call (pre-execution / injection classifier)
 *    registry.getJudgeModel() → Model
 *    Used directly in the llm-judge evaluator. Zero overhead, synchronous.
 *    Right choice for blocking pre-execution checks where the user is waiting.
 *
 * 2. weaveAgent wrapper (post-execution checks)
 *    registry.getJudgeAgent() → Agent
 *    Wraps the same model in a single-step agent for audit trail + observability.
 *    Each post-execution check gets its own agent identity and span.
 *    maxSteps:1 means it's identical latency to a direct call but goes through
 *    the agent loop (weaveAudit, span attribution, structured output enforcement).
 *
 * Model selection priority:
 *   1. GUARDRAIL_JUDGE_PROVIDER / GUARDRAIL_JUDGE_MODEL env vars
 *   2. Cheapest fast model from the configured providers
 *      (claude-haiku-4-5 > gpt-4o-mini > gemini-flash > the default model)
 *   3. Falls back to the app's defaultProvider / defaultModel
 *
 * A-4: Module-level mutable singletons have been replaced by a
 * `GuardrailJudgeRegistry` class, instanced per ChatEngine, which eliminates
 * cross-test contamination and enables multiple ChatEngine instances to coexist
 * in the same process with independent judge models.
 *
 * Backward-compatible module-level functions delegate to a default registry
 * instance (`defaultRegistry`) so existing callers are unaffected.
 */
import type { Agent, EmbeddingModel, Model, ModerationModel } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { getOrCreateModel, type ProviderConfig } from './chat-runtime.js';

// ── Model priority list ────────────────────────────────────────────────────

/** Preferred judge models per provider — cheapest fast model first.
 *  OpenAI is tried before Anthropic so a depleted Anthropic account does not
 *  block guardrail evaluation when OpenAI is also configured. */
const JUDGE_MODEL_PREFERENCE: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.0-flash',
  gemini: 'gemini-2.0-flash',
};

export interface GuardrailJudgeConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
}

/**
 * Resolve the judge model from env vars or the cheapest configured provider.
 * Returns `undefined` if no provider is configured (model-graded checks skip).
 */
export async function getGuardrailJudgeModel(
  config: GuardrailJudgeConfig,
): Promise<Model | undefined> {
  const envProvider = process.env['GUARDRAIL_JUDGE_PROVIDER'];
  const envModel = process.env['GUARDRAIL_JUDGE_MODEL'];

  if (envProvider && envModel) {
    const providerCfg = config.providers[envProvider];
    if (providerCfg) {
      try {
        return await getOrCreateModel(envProvider, envModel, providerCfg);
      } catch {
        // fall through to preference order
      }
    }
  }

  for (const [provider, preferredModel] of Object.entries(JUDGE_MODEL_PREFERENCE)) {
    const providerCfg = config.providers[provider];
    if (!providerCfg?.apiKey?.trim()) continue;
    const modelId = envModel ?? preferredModel;
    try {
      return await getOrCreateModel(provider, modelId, providerCfg);
    } catch {
      continue;
    }
  }

  const defaultCfg = config.providers[config.defaultProvider];
  if (defaultCfg) {
    try {
      return await getOrCreateModel(config.defaultProvider, config.defaultModel, defaultCfg);
    } catch {
      // no model available
    }
  }

  return undefined;
}

// ── GuardrailJudgeRegistry ─────────────────────────────────────────────────
//
// A-4: Encapsulates the four previously module-level mutable singletons
// (_judgeAgent, _activeJudgeModel, _activeModerationModel, _activeEmbeddingModel)
// into an instance so multiple ChatEngine instances can coexist in the same
// process without cross-contaminating each other's guardrail state.
// Tests can create a fresh registry per suite rather than resetting globals.

const AGENT_SYSTEM_PROMPT = `You are a guardrail evaluation agent. You receive a piece of text and must evaluate it according to the rubric provided.

Always respond with a single JSON object containing exactly these fields:
- "decision": one of "allow", "warn", or "deny"
- "confidence": a number between 0 and 1
- "rationale": one concise sentence explaining your reasoning

Respond ONLY with the JSON object. No markdown, no explanation outside the JSON.`;

export class GuardrailJudgeRegistry {
  private _judgeAgent: Agent | undefined;
  private _judgeModel: Model | undefined;
  private _moderationModel: ModerationModel | undefined;
  private _embeddingModel: EmbeddingModel | undefined;

  // ── Judge model ─────────────────────────────────────────────

  setJudgeModel(model: Model | undefined): void {
    this._judgeModel = model;
    this._judgeAgent = undefined; // rebuild agent on next access
  }

  getJudgeModel(): Model | undefined {
    return this._judgeModel;
  }

  /** Returns a cached single-step weaveAgent for post-execution guardrail checks. */
  getJudgeAgent(): Agent | undefined {
    if (!this._judgeModel) return undefined;
    if (!this._judgeAgent) {
      this._judgeAgent = weaveAgent({
        name: 'guardrail-judge',
        model: this._judgeModel,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        maxSteps: 1,
      });
    }
    return this._judgeAgent;
  }

  // ── Moderation model ────────────────────────────────────────

  setModerationModel(model: ModerationModel | undefined): void {
    this._moderationModel = model;
  }

  getModerationModel(): ModerationModel | undefined {
    return this._moderationModel;
  }

  // ── Embedding model ─────────────────────────────────────────

  setEmbeddingModel(model: EmbeddingModel | undefined): void {
    this._embeddingModel = model;
  }

  getEmbeddingModel(): EmbeddingModel | undefined {
    return this._embeddingModel;
  }
}

// ── Default registry (process-wide singleton) ─────────────────────────────
// Kept for backward compatibility. All module-level functions below delegate
// to this instance so existing call sites in guardrail-eval-utils, chat.ts,
// and the guardrails slot continue to work without threading a registry
// reference through every caller.

const defaultRegistry = new GuardrailJudgeRegistry();

// ── Single-step weaveAgent wrapper ─────────────────────────────────────────

/**
 * Returns a cached single-step weaveAgent used for post-execution guardrail checks.
 * Delegates to `defaultRegistry`.
 * @deprecated Prefer using a `GuardrailJudgeRegistry` instance directly (A-4).
 */
export function createGuardrailJudgeAgent(model: Model): Agent {
  defaultRegistry.setJudgeModel(model);
  return defaultRegistry.getJudgeAgent()!;
}

/** Reset cached agent (call when model changes at runtime). */
export function resetGuardrailJudgeAgent(): void {
  defaultRegistry.setJudgeModel(defaultRegistry.getJudgeModel());
}

// ── Active judge model (module-level compat layer) ─────────────────────────

export function setActiveGuardrailJudgeModel(model: Model | undefined): void {
  defaultRegistry.setJudgeModel(model);
}

export function getActiveGuardrailJudgeModel(): Model | undefined {
  return defaultRegistry.getJudgeModel();
}

// ── Moderation model (R2 compat layer) ──────────────────────────────────────

export async function getGuardrailModerationModel(
  providers: Record<string, ProviderConfig>,
): Promise<ModerationModel | undefined> {
  const apiKey = process.env['GUARDRAIL_MODERATION_API_KEY']
    ?? providers['openai']?.apiKey;
  // M-26: use non-empty check instead of brittle 'sk-' prefix check
  if (!apiKey?.trim().length) return undefined;
  try {
    const mod = await import('@weaveintel/provider-openai');
    const fn = (mod as unknown as Record<string, unknown>)['weaveOpenAIModerationModel']
      ?? (mod as unknown as Record<string, unknown>)['weaveOpenAIModeration'];
    if (typeof fn !== 'function') return undefined;
    return fn('omni-moderation-latest', { apiKey }) as ModerationModel;
  } catch {
    return undefined;
  }
}

export function setActiveGuardrailModerationModel(m: ModerationModel | undefined): void {
  defaultRegistry.setModerationModel(m);
}

export function getActiveGuardrailModerationModel(): ModerationModel | undefined {
  return defaultRegistry.getModerationModel();
}

// ── Embedding model (R3 compat layer) ──────────────────────────────────────

// L-22: DEFAULT_EMBEDDING_MODEL promoted to a named export constant so callers
// can reference it without hardcoding the string.
export const DEFAULT_GUARDRAIL_EMBEDDING_MODEL = 'text-embedding-3-small';

export async function getGuardrailEmbeddingModel(
  providers: Record<string, ProviderConfig>,
): Promise<EmbeddingModel | undefined> {
  const envProvider = process.env['GUARDRAIL_EMBEDDING_PROVIDER'];
  const envModel = process.env['GUARDRAIL_EMBEDDING_MODEL'] ?? DEFAULT_GUARDRAIL_EMBEDDING_MODEL;
  const apiKey = process.env['GUARDRAIL_EMBEDDING_API_KEY']
    ?? providers[envProvider ?? 'openai']?.apiKey
    ?? providers['openai']?.apiKey;
  // M-26: non-empty check
  if (!apiKey?.trim().length) return undefined;
  try {
    const mod = await import('@weaveintel/provider-openai');
    const fn = (mod as unknown as Record<string, unknown>)['weaveOpenAIEmbeddingModel']
      ?? (mod as unknown as Record<string, unknown>)['weaveOpenAIEmbedding'];
    if (typeof fn !== 'function') return undefined;
    return fn(envModel, { apiKey }) as EmbeddingModel;
  } catch {
    return undefined;
  }
}

export function setActiveGuardrailEmbeddingModel(m: EmbeddingModel | undefined): void {
  defaultRegistry.setEmbeddingModel(m);
}

export function getActiveGuardrailEmbeddingModel(): EmbeddingModel | undefined {
  return defaultRegistry.getEmbeddingModel();
}
