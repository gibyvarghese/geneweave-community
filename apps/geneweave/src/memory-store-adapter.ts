/**
 * Phase 5 — GeneWeave `MemoryStore` bridge adapter.
 *
 * Implements the `@weaveintel/core` `MemoryStore` interface over the existing
 * geneWeave `DatabaseAdapter` so that `runtime.memory.store` and
 * `fusedMemorySearch` operate on the SAME underlying data that the chat path
 * writes via `saveToMemory()` / `db.saveSemanticMemory()` / etc.
 *
 * This avoids duplicating data into a second SQLite file and ensures agents
 * calling `ctx.runtime.memory.semantic.recall(...)` see everything the chat
 * pipeline has learned.
 *
 * Mapping:
 *   semantic_memory table  → MemoryEntry { type: 'semantic' }
 *   entity_memory table    → MemoryEntry { type: 'entity' }
 *   episodic_memory table  → MemoryEntry { type: 'episodic' }
 *
 * `delete` and `clear` are intentionally limited — they delegate to
 * whatever bulk-delete the DB adapter supports, else no-op.
 */

import type { ExecutionContext, MemoryEntry, MemoryFilter, MemoryQuery, MemoryStore, SemanticMemory } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';
import type { SemanticMemoryRow, EntityMemoryRow, EpisodicMemoryRow } from './db-types/memory.js';
import { getActiveSemanticMemoryBackend } from './memory-pgvector.js';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';

// ─── Row → MemoryEntry mappers ────────────────────────────────────────────────

function semanticRowToEntry(row: SemanticMemoryRow): MemoryEntry {
  let embedding: readonly number[] | undefined;
  if (row.embedding) {
    try { embedding = JSON.parse(row.embedding) as number[]; } catch { /* ignore */ }
  }
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* ignore */ }
  }
  return {
    id: row.id,
    type: 'semantic',
    content: row.content,
    metadata: { ...metadata, memoryType: row.memory_type, source: row.source },
    ...(embedding ? { embedding } : {}),
    createdAt: row.created_at,
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
  };
}

function entityRowToEntry(row: EntityMemoryRow): MemoryEntry {
  let facts: Record<string, unknown> = {};
  try { facts = JSON.parse(row.facts) as Record<string, unknown>; } catch { /* ignore */ }
  return {
    id: row.id,
    type: 'entity',
    content: row.entity_name,
    metadata: { entityType: row.entity_type, facts, confidence: row.confidence, source: row.source },
    createdAt: row.created_at,
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
  };
}

function episodicRowToEntry(row: EpisodicMemoryRow): MemoryEntry {
  let tags: string[] = [];
  if (row.tags) {
    try { tags = JSON.parse(row.tags) as string[]; } catch { /* ignore */ }
  }
  return {
    id: row.id,
    type: 'episodic',
    content: row.content,
    metadata: { messageRole: row.message_role, importance: row.importance, tags },
    createdAt: row.created_at,
    importance: row.importance,
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
  };
}

// ─── Cosine similarity (local fallback) ──────────────────────────────────────

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

function matchesBasicFilter(entry: MemoryEntry, filter?: MemoryFilter): boolean {
  if (!filter) return true;
  if (filter.userId && entry.userId !== filter.userId) return false;
  if (filter.tenantId && entry.tenantId !== filter.tenantId) return false;
  return true;
}

// ─── Keyword-only SemanticMemory fallback ─────────────────────────────────────

/**
 * A minimal `SemanticMemory` that uses keyword search instead of vector
 * similarity. Used when no embedding model is configured at boot. The chat
 * pipeline still stores embeddings whenever it does have an embedding model,
 * so future retrieval via the runtime slot can still benefit from vectors once
 * the model is available.
 */

