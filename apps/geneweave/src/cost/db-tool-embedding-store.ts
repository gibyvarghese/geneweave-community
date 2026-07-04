/**
 * Phase 8 — DB-backed `EmbeddingStore` for the cost-governor intent-RAG
 * lever. Wraps the geneweave `tool_embeddings` SQLite table so the package
 * stays free of DB imports.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { EmbeddingStore, ToolEmbedding } from '@weaveintel/cost-governor';
import type { DatabaseAdapter } from '../db-types.js';

export interface CreateDbToolEmbeddingStoreOptions {
  readonly db: DatabaseAdapter;
  /** Filter the store to a single embedding model id (e.g. `'text-embedding-3-small'`). */
  readonly modelId?: string;
}

export function createDbToolEmbeddingStore(opts: CreateDbToolEmbeddingStoreOptions): EmbeddingStore {
  const { db, modelId } = opts;
  return {
    async get(toolKey: string): Promise<ToolEmbedding | null> {
      const row = await db.getToolEmbedding(toolKey);
      if (!row) return null;
      if (modelId && row.model_id !== modelId) return null;
      return rowToEmbedding(row);
    },
    async getAll(): Promise<ReadonlyArray<ToolEmbedding>> {
      const rows = await db.listToolEmbeddings(modelId ? { modelId } : undefined);
      return rows.map(rowToEmbedding);
    },
    async upsert(embedding: ToolEmbedding): Promise<void> {
      await db.upsertToolEmbedding({
        id: newUUIDv7(),
        tool_key: embedding.toolKey,
        model_id: embedding.modelId,
        dimension: embedding.dimension,
        embedding: JSON.stringify(embedding.vector),
        description_hash: embedding.descriptionHash,
      });
    },
  };
}

function rowToEmbedding(row: { tool_key: string; model_id: string; dimension: number; embedding: string; description_hash: string }): ToolEmbedding {
  let vector: number[] = [];
  try {
    const parsed = JSON.parse(row.embedding);
    if (Array.isArray(parsed)) vector = parsed.filter((n) => typeof n === 'number');
  } catch {
    // corrupt row — return empty vector; decision helper treats dimension mismatch as skip
  }
  return {
    toolKey: row.tool_key,
    modelId: row.model_id,
    dimension: row.dimension,
    vector,
    descriptionHash: row.description_hash,
  };
}
