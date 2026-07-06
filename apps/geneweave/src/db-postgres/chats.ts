// SPDX-License-Identifier: MIT
/**
 * Postgres port of the FULL `IChatStore` domain of the geneWeave `DatabaseAdapter` — chats,
 * conversations (user-scoped list/search + pin/archive), messages, metrics, evals, user
 * preferences & notification prefs, chat settings, traces, temporal-tool persistence, and agent
 * activity.
 *
 * Each method mirrors the SQLite implementation in `../db-sqlite.ts` statement-for-statement: same
 * SQL, same column order, same integer-boolean and TEXT-JSON conventions. The only translations are
 * the SQLite→Postgres dialect differences:
 *   - `?`→`$n` placeholders (dynamic builders renumber via `$${params.length + 1}`);
 *   - `datetime('now')`→`${ctx.now}` (UTC `YYYY-MM-DD HH:MM:SS` text, parity with SQLite);
 *   - every TEXT ordering pinned to `COLLATE "C"` (plain byte order) so results match SQLite;
 *   - `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`, upsert→`ON CONFLICT (...) DO UPDATE SET`;
 *   - `DATE(t)` on our `YYYY-MM-DD HH:MM:SS` text → `substring(t FROM 1 FOR 10)` (same date text);
 *   - SQLite `rowid` tiebreaks → the primary key `id COLLATE "C"` for a stable secondary sort;
 *   - `COUNT/SUM/AVG` results coerced to JS numbers via `Number(...)`.
 *
 * Booleans (pinned/archived/enabled flags) are INTEGER 0/1 numbers; JSON/metadata columns are TEXT
 * pass-through; `cost` is DOUBLE→number; every value is a bound parameter.
 *
 * This module implements the COMPLETE `IChatStore` and SUPERSEDES the handful of chat/message
 * methods the core slice in `../db-postgres.ts` implements inline (createChat/addMessage/getMessages/
 * updateChatTitle/deleteChat) — those are re-ported here identically so composition is lossless.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  ChatRow,
  MessageRow,
  MetricRow,
  EvalRow,
  UserPreferencesRow,
  ChatSettingsRow,
  TraceRow,
  TemporalTimerRow,
  TemporalStopwatchRow,
  TemporalReminderRow,
  MetricsSummary,
  ConversationRow,
  UserNotificationPrefRow,
} from '../db-types/core.js';
import type { ConversationListOptions, ConversationFlags } from '../db-types/adapter-chats.js';

export function pgChatStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ── Chats ──────────────────────────────────────────────────────────────────
    async createChat(c: { id: string; userId: string; title: string; model: string; provider: string }): Promise<void> {
      await ctx.query(
        'INSERT INTO chats (id, user_id, title, model, provider) VALUES ($1, $2, $3, $4, $5)',
        [c.id, c.userId, c.title, c.model, c.provider],
      );
    },

    async getChat(id: string, userId: string): Promise<ChatRow | null> {
      const { rows } = await ctx.query('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
      return (rows[0] as ChatRow | undefined) ?? null;
    },

    async getChatById(id: string): Promise<ChatRow | null> {
      const { rows } = await ctx.query('SELECT * FROM chats WHERE id = $1', [id]);
      return (rows[0] as ChatRow | undefined) ?? null;
    },

    async getUserChats(userId: string): Promise<ChatRow[]> {
      const { rows } = await ctx.query('SELECT * FROM chats WHERE user_id = $1 ORDER BY updated_at COLLATE "C" DESC', [userId]);
      return rows as unknown as ChatRow[];
    },

    async updateChatTitle(id: string, userId: string, title: string): Promise<void> {
      await ctx.query(
        `UPDATE chats SET title = $1, updated_at = ${ctx.now} WHERE id = $2 AND user_id = $3`,
        [title, id, userId],
      );
    },

    async deleteChat(id: string, userId: string): Promise<void> {
      await ctx.query('DELETE FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    // ── Conversations (user-scoped list/search + pin/archive — SP2) ─────────────
    async listUserConversations(userId: string, opts: ConversationListOptions = {}): Promise<ConversationRow[]> {
      const filter = opts.filter ?? 'active';
      const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 200);
      const offset = Math.max(Number(opts.offset ?? 0), 0);

      const where: string[] = ['c.user_id = $1'];
      const params: unknown[] = [userId];

      if (filter === 'active') where.push('c.archived = 0');
      else if (filter === 'archived') where.push('c.archived = 1');
      else if (filter === 'pinned') where.push('c.pinned = 1 AND c.archived = 0');
      // 'all' adds no archived/pinned constraint.

      const query = (opts.query ?? '').trim();
      if (query) {
        // Escape LIKE wildcards so user input is matched literally.
        const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const like = `%${escaped}%`;
        const p1 = `$${params.length + 1}`;
        const p2 = `$${params.length + 2}`;
        where.push(
          `(c.title LIKE ${p1} ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.chat_id = c.id AND m2.content LIKE ${p2} ESCAPE '\\'))`,
        );
        params.push(like, like);
      }

      const limitP = `$${params.length + 1}`;
      const offsetP = `$${params.length + 2}`;
      params.push(limit, offset);

      const sql = `
        SELECT
          c.id, c.title, c.model, c.provider, c.pinned, c.archived, c.created_at, c.updated_at,
          COALESCE(cs.mode, 'agent') AS mode,
          (SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at COLLATE "C" DESC, m.id COLLATE "C" DESC LIMIT 1) AS snippet
        FROM chats c
        LEFT JOIN chat_settings cs ON cs.chat_id = c.id
        WHERE ${where.join(' AND ')}
        ORDER BY c.pinned DESC, c.updated_at COLLATE "C" DESC, c.id COLLATE "C" DESC
        LIMIT ${limitP} OFFSET ${offsetP}`;

      const { rows } = await ctx.query(sql, params);
      return rows as unknown as ConversationRow[];
    },

    async getUserConversation(id: string, userId: string): Promise<ConversationRow | null> {
      const sql = `
        SELECT
          c.id, c.title, c.model, c.provider, c.pinned, c.archived, c.created_at, c.updated_at,
          COALESCE(cs.mode, 'agent') AS mode,
          (SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at COLLATE "C" DESC, m.id COLLATE "C" DESC LIMIT 1) AS snippet
        FROM chats c
        LEFT JOIN chat_settings cs ON cs.chat_id = c.id
        WHERE c.id = $1 AND c.user_id = $2`;
      const { rows } = await ctx.query(sql, [id, userId]);
      return (rows[0] as ConversationRow | undefined) ?? null;
    },

    async setConversationFlags(id: string, userId: string, flags: ConversationFlags): Promise<ConversationRow | null> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (flags.pinned !== undefined) { sets.push(`pinned = $${params.length + 1}`); params.push(flags.pinned ? 1 : 0); }
      if (flags.archived !== undefined) { sets.push(`archived = $${params.length + 1}`); params.push(flags.archived ? 1 : 0); }
      if (flags.title !== undefined) { sets.push(`title = $${params.length + 1}`); params.push(flags.title); }

      if (sets.length > 0) {
        // Flag/title changes deliberately do NOT bump updated_at so pin/archive
        // never reorders the recency-sorted list.
        const idP = `$${params.length + 1}`;
        const userP = `$${params.length + 2}`;
        params.push(id, userId);
        await ctx.query(`UPDATE chats SET ${sets.join(', ')} WHERE id = ${idP} AND user_id = ${userP}`, params);
      }
      return this.getUserConversation!(id, userId);
    },

    // ── Messages ───────────────────────────────────────────────────────────────
    async addMessage(m: {
      id: string; chatId: string; role: string; content: string;
      metadata?: string; tokensUsed?: number; cost?: number; latencyMs?: number;
    }): Promise<void> {
      await ctx.query(
        'INSERT INTO messages (id, chat_id, role, content, metadata, tokens_used, cost, latency_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [m.id, m.chatId, m.role, m.content, m.metadata ?? null, m.tokensUsed ?? 0, m.cost ?? 0, m.latencyMs ?? 0],
      );
      await ctx.query(`UPDATE chats SET updated_at = ${ctx.now} WHERE id = $1`, [m.chatId]);
    },

    async getMessages(chatId: string): Promise<MessageRow[]> {
      const { rows } = await ctx.query('SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at COLLATE "C" ASC', [chatId]);
      return rows as unknown as MessageRow[];
    },

    // ── Metrics ────────────────────────────────────────────────────────────────
    async recordMetric(m: {
      id: string; userId: string; chatId?: string; type: string;
      provider?: string; model?: string; promptTokens?: number;
      completionTokens?: number; totalTokens?: number; cost?: number;
      latencyMs?: number; metadata?: string;
    }): Promise<void> {
      await ctx.query(
        'INSERT INTO metrics (id, user_id, chat_id, type, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, latency_ms, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [
          m.id, m.userId, m.chatId ?? null, m.type, m.provider ?? null, m.model ?? null,
          m.promptTokens ?? 0, m.completionTokens ?? 0, m.totalTokens ?? 0,
          m.cost ?? 0, m.latencyMs ?? 0, m.metadata ?? null,
        ],
      );
    },

    async getMetrics(userId: string, from?: string, to?: string): Promise<MetricRow[]> {
      let sql = 'SELECT * FROM metrics WHERE user_id = $1';
      const params: unknown[] = [userId];
      if (from) { sql += ` AND created_at >= $${params.length + 1}`; params.push(from); }
      if (to) { sql += ` AND created_at <= $${params.length + 1}`; params.push(to); }
      sql += ' ORDER BY created_at COLLATE "C" DESC';
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as MetricRow[];
    },

    async getMetricsSummary(userId: string, from?: string, to?: string): Promise<MetricsSummary> {
      let where = 'WHERE user_id = $1';
      const params: unknown[] = [userId];
      if (from) { where += ` AND created_at >= $${params.length + 1}`; params.push(from); }
      if (to) { where += ` AND created_at <= $${params.length + 1}`; params.push(to); }

      const { rows: totalRows } = await ctx.query(
        `SELECT COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost),0) as total_cost, COALESCE(AVG(latency_ms),0) as avg_latency_ms FROM metrics ${where}`,
        params,
      );
      const totals = totalRows[0] as { total_tokens: unknown; total_cost: unknown; avg_latency_ms: unknown };

      const { rows: msgRows } = await ctx.query(
        `SELECT COUNT(*) as cnt FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = $1)`,
        [userId],
      );
      const msgCount = msgRows[0] as { cnt: unknown };

      const { rows: chatRows } = await ctx.query('SELECT COUNT(*) as cnt FROM chats WHERE user_id = $1', [userId]);
      const chatCount = chatRows[0] as { cnt: unknown };

      const { rows: byModelRows } = await ctx.query(
        `SELECT model, provider, SUM(total_tokens) as tokens, SUM(cost) as cost, COUNT(*) as count FROM metrics ${where} GROUP BY model, provider`,
        params,
      );
      const byModel = (byModelRows as Array<{ model: string; provider: string; tokens: unknown; cost: unknown; count: unknown }>).map((r) => ({
        model: r.model,
        provider: r.provider,
        tokens: Number(r.tokens),
        cost: Number(r.cost),
        count: Number(r.count),
      }));

      const { rows: byDayRows } = await ctx.query(
        `SELECT substring(created_at FROM 1 FOR 10) as date, SUM(total_tokens) as tokens, SUM(cost) as cost, COUNT(*) as count FROM metrics ${where} GROUP BY substring(created_at FROM 1 FOR 10) ORDER BY substring(created_at FROM 1 FOR 10) COLLATE "C"`,
        params,
      );
      const byDay = (byDayRows as Array<{ date: string; tokens: unknown; cost: unknown; count: unknown }>).map((r) => ({
        date: r.date,
        tokens: Number(r.tokens),
        cost: Number(r.cost),
        count: Number(r.count),
      }));

      return {
        total_tokens: Number(totals.total_tokens),
        total_cost: Number(totals.total_cost),
        avg_latency_ms: Math.round(Number(totals.avg_latency_ms)),
        total_messages: Number(msgCount.cnt),
        total_chats: Number(chatCount.cnt),
        by_model: byModel,
        by_day: byDay,
      };
    },

    // ── Evals ──────────────────────────────────────────────────────────────────
    async recordEval(r: {
      id: string; userId: string; chatId?: string; evalName: string;
      score: number; passed: number; failed: number; total: number; details?: string;
    }): Promise<void> {
      await ctx.query(
        'INSERT INTO eval_results (id, user_id, chat_id, eval_name, score, passed, failed, total, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [r.id, r.userId, r.chatId ?? null, r.evalName, r.score, r.passed, r.failed, r.total, r.details ?? null],
      );
    },

    async getEvals(userId: string, from?: string, to?: string): Promise<EvalRow[]> {
      let sql = 'SELECT * FROM eval_results WHERE user_id = $1';
      const params: unknown[] = [userId];
      // eval_results uses updated_at (no created_at column)
      if (from) { sql += ` AND updated_at >= $${params.length + 1}`; params.push(from); }
      if (to) { sql += ` AND updated_at <= $${params.length + 1}`; params.push(to); }
      sql += ' ORDER BY updated_at COLLATE "C" DESC';
      const { rows } = await ctx.query(sql, params);
      return rows as unknown as EvalRow[];
    },

    // ── User Preferences ─────────────────────────────────────────────────────────
    async getUserPreferences(userId: string): Promise<UserPreferencesRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
      return (rows[0] as UserPreferencesRow | undefined) ?? null;
    },

    async saveUserPreferences(userId: string, defaultMode: string, theme: string, showProcessCard?: boolean): Promise<void> {
      const showFlag = showProcessCard === false ? 0 : 1;
      await ctx.query(
        `INSERT INTO user_preferences (user_id, default_mode, theme, show_process_card)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(user_id) DO UPDATE SET
           default_mode=excluded.default_mode,
           theme=excluded.theme,
           show_process_card=excluded.show_process_card,
           updated_at=${ctx.now}`,
        [userId, defaultMode, theme, showFlag],
      );
    },

    // m136 — Account settings surface. `patch` is a whitelist-validated set of columns from the service layer.
    async updateUserAccountPrefs(userId: string, patch: Record<string, string | null>): Promise<void> {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      // Ensure a row exists first (a fresh user may have no preferences row yet).
      await ctx.query(
        `INSERT INTO user_preferences (user_id, default_mode, theme, show_process_card) VALUES ($1, 'direct', 'light', 1) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const setClause = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
      const vals = cols.map((c) => patch[c] ?? null);
      await ctx.query(
        `UPDATE user_preferences SET ${setClause}, updated_at=${ctx.now} WHERE user_id=$${vals.length + 1}`,
        [...vals, userId],
      );
    },

    async getUserNotificationPrefs(userId: string): Promise<UserNotificationPrefRow[]> {
      const { rows } = await ctx.query('SELECT * FROM user_notification_prefs WHERE user_id = $1 ORDER BY event_key COLLATE "C"', [userId]);
      return rows as unknown as UserNotificationPrefRow[];
    },

    async setUserNotificationPref(userId: string, eventKey: string, channels: { in_app?: boolean; email?: boolean; push?: boolean }): Promise<void> {
      const { rows } = await ctx.query('SELECT * FROM user_notification_prefs WHERE user_id = $1 AND event_key = $2', [userId, eventKey]);
      const existing = rows[0] as UserNotificationPrefRow | undefined;
      const inApp = channels.in_app === undefined ? (existing?.in_app ?? 1) : (channels.in_app ? 1 : 0);
      const email = channels.email === undefined ? (existing?.email ?? 0) : (channels.email ? 1 : 0);
      const push = channels.push === undefined ? (existing?.push ?? 0) : (channels.push ? 1 : 0);
      await ctx.query(
        `INSERT INTO user_notification_prefs (user_id, event_key, in_app, email, push) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(user_id, event_key) DO UPDATE SET in_app=excluded.in_app, email=excluded.email, push=excluded.push, updated_at=${ctx.now}`,
        [userId, eventKey, inApp, email, push],
      );
    },

    // ── Chat Settings ────────────────────────────────────────────────────────────
    async getChatSettings(chatId: string): Promise<ChatSettingsRow | null> {
      const { rows } = await ctx.query('SELECT * FROM chat_settings WHERE chat_id = $1', [chatId]);
      return (rows[0] as ChatSettingsRow | undefined) ?? null;
    },

    async saveChatSettings(s: {
      chatId: string; mode: string; systemPrompt?: string; timezone?: string;
      enabledTools?: string; redactionEnabled?: boolean; redactionPatterns?: string; workers?: string;
      reflectEnabled?: boolean; reflectMaxRevisions?: number; reflectCriteria?: string;
      verifyEnabled?: boolean; verifyMinScore?: number; verifyMaxAttempts?: number;
      supervisorReplanOnFailure?: boolean; supervisorParallelDelegation?: boolean;
      ensembleAgents?: string; ensembleResolver?: string;
      reasoningEnabled?: boolean; reasoningEffort?: string; reasoningBudgetTokens?: number;
      hitlEnabled?: boolean; hitlRequireAll?: boolean; hitlTimeoutMs?: number;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO chat_settings
           (chat_id, mode, system_prompt, timezone, enabled_tools, redaction_enabled, redaction_patterns, workers,
            reflect_enabled, reflect_max_revisions, reflect_criteria,
            verify_enabled, verify_min_score, verify_max_attempts,
            supervisor_replan_on_failure, supervisor_parallel_delegation,
            ensemble_agents, ensemble_resolver,
            reasoning_enabled, reasoning_effort, reasoning_budget_tokens,
            hitl_enabled, hitl_require_all, hitl_timeout_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         ON CONFLICT(chat_id) DO UPDATE SET
           mode=excluded.mode, system_prompt=excluded.system_prompt, timezone=excluded.timezone,
           enabled_tools=excluded.enabled_tools, redaction_enabled=excluded.redaction_enabled,
           redaction_patterns=excluded.redaction_patterns, workers=excluded.workers,
           reflect_enabled=excluded.reflect_enabled, reflect_max_revisions=excluded.reflect_max_revisions,
           reflect_criteria=excluded.reflect_criteria,
           verify_enabled=excluded.verify_enabled, verify_min_score=excluded.verify_min_score,
           verify_max_attempts=excluded.verify_max_attempts,
           supervisor_replan_on_failure=excluded.supervisor_replan_on_failure,
           supervisor_parallel_delegation=excluded.supervisor_parallel_delegation,
           ensemble_agents=excluded.ensemble_agents, ensemble_resolver=excluded.ensemble_resolver,
           reasoning_enabled=excluded.reasoning_enabled, reasoning_effort=excluded.reasoning_effort,
           reasoning_budget_tokens=excluded.reasoning_budget_tokens,
           hitl_enabled=excluded.hitl_enabled, hitl_require_all=excluded.hitl_require_all,
           hitl_timeout_ms=excluded.hitl_timeout_ms,
           updated_at=${ctx.now}`,
        [
          s.chatId, s.mode, s.systemPrompt ?? null,
          s.timezone ?? null,
          s.enabledTools ?? null, s.redactionEnabled ? 1 : 0,
          s.redactionPatterns ?? null, s.workers ?? null,
          s.reflectEnabled ? 1 : 0, s.reflectMaxRevisions ?? 1, s.reflectCriteria ?? null,
          s.verifyEnabled ? 1 : 0, s.verifyMinScore ?? 0.7, s.verifyMaxAttempts ?? 1,
          s.supervisorReplanOnFailure ? 1 : 0, s.supervisorParallelDelegation ? 1 : 0,
          s.ensembleAgents ?? null, s.ensembleResolver ?? null,
          s.reasoningEnabled ? 1 : 0, s.reasoningEffort ?? null, s.reasoningBudgetTokens ?? 0,
          s.hitlEnabled ? 1 : 0, s.hitlRequireAll ? 1 : 0, s.hitlTimeoutMs ?? 300000,
        ],
      );
    },

    // ── Traces ─────────────────────────────────────────────────────────────────
    async saveTrace(t: {
      id: string; userId: string; chatId?: string; messageId?: string;
      traceId: string; spanId: string; parentSpanId?: string;
      name: string; startTime: number; endTime?: number;
      status?: string; attributes?: string; events?: string;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO traces (id, user_id, chat_id, message_id, trace_id, span_id, parent_span_id, name, start_time, end_time, status, attributes, events)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          t.id, t.userId, t.chatId ?? null, t.messageId ?? null,
          t.traceId, t.spanId, t.parentSpanId ?? null,
          t.name, t.startTime, t.endTime ?? null,
          t.status ?? null, t.attributes ?? null, t.events ?? null,
        ],
      );
    },

    async getChatTraces(chatId: string): Promise<TraceRow[]> {
      const { rows } = await ctx.query('SELECT * FROM traces WHERE chat_id = $1 ORDER BY start_time ASC', [chatId]);
      return rows as unknown as TraceRow[];
    },

    async getUserTraces(userId: string, limit?: number): Promise<TraceRow[]> {
      const { rows } = await ctx.query('SELECT * FROM traces WHERE user_id = $1 ORDER BY start_time DESC LIMIT $2', [userId, limit ?? 100]);
      return rows as unknown as TraceRow[];
    },

    // ── Temporal tools persistence ───────────────────────────────────────────────
    async upsertTemporalTimer(row: {
      id: string; scopeId: string; label?: string | null; durationMs?: number | null;
      state: string; createdAt: string; startedAt?: string | null; pausedAt?: string | null;
      resumedAt?: string | null; stoppedAt?: string | null; elapsedMs: number;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO temporal_timers
         (id, scope_id, label, duration_ms, state, created_at, started_at, paused_at, resumed_at, stopped_at, elapsed_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT(scope_id, id) DO UPDATE SET
           label=excluded.label,
           duration_ms=excluded.duration_ms,
           state=excluded.state,
           created_at=excluded.created_at,
           started_at=excluded.started_at,
           paused_at=excluded.paused_at,
           resumed_at=excluded.resumed_at,
           stopped_at=excluded.stopped_at,
           elapsed_ms=excluded.elapsed_ms,
           updated_at=${ctx.now}`,
        [
          row.id, row.scopeId, row.label ?? null, row.durationMs ?? null, row.state,
          row.createdAt, row.startedAt ?? null, row.pausedAt ?? null, row.resumedAt ?? null,
          row.stoppedAt ?? null, row.elapsedMs,
        ],
      );
    },

    async getTemporalTimer(scopeId: string, id: string): Promise<TemporalTimerRow | null> {
      const { rows } = await ctx.query('SELECT * FROM temporal_timers WHERE scope_id = $1 AND id = $2', [scopeId, id]);
      return (rows[0] as TemporalTimerRow | undefined) ?? null;
    },

    async listTemporalTimers(scopeId: string): Promise<TemporalTimerRow[]> {
      const { rows } = await ctx.query('SELECT * FROM temporal_timers WHERE scope_id = $1 ORDER BY created_at COLLATE "C" DESC', [scopeId]);
      return rows as unknown as TemporalTimerRow[];
    },

    async upsertTemporalStopwatch(row: {
      id: string; scopeId: string; label?: string | null; state: string; createdAt: string;
      startedAt?: string | null; pausedAt?: string | null; resumedAt?: string | null;
      stoppedAt?: string | null; elapsedMs: number; lapsJson: string;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO temporal_stopwatches
         (id, scope_id, label, state, created_at, started_at, paused_at, resumed_at, stopped_at, elapsed_ms, laps_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT(scope_id, id) DO UPDATE SET
           label=excluded.label,
           state=excluded.state,
           created_at=excluded.created_at,
           started_at=excluded.started_at,
           paused_at=excluded.paused_at,
           resumed_at=excluded.resumed_at,
           stopped_at=excluded.stopped_at,
           elapsed_ms=excluded.elapsed_ms,
           laps_json=excluded.laps_json,
           updated_at=${ctx.now}`,
        [
          row.id, row.scopeId, row.label ?? null, row.state, row.createdAt,
          row.startedAt ?? null, row.pausedAt ?? null, row.resumedAt ?? null,
          row.stoppedAt ?? null, row.elapsedMs, row.lapsJson,
        ],
      );
    },

    async getTemporalStopwatch(scopeId: string, id: string): Promise<TemporalStopwatchRow | null> {
      const { rows } = await ctx.query('SELECT * FROM temporal_stopwatches WHERE scope_id = $1 AND id = $2', [scopeId, id]);
      return (rows[0] as TemporalStopwatchRow | undefined) ?? null;
    },

    async listTemporalStopwatches(scopeId: string): Promise<TemporalStopwatchRow[]> {
      const { rows } = await ctx.query('SELECT * FROM temporal_stopwatches WHERE scope_id = $1 ORDER BY created_at COLLATE "C" DESC', [scopeId]);
      return rows as unknown as TemporalStopwatchRow[];
    },

    async upsertTemporalReminder(row: {
      id: string; scopeId: string; text: string; dueAt: string; timezone: string;
      status: string; createdAt: string; cancelledAt?: string | null;
    }): Promise<void> {
      await ctx.query(
        `INSERT INTO temporal_reminders
         (id, scope_id, text, due_at, timezone, status, created_at, cancelled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(scope_id, id) DO UPDATE SET
           text=excluded.text,
           due_at=excluded.due_at,
           timezone=excluded.timezone,
           status=excluded.status,
           created_at=excluded.created_at,
           cancelled_at=excluded.cancelled_at,
           updated_at=${ctx.now}`,
        [
          row.id, row.scopeId, row.text, row.dueAt, row.timezone,
          row.status, row.createdAt, row.cancelledAt ?? null,
        ],
      );
    },

    async getTemporalReminder(scopeId: string, id: string): Promise<TemporalReminderRow | null> {
      const { rows } = await ctx.query('SELECT * FROM temporal_reminders WHERE scope_id = $1 AND id = $2', [scopeId, id]);
      return (rows[0] as TemporalReminderRow | undefined) ?? null;
    },

    async listTemporalReminders(scopeId: string): Promise<TemporalReminderRow[]> {
      const { rows } = await ctx.query('SELECT * FROM temporal_reminders WHERE scope_id = $1 ORDER BY due_at COLLATE "C" ASC', [scopeId]);
      return rows as unknown as TemporalReminderRow[];
    },

    // ── Agent activity ───────────────────────────────────────────────────────────
    async getAgentActivity(userId: string, limit?: number): Promise<Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>> {
      const sql = `
        SELECT m.*, c.title AS chat_title, c.model AS chat_model, c.provider AS chat_provider
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        WHERE c.user_id = $1 AND m.role = 'assistant' AND m.metadata IS NOT NULL
        ORDER BY m.created_at COLLATE "C" DESC
        LIMIT $2
      `;
      const { rows } = await ctx.query(sql, [userId, limit ?? 50]);
      return rows as unknown as Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>;
    },
  };
}
