/**
 * Reasoning request mapping — buildReasoningRequestMetadata + adjusters.
 *
 * Positive, negative, stress, security/robustness.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReasoningRequestMetadata,
  reasoningAdjustedTemperature,
  reasoningAdjustedMaxTokens,
} from './chat-reasoning-utils.js';
import { resolveReasoning } from './me-run-agent.js';

describe('buildReasoningRequestMetadata — Anthropic (positive)', () => {
  it('maps enabled+capable+anthropic to a thinking budget', () => {
    const m = buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true, effort: 'medium', maxTokens: 8000 });
    expect(m?.thinking?.type).toBe('enabled');
    expect(m?.thinking?.budget_tokens).toBe(4096); // medium default
    expect(m?.reasoningEffort).toBeUndefined();
  });

  it('derives budget from effort (low=1024, high clamps under maxTokens)', () => {
    expect(buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true, effort: 'low', maxTokens: 8000 })?.thinking?.budget_tokens).toBe(1024);
    // high=8192 but maxTokens 4096 → ceiling 3584
    expect(buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true, effort: 'high', maxTokens: 4096 })?.thinking?.budget_tokens).toBe(3584);
  });

  it('honours an explicit budget, clamped to [1024, maxTokens-512]', () => {
    expect(buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true, budgetTokens: 2000, maxTokens: 16000 })?.thinking?.budget_tokens).toBe(2000);
    expect(buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true, budgetTokens: 100, maxTokens: 16000 })?.thinking?.budget_tokens).toBe(1024); // floor
    expect(buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true, budgetTokens: 999999, maxTokens: 4096 })?.thinking?.budget_tokens).toBe(3584); // ceiling
  });
});

describe('buildReasoningRequestMetadata — OpenAI (positive)', () => {
  it('maps to a reasoning effort hint (no thinking budget)', () => {
    const m = buildReasoningRequestMetadata({ provider: 'openai', supportsThinking: true, enabled: true, effort: 'high' });
    expect(m?.reasoningEffort).toBe('high');
    expect(m?.thinking).toBeUndefined();
  });
});

describe('buildReasoningRequestMetadata — negative / gating', () => {
  it('returns undefined when disabled', () => {
    expect(buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: false })).toBeUndefined();
  });
  it('returns undefined when the model is not reasoning-capable (security gate)', () => {
    expect(buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: false, enabled: true })).toBeUndefined();
    expect(buildReasoningRequestMetadata({ provider: 'openai', supportsThinking: false, enabled: true })).toBeUndefined();
  });
  it('returns undefined for an unknown provider even if capable', () => {
    expect(buildReasoningRequestMetadata({ provider: 'gemini', supportsThinking: true, enabled: true })).toBeUndefined();
    expect(buildReasoningRequestMetadata({ provider: 'ollama', supportsThinking: true, enabled: true })).toBeUndefined();
  });
  it('normalizes a bogus effort to medium', () => {
    expect(buildReasoningRequestMetadata({ provider: 'openai', supportsThinking: true, enabled: true, effort: 'ULTRA' })?.reasoningEffort).toBe('medium');
    expect(buildReasoningRequestMetadata({ provider: 'openai', supportsThinking: true, enabled: true, effort: null })?.reasoningEffort).toBe('medium');
  });
});

describe('buildReasoningRequestMetadata — robustness/stress', () => {
  it('never produces a budget below 1024 or above maxTokens-512, for any input', () => {
    for (let i = 0; i < 500; i++) {
      const maxTokens = 1024 + (i * 37) % 60000;
      const budgetTokens = (i * 991) % 200000 - 50000; // includes negatives
      const m = buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true, budgetTokens, maxTokens });
      const b = m!.thinking!.budget_tokens;
      expect(b).toBeGreaterThanOrEqual(1024);
      expect(b).toBeLessThanOrEqual(Math.max(1024, maxTokens - 512));
    }
  });
  it('does not throw on missing maxTokens (defaults to 4096)', () => {
    expect(() => buildReasoningRequestMetadata({ provider: 'anthropic', supportsThinking: true, enabled: true })).not.toThrow();
  });
});

describe('reasoning adjusters', () => {
  it('suppresses temperature only when thinking is active', () => {
    expect(reasoningAdjustedTemperature({ thinking: { type: 'enabled', budget_tokens: 2048 } }, 0.7)).toBeUndefined();
    expect(reasoningAdjustedTemperature({ reasoningEffort: 'high' }, 0.7)).toBe(0.7);
    expect(reasoningAdjustedTemperature(undefined, 0.7)).toBe(0.7);
  });
  it('bumps maxTokens above the thinking budget, else passes through', () => {
    expect(reasoningAdjustedMaxTokens({ thinking: { type: 'enabled', budget_tokens: 4000 } }, 4096)).toBe(5024);
    expect(reasoningAdjustedMaxTokens({ reasoningEffort: 'low' }, 4096)).toBe(4096);
    expect(reasoningAdjustedMaxTokens(undefined, 4096)).toBe(4096);
  });
});

describe('resolveReasoning (run metadata)', () => {
  it('enables reasoning from metadata.reasoning=true (positive)', () => {
    expect(resolveReasoning({ reasoning: true })).toEqual({ reasoningEnabled: true });
  });
  it('enables + carries a valid effort and budget', () => {
    expect(resolveReasoning({ reasoningEffort: 'high', reasoningBudgetTokens: 3000 })).toEqual({ reasoningEnabled: true, reasoningEffort: 'high', reasoningBudgetTokens: 3000 });
  });
  it('ignores invalid effort but still enables via the budget', () => {
    expect(resolveReasoning({ reasoningEffort: 'bogus', reasoningBudgetTokens: 2000 })).toEqual({ reasoningEnabled: true, reasoningBudgetTokens: 2000 });
  });
  it('returns empty (no reasoning) for absent/negative/zero (negative)', () => {
    expect(resolveReasoning(undefined)).toEqual({});
    expect(resolveReasoning({})).toEqual({});
    expect(resolveReasoning({ reasoning: false })).toEqual({});
    expect(resolveReasoning({ reasoningBudgetTokens: 0 })).toEqual({});
  });
  it('clamps a negative budget to 0 and does not enable on it alone (security)', () => {
    expect(resolveReasoning({ reasoningBudgetTokens: -5 })).toEqual({});
  });
});
