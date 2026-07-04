/**
 * pgvector semantic-memory backend for geneWeave.
 *
 * Follows the same module-level singleton pattern as guardrail-judge.ts —
 * call `setActiveSemanticMemoryBackend(backend)` once at boot and every
 * component (saveToMemory, buildMemoryContext, tool callbacks) picks it up
 * without threading dependencies through every call site.
 *
 * When no backend is set the application falls back to the existing SQLite
 * db.* methods transparently.
 */

import type { ExecutionContext, EmbeddingModel } from '@weaveintel/core';
import { weavePgVectorMemoryStore, type PgVectorMemoryStoreOptions } from '@weaveintel/memory';
import type { DatabaseAdapter } from './db.js';

// ── Shared result type ────────────────────────────────────────────────────────

/** Minimal representation of a semantic memory entry used across the pipeline. */
export interface SemanticMemoryEntry {
  id: string;
  content: string;
  memory_type: string;   // 'user_fact' | 'preference' | 'summary' | 'semantic'
  source: string;        // 'user' | 'assistant' | 'user_requested'
  created_at: string;
}

// ── Backend interface ─────────────────────────────────────────────────────────

export interface SemanticMemoryBackend {
  /**
   * Persist a semantic memory entry.
   * An optional pre-computed embedding is stored alongside the content
   * so future searches can rank by vector similarity.
   */
  save(
    ctx: ExecutionContext,
    opts: {
      id: string;
      userId: string;
      chatId?: string;
      content: string;
      memoryType: string;
      source: string;
      embedding?: number[];
    },
  ): Promise<void>;

  /**
   * Search memories by natural-language query.
   * If `queryEmbedding` is provided the backend performs vector similarity
   * search; otherwise it falls back to keyword matching.
   */
  search(
    ctx: ExecutionContext,
    opts: {
      userId: string;
      query: string;
      limit: number;
      queryEmbedding?: number[];
    },
  ): Promise<SemanticMemoryEntry[]>;

  /** Return the most recent entries for a user (no query scoring).
   * Used by identity-recall and context injection code paths that need
   * recent facts regardless of relevance to the current message.
   */
  list(userId: string, limit: number): Promise<SemanticMemoryEntry[]>;

  /**
   * Delete every semantic memory entry for a user whose `content` contains
   * `needle` (case-insensitive substring match). Powers the `memory_forget`
   * tool so the agent can erase a fact the user no longer wants stored.
   * Returns the number of rows removed (best-effort; backends may not be
   * able to count exactly).
   */
  forget(
    ctx: ExecutionContext,
    opts: { userId: string; needle: string },
  ): Promise<{ deleted: number }>;

  /** Release resources (e.g. close the DB connection pool). */
  close(): Promise<void>;
}

// ── SQLite backend (default / fallback) ──────────────────────────────────────

/**
 * Wraps the existing SQLite DatabaseAdapter methods.
 * Used when PGVECTOR_URL is not configured so no behaviour changes for
 * deployments that don't need Postgres.
 */
export function createSQLiteSemanticMemoryBackend(db: DatabaseAdapter): SemanticMemoryBackend {
  return {
    async save(_ctx, opts) {
      await db.saveSemanticMemory({
        id: opts.id,
        userId: opts.userId,
        chatId: opts.chatId,
        content: opts.content,
        memoryType: opts.memoryType,
        source: opts.source,
        embedding: opts.embedding,
      });
    },

    async search(_ctx, opts) {
      const rows = await db.searchSemanticMemory({
        userId: opts.userId,
        query: opts.query,
        limit: opts.limit,
        queryEmbedding: opts.queryEmbedding,
      });
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        memory_type: r.memory_type,
        source: r.source,
        created_at: r.created_at,
      }));
    },

    async list(userId, limit) {
      const rows = await db.listSemanticMemory(userId, limit);
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        memory_type: r.memory_type,
        source: r.source,
        created_at: r.created_at,
      }));
    },

    async forget(_ctx, opts) {
      // List up to a generous window and substring-match client-side; lets
      // us reuse a single delete path regardless of how the row was saved.
      const rows = await db.listSemanticMemory(opts.userId, 1000);
      const needle = opts.needle.toLowerCase();
      const victims = rows.filter((r) => r.content.toLowerCase().includes(needle));
      let deleted = 0;
      for (const v of victims) {
        try {
          await db.deleteSemanticMemory(v.id, opts.userId);
          deleted += 1;
        } catch { /* best-effort */ }
      }
      return { deleted };
    },

    async close() { /* SQLite adapter lifecycle managed elsewhere */ },
  };
}

// ── pgvector backend ──────────────────────────────────────────────────────────

/**
 * Wraps `weavePgVectorMemoryStore` from @weaveintel/memory.
 * All semantic memory writes and searches go through PostgreSQL + pgvector;
 * entity memory and all other geneWeave tables remain in SQLite.
 */
