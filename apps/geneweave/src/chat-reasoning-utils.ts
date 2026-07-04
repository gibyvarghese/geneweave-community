/**
 * Reasoning request mapping.
 *
 * Translates a chat's reasoning settings (DB: `chat_settings.reasoning_*`) into
 * the provider-specific request metadata the provider packages already consume:
 *   - Anthropic → `metadata.thinking = { type:'enabled', budget_tokens }`
 *     (packages/provider-anthropic/src/anthropic.ts) → streams `reasoning` chunks.
 *   - OpenAI    → `metadata.reasoningEffort = 'low'|'medium'|'high'`
 *     (packages/provider-openai/src/openai.ts, cost-governor lever L7).
 *
 * Gated on model capability (`supports_thinking`) so reasoning is never
 * requested from a model that does not support it (which would error).
 *
 * Pure + provider-agnostic; the providers own the wire format, this maps config
 * onto it.
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ReasoningRequestMetadata {
  /** Anthropic extended-thinking request. */
  thinking?: { type: 'enabled'; budget_tokens: number };
  /** OpenAI reasoning-effort hint. */
  reasoningEffort?: ReasoningEffort;
}

export interface BuildReasoningMetadataInput {
  provider: string;
  /** From `model_capability_scores.supports_thinking` for the chat's model. */
  supportsThinking: boolean;
  /** `chat_settings.reasoning_enabled`. */
  enabled: boolean;
  /** `chat_settings.reasoning_effort`. */
  effort?: string | null;
  /** `chat_settings.reasoning_budget_tokens` (0/undefined → derive from effort). */
  budgetTokens?: number | null;
  /** Request maxTokens, so the Anthropic budget always leaves room for output. */
  maxTokens?: number;
}

const MIN_THINKING_BUDGET = 1024;

function normalizeEffort(effort: string | null | undefined): ReasoningEffort {
  return effort === 'low' || effort === 'high' ? effort : 'medium';
}

function effortToBudget(effort: ReasoningEffort): number {
  return effort === 'low' ? 1024 : effort === 'high' ? 8192 : 4096;
}

/**
 * Map reasoning settings → provider request metadata, or `undefined` when
 * reasoning should not be requested (disabled, unsupported model, or an unknown
 * provider). For Anthropic the thinking budget is clamped to ≥1024 and to leave
 * at least 512 output tokens under `maxTokens`.
 */
export function buildReasoningRequestMetadata(input: BuildReasoningMetadataInput): ReasoningRequestMetadata | undefined {
  if (!input.enabled || !input.supportsThinking) return undefined;
  const effort = normalizeEffort(input.effort);

  if (input.provider === 'anthropic') {
    const maxTokens = input.maxTokens && input.maxTokens > 0 ? input.maxTokens : 4096;
    const requested = input.budgetTokens && input.budgetTokens > 0 ? Math.trunc(input.budgetTokens) : effortToBudget(effort);
    const ceiling = Math.max(MIN_THINKING_BUDGET, maxTokens - 512);
    const budget = Math.min(Math.max(MIN_THINKING_BUDGET, requested), ceiling);
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }

  if (input.provider === 'openai') {
    return { reasoningEffort: effort };
  }

  // Other providers: reasoning not supported via this mapping.
  return undefined;
}

/**
 * When Anthropic extended thinking is active the request must NOT pin a
 * non-default temperature (the API rejects `temperature` with thinking). This
 * returns the temperature to send (undefined when thinking is active).
 */
export function reasoningAdjustedTemperature(meta: ReasoningRequestMetadata | undefined, temperature: number | undefined): number | undefined {
  return meta?.thinking ? undefined : temperature;
}

/**
 * Ensure the request leaves room for output above the thinking budget. Returns
 * the maxTokens to send (bumped when a large budget would starve the answer).
 */
export function reasoningAdjustedMaxTokens(meta: ReasoningRequestMetadata | undefined, maxTokens: number): number {
  if (!meta?.thinking) return maxTokens;
  return Math.max(maxTokens, meta.thinking.budget_tokens + 1024);
}
