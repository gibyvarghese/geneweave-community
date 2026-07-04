/**
 * Phase C — secrets via runtime
 *
 * Verify that built-in tools resolve API keys through `runtime.secrets`
 * instead of `process.env` when an `ExecutionContext` carrying a runtime
 * is present. Falls back to env when no runtime is reachable, preserving
 * the zero-config DX.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  weaveRuntime,
  weaveContext,
  inMemorySecretResolver,
  chainSecretResolvers,
  envSecretResolver,
} from '@weaveintel/core';
import { BUILTIN_TOOLS } from './tools.js';

describe('Phase C: secrets via runtime', () => {
  const originalTavily = process.env['TAVILY_API_KEY'];
  const originalBrave = process.env['BRAVE_SEARCH_API_KEY'];

  beforeEach(() => {
    delete process.env['TAVILY_API_KEY'];
    delete process.env['BRAVE_SEARCH_API_KEY'];
    delete process.env['BRAVE_API_KEY'];
  });

  afterEach(() => {
    if (originalTavily !== undefined) process.env['TAVILY_API_KEY'] = originalTavily;
    if (originalBrave !== undefined) process.env['BRAVE_SEARCH_API_KEY'] = originalBrave;
  });

  it('web_search resolves TAVILY_API_KEY from runtime.secrets (in-memory) when no env is set', async () => {
    const tool = BUILTIN_TOOLS['web_search'];
    expect(tool).toBeDefined();

    const runtime = weaveRuntime({
      secrets: chainSecretResolvers(
        inMemorySecretResolver({ TAVILY_API_KEY: 'tav-from-vault' }),
        envSecretResolver(),
      ),
    });
    const ctx = weaveContext({ runtime });

    const result = await tool!.invoke(ctx, { name: 'web_search', arguments: { query: 'unused', provider: 'tavily', limit: 1 } });
    const text = result.content;
    const parsed = JSON.parse(text);
    expect(parsed.provider).toBe('tavily');
  });

  it('runtime resolver overrides env on chain order', async () => {
    process.env['TAVILY_API_KEY'] = 'env-key';
    const tool = BUILTIN_TOOLS['web_search'];
    const runtime = weaveRuntime({
      secrets: chainSecretResolvers(
        inMemorySecretResolver({ TAVILY_API_KEY: 'vault-key' }),
        envSecretResolver(),
      ),
    });
    const ctx = weaveContext({ runtime });
    const result = await tool!.invoke(ctx, { name: 'web_search', arguments: { query: 'q', provider: 'tavily', limit: 1 } });
    const parsed = JSON.parse(result.content);
    expect(parsed.provider).toBe('tavily');
  });

  it('falls back to process.env when no runtime is supplied (zero-config DX)', async () => {
    process.env['TAVILY_API_KEY'] = 'env-fallback';
    const tool = BUILTIN_TOOLS['web_search'];
    const ctx = weaveContext({});
    const result = await tool!.invoke(ctx, { name: 'web_search', arguments: { query: 'q', provider: 'tavily', limit: 1 } });
    const parsed = JSON.parse(result.content);
    expect(parsed.provider).toBe('tavily');
  });

  it('reports no providers when neither runtime nor env supplies any key (and duckduckgo is disabled)', async () => {
    const prevDdg = process.env['SEARCH_DUCKDUCKGO_ENABLED'];
    process.env['SEARCH_DUCKDUCKGO_ENABLED'] = 'false';
    try {
      const tool = BUILTIN_TOOLS['web_search'];
      const runtime = weaveRuntime({ secrets: inMemorySecretResolver({}) });
      const ctx = weaveContext({ runtime });
      const result = await tool!.invoke(ctx, { name: 'web_search', arguments: { query: 'q', limit: 1 } });
      const parsed = JSON.parse(result.content);
      expect(parsed.provider).toBe('none');
      expect(String(parsed.error || '')).toContain('No search providers');
    } finally {
      if (prevDdg !== undefined) process.env['SEARCH_DUCKDUCKGO_ENABLED'] = prevDdg;
      else delete process.env['SEARCH_DUCKDUCKGO_ENABLED'];
    }
  });
});