export function createPgVectorSemanticMemoryBackend(
  pgOpts: PgVectorMemoryStoreOptions,
): SemanticMemoryBackend {
  const store = weavePgVectorMemoryStore(pgOpts);

  function toEntry(e: import('@weaveintel/core').MemoryEntry): SemanticMemoryEntry {
    return {
      id: e.id,
      content: e.content,
      memory_type: (e.metadata['memory_type'] as string | undefined) ?? 'semantic',
      source: (e.metadata['source'] as string | undefined) ?? 'assistant',
      created_at: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
    };
  }

  // Minimal ExecutionContext stub for pure storage operations that don't
  // need a real execution context (list, delete). store.query/_write/_delete
  // accept ctx but all pgvector store operations ignore it.
  const noop = () => { throw new Error('noop ctx used outside storage ops'); };
  const storageCtx: ExecutionContext = {
    executionId: 'pgvector-storage',
    metadata: {},
    tracer: { trace: noop as never, span: noop as never },
  } as unknown as ExecutionContext;

  return {
    async save(ctx, opts) {
      await store.write(ctx, [{
        id: opts.id,
        type: 'semantic',
        content: opts.content,
        metadata: {
          memory_type: opts.memoryType,
          source: opts.source,
          chat_id: opts.chatId ?? null,
        },
        embedding: opts.embedding,
        createdAt: new Date().toISOString(),
        userId: opts.userId,
      }]);
    },

    async search(ctx, opts) {
      const entries = await store.query(ctx, {
        type: 'semantic',
        embedding: opts.queryEmbedding,
        query: opts.queryEmbedding ? undefined : opts.query,
        filter: { userId: opts.userId },
        topK: opts.limit,
      });
      return entries.map(toEntry);
    },

    async list(userId, limit) {
      const entries = await store.query(storageCtx, {
        type: 'semantic',
        filter: { userId },
        topK: limit,
      });
      return entries.map(toEntry);
    },

    async forget(ctx, opts) {
      // Fetch a generous recent window, substring-match content client-side,
      // then delete by id. Avoids relying on FTS for arbitrary sentinels and
      // works uniformly with vector-only writes.
      const entries = await store.query(ctx, {
        type: 'semantic',
        filter: { userId: opts.userId },
        topK: 1000,
      });
      const needle = opts.needle.toLowerCase();
      const victimIds = entries
        .filter((e) => e.content.toLowerCase().includes(needle))
        .map((e) => e.id);
      if (victimIds.length > 0) {
        await store.delete(ctx, victimIds);
      }
      return { deleted: victimIds.length };
    },

    async close() {
      await store.close();
    },
  };
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _activeBackend: SemanticMemoryBackend | undefined;

export function setActiveSemanticMemoryBackend(backend: SemanticMemoryBackend | undefined): void {
  _activeBackend = backend;
}

export function getActiveSemanticMemoryBackend(): SemanticMemoryBackend | undefined {
  return _activeBackend;
}

// ── Boot helper ───────────────────────────────────────────────────────────────

/**
 * Reads `PGVECTOR_URL` (and optional `PGVECTOR_DIMENSIONS`) from the
 * environment, creates a pgvector backend, and registers it as the active
 * semantic memory backend.
 *
 * Call once during `createGeneWeave()` after the embedding model is ready.
 * Returns `true` when pgvector is configured and activated, `false` when the
 * env var is absent (SQLite fallback stays active).
 */
export function initPgVectorSemanticMemory(db: DatabaseAdapter): boolean {
  const pgUrl = process.env['PGVECTOR_URL'];
  if (!pgUrl) {
    setActiveSemanticMemoryBackend(createSQLiteSemanticMemoryBackend(db));
    return false;
  }

  const dimensions = process.env['PGVECTOR_DIMENSIONS']
    ? parseInt(process.env['PGVECTOR_DIMENSIONS'], 10)
    : 1536;

  const indexType = (process.env['PGVECTOR_INDEX_TYPE'] as PgVectorMemoryStoreOptions['indexType'])
    ?? 'hnsw';

  const backend = createPgVectorSemanticMemoryBackend({
    url: pgUrl,
    dimensions,
    indexType,
    distanceMetric: 'cosine',
    tableName: 'geneweave_memory_vec',
  });

  setActiveSemanticMemoryBackend(backend);
  return true;
}

/** Resolve the embedding model used for memory — reuses the guardrail embedding model when set. */
export async function resolveMemoryEmbeddingModel(): Promise<EmbeddingModel | undefined> {
  const { getActiveGuardrailEmbeddingModel } = await import('./guardrail-judge.js');
  return getActiveGuardrailEmbeddingModel();
}
