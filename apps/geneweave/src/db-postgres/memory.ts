// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IMemoryStore` domain slice of the geneWeave `DatabaseAdapter` — website
 * credentials, SSO linked accounts, and the five memory tiers (semantic, entity, episodic,
 * procedural, working) plus memory settings and extraction events.
 *
 * Each method mirrors the SQLite implementation in `../db-sqlite.ts` statement-for-statement: same SQL,
 * same column order, same integer-boolean (0/1) and TEXT-JSON conventions. Only the SQLite→Postgres
 * dialect differs — `?`→`$n`, `datetime('now')`→`${ctx.now}`, text `ORDER BY`→`COLLATE "C"` (byte
 * order), `INSERT OR REPLACE`→`ON CONFLICT (...) DO UPDATE`, and `COLLATE NOCASE`→`LOWER(...)`.
 *
 * Semantic-memory vector search keeps the SQLite approach EXACTLY: candidate rows are pulled with SQL
 * (`embedding IS NOT NULL`), then cosine similarity, the relevance gate, and the top-K sort all run
 * in JS over the stored embedding TEXT — NOT pgvector. Only the SQL execution changes.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  SemanticMemoryRow,
  EntityMemoryRow,
  MemoryExtractionEventRow,
  WebsiteCredentialRow,
  SSOLinkedAccountRow,
  EpisodicMemoryRow,
  ProceduralMemoryRow,
  WorkingMemorySnapshotRow,
  MemorySettingsRow,
} from '../db-types/memory.js';

