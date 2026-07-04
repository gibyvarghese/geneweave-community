/**
 * geneWeave — Cache Phase 2 REAL-LLM provider test (OpenAI prompt caching).
 *
 * OpenAI caches stable prefixes (≥1024 tokens) automatically and reports the
 * cached portion in `prompt_tokens_details.cached_tokens`. This test calls the
 * real API twice with the same large prefix and asserts the second call reads
 * from the prompt cache — proving the provider surfaces `cacheReadTokens` in
 * `usage`. A short prefix (below the cache minimum) is the negative control.
 *
 * Skips when OPENAI_API_KEY is absent. Run with the root .env loaded.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

loadEnv({ path: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env') });

const OPENAI_KEY = process.env['OPENAI_API_KEY'];
const MODEL = process.env['CACHE_E2E_MODEL'] ?? 'gpt-4o-mini';

// Stable prefix well above OpenAI's 1024-token cache minimum (~6k tokens).
const BIG_SYSTEM = (
  'You are geneWeave, an enterprise AI orchestration assistant. Follow these standing operating ' +
  'instructions precisely on every turn. '
).repeat(220);

describe('Cache Phase 2 — real OpenAI prompt caching', () => {
  it.skipIf(!OPENAI_KEY)('reads the cached prefix on a repeated request (cached_tokens > 0)', async () => {
    const model = weaveOpenAIModel(MODEL, { apiKey: OPENAI_KEY! });
    const ctx = weaveContext({ deadline: Date.now() + 60_000 });
    const cacheKey = 'gw-phase2-test-' + Math.abs(hashStr(MODEL));

    const mkReq = (userText: string) => ({
      messages: [
        { role: 'system' as const, content: BIG_SYSTEM },
        { role: 'user' as const, content: userText },
      ],
      maxTokens: 16,
      // Routing affinity hint so both requests land on the same cache.
      metadata: { promptCacheKey: cacheKey },
    });

    // Prime the cache, then read it with a different user suffix (same prefix).
    const first = await model.generate(ctx, mkReq('Reply with the word ONE.'));
    const second = await model.generate(ctx, mkReq('Reply with the word TWO.'));

    expect(second.usage.cacheReadTokens ?? 0).toBeGreaterThan(0);
    // The cached portion is a large fraction of the (stable) prompt tokens.
    expect((second.usage.cacheReadTokens ?? 0)).toBeLessThanOrEqual(second.usage.promptTokens);
    // Telemetry sanity: at least one call interacted with the cache.
    expect((first.usage.cacheReadTokens ?? 0) + (second.usage.cacheReadTokens ?? 0)).toBeGreaterThan(0);
  }, 90_000);

  it.skipIf(!OPENAI_KEY)('a short prompt below the cache minimum reports no cached tokens', async () => {
    const model = weaveOpenAIModel(MODEL, { apiKey: OPENAI_KEY! });
    const ctx = weaveContext({ deadline: Date.now() + 60_000 });
    const res = await model.generate(ctx, {
      messages: [{ role: 'user' as const, content: 'Say OK.' }],
      maxTokens: 8,
    });
    expect(res.usage.cacheReadTokens ?? 0).toBe(0);
  }, 90_000);
});

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