export function createKeywordSemanticMemory(store: MemoryStore): SemanticMemory {
  return {
    async store(ctx, content, metadata) {
      const entry: MemoryEntry = {
        id: `sem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'semantic',
        content,
        metadata: metadata ?? {},
        createdAt: new Date().toISOString(),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      };
      await store.write(ctx, [entry]);
    },
    async recall(ctx, query, topK) {
      return store.query(ctx, { type: 'semantic', query, topK: topK ?? 5 });
    },
  };
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export function createGeneWeaveMemoryStore(db: DatabaseAdapter): MemoryStore {
  return {
    async write(ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void> {
      for (const entry of entries) {
        const userId = entry.userId ?? ctx.userId;
        if (!userId) continue;

        if (entry.type === 'semantic') {
          const embedding = entry.embedding
            ? (Array.from(entry.embedding) as number[])
            : undefined;
          const backend = getActiveSemanticMemoryBackend();
          const saveOpts = {
            id: entry.id,
            userId,
            content: entry.content,
            memoryType: String(entry.metadata['memoryType'] ?? 'semantic'),
            source: String(entry.metadata['source'] ?? 'assistant'),
            embedding,
            ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
          };
          await (backend ? backend.save(ctx, saveOpts) : db.saveSemanticMemory(saveOpts));

        } else if (entry.type === 'entity') {
          const facts = (entry.metadata['facts'] && typeof entry.metadata['facts'] === 'object')
            ? (entry.metadata['facts'] as Record<string, unknown>)
            : {};
          await db.upsertEntity({
            userId,
            entityName: entry.content,
            entityType: typeof entry.metadata['entityType'] === 'string'
              ? entry.metadata['entityType']
              : 'general',
            facts,
            confidence: typeof entry.metadata['confidence'] === 'number'
              ? entry.metadata['confidence']
              : 0.6,
            source: typeof entry.metadata['source'] === 'string'
              ? entry.metadata['source']
              : 'runtime',
            ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
          });

        } else if (entry.type === 'episodic') {
          await db.saveEpisodicMemory({
            id: entry.id || newUUIDv7(),
            userId,
            content: entry.content,
            messageRole: typeof entry.metadata['messageRole'] === 'string'
              ? entry.metadata['messageRole']
              : 'assistant',
            importance: typeof entry.importance === 'number' ? entry.importance : 0.5,
            tags: Array.isArray(entry.metadata['tags'])
              ? (entry.metadata['tags'] as string[])
              : [],
            ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
          });
        }
        // 'working', 'procedural', 'conversation' — not bridged in this pass
      }
    },

    async query(ctx: ExecutionContext, opts: MemoryQuery): Promise<MemoryEntry[]> {
      const userId = opts.filter?.userId ?? ctx.userId;
      const types = opts.type
        ? [opts.type]
        : (opts.filter?.types ?? ['semantic', 'episodic', 'entity']);

      const limit = opts.topK ?? 10;
      const results: MemoryEntry[] = [];

      if (types.includes('semantic')) {
        const embeddingModel = getActiveGuardrailEmbeddingModel();
        let queryEmbedding: number[] | undefined = opts.embedding
          ? Array.from(opts.embedding) as number[]
          : undefined;

        // Auto-generate embedding for the query string if we have a model
        if (!queryEmbedding && opts.query && embeddingModel && ctx) {
          try {
            const res = await embeddingModel.embed(ctx, { input: [opts.query.slice(0, 2000)] });
            queryEmbedding = res.embeddings[0] as number[] | undefined;
          } catch { /* fall through to keyword search */ }
        }

        let semanticRows: SemanticMemoryRow[] = [];
        if (userId) {
          const backend = getActiveSemanticMemoryBackend();
          if (backend) {
            const backendResults = await backend.search(ctx, {
              userId,
              query: opts.query ?? '',
              limit,
              queryEmbedding,
            });
            semanticRows = backendResults.map((r) => ({
              id: r.id,
              user_id: userId,
              chat_id: null,
              tenant_id: opts.filter?.tenantId ?? null,
              content: r.content,
              memory_type: r.memory_type,
              source: r.source,
              embedding: null,
              metadata: null,
              created_at: '',
              updated_at: '',
            }));
          } else if (opts.query || queryEmbedding) {
            semanticRows = await db.searchSemanticMemory({
              userId,
              query: opts.query ?? '',
              limit,
              queryEmbedding,
            });
          } else {
            semanticRows = await db.listSemanticMemory(userId, limit);
          }
        }
        let entries = semanticRows.map(semanticRowToEntry).filter((e) => matchesBasicFilter(e, opts.filter));

        // If vector search wasn't done by the backend, do it here
        if (opts.embedding && entries.some((e) => e.embedding)) {
          const qEmb = opts.embedding;
          entries = entries
            .filter((e) => e.embedding)
            .map((e) => ({ e, s: cosine(qEmb, e.embedding!) }))
            .filter((r) => !opts.minScore || r.s >= opts.minScore)
            .sort((a, b) => b.s - a.s)
            .slice(0, limit)
            .map((r) => ({ ...r.e, score: r.s }));
        } else {
          entries = entries.slice(0, limit);
        }
        results.push(...entries);
      }

      if (types.includes('entity') && userId) {
        const entityRows = opts.query
          ? await db.searchEntities(userId, opts.query)
          : await db.listEntities(userId);
        const entries = entityRows
          .map(entityRowToEntry)
          .filter((e) => matchesBasicFilter(e, opts.filter))
          .slice(0, limit);
        results.push(...entries);
      }

      if ((types.includes('episodic') || types.includes('conversation')) && userId) {
        const episodicRows = await db.listEpisodicMemory(userId, limit * 2);
        const entries = episodicRows
          .map(episodicRowToEntry)
          .filter((e) => matchesBasicFilter(e, opts.filter));

        // Keyword filter if no vector search
        const filtered = opts.query && !opts.embedding
          ? entries.filter((e) =>
              e.content.toLowerCase().includes(opts.query!.toLowerCase()),
            )
          : entries;
        results.push(...filtered.slice(0, limit));
      }

      // Deduplicate by id and cap to topK
      const seen = new Set<string>();
      const deduped: MemoryEntry[] = [];
      for (const e of results) {
        if (!seen.has(e.id)) { seen.add(e.id); deduped.push(e); }
      }
      return deduped.slice(0, opts.topK ?? 10);
    },

    async delete(_ctx: ExecutionContext, _ids: string[]): Promise<void> {
      // Best-effort: no bulk-delete API on the geneWeave DB adapter
    },

    async clear(_ctx: ExecutionContext, _filter?: MemoryFilter): Promise<void> {
      // Best-effort: no bulk-clear API on the geneWeave DB adapter
    },
  };
}
