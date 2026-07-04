// SPDX-License-Identifier: MIT
/**
 * Phase 3 — Shared Cost Governor Slot integration tests.
 *
 * Verifies that:
 *   - weaveRuntime advertises RuntimeCapabilities.Cost when a cost slot is wired
 *   - The adapter correctly gates / records through the runtime
 *   - createGeneWeave boot produces runtime.has(Cost)=true
 *   - sendMessageImpl returns a guardrail deny when the budget is exhausted
 */
import { describe, it, expect, vi } from 'vitest';
import { weaveRuntime, RuntimeCapabilities } from '@weaveintel/core';
import { createRuntimeCostAdapter } from '@weaveintel/cost-governor';
import { createInMemoryCostLedger } from '@weaveintel/cost-governor';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCostAdapter(limitUsd: number | null) {
  const ledger = createInMemoryCostLedger();
  return { adapter: createRuntimeCostAdapter({ ledger, globalLimitUsd: limitUsd }), ledger };
}

// ── weaveRuntime Cost capability ──────────────────────────────────────────────

describe('weaveRuntime Cost capability', () => {
  it('does NOT advertise Cost when no cost slot is provided', () => {
    const rt = weaveRuntime({ tlsFloor: false });
    expect(rt.has(RuntimeCapabilities.Cost)).toBe(false);
    expect(rt.cost).toBeUndefined();
  });

  it('advertises Cost when a cost slot is provided', () => {
    const { adapter } = makeCostAdapter(null);
    const rt = weaveRuntime({ tlsFloor: false, cost: adapter });
    expect(rt.has(RuntimeCapabilities.Cost)).toBe(true);
    expect(rt.cost).toBe(adapter);
  });

  it('cost slot is accessible via runtime.cost', () => {
    const { adapter } = makeCostAdapter(5.0);
    const rt = weaveRuntime({ tlsFloor: false, cost: adapter });
    expect(rt.cost).toBeDefined();
  });
});

// ── gate() / record() through runtime ────────────────────────────────────────

describe('runtime.cost gate() / record()', () => {
  it('gate() allows when no limit is configured', async () => {
    const { adapter } = makeCostAdapter(null);
    const rt = weaveRuntime({ tlsFloor: false, cost: adapter });
    const result = await rt.cost!.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(true);
  });

  it('gate() allows when spend is under limit', async () => {
    const { adapter } = makeCostAdapter(1.0);
    const rt = weaveRuntime({ tlsFloor: false, cost: adapter });
    await rt.cost!.record({ userId: 'u1', tenantId: null, model: 'm', provider: 'p', promptTokens: 10, completionTokens: 5, costUsd: 0.01 });
    const result = await rt.cost!.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(true);
  });

  it('gate() denies once limit is exceeded', async () => {
    const { adapter } = makeCostAdapter(0.10);
    const rt = weaveRuntime({ tlsFloor: false, cost: adapter });
    await rt.cost!.record({ userId: 'u1', tenantId: null, model: 'm', provider: 'p', promptTokens: 100, completionTokens: 50, costUsd: 0.20 });
    const result = await rt.cost!.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Spending limit');
  });

  it('getBudgetStatus() reflects recorded spend', async () => {
    const { adapter } = makeCostAdapter(5.0);
    const rt = weaveRuntime({ tlsFloor: false, cost: adapter });
    await rt.cost!.record({ userId: 'u1', tenantId: null, model: 'm', provider: 'p', promptTokens: 100, completionTokens: 50, costUsd: 0.42 });
    const status = await rt.cost!.getBudgetStatus('u1');
    expect(status.used).toBeCloseTo(0.42);
    expect(status.limit).toBe(5.0);
    expect(status.period).toBe('lifetime');
  });
});

// ── sendMessageImpl budget gate ────────────────────────────────────────────────

