/**
 * geneWeave — memory consolidation wiring
 *
 * Bridges @weaveintel/memory's `weaveMemoryConsolidator` into geneWeave.
 * Two trigger modes:
 *
 *   1. Explicit call — `triggerConsolidationForUser(userId, sessionId)` is
 *      invoked from the chat engine after message processing completes.
 *      The consolidation runs asynchronously (fire-and-forget) so it never
 *      blocks the response stream.
 *
 *   2. Cron sweep — when `MEMORY_CONSOLIDATION_CRON=true`, a periodic setInterval
 *      sweeps all unconsolidated episodic entries every hour (configurable via
 *      `MEMORY_CONSOLIDATION_INTERVAL_MS`).
 *
 * The consolidator reads episodic-tagged entries from the SQLite store and
 * writes durable semantic facts to the active semantic-memory backend
 * (pgvector when PGVECTOR_URL is set, SQLite otherwise).
 */

import { createLogger } from '@weaveintel/core';
import type {
  ExecutionContext,
  MemoryStore,
  MemoryEntry,
  MemoryQuery,
  MemoryFilter,
} from '@weaveintel/core';

const logger = createLogger('memory-consolidation');
import { weaveMemoryConsolidator, type MemoryConsolidatorOptions } from '@weaveintel/memory';
import type { DatabaseAdapter } from './db.js';
import { getActiveSemanticMemoryBackend } from './memory-pgvector.js';

// ── SQLite episodic store adapter ─────────────────────────────────────────────

