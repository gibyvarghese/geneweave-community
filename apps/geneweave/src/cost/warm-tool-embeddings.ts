/**
 * Phase 8 — Embedding warmer for the cost-governor intent-RAG lever.
 *
 * Walks BUILTIN_TOOLS at startup, hashes each tool description, and
 * (re)embeds rows whose stored hash differs from the current source.
 * Idempotent. No-op without an embedder (e.g. when OPENAI_API_KEY is
 * absent). Best-effort: failures are logged and never block startup.
 */
import {
  hashDescription,
  type Embedder,
  type EmbeddingStore,
  type ToolEmbedding,
} from '@weaveintel/cost-governor';
import { BUILTIN_TOOLS } from '../tools.js';

export interface WarmToolEmbeddingsOptions {
  readonly embedder: Embedder | null;
  readonly store: EmbeddingStore;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function warmToolEmbeddings(opts: WarmToolEmbeddingsOptions): Promise<{ embedded: number; skipped: number; total: number }> {
  const { embedder, store, log } = opts;
  if (!embedder) {
    log?.('cost.intent-rag: embedder unavailable (no OPENAI_API_KEY) — warmer skipped');
    return { embedded: 0, skipped: 0, total: 0 };
  }

  const entries = Object.entries(BUILTIN_TOOLS);
  const toEmbed: Array<{ key: string; description: string; hash: string }> = [];
  let skipped = 0;

  for (const [key, tool] of entries) {
    const description = (tool as { description?: string }).description ?? '';
    if (!description) {
      skipped++;
      continue;
    }
    const hash = hashDescription(description);
    let existing: ToolEmbedding | null = null;
    try {
      existing = await store.get(key);
    } catch (err) {
      log?.('cost.intent-rag: store.get failed', { key, err: String(err) });
    }
    if (existing && existing.descriptionHash === hash && existing.modelId === embedder.modelId) {
      skipped++;
      continue;
    }
    toEmbed.push({ key, description, hash });
  }

  if (toEmbed.length === 0) {
    log?.('cost.intent-rag: warmer up-to-date', { total: entries.length, skipped });
    return { embedded: 0, skipped, total: entries.length };
  }

  let embedded = 0;
  try {
    const vectors = await embedder.embed(toEmbed.map((t) => t.description));
    for (let i = 0; i < toEmbed.length; i++) {
      const item = toEmbed[i]!;
      const vec = vectors[i];
      if (!vec || vec.length !== embedder.dimension) continue;
      try {
        await store.upsert({
          toolKey: item.key,
          modelId: embedder.modelId,
          dimension: embedder.dimension,
          vector: [...vec],
          descriptionHash: item.hash,
        });
        embedded++;
      } catch (err) {
        log?.('cost.intent-rag: store.upsert failed', { key: item.key, err: String(err) });
      }
    }
  } catch (err) {
    log?.('cost.intent-rag: embedder.embed failed — skipping warm cycle', { err: String(err) });
  }

  log?.('cost.intent-rag: warmer complete', { embedded, skipped, total: entries.length });
  return { embedded, skipped, total: entries.length };
}