/** Cosine similarity over two equal-length embedding vectors — byte-identical to the SQLite adapter's. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export function pgMemoryStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Semantic Memory ───────────────────────────────────────
    async saveSemanticMemory(m: {
      id: string;
      userId: string;
      chatId?: string;
      tenantId?: string;
      content: string;
      memoryType?: string;
      source?: string;
      embedding?: number[];
      metadata?: string;
    }): Promise<void> {
      const embeddingJson = m.embedding && m.embedding.length > 0
        ? JSON.stringify(m.embedding)
        : null;
      // Upsert so the @weaveintel/memory correction/supersede round-trip can
      // rewrite an existing entry (same id) in place while preserving lineage.
      await ctx.query(
        `INSERT INTO semantic_memory (id, user_id, chat_id, tenant_id, content, memory_type, source, embedding, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(id) DO UPDATE SET
           content    = excluded.content,
           memory_type = excluded.memory_type,
           source     = excluded.source,
           embedding  = excluded.embedding,
           metadata   = excluded.metadata,
           updated_at = ${ctx.now}`,
        [
          m.id, m.userId, m.chatId ?? null, m.tenantId ?? null,
          m.content, m.memoryType ?? 'semantic', m.source ?? 'assistant',
          embeddingJson, m.metadata ?? null,
        ],
      );
    },

    async getSemanticMemoryById(id: string, userId: string): Promise<SemanticMemoryRow | null> {
      const { rows } = await ctx.query(
        'SELECT * FROM semantic_memory WHERE id = $1 AND user_id = $2',
        [id, userId],
      );
      return (rows[0] as SemanticMemoryRow | undefined) ?? null;
    },

    async searchSemanticMemory(opts: {
      userId: string;
      query: string;
      limit?: number;
      queryEmbedding?: number[];
    }): Promise<SemanticMemoryRow[]> {
      const limit = opts.limit ?? 5;

      // ── Vector search: when a query embedding is supplied and the user has
      // stored embeddings, rank by cosine similarity instead of keyword score.
      if (opts.queryEmbedding && opts.queryEmbedding.length > 0) {
        const { rows } = await ctx.query(
          'SELECT * FROM semantic_memory WHERE user_id = $1 AND embedding IS NOT NULL ORDER BY created_at COLLATE "C" DESC LIMIT 200',
          [opts.userId],
        );
        const candidates = rows as unknown as SemanticMemoryRow[];

        if (candidates.length > 0) {
          const qVec = opts.queryEmbedding;
          const scored = candidates.map((row) => {
            let sim = 0;
            try {
              const vec = JSON.parse(row.embedding!) as number[];
              sim = cosineSimilarity(qVec, vec);
            } catch { /* skip malformed */ }
            return { row, sim };
          });
          scored.sort((a, b) => b.sim - a.sim);
          // Relevance gate: drop noise so unrelated facts don't surface for an
          // off-topic query. Without this, top-K returns even when nothing matches.
          // Absolute floor + relative cutoff against the best score; tunable via env.
          const absFloor = (() => {
            const raw = Number.parseFloat(process.env['SEMANTIC_MEMORY_MIN_SIM'] ?? '');
            return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.20;
          })();
          const relFloor = (() => {
            const raw = Number.parseFloat(process.env['SEMANTIC_MEMORY_REL_FLOOR'] ?? '');
            return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.60;
          })();
          const topSim = scored[0]?.sim ?? 0;
          const cutoff = Math.max(absFloor, topSim * relFloor);
          const filtered = scored.filter((s) => s.sim >= cutoff);
          return filtered.slice(0, limit).map((s) => s.row);
        }
      }

      // ── Keyword fallback ───────────────────────────────────────────────────
      const words = opts.query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      if (words.length === 0) {
        const { rows } = await ctx.query(
          'SELECT * FROM semantic_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2',
          [opts.userId, limit],
        );
        return rows as unknown as SemanticMemoryRow[];
      }
      const likeParams = words.map(w => `%${w}%`);
      // Placeholder numbering mirrors the SQLite arg order: score LIKEs, then user_id, then WHERE LIKEs, then limit.
      const scoreParts = words.map((_, i) => `CASE WHEN LOWER(content) LIKE $${i + 1} THEN 1 ELSE 0 END`).join(' + ');
      const userIdPos = words.length + 1;
      const whereParts = words.map((_, i) => `LOWER(content) LIKE $${userIdPos + 1 + i}`).join(' OR ');
      const limitPos = userIdPos + words.length + 1;
      const sql = `
        SELECT *, (${scoreParts}) AS _score
        FROM semantic_memory
        WHERE user_id = $${userIdPos} AND (${whereParts})
        ORDER BY _score DESC, created_at COLLATE "C" DESC
        LIMIT $${limitPos}
      `;
      const { rows } = await ctx.query(sql, [...likeParams, opts.userId, ...likeParams, limit]);
      return rows as unknown as SemanticMemoryRow[];
    },

    async listSemanticMemory(userId: string, limit = 20): Promise<SemanticMemoryRow[]> {
      // `id` tiebreaker (byte-order to match SQLite): same-millisecond rows share created_at, so without
      // it newest-first is nondeterministic and diverges from SQLite — a cross-engine parity flake.
      const { rows } = await ctx.query(
        'SELECT * FROM semantic_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC, id COLLATE "C" DESC LIMIT $2',
        [userId, limit],
      );
      return rows as unknown as SemanticMemoryRow[];
    },

    async deleteSemanticMemory(id: string, userId: string): Promise<void> {
      await ctx.query('DELETE FROM semantic_memory WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    async clearUserSemanticMemory(userId: string): Promise<void> {
      await ctx.query('DELETE FROM semantic_memory WHERE user_id = $1', [userId]);
    },

    async trimSemanticMemoryForUser(userId: string, maxEntries: number): Promise<void> {
      const { rows } = await ctx.query(
        'SELECT COUNT(*) AS n FROM semantic_memory WHERE user_id = $1',
        [userId],
      );
      const count = Number((rows[0] as { n: number | string }).n);
      if (count <= maxEntries) return;
      const excess = count - maxEntries;
      await ctx.query(
        `DELETE FROM semantic_memory WHERE id IN (
           SELECT id FROM semantic_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" ASC LIMIT $2
         )`,
        [userId, excess],
      );
    },

    async purgeSemanticMemoryOlderThan(userId: string, cutoffMs: number): Promise<void> {
      const cutoffSec = Math.floor(cutoffMs / 1000);
      // SQLite `strftime('%s', created_at)` → epoch seconds. Postgres reads the TEXT timestamp back as
      // a UTC timestamp and converts it to epoch, matching the same numeric comparison.
      await ctx.query(
        `DELETE FROM semantic_memory WHERE user_id = $1 AND EXTRACT(EPOCH FROM (created_at::timestamp AT TIME ZONE 'utc')) < $2`,
        [userId, cutoffSec],
      );
    },

    async listAllSemanticMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<SemanticMemoryRow[]> {
      if (opts.userId) {
        const { rows } = await ctx.query(
          'SELECT * FROM semantic_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2 OFFSET $3',
          [opts.userId, opts.limit ?? 50, opts.offset ?? 0],
        );
        return rows as unknown as SemanticMemoryRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM semantic_memory ORDER BY created_at COLLATE "C" DESC LIMIT $1 OFFSET $2',
        [opts.limit ?? 50, opts.offset ?? 0],
      );
      return rows as unknown as SemanticMemoryRow[];
    },

    // ─── Entity Memory ─────────────────────────────────────────
    async upsertEntity(e: {
      userId: string;
      entityName: string;
      entityType?: string;
      facts: Record<string, unknown>;
      confidence?: number;
      source?: string;
      chatId?: string;
      tenantId?: string;
    }): Promise<void> {
      // Merge facts: read existing JSON and merge with new facts
      const { rows: existingRows } = await ctx.query(
        'SELECT facts, confidence, source FROM entity_memory WHERE user_id = $1 AND entity_name = $2',
        [e.userId, e.entityName],
      );
      const existing = existingRows[0] as { facts: string; confidence: number; source: string } | undefined;
      const merged = existing ? { ...JSON.parse(existing.facts), ...e.facts } : e.facts;
      const incomingConfidence = Math.max(0, Math.min(1, e.confidence ?? 0.6));
      const existingConfidence = existing?.confidence ?? 0;
      const chosenConfidence = Math.max(existingConfidence, incomingConfidence);
      const chosenSource = incomingConfidence >= existingConfidence ? (e.source ?? 'regex') : (existing?.source ?? 'regex');
      await ctx.query(
        `INSERT INTO entity_memory (id, user_id, chat_id, tenant_id, entity_name, entity_type, facts, confidence, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(user_id, entity_name) DO UPDATE SET
           entity_type = excluded.entity_type,
           facts = $10,
           confidence = $11,
           source = $12,
           chat_id = COALESCE(excluded.chat_id, entity_memory.chat_id),
           updated_at = ${ctx.now}`,
        [
          newUUIDv7(), e.userId, e.chatId ?? null, e.tenantId ?? null,
          e.entityName, e.entityType ?? 'general', JSON.stringify(merged), chosenConfidence, chosenSource,
          JSON.stringify(merged),
          chosenConfidence,
          chosenSource,
        ],
      );
    },

    async getEntity(userId: string, entityName: string): Promise<EntityMemoryRow | null> {
      // SQLite `COLLATE NOCASE` on entity_name → case-insensitive match via LOWER(...).
      const { rows } = await ctx.query(
        'SELECT * FROM entity_memory WHERE user_id = $1 AND LOWER(entity_name) = LOWER($2)',
        [userId, entityName],
      );
      return (rows[0] as EntityMemoryRow | undefined) ?? null;
    },

    async searchEntities(userId: string, query: string): Promise<EntityMemoryRow[]> {
      const q = `%${query}%`;
      const { rows } = await ctx.query(
        `SELECT * FROM entity_memory WHERE user_id = $1
         AND (LOWER(entity_name) LIKE LOWER($2) OR LOWER(facts) LIKE LOWER($3))
         ORDER BY updated_at COLLATE "C" DESC LIMIT 10`,
        [userId, q, q],
      );
      return rows as unknown as EntityMemoryRow[];
    },

    async listEntities(userId: string): Promise<EntityMemoryRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM entity_memory WHERE user_id = $1 ORDER BY entity_type COLLATE "C" ASC, entity_name COLLATE "C" ASC',
        [userId],
      );
      return rows as unknown as EntityMemoryRow[];
    },

    async deleteEntity(userId: string, entityName: string): Promise<number> {
      const res = await ctx.query('DELETE FROM entity_memory WHERE user_id = $1 AND entity_name = $2', [userId, entityName]);
      return (res as unknown as { rowCount?: number }).rowCount ?? 0;
    },

    async clearUserEntityMemory(userId: string): Promise<void> {
      await ctx.query('DELETE FROM entity_memory WHERE user_id = $1', [userId]);
    },

    async trimEntityMemoryForUser(userId: string, maxEntries: number): Promise<void> {
      const { rows } = await ctx.query(
        'SELECT COUNT(*) AS n FROM entity_memory WHERE user_id = $1',
        [userId],
      );
      const count = Number((rows[0] as { n: number | string }).n);
      if (count <= maxEntries) return;
      const excess = count - maxEntries;
      await ctx.query(
        `DELETE FROM entity_memory WHERE id IN (
           SELECT id FROM entity_memory WHERE user_id = $1 ORDER BY updated_at COLLATE "C" ASC LIMIT $2
         )`,
        [userId, excess],
      );
    },

    async listAllEntityMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<EntityMemoryRow[]> {
      if (opts.userId) {
        const { rows } = await ctx.query(
          'SELECT * FROM entity_memory WHERE user_id = $1 ORDER BY updated_at COLLATE "C" DESC LIMIT $2 OFFSET $3',
          [opts.userId, opts.limit ?? 50, opts.offset ?? 0],
        );
        return rows as unknown as EntityMemoryRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM entity_memory ORDER BY updated_at COLLATE "C" DESC LIMIT $1 OFFSET $2',
        [opts.limit ?? 50, opts.offset ?? 0],
      );
      return rows as unknown as EntityMemoryRow[];
    },

    async recordMemoryExtractionEvent(e: {
      id: string;
      userId: string;
      chatId?: string;
      tenantId?: string;
      selfDisclosure: boolean;
      regexEntitiesCount: number;
      llmEntitiesCount: number;
      mergedEntitiesCount: number;
      events?: string;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO memory_extraction_events
         (id, user_id, chat_id, tenant_id, self_disclosure, regex_entities_count, llm_entities_count, merged_entities_count, events)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          e.id,
          e.userId,
          e.chatId ?? null,
          e.tenantId ?? null,
          e.selfDisclosure ? 1 : 0,
          e.regexEntitiesCount,
          e.llmEntitiesCount,
          e.mergedEntitiesCount,
          e.events ?? null,
        ],
      );
    },

    async getMemoryExtractionEvent(id: string): Promise<MemoryExtractionEventRow | null> {
      const { rows } = await ctx.query('SELECT * FROM memory_extraction_events WHERE id = $1', [id]);
      return (rows[0] as MemoryExtractionEventRow | undefined) ?? null;
    },

    async listMemoryExtractionEvents(chatId?: string, limit = 100): Promise<MemoryExtractionEventRow[]> {
      if (chatId) {
        const { rows } = await ctx.query(
          'SELECT * FROM memory_extraction_events WHERE chat_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2',
          [chatId, limit],
        );
        return rows as unknown as MemoryExtractionEventRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM memory_extraction_events ORDER BY created_at COLLATE "C" DESC LIMIT $1',
        [limit],
      );
      return rows as unknown as MemoryExtractionEventRow[];
    },

    async listAllMemoryExtractionEvents(opts: { userId?: string; limit?: number; offset?: number }): Promise<MemoryExtractionEventRow[]> {
      if (opts.userId) {
        const { rows } = await ctx.query(
          'SELECT * FROM memory_extraction_events WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2 OFFSET $3',
          [opts.userId, opts.limit ?? 50, opts.offset ?? 0],
        );
        return rows as unknown as MemoryExtractionEventRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM memory_extraction_events ORDER BY created_at COLLATE "C" DESC LIMIT $1 OFFSET $2',
        [opts.limit ?? 50, opts.offset ?? 0],
      );
      return rows as unknown as MemoryExtractionEventRow[];
    },

    // ─── Episodic Memory ────────────────────────────────────────
    async saveEpisodicMemory(e: { id: string; userId: string; chatId?: string; tenantId?: string; messageRole?: string; content: string; importance?: number; tags?: string[] }): Promise<void> {
      await ctx.query(
        `INSERT INTO episodic_memory (id, user_id, chat_id, tenant_id, message_role, content, importance, tags, consolidated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
        [
          e.id, e.userId, e.chatId ?? null, e.tenantId ?? null,
          e.messageRole ?? 'user', e.content,
          e.importance ?? 0.5,
          e.tags && e.tags.length > 0 ? JSON.stringify(e.tags) : null,
        ],
      );
    },

    async listEpisodicMemory(userId: string, limit = 50): Promise<EpisodicMemoryRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM episodic_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2',
        [userId, limit],
      );
      return rows as unknown as EpisodicMemoryRow[];
    },

    async listUnconsolidatedEpisodic(userId: string, limit = 100): Promise<EpisodicMemoryRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM episodic_memory WHERE user_id = $1 AND consolidated = 0 ORDER BY created_at COLLATE "C" ASC LIMIT $2',
        [userId, limit],
      );
      return rows as unknown as EpisodicMemoryRow[];
    },

    async markEpisodicConsolidated(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      await ctx.query(`UPDATE episodic_memory SET consolidated = 1 WHERE id IN (${placeholders})`, ids);
    },

    async deleteEpisodicMemory(id: string, userId: string): Promise<void> {
      await ctx.query('DELETE FROM episodic_memory WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    async clearUserEpisodicMemory(userId: string): Promise<void> {
      await ctx.query('DELETE FROM episodic_memory WHERE user_id = $1', [userId]);
    },

    async trimEpisodicMemoryForUser(userId: string, maxEntries: number): Promise<void> {
      const { rows } = await ctx.query('SELECT COUNT(*) AS n FROM episodic_memory WHERE user_id = $1', [userId]);
      const count = Number((rows[0] as { n: number | string }).n);
      if (count <= maxEntries) return;
      const excess = count - maxEntries;
      const { rows: oldestRows } = await ctx.query(
        'SELECT id FROM episodic_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" ASC LIMIT $2',
        [userId, excess],
      );
      const oldest = oldestRows as unknown as { id: string }[];
      for (const row of oldest) {
        await ctx.query('DELETE FROM episodic_memory WHERE id = $1', [row.id]);
      }
    },

    async listAllEpisodicMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<EpisodicMemoryRow[]> {
      if (opts.userId) {
        const { rows } = await ctx.query(
          'SELECT * FROM episodic_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2 OFFSET $3',
          [opts.userId, opts.limit ?? 50, opts.offset ?? 0],
        );
        return rows as unknown as EpisodicMemoryRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM episodic_memory ORDER BY created_at COLLATE "C" DESC LIMIT $1 OFFSET $2',
        [opts.limit ?? 50, opts.offset ?? 0],
      );
      return rows as unknown as EpisodicMemoryRow[];
    },

    // ─── Procedural Memory ──────────────────────────────────────
    async createProceduralMemory(p: Omit<ProceduralMemoryRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO procedural_memory
           (id, user_id, agent_id, instruction_delta, proposed_by, status, confidence, human_task_id, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [p.id, p.user_id, p.agent_id, p.instruction_delta, p.proposed_by, p.status, p.confidence, p.human_task_id ?? null, p.applied_at ?? null],
      );
    },

    async getProceduralMemory(id: string): Promise<ProceduralMemoryRow | null> {
      const { rows } = await ctx.query('SELECT * FROM procedural_memory WHERE id = $1', [id]);
      return (rows[0] as ProceduralMemoryRow | undefined) ?? null;
    },

    async listProceduralMemory(userId: string, status?: string): Promise<ProceduralMemoryRow[]> {
      if (status) {
        const { rows } = await ctx.query(
          'SELECT * FROM procedural_memory WHERE user_id = $1 AND status = $2 ORDER BY created_at COLLATE "C" DESC',
          [userId, status],
        );
        return rows as unknown as ProceduralMemoryRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM procedural_memory WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC',
        [userId],
      );
      return rows as unknown as ProceduralMemoryRow[];
    },

    async listAllProceduralMemory(opts: { userId?: string; status?: string; limit?: number; offset?: number }): Promise<ProceduralMemoryRow[]> {
      const parts: string[] = [];
      const vals: unknown[] = [];
      if (opts.userId) { parts.push(`user_id = $${vals.length + 1}`); vals.push(opts.userId); }
      if (opts.status) { parts.push(`status = $${vals.length + 1}`); vals.push(opts.status); }
      const where = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
      const limitPos = vals.length + 1;
      const offsetPos = vals.length + 2;
      vals.push(opts.limit ?? 50, opts.offset ?? 0);
      const { rows } = await ctx.query(
        `SELECT * FROM procedural_memory ${where} ORDER BY created_at COLLATE "C" DESC LIMIT $${limitPos} OFFSET $${offsetPos}`,
        vals,
      );
      return rows as unknown as ProceduralMemoryRow[];
    },

    async updateProceduralMemoryStatus(id: string, status: string, appliedAt?: string): Promise<void> {
      if (appliedAt) {
        await ctx.query(
          `UPDATE procedural_memory SET status = $1, applied_at = $2, updated_at = ${ctx.now} WHERE id = $3`,
          [status, appliedAt, id],
        );
      } else {
        await ctx.query(
          `UPDATE procedural_memory SET status = $1, updated_at = ${ctx.now} WHERE id = $2`,
          [status, id],
        );
      }
    },

    async deleteProceduralMemory(id: string): Promise<void> {
      await ctx.query('DELETE FROM procedural_memory WHERE id = $1', [id]);
    },

    async listAppliedProcedural(userId: string, agentId?: string): Promise<ProceduralMemoryRow[]> {
      if (agentId) {
        const { rows } = await ctx.query(
          `SELECT * FROM procedural_memory WHERE user_id = $1 AND agent_id = $2 AND status = 'applied' ORDER BY applied_at COLLATE "C" DESC`,
          [userId, agentId],
        );
        return rows as unknown as ProceduralMemoryRow[];
      }
      const { rows } = await ctx.query(
        `SELECT * FROM procedural_memory WHERE user_id = $1 AND status = 'applied' ORDER BY applied_at COLLATE "C" DESC`,
        [userId],
      );
      return rows as unknown as ProceduralMemoryRow[];
    },

    // ─── Working Memory Snapshots ────────────────────────────────
    async saveWorkingMemorySnapshot(s: { id: string; userId: string; chatId?: string; agentId?: string; content: Record<string, unknown> }): Promise<void> {
      await ctx.query(
        `INSERT INTO working_memory_snapshots (id, user_id, chat_id, agent_id, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [s.id, s.userId, s.chatId ?? null, s.agentId ?? 'default', JSON.stringify(s.content)],
      );
    },

    async getLatestWorkingMemory(userId: string, agentId?: string): Promise<WorkingMemorySnapshotRow | null> {
      if (agentId) {
        const { rows } = await ctx.query(
          'SELECT * FROM working_memory_snapshots WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at COLLATE "C" DESC LIMIT 1',
          [userId, agentId],
        );
        return (rows[0] as WorkingMemorySnapshotRow | undefined) ?? null;
      }
      const { rows } = await ctx.query(
        'SELECT * FROM working_memory_snapshots WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT 1',
        [userId],
      );
      return (rows[0] as WorkingMemorySnapshotRow | undefined) ?? null;
    },

    async listWorkingMemorySnapshots(userId: string, limit = 20): Promise<WorkingMemorySnapshotRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM working_memory_snapshots WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2',
        [userId, limit],
      );
      return rows as unknown as WorkingMemorySnapshotRow[];
    },

    async listAllWorkingMemorySnapshots(opts: { userId?: string; limit?: number; offset?: number }): Promise<WorkingMemorySnapshotRow[]> {
      if (opts.userId) {
        const { rows } = await ctx.query(
          'SELECT * FROM working_memory_snapshots WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT $2 OFFSET $3',
          [opts.userId, opts.limit ?? 50, opts.offset ?? 0],
        );
        return rows as unknown as WorkingMemorySnapshotRow[];
      }
      const { rows } = await ctx.query(
        'SELECT * FROM working_memory_snapshots ORDER BY created_at COLLATE "C" DESC LIMIT $1 OFFSET $2',
        [opts.limit ?? 50, opts.offset ?? 0],
      );
      return rows as unknown as WorkingMemorySnapshotRow[];
    },

    async deleteWorkingMemorySnapshot(id: string, userId: string): Promise<void> {
      await ctx.query('DELETE FROM working_memory_snapshots WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    async clearUserWorkingMemory(userId: string): Promise<void> {
      await ctx.query('DELETE FROM working_memory_snapshots WHERE user_id = $1', [userId]);
    },

    // ─── Memory Settings ────────────────────────────────────────
    async getMemorySettings(tenantId?: string): Promise<MemorySettingsRow | null> {
      // Try tenant-specific first; fall back to global (tenant_id IS NULL)
      if (tenantId) {
        const { rows } = await ctx.query(
          'SELECT * FROM memory_settings WHERE tenant_id = $1',
          [tenantId],
        );
        const row = (rows[0] as MemorySettingsRow | undefined) ?? null;
        if (row) return row;
      }
      const { rows } = await ctx.query(
        'SELECT * FROM memory_settings WHERE tenant_id IS NULL LIMIT 1',
        [],
      );
      return (rows[0] as MemorySettingsRow | undefined) ?? null;
    },

    async upsertMemorySettings(s: Omit<MemorySettingsRow, 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO memory_settings
           (id, tenant_id, enable_semantic, enable_entity, enable_episodic,
            enable_procedural, enable_working, auto_extract_on_turn,
            consolidation_enabled, consolidation_interval_min,
            max_episodic_per_user, max_semantic_per_user, max_entity_per_user,
            updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${ctx.now})
         ON CONFLICT(id) DO UPDATE SET
           enable_semantic = excluded.enable_semantic,
           enable_entity = excluded.enable_entity,
           enable_episodic = excluded.enable_episodic,
           enable_procedural = excluded.enable_procedural,
           enable_working = excluded.enable_working,
           auto_extract_on_turn = excluded.auto_extract_on_turn,
           consolidation_enabled = excluded.consolidation_enabled,
           consolidation_interval_min = excluded.consolidation_interval_min,
           max_episodic_per_user = excluded.max_episodic_per_user,
           max_semantic_per_user = excluded.max_semantic_per_user,
           max_entity_per_user = excluded.max_entity_per_user,
           updated_at = ${ctx.now}`,
        [
          s.id, s.tenant_id ?? null,
          s.enable_semantic ? 1 : 0, s.enable_entity ? 1 : 0, s.enable_episodic ? 1 : 0,
          s.enable_procedural ? 1 : 0, s.enable_working ? 1 : 0, s.auto_extract_on_turn ? 1 : 0,
          s.consolidation_enabled ? 1 : 0, s.consolidation_interval_min,
          s.max_episodic_per_user, s.max_semantic_per_user, s.max_entity_per_user,
        ],
      );
    },

    async listMemorySettings(): Promise<MemorySettingsRow[]> {
      const { rows } = await ctx.query('SELECT * FROM memory_settings ORDER BY tenant_id COLLATE "C" ASC NULLS FIRST', []);
      return rows as unknown as MemorySettingsRow[];
    },

    // ─── Website Credentials (Browser Auth Vault) ──────────────
    async createWebsiteCredential(c: Omit<WebsiteCredentialRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO website_credentials (id, user_id, site_name, site_url_pattern, auth_method, credentials_encrypted, encryption_iv, last_used_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [c.id, c.user_id, c.site_name, c.site_url_pattern, c.auth_method, c.credentials_encrypted, c.encryption_iv, c.last_used_at ?? null, c.status],
      );
    },

    async getWebsiteCredential(id: string, userId: string): Promise<WebsiteCredentialRow | null> {
      const { rows } = await ctx.query('SELECT * FROM website_credentials WHERE id = $1 AND user_id = $2', [id, userId]);
      return (rows[0] as WebsiteCredentialRow | undefined) ?? null;
    },

    async listWebsiteCredentials(userId: string): Promise<WebsiteCredentialRow[]> {
      const { rows } = await ctx.query('SELECT * FROM website_credentials WHERE user_id = $1 ORDER BY updated_at COLLATE "C" DESC', [userId]);
      return rows as unknown as WebsiteCredentialRow[];
    },

    async listAllActiveWebsiteCredentials(): Promise<WebsiteCredentialRow[]> {
      const { rows } = await ctx.query(`SELECT * FROM website_credentials WHERE status = 'active' ORDER BY updated_at COLLATE "C" DESC`, []);
      return rows as unknown as WebsiteCredentialRow[];
    },

    async findWebsiteCredential(userId: string, url: string): Promise<WebsiteCredentialRow | null> {
      // Find credentials where the URL matches the site_url_pattern using glob-style matching
      const { rows } = await ctx.query(
        `SELECT * FROM website_credentials WHERE user_id = $1 AND status = 'active' ORDER BY last_used_at COLLATE "C" DESC`,
        [userId],
      );
      const creds = rows as unknown as WebsiteCredentialRow[];
      for (const row of creds) {
        const pattern = row.site_url_pattern;
        // Convert simple glob to regex: *.example.com/* → .*\.example\.com\/.*
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        if (new RegExp(`^${escaped}$`, 'i').test(url)) return row;
      }
      return null;
    },

    async updateWebsiteCredential(id: string, userId: string, fields: Partial<Omit<WebsiteCredentialRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<void> {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = ${ctx.now}`);
      const idPos = vals.length + 1;
      const userIdPos = vals.length + 2;
      vals.push(id, userId);
      await ctx.query(`UPDATE website_credentials SET ${sets.join(', ')} WHERE id = $${idPos} AND user_id = $${userIdPos}`, vals);
    },

    async deleteWebsiteCredential(id: string, userId: string): Promise<void> {
      await ctx.query('DELETE FROM website_credentials WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    // ─── SSO Linked Accounts (for SSO pass-through) ─────────────
    async createSSOLinkedAccount(acct: { id: string; user_id: string; identity_provider: string; email?: string; session_encrypted: string; encryption_iv: string }): Promise<void> {
      // SQLite `INSERT OR REPLACE` on the (user_id, identity_provider) unique key → upsert.
      await ctx.query(
        `INSERT INTO sso_linked_accounts (id, user_id, identity_provider, email, session_encrypted, encryption_iv)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, identity_provider) DO UPDATE SET
           id = excluded.id,
           email = excluded.email,
           session_encrypted = excluded.session_encrypted,
           encryption_iv = excluded.encryption_iv`,
        [acct.id, acct.user_id, acct.identity_provider, acct.email ?? null, acct.session_encrypted, acct.encryption_iv],
      );
    },

    async getSSOLinkedAccount(userId: string, identityProvider: string): Promise<SSOLinkedAccountRow | null> {
      const { rows } = await ctx.query(
        `SELECT * FROM sso_linked_accounts WHERE user_id = $1 AND identity_provider = $2 AND status = 'active'`,
        [userId, identityProvider],
      );
      return (rows[0] as SSOLinkedAccountRow | undefined) ?? null;
    },

    async listSSOLinkedAccounts(userId: string): Promise<Array<Omit<SSOLinkedAccountRow, 'session_encrypted' | 'encryption_iv'>>> {
      const { rows } = await ctx.query(
        `SELECT id, user_id, identity_provider, email, status, linked_at, updated_at
         FROM sso_linked_accounts
         WHERE user_id = $1 AND status = 'active'
         ORDER BY linked_at COLLATE "C" DESC`,
        [userId],
      );
      return rows as unknown as Array<Omit<SSOLinkedAccountRow, 'session_encrypted' | 'encryption_iv'>>;
    },

    async deleteSSOLinkedAccount(userId: string, identityProvider: string): Promise<void> {
      await ctx.query('DELETE FROM sso_linked_accounts WHERE user_id = $1 AND identity_provider = $2', [userId, identityProvider]);
    },
  };
}