function createEpisodicStore(db: DatabaseAdapter): MemoryStore {
  return {
    async write(_ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void> {
      for (const entry of entries) {
        if (entry.metadata['_consolidated'] && entry.type === 'episodic') {
          // Write a tiny marker row so future queries know this episodic entry was processed.
          try {
            await db.saveSemanticMemory({
              id: `${entry.id}:consolidated_marker`,
              userId: entry.userId ?? 'unknown',
              content: `__consolidated__ ${entry.id}`,
              memoryType: 'episodic',
              source: 'consolidation-marker',
              embedding: undefined,
            });
          } catch {
            // Non-critical — worst case we re-process the entry next run
          }
        } else if (entry.type !== 'episodic') {
          // Persist consolidated semantic facts to the active backend (or SQLite fallback).
          const semanticBackend = getActiveSemanticMemoryBackend();
          try {
            if (semanticBackend) {
              await semanticBackend.save(_ctx, {
                id: entry.id,
                userId: entry.userId ?? _ctx.userId ?? 'unknown',
                content: entry.content,
                memoryType: (entry.type as string) || 'semantic',
                source: (entry.metadata['source'] as string) || 'consolidation',
              });
            } else {
              await db.saveSemanticMemory({
                id: entry.id,
                userId: entry.userId ?? _ctx.userId ?? 'unknown',
                content: entry.content,
                memoryType: (entry.type as string) || 'semantic',
                source: (entry.metadata['source'] as string) || 'consolidation',
                embedding: undefined,
              });
            }
          } catch (err) {
            logger.error(`failed to persist consolidated entry ${entry.id}`, { err });
          }
        }
      }
    },

    async query(_ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      const userId = options.filter?.userId;
      if (!userId) return [];
      const rows = await db.listSemanticMemory(userId, options.topK ?? 50);
      return rows
        .filter((r) => r.source === 'user' || r.memory_type === 'episodic')
        .filter((r) => !r.content.startsWith('__consolidated__'))
        .map((r): MemoryEntry => ({
          id: r.id,
          type: 'episodic',
          content: r.content,
          metadata: { memory_type: r.memory_type, source: r.source },
          createdAt: r.created_at,
          userId,
        }));
    },

    async delete(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      const userId = _ctx.userId ?? 'unknown';
      await Promise.all(ids.map((id) => db.deleteSemanticMemory(id, userId).catch((err) => {
        logger.error(`episodic delete failed for ${id}`, { err });
      })));
    },
    async clear(_ctx: ExecutionContext, filter?: MemoryFilter): Promise<void> {
      const userId = filter?.userId ?? _ctx.userId ?? 'unknown';
      const rows = await db.listSemanticMemory(userId, 10_000);
      const episodic = rows.filter((r) => r.source === 'user' || r.memory_type === 'episodic');
      await Promise.all(episodic.map((r) => db.deleteSemanticMemory(r.id, userId).catch((err) => {
        logger.error(`episodic clear failed for ${r.id}`, { err });
      })));
    },
  };
}

// ── Semantic store adapter (wraps active backend) ────────────────────────────

function createSemanticStore(): MemoryStore {
  return {
    async write(ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void> {
      const backend = getActiveSemanticMemoryBackend();
      if (!backend) return;
      for (const entry of entries) {
        await backend.save(ctx, {
          id: entry.id,
          userId: entry.userId ?? ctx.userId ?? 'unknown',
          content: entry.content,
          memoryType: 'consolidated',
          source: (entry.metadata['_sourceTag'] as string | undefined) ?? 'consolidation',
        });
      }
    },

    async query(ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      const backend = getActiveSemanticMemoryBackend();
      if (!backend) return [];
      const userId = options.filter?.userId ?? ctx.userId ?? 'unknown';
      const rows = await backend.list(userId, options.topK ?? 50);
      return rows.map((r): MemoryEntry => ({
        id: r.id,
        type: 'semantic',
        content: r.content,
        metadata: { memory_type: r.memory_type, source: r.source },
        createdAt: r.created_at,
        userId,
      }));
    },

    async delete(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      const backend = getActiveSemanticMemoryBackend();
      if (!backend) return;
      const userId = _ctx.userId ?? 'unknown';
      await Promise.all(ids.map(async (id) => {
        try {
          // The semantic backend doesn't expose a delete-by-id API; ask the
          // local DB fallback so that SQLite-backed deployments still work.
          const fallbackDb = _consolidatorDb;
          if (fallbackDb) await fallbackDb.deleteSemanticMemory(id, userId);
        } catch (err) {
          logger.error(`semantic delete failed for ${id}`, { err });
        }
      }));
    },
    async clear(_ctx: ExecutionContext, filter?: MemoryFilter): Promise<void> {
      const userId = filter?.userId ?? _ctx.userId ?? 'unknown';
      const fallbackDb = _consolidatorDb;
      if (!fallbackDb) return;
      const rows = await fallbackDb.listSemanticMemory(userId, 10_000);
      await Promise.all(rows.map((r) => fallbackDb.deleteSemanticMemory(r.id, userId).catch((err) => {
        logger.error(`semantic clear failed for ${r.id}`, { err });
      })));
    },
  };
}

// ── Module-level consolidator singleton ──────────────────────────────────────

let _consolidatorDb: DatabaseAdapter | null = null;
let _runConsolidation: ((userId: string | undefined, sessionId: string | undefined) => Promise<void>) | null = null;

/**
 * Initialise memory consolidation.  Call once from `createGeneWeave()` after
 * the semantic memory backend is ready.
 */
export function initMemoryConsolidation(opts: {
  db: DatabaseAdapter;
  llmExtractor?: MemoryConsolidatorOptions['llmExtractor'];
}): void {
  if (_consolidatorDb) {
    if (_consolidatorDb !== opts.db) {
      logger.warn('initMemoryConsolidation called with a different DatabaseAdapter — re-initialisation is ignored. Call resetMemoryConsolidation() first if you need to swap the DB instance.');
    }
    return;
  }
  _consolidatorDb = opts.db;

  const consolidator = weaveMemoryConsolidator({
    episodicStore: createEpisodicStore(opts.db),
    semanticStore: createSemanticStore(),
    llmExtractor: opts.llmExtractor,
    minConfidence: 0.6,
    sourceTag: 'geneweave-consolidation',
  });

  _runConsolidation = async (userId: string | undefined, sessionId: string | undefined) => {
    const ctx: ExecutionContext = {
      executionId: `consolidation:${sessionId ?? userId ?? Date.now()}`,
      userId: userId ?? undefined,
      metadata: { sessionId, userId },
      tracer: { trace: () => { /* noop */ }, span: () => { /* noop */ } },
    } as unknown as ExecutionContext;

    try {
      const result = await consolidator.consolidate(ctx, { userId, sessionId, batchSize: 50 });
      if (result.factsWritten > 0 || result.errors.length > 0) {
        logger.info('consolidation run', {
          userId: userId ?? '-', sessionId: sessionId ?? '-',
          read: result.episodicRead, extracted: result.factsExtracted,
          deduped: result.factsDeduped, written: result.factsWritten,
          errors: result.errors.length ? result.errors.join('; ') : undefined,
        });
      }
    } catch (err) {
      logger.warn('consolidation run failed', { err: String(err) });
    }
  };

  // Optional cron sweep
  if (process.env['MEMORY_CONSOLIDATION_CRON'] === 'true') {
    const intervalMs = parseInt(process.env['MEMORY_CONSOLIDATION_INTERVAL_MS'] ?? '3600000', 10);
    setInterval(() => {
      void _runConsolidation?.(undefined, undefined);
    }, intervalMs);
    logger.info(`cron sweep active — interval ${intervalMs / 1000}s`);
  }

  logger.info('memory consolidation initialised');
}

/**
 * Trigger consolidation for a user/session asynchronously (fire-and-forget).
 * Call this after a message is processed — it never blocks the response.
 */
export function triggerConsolidationForUser(userId: string, sessionId?: string): void {
  if (!_runConsolidation) return;
  void _runConsolidation(userId, sessionId);
}

export { weaveMemoryConsolidator } from '@weaveintel/memory';
export type { MemoryConsolidatorOptions } from '@weaveintel/memory';