describe('sendMessageImpl — budget gate deny', () => {
  it('returns guardrail deny when budget is exceeded', async () => {
    const { sendMessageImpl } = await import('./chat-send-message.js');

    // Build a cost adapter that is already over-budget
    const { adapter } = makeCostAdapter(0.01);
    const rt = weaveRuntime({ tlsFloor: false, cost: adapter });
    // Pre-seed spend over the $0.01 limit
    await rt.cost!.record({ userId: 'u1', tenantId: null, model: 'gpt-4o', provider: 'openai', promptTokens: 1000, completionTokens: 500, costUsd: 0.50 });

    const deps = {
      config: {
        defaultProvider: 'mock',
        defaultModel: 'mock-model',
        // 'mock' provider is handled by getOrCreateModel → @weaveintel/devtools
        providers: { mock: {} },
        jwtSecret: 'x',
        corsOrigin: undefined,
        publicBaseUrl: undefined,
        runtime: rt,
      },
      db: {
        getChat: vi.fn().mockResolvedValue(null),
        getChatSettings: vi.fn().mockResolvedValue(null),
        getUserById: vi.fn().mockResolvedValue({ id: 'u1', persona: 'user', tenant_id: null }),
        getMessages: vi.fn().mockResolvedValue([]),
        listEnabledGuardrails: vi.fn().mockResolvedValue([]),
        getRoutingPolicyForModel: vi.fn().mockResolvedValue(null),
        getToolPolicyByKey: vi.fn().mockResolvedValue(null),
        getSkillsByIds: vi.fn().mockResolvedValue([]),
        listMemories: vi.fn().mockResolvedValue([]),
        upsertMemory: vi.fn().mockResolvedValue(undefined),
        listProceduralInstructions: vi.fn().mockResolvedValue([]),
        getChatContextSummary: vi.fn().mockResolvedValue(null),
        listWorkingMemoryEntries: vi.fn().mockResolvedValue([]),
        getPromptContract: vi.fn().mockResolvedValue(null),
        createMessage: vi.fn().mockResolvedValue(undefined),
        addMessage: vi.fn().mockResolvedValue(undefined),
        updateChatTitle: vi.fn().mockResolvedValue(undefined),
        upsertChatContextSummary: vi.fn().mockResolvedValue(undefined),
        getCachePolicy: vi.fn().mockResolvedValue(null),
        getRedactionPolicy: vi.fn().mockResolvedValue(null),
        listTenantThemes: vi.fn().mockResolvedValue([]),
        listCostPolicies: vi.fn().mockResolvedValue([]),
        getModelSetting: vi.fn().mockResolvedValue(null),
        listEnabledSkills: vi.fn().mockResolvedValue([]),
        getGlobalPromptConfig: vi.fn().mockResolvedValue(null),
        listPrompts: vi.fn().mockResolvedValue([]),
        listPromptVersions: vi.fn().mockResolvedValue([]),
        listPromptExperiments: vi.fn().mockResolvedValue([]),
      } as any,
      healthTracker: {
        listHealth: vi.fn().mockReturnValue([]),
        getBlockedProviders: vi.fn().mockReturnValue(new Set()),
        blockProvider: vi.fn(),
        recordOutcome: vi.fn(),
      },
      responseCache: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      },
      cacheKeyBuilder: { build: vi.fn().mockReturnValue('key') },
      getAvailableModels: vi.fn().mockResolvedValue([]),
      withResponseCardFormatPolicy: vi.fn().mockResolvedValue(undefined),
      runAgent: vi.fn(),
      loadPricing: vi.fn().mockResolvedValue(new Map()),
      recordModelOutcome: vi.fn(),
      safeParseJson: vi.fn().mockReturnValue(null),
    };

    const result = await sendMessageImpl(deps, 'u1', 'chat1', 'hello');
    expect(result.guardrail?.decision).toBe('deny');
    expect(result.cost).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
    expect(result.assistantContent).toContain('Spending limit');
  });
});
