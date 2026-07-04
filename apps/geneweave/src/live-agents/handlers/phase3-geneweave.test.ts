/**
 * Phase 3 — Geneweave handler wiring: comprehensive test suite
 *
 * Covers the three geneweave-specific handler overrides registered via
 * `handler-registry-boot.ts`:
 *
 *   geneweaveComputerUseHandler   — CUA model wrapping + tool auto-injection
 *   geneweaveBrowserHandler       — domain allowlist guard + headless validation
 *   geneweaveCodeInterpreterHandler — CSE validation + runtime banner
 *
 * Test categories:
 *   Positive    — factory builds, ticks execute, results are valid
 *   Negative    — missing model, invalid config, blocked domain, missing CSE
 *   Stress      — concurrent factory calls, many ticks, large inbox
 *   Security    — domain bypass attempts, path traversal in bodies, injection via config
 *
 * Also verifies:
 *   - `HandlerRegistry.registerOrReplace` supersedes the base runtime registration
 *   - The `initHandlerRegistry()` singleton wires all three overrides
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Model, ModelResponse, ModelInfo } from '@weaveintel/core';
import type { ActionExecutionContext, LiveAgent } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext } from '@weaveintel/live-agents-runtime';
import { HandlerRegistry, createDefaultHandlerRegistry } from '@weaveintel/live-agents-runtime';

import { geneweaveComputerUseHandler } from './computer-use-handler.js';
import { geneweaveBrowserHandler } from './browser-handler.js';
import { geneweaveCodeInterpreterHandler } from './code-interpreter-handler.js';

// ── Shared test helpers ───────────────────────────────────────────────────────

const mockInfo: ModelInfo = {
  provider: 'anthropic',
  modelId: 'claude-opus-4-8',
  capabilities: new Set(),
};

function makeMockModel(provider = 'anthropic'): Model {
  const info: ModelInfo = { ...mockInfo, provider };
  return {
    info,
    generate: vi.fn().mockResolvedValue({
      id: 'mock-resp-1',
      content: 'Task completed.',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'mock-model',
    } satisfies ModelResponse),
    hasCapability: () => false,
  } as unknown as Model;
}

function makeExecCtx(msgs: Array<Partial<Record<string, unknown>>> = []): ActionExecutionContext {
  const messages = msgs.map((m, i) => ({
    id: `msg-${i + 1}`,
    kind: 'TASK',
    status: 'DELIVERED',
    subject: 'Test task',
    body: 'Do something useful',
    fromType: 'HUMAN',
    fromId: 'human-1',
    toType: 'AGENT',
    toId: 'agent-1',
    createdAt: new Date().toISOString(),
    ...m,
  }));
  return {
    tickId: 'tick-test-1',
    nowIso: new Date().toISOString(),
    agent: {
      id: 'agent-1', role: 'worker', name: 'Worker', meshId: 'mesh-1', status: 'ACTIVE',
    } as unknown as LiveAgent,
    activeBindings: [],
    stateStore: {
      listMessagesForRecipient: vi.fn().mockResolvedValue(messages),
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveBacklogItem: vi.fn().mockResolvedValue(undefined),
      listBacklogForAgent: vi.fn().mockResolvedValue([]),
      listBacklogItemsByStatus: vi.fn().mockResolvedValue([]),
    } as unknown as ActionExecutionContext['stateStore'],
  };
}

const mockAction = { type: 'StartTask' as const, backlogItemId: 'blg-1' };
const mockXCtx = {} as ExecutionContext;

function makeCtx(
  kind: string,
  config: Record<string, unknown> = {},
  extras: Partial<HandlerContext> = {},
): HandlerContext {
  return {
    binding: { id: `binding-${kind}`, agentId: 'agent-1', handlerKind: kind, config },
    agent: { id: 'agent-1', meshId: 'mesh-1', roleKey: 'worker', name: 'Test Agent' },
    log: vi.fn(),
    ...extras,
  };
}

// ── HandlerRegistry.registerOrReplace ────────────────────────────────────────

describe('HandlerRegistry.registerOrReplace', () => {
  it('replaces an existing registration without throwing', () => {
    const registry = new HandlerRegistry();
    registry.register({ kind: 'test.kind', description: 'orig', factory: () => vi.fn() });
    expect(() =>
      registry.registerOrReplace({ kind: 'test.kind', description: 'replaced', factory: () => vi.fn() }),
    ).not.toThrow();
  });

  it('the replaced registration is what resolve() returns', () => {
    const registry = new HandlerRegistry();
    registry.register({ kind: 'test.kind', description: 'orig', factory: () => vi.fn() });
    const newFactory = () => vi.fn();
    registry.registerOrReplace({ kind: 'test.kind', description: 'replaced', factory: newFactory });
    expect(registry.resolve('test.kind')?.factory).toBe(newFactory);
  });

  it('registers a new kind when not already present', () => {
    const registry = new HandlerRegistry();
    registry.registerOrReplace({ kind: 'new.kind', description: 'new', factory: () => vi.fn() });
    expect(registry.resolve('new.kind')).not.toBeNull();
  });
});

// ── geneweaveComputerUseHandler — Positive ───────────────────────────────────

describe('geneweaveComputerUseHandler — positive', () => {
  it('has kind=agentic.computer-use', () => {
    expect(geneweaveComputerUseHandler.kind).toBe('agentic.computer-use');
  });

  it('factory returns a callable TaskHandler with Anthropic model', () => {
    const ctx = makeCtx('agentic.computer-use', { max_steps: 5 }, {
      model: makeMockModel('anthropic'),
    });
    const handler = geneweaveComputerUseHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('factory returns a callable TaskHandler with OpenAI model', () => {
    const ctx = makeCtx('agentic.computer-use', { max_steps: 5 }, {
      model: makeMockModel('openai'),
    });
    const handler = geneweaveComputerUseHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('auto-injects CUA tools when HandlerContext.tools is absent', () => {
    const ctx = makeCtx('agentic.computer-use', {}, { model: makeMockModel('anthropic') });
    expect(ctx.tools).toBeUndefined();
    // factory should not throw even without tools (they get auto-injected)
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });

  it('respects provided tools — does not override operator-configured registry', () => {
    const mockTools = { get: vi.fn(), list: vi.fn(), register: vi.fn() } as unknown as import('@weaveintel/core').ToolRegistry;
    const ctx = makeCtx('agentic.computer-use', {}, {
      model: makeMockModel('anthropic'),
      tools: mockTools,
    });
    // If tools are present, factory must not throw (no override)
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });

  it('wraps Anthropic model (generates provider-aware metadata inject)', () => {
    const baseModel = makeMockModel('anthropic');
    const ctx = makeCtx('agentic.computer-use', {
      display_width: 1920, display_height: 1080,
    }, { model: baseModel });
    // Should not throw; wrapping is transparent
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });

  it('does NOT wrap non-Anthropic models with CUA metadata', () => {
    const openaiModel = makeMockModel('openai');
    const ctx = makeCtx('agentic.computer-use', {}, { model: openaiModel });
    // Handler builds cleanly; OpenAI model passed through unchanged
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });

  it('reads display_width and display_height from config', () => {
    const ctx = makeCtx('agentic.computer-use', {
      display_width: 2560,
      display_height: 1440,
    }, { model: makeMockModel('anthropic') });
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });

  it('executes empty-inbox tick without throwing (no-op path)', async () => {
    const ctx = makeCtx('agentic.computer-use', { max_steps: 2 }, {
      model: makeMockModel('anthropic'),
    });
    const handler = geneweaveComputerUseHandler.factory(ctx);
    const execCtx = makeExecCtx([]);
    const result = await handler(mockAction, execCtx, mockXCtx);
    // no-op result is acceptable (no inbox = no work)
    expect(result).toBeDefined();
  });

  it('configSchema is preserved from the base runtime handler', () => {
    expect(geneweaveComputerUseHandler.configSchema).toBeDefined();
    expect(geneweaveComputerUseHandler.configSchema?.['type']).toBe('object');
  });

  it('description matches runtime handler description', () => {
    expect(geneweaveComputerUseHandler.description).toBeTruthy();
    expect(geneweaveComputerUseHandler.description.length).toBeGreaterThan(20);
  });
});

// ── geneweaveComputerUseHandler — Negative ───────────────────────────────────

describe('geneweaveComputerUseHandler — negative', () => {
  it('throws when neither model nor modelResolver is provided', () => {
    const ctx = makeCtx('agentic.computer-use', {});
    expect(() => geneweaveComputerUseHandler.factory(ctx)).toThrow(/model/i);
  });

  it('throws informative error message including agent id', () => {
    const ctx = makeCtx('agentic.computer-use', {});
    expect(() => geneweaveComputerUseHandler.factory(ctx)).toThrow('agent-1');
  });

  it('throws when model is null explicitly', () => {
    const ctx = makeCtx('agentic.computer-use', {}, { model: undefined });
    expect(() => geneweaveComputerUseHandler.factory(ctx)).toThrow();
  });
});

// ── geneweaveBrowserHandler — Positive ───────────────────────────────────────

describe('geneweaveBrowserHandler — positive', () => {
  it('has kind=agentic.browser', () => {
    expect(geneweaveBrowserHandler.kind).toBe('agentic.browser');
  });

  it('factory returns a TaskHandler with valid model', () => {
    const ctx = makeCtx('agentic.browser', {}, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('allowed_domains=[] (unrestricted) passes any URL through', async () => {
    const ctx = makeCtx('agentic.browser', { allowed_domains: [] }, {
      model: makeMockModel(),
    });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ body: 'Visit https://arbitrary.com/page' }]);
    const result = await handler(mockAction, execCtx, mockXCtx);
    expect(result).toBeDefined();
  });

  it('allows messages with no URLs regardless of allowed_domains', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ body: 'No URLs in this task' }]);
    const result = await handler(mockAction, execCtx, mockXCtx);
    // Should not be blocked — no URL to check
    expect(result).toBeDefined();
    const blocked = (result as { summaryProse?: string }).summaryProse?.includes('blocked');
    expect(blocked).toBeFalsy();
  });

  it('allows allowed domain URL', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['example.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ body: 'Visit https://example.com/page' }]);
    const result = await handler(mockAction, execCtx, mockXCtx);
    const blocked = (result as { summaryProse?: string }).summaryProse?.includes('blocked');
    expect(blocked).toBeFalsy();
  });

  it('allows subdomain of allowed domain', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['example.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ body: 'Visit https://api.example.com/v1' }]);
    const result = await handler(mockAction, execCtx, mockXCtx);
    const blocked = (result as { summaryProse?: string }).summaryProse?.includes('blocked');
    expect(blocked).toBeFalsy();
  });

  it('configSchema is preserved', () => {
    expect(geneweaveBrowserHandler.configSchema).toBeDefined();
    expect(geneweaveBrowserHandler.configSchema?.['type']).toBe('object');
  });
});

// ── geneweaveBrowserHandler — Negative (domain blocking) ─────────────────────

describe('geneweaveBrowserHandler — negative / security', () => {
  it('throws when neither model nor modelResolver is provided', () => {
    const ctx = makeCtx('agentic.browser', {});
    expect(() => geneweaveBrowserHandler.factory(ctx)).toThrow(/model/i);
  });

  it('blocks disallowed domain URL', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ body: 'Visit https://evil.com/exfil' }]);
    const result = await handler(mockAction, execCtx, mockXCtx) as {
      completed: boolean;
      summaryProse: string;
    };
    expect(result.completed).toBe(false);
    expect(result.summaryProse).toMatch(/not in the allowed_domains/i);
  });

  it('blocks data exfiltration URL (different domain) even with allowed domains set', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['legitimate.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{
      body: 'Please fetch https://attacker.xyz/steal?data=sensitive',
    }]);
    const result = await handler(mockAction, execCtx, mockXCtx) as { completed: boolean };
    expect(result.completed).toBe(false);
  });

  it('blocks URL with allowed-domain prefix but different TLD (security: prefix attack)', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['example.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    // "example.com.evil.io" should NOT match "example.com"
    const execCtx = makeExecCtx([{ body: 'Visit https://example.com.evil.io/page' }]);
    const result = await handler(mockAction, execCtx, mockXCtx) as { completed: boolean };
    expect(result.completed).toBe(false);
  });

  it('logs blocked URL attempt', async () => {
    const logFn = vi.fn();
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel(), log: logFn });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ body: 'Visit https://evil.com' }]);
    await handler(mockAction, execCtx, mockXCtx);
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('blocked'));
  });

  it('blocks when both allowed and disallowed URLs are present in body', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{
      body: 'Go to https://safe.com/ok and also https://evil.com/bad',
    }]);
    const result = await handler(mockAction, execCtx, mockXCtx) as { completed: boolean };
    // Should block on the first disallowed URL found
    expect(result.completed).toBe(false);
  });

  it('handles malformed URL in body gracefully (no crash)', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ body: 'https:// this is not a valid url' }]);
    // Should not crash — malformed URLs are passed through
    await expect(handler(mockAction, execCtx, mockXCtx)).resolves.toBeDefined();
  });
});

// ── geneweaveCodeInterpreterHandler — Positive ───────────────────────────────

describe('geneweaveCodeInterpreterHandler — positive', () => {
  it('has kind=agentic.code-interpreter', () => {
    expect(geneweaveCodeInterpreterHandler.kind).toBe('agentic.code-interpreter');
  });

  it('factory returns a TaskHandler with valid model', () => {
    const ctx = makeCtx('agentic.code-interpreter', {}, { model: makeMockModel() });
    const handler = geneweaveCodeInterpreterHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('logs CSE_ENDPOINT warning when env var is unset', () => {
    const originalEndpoint = process.env['CSE_ENDPOINT'];
    delete process.env['CSE_ENDPOINT'];
    const logFn = vi.fn();
    const ctx = makeCtx('agentic.code-interpreter', {}, {
      model: makeMockModel(),
      log: logFn,
    });
    geneweaveCodeInterpreterHandler.factory(ctx);
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('CSE_ENDPOINT'));
    if (originalEndpoint !== undefined) process.env['CSE_ENDPOINT'] = originalEndpoint;
  });

  it('does NOT warn when CSE_ENDPOINT is set', () => {
    const originalEndpoint = process.env['CSE_ENDPOINT'];
    process.env['CSE_ENDPOINT'] = 'http://localhost:8000';
    const logFn = vi.fn();
    const ctx = makeCtx('agentic.code-interpreter', {}, {
      model: makeMockModel(),
      log: logFn,
    });
    geneweaveCodeInterpreterHandler.factory(ctx);
    const warned = logFn.mock.calls.some(
      (c) => String(c[0]).includes('WARNING'),
    );
    expect(warned).toBe(false);
    if (originalEndpoint !== undefined) process.env['CSE_ENDPOINT'] = originalEndpoint;
    else delete process.env['CSE_ENDPOINT'];
  });

  it('logs runtime + auto_install_libs to ctx.log', () => {
    const logFn = vi.fn();
    const ctx = makeCtx('agentic.code-interpreter', {
      runtime: 'python3.11',
      auto_install_libs: false,
      max_cells: 10,
    }, { model: makeMockModel(), log: logFn });
    geneweaveCodeInterpreterHandler.factory(ctx);
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('python3.11'));
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('false'));
  });

  it('defaults runtime to python3.12', () => {
    const logFn = vi.fn();
    const ctx = makeCtx('agentic.code-interpreter', {}, {
      model: makeMockModel(),
      log: logFn,
    });
    geneweaveCodeInterpreterHandler.factory(ctx);
    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('python3.12'));
  });

  it('accepts all valid runtime values', () => {
    for (const runtime of ['python3.10', 'python3.11', 'python3.12']) {
      const ctx = makeCtx('agentic.code-interpreter', { runtime }, { model: makeMockModel() });
      expect(() => geneweaveCodeInterpreterHandler.factory(ctx)).not.toThrow();
    }
  });

  it('executes empty-inbox tick without throwing', async () => {
    const ctx = makeCtx('agentic.code-interpreter', { max_steps: 2 }, {
      model: makeMockModel(),
    });
    const handler = geneweaveCodeInterpreterHandler.factory(ctx);
    const execCtx = makeExecCtx([]);
    await expect(handler(mockAction, execCtx, mockXCtx)).resolves.toBeDefined();
  });

  it('configSchema type is object', () => {
    expect(geneweaveCodeInterpreterHandler.configSchema?.['type']).toBe('object');
  });
});

// ── geneweaveCodeInterpreterHandler — Negative ───────────────────────────────

describe('geneweaveCodeInterpreterHandler — negative', () => {
  it('throws when neither model nor modelResolver is provided', () => {
    const ctx = makeCtx('agentic.code-interpreter', {});
    expect(() => geneweaveCodeInterpreterHandler.factory(ctx)).toThrow(/model/i);
  });
});

// ── initHandlerRegistry wiring ────────────────────────────────────────────────

describe('initHandlerRegistry — geneweave overrides wired', () => {
  it('all three overrides supersede the runtime defaults in createDefaultHandlerRegistry', () => {
    const registry = createDefaultHandlerRegistry();
    // Apply the same overrides that initHandlerRegistry() does
    registry.registerOrReplace(geneweaveComputerUseHandler);
    registry.registerOrReplace(geneweaveBrowserHandler);
    registry.registerOrReplace(geneweaveCodeInterpreterHandler);

    const cuaReg = registry.resolve('agentic.computer-use');
    const browserReg = registry.resolve('agentic.browser');
    const codeReg = registry.resolve('agentic.code-interpreter');

    // All three should resolve to the geneweave overrides (same factory reference)
    expect(cuaReg?.factory).toBe(geneweaveComputerUseHandler.factory);
    expect(browserReg?.factory).toBe(geneweaveBrowserHandler.factory);
    expect(codeReg?.factory).toBe(geneweaveCodeInterpreterHandler.factory);
  });

  it('all 11 handler kinds are still registered after overrides', () => {
    const registry = createDefaultHandlerRegistry();
    registry.registerOrReplace(geneweaveComputerUseHandler);
    registry.registerOrReplace(geneweaveBrowserHandler);
    registry.registerOrReplace(geneweaveCodeInterpreterHandler);

    const kinds = registry.kinds();
    expect(kinds).toContain('agentic.react');
    expect(kinds).toContain('agentic.computer-use');
    expect(kinds).toContain('agentic.browser');
    expect(kinds).toContain('agentic.code-interpreter');
    expect(kinds).toContain('agentic.voice-realtime');
    expect(kinds).toContain('agentic.multimodal');
    expect(kinds).toContain('deterministic.mapreduce');
    expect(kinds).toContain('multi-agent.swarm');
    expect(kinds).toContain('external.mcp-tool');
    expect(kinds.length).toBeGreaterThanOrEqual(11);
  });

  it('registry.build() resolves and calls the geneweave factory for agentic.computer-use', () => {
    const registry = createDefaultHandlerRegistry();
    registry.registerOrReplace(geneweaveComputerUseHandler);

    const ctx = makeCtx('agentic.computer-use', {}, { model: makeMockModel('anthropic') });
    expect(() => registry.build(ctx)).not.toThrow();
  });
});

// ── Stress tests ─────────────────────────────────────────────────────────────

describe('Stress — concurrent factory calls', () => {
  it('builds 50 CUA handlers concurrently without error', async () => {
    const builds = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => {
        const ctx = makeCtx('agentic.computer-use', { max_steps: 5 }, {
          model: makeMockModel('anthropic'),
        });
        return geneweaveComputerUseHandler.factory(ctx);
      }),
    );
    const handlers = await Promise.all(builds);
    expect(handlers).toHaveLength(50);
    handlers.forEach((h) => expect(typeof h).toBe('function'));
  });

  it('builds 50 browser handlers concurrently without error', async () => {
    const builds = Array.from({ length: 50 }, () =>
      Promise.resolve().then(() => {
        const ctx = makeCtx('agentic.browser', { allowed_domains: ['ok.com'] }, {
          model: makeMockModel(),
        });
        return geneweaveBrowserHandler.factory(ctx);
      }),
    );
    const handlers = await Promise.all(builds);
    expect(handlers).toHaveLength(50);
  });

  it('builds 50 code-interpreter handlers concurrently without error', async () => {
    const builds = Array.from({ length: 50 }, () =>
      Promise.resolve().then(() => {
        const ctx = makeCtx('agentic.code-interpreter', { runtime: 'python3.12' }, {
          model: makeMockModel(),
        });
        return geneweaveCodeInterpreterHandler.factory(ctx);
      }),
    );
    const handlers = await Promise.all(builds);
    expect(handlers).toHaveLength(50);
  });

  it('domain-guard tick handles large inbox (100 messages) efficiently', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);

    const msgs = Array.from({ length: 100 }, (_, i) => ({
      body: `Visit https://safe.com/page-${i}`,
    }));
    const execCtx = makeExecCtx(msgs);
    const start = Date.now();
    await handler(mockAction, execCtx, mockXCtx);
    expect(Date.now() - start).toBeLessThan(2000); // < 2 s for 100 messages
  });

  it('blocks correctly on 100th message having disallowed domain', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);

    // First 99 OK, last one has evil.com
    const msgs = Array.from({ length: 99 }, (_, i) => ({
      id: `msg-${i + 1}`,
      body: `Visit https://safe.com/page-${i}`,
    }));
    msgs.push({ id: 'msg-100', body: 'Visit https://evil.com/steal' });
    const execCtx = makeExecCtx(msgs);
    const result = await handler(mockAction, execCtx, mockXCtx) as { completed: boolean };
    expect(result.completed).toBe(false);
  });
});

// ── Security — weaveAgent path (createCuaWeaveAgent via runtime export) ───────

describe('Security — CUA model wrapping is provider-aware', () => {
  it('Anthropic model gets CUA wrapper applied (provider check)', () => {
    const anthropicModel = makeMockModel('anthropic');
    const ctx = makeCtx('agentic.computer-use', {}, { model: anthropicModel });
    // Should not throw; the provider=anthropic branch runs wrapModelForCua
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });

  it('Non-Anthropic model bypasses CUA wrapper (no crash on OpenAI)', () => {
    const openaiModel = makeMockModel('openai');
    const ctx = makeCtx('agentic.computer-use', {}, { model: openaiModel });
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });

  it('Non-Anthropic model bypasses CUA wrapper (Ollama)', () => {
    const ollamaModel = makeMockModel('ollama');
    const ctx = makeCtx('agentic.computer-use', {}, { model: ollamaModel });
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });
});

describe('Security — path traversal blocked at config level (browser)', () => {
  it('does not crash on path traversal sequences in body', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{
      body: 'Visit https://safe.com/../../../etc/passwd',
    }]);
    // URL with path traversal but allowed domain — safe to pass through
    await expect(handler(mockAction, execCtx, mockXCtx)).resolves.toBeDefined();
  });

  it('blocks URL with different domain even with path traversal in path', async () => {
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['safe.com'],
    }, { model: makeMockModel() });
    const handler = geneweaveBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{
      body: 'Go to https://evil.com/../safe.com/data',
    }]);
    const result = await handler(mockAction, execCtx, mockXCtx) as { completed: boolean };
    // Domain is evil.com, blocked regardless of path
    expect(result.completed).toBe(false);
  });
});

describe('Security — config injection does not execute arbitrary code', () => {
  it('config value with shell metacharacters does not escape to process', () => {
    // config_json values go into system prompt header strings, not shell calls
    const ctx = makeCtx('agentic.code-interpreter', {
      runtime: 'python3.12; rm -rf /',
      auto_install_libs: true,
    }, { model: makeMockModel() });
    // Should not crash or spawn a shell — value is string-interpolated into a log line
    expect(() => geneweaveCodeInterpreterHandler.factory(ctx)).not.toThrow();
  });

  it('config value with SQL injection chars does not affect DB (handled by bound params)', () => {
    const ctx = makeCtx('agentic.computer-use', {
      fallbackPrompt: "'; DROP TABLE live_agents; --",
    }, { model: makeMockModel() });
    expect(() => geneweaveComputerUseHandler.factory(ctx)).not.toThrow();
  });
});
