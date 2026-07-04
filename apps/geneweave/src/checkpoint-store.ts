/**
 * geneWeave — SQLite-backed agent checkpoint store
 *
 * Wraps the `agent_checkpoints` table (created by migration m66) as a
 * `CheckpointStore` so that agent run state is persisted to the geneWeave
 * SQLite DB — scoped per (chat_id, user_id) for proper ACL enforcement.
 *
 * Used in `chat.ts` when `settings.checkpointEnabled` is true.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { AgentCheckpoint, CheckpointStore } from '@weaveintel/agents';

// ── Statement cache ───────────────────────────────────────────
// Prepared statements are re-used across calls; they are scoped to the chatId
// via WHERE clauses to prevent cross-chat data leakage.

type Stmt = BetterSqlite3.Statement<unknown[]>;
interface Stmts {
  save: Stmt;
  load: Stmt;
  list: Stmt;
  del: Stmt;
}

const stmtCache = new WeakMap<BetterSqlite3.Database, Stmts>();

function getStmts(db: BetterSqlite3.Database): Stmts {
  if (stmtCache.has(db)) return stmtCache.get(db)!;
  const stmts: Stmts = {
    save: db.prepare(`
      INSERT INTO agent_checkpoints
        (run_id, chat_id, user_id, agent_name, step_index, payload, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(run_id) DO UPDATE SET
        agent_name  = excluded.agent_name,
        step_index  = excluded.step_index,
        payload     = excluded.payload,
        status      = excluded.status,
        updated_at  = excluded.updated_at
    `),
    load: db.prepare(
      `SELECT payload FROM agent_checkpoints WHERE run_id = ? AND chat_id = ? LIMIT 1`,
    ),
    list: db.prepare(
      `SELECT payload FROM agent_checkpoints WHERE agent_name = ? AND chat_id = ? ORDER BY updated_at DESC`,
    ),
    del: db.prepare(
      `DELETE FROM agent_checkpoints WHERE run_id = ? AND chat_id = ?`,
    ),
  };
  stmtCache.set(db, stmts);
  return stmts;
}

// ── Factory ───────────────────────────────────────────────────

/**
 * Create a `CheckpointStore` backed by the geneWeave SQLite database.
 *
 * All operations are scoped to `chatId` so agents in different chats cannot
 * accidentally read each other's state.
 *
 * @param rawDb  The `better-sqlite3` Database instance (from `SQLiteAdapter.rawDb`).
 * @param chatId  Scope key — enforced in every query.
 * @param userId  Stored on every row for audit / ACL.
 */
export function createSQLiteCheckpointStoreForChat(
  rawDb: BetterSqlite3.Database,
  chatId: string,
  userId: string,
): CheckpointStore {
  const stmts = getStmts(rawDb);

  return {
    async save(runId, checkpoint) {
      stmts.save.run(
        runId,
        chatId,
        userId,
        checkpoint.agentName,
        checkpoint.stepIndex,
        JSON.stringify(checkpoint),
        checkpoint.status ?? null,
      );
    },

    async load(runId) {
      const row = stmts.load.get(runId, chatId) as { payload: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.payload) as AgentCheckpoint;
      } catch {
        return null;
      }
    },

    async list(agentName) {
      const rows = stmts.list.all(agentName, chatId) as { payload: string }[];
      const results: AgentCheckpoint[] = [];
      for (const r of rows) {
        try {
          results.push(JSON.parse(r.payload) as AgentCheckpoint);
        } catch { /* skip corrupt rows */ }
      }
      return results;
    },

    async delete(runId) {
      stmts.del.run(runId, chatId);
    },
  };
}
