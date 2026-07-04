/**
 * Phase 8 — Lazy OpenAI-backed `Embedder` adapter for the cost-governor
 * intent-RAG lever. Returns `null` when `OPENAI_API_KEY` is absent so the
 * package's graceful-degradation invariant kicks in (filter pass-through).
 */
import type { Embedder } from '@weaveintel/cost-governor';
import { weaveOpenAIEmbeddingModel } from '@weaveintel/provider-openai';
import { weaveContext } from '@weaveintel/core';

export interface CreateOpenAIEmbedderOptions {
  /** Defaults to `'text-embedding-3-small'` (1536 dim). */
  readonly modelId?: string;
  /** Defaults to 1536 (matches `text-embedding-3-small`). */
  readonly dimension?: number;
  /** Override env var name. Defaults to `OPENAI_API_KEY`. */
  readonly apiKeyEnv?: string;
}

/**
 * Returns an `Embedder` bound to the OpenAI Embeddings API, or `null` when
 * the configured env var is missing. Callers MUST treat `null` as a signal
 * to skip intent-rag wiring entirely (the cost-governor filter will fall
 * through to pass-through anyway, but skipping the wire avoids per-tick
 * resolver overhead).
 */
export function createOpenAIEmbedder(opts: CreateOpenAIEmbedderOptions = {}): Embedder | null {
  const apiKeyEnv = opts.apiKeyEnv ?? 'OPENAI_API_KEY';
  if (!process.env[apiKeyEnv]) return null;
  const modelId = opts.modelId ?? 'text-embedding-3-small';
  const dimension = opts.dimension ?? 1536;
  const inner = weaveOpenAIEmbeddingModel(modelId);
  return {
    modelId,
    dimension,
    async embed(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
      if (texts.length === 0) return [];
      const ctx = weaveContext({});
      const res = await inner.embed(ctx, { input: [...texts] });
      return res.embeddings;
    },
  };
}
