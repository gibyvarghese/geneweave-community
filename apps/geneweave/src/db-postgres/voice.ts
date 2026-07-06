// SPDX-License-Identifier: MIT
/**
 * Postgres store for the voice-agent domain (IVoiceStore): voice_configs, voice_sessions,
 * voice_session_events (m47/m48). One factory `(ctx: PgCtx) => Partial<DatabaseAdapter>` returning
 * every IVoiceStore method, mirroring the SQLite implementation in db-sqlite.ts SQL-for-SQL.
 *
 * Translation notes vs. the SQLite bodies:
 *   • `?` placeholders → `$1,$2,…`; every value stays a bound param (no interpolation of data).
 *   • `datetime('now')` → the ctx.now expression, so timestamps read back in SQLite's text shape.
 *   • SQLite `INSERT … ON CONFLICT(user_id) DO UPDATE … ; SELECT *` → the same upsert with
 *     `RETURNING *`, so the row is returned in one round-trip.
 *   • Booleans persist as INTEGER 0/1 (ws_connected); JSON columns (enabled_tools, config_snapshot,
 *     *_policy) are TEXT pass-through, exactly as SQLite stores them.
 *   • `ORDER BY created_at DESC` on a TEXT timestamp column keeps byte order without COLLATE "C"
 *     (fixed-width `YYYY-MM-DD HH:MM:SS`); no text ORDER BY over user-supplied text is present here.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  VoiceConfigRow,
  VoiceConfigCreate,
  VoiceConfigUpdate,
  VoiceSessionRow,
  VoiceSessionCreate,
  VoiceSessionListFilter,
  VoiceSessionStatus,
  VoiceSessionEventRow,
  VoiceSessionEventCreate,
} from '../db-types/adapter-voice.js';

export function pgVoiceStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Voice config (per-user preferences) ────────────────────────────────
    async getVoiceConfig(userId: string): Promise<VoiceConfigRow | null> {
      const { rows } = await ctx.query('SELECT * FROM voice_configs WHERE user_id = $1', [userId]);
      return (rows[0] as unknown as VoiceConfigRow | undefined) ?? null;
    },

    async upsertVoiceConfig(create: VoiceConfigCreate): Promise<VoiceConfigRow> {
      const id = newUUIDv7();
      const { rows } = await ctx.query(
        `
        INSERT INTO voice_configs
          (id, user_id, tenant_id, stt_provider, stt_model, stt_language,
           tts_provider, tts_model, tts_voice, tts_speed, tts_format,
           enabled_tools, mode, guardrail_policy, cost_policy,
           pipeline_mode, realtime_model)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT(user_id) DO UPDATE SET
          stt_provider = excluded.stt_provider,
          stt_model    = excluded.stt_model,
          stt_language = excluded.stt_language,
          tts_provider = excluded.tts_provider,
          tts_model    = excluded.tts_model,
          tts_voice    = excluded.tts_voice,
          tts_speed    = excluded.tts_speed,
          tts_format   = excluded.tts_format,
          enabled_tools = excluded.enabled_tools,
          mode         = excluded.mode,
          guardrail_policy = excluded.guardrail_policy,
          cost_policy  = excluded.cost_policy,
          pipeline_mode = excluded.pipeline_mode,
          realtime_model = excluded.realtime_model,
          updated_at   = ${ctx.now}
        RETURNING *
      `,
        [
          id,
          create.userId,
          create.tenantId ?? null,
          create.sttProvider ?? 'openai',
          create.sttModel ?? 'whisper-1',
          create.sttLanguage ?? null,
          create.ttsProvider ?? 'openai',
          create.ttsModel ?? 'tts-1',
          create.ttsVoice ?? 'alloy',
          create.ttsSpeed ?? 1.0,
          create.ttsFormat ?? 'mp3',
          create.enabledTools ? JSON.stringify(create.enabledTools) : null,
          create.mode ?? 'agent',
          create.guardrailPolicy ?? null,
          create.costPolicy ?? null,
          create.pipelineMode ?? 'chained',
          create.realtimeModel ?? 'gpt-realtime-2',
        ],
      );
      return rows[0] as unknown as VoiceConfigRow;
    },

    async updateVoiceConfig(userId: string, update: VoiceConfigUpdate): Promise<VoiceConfigRow | null> {
      const sets: string[] = [`updated_at = ${ctx.now}`];
      const vals: unknown[] = [];
      const p = () => `$${vals.length}`;
      if (update.sttProvider !== undefined) { vals.push(update.sttProvider); sets.push(`stt_provider = ${p()}`); }
      if (update.sttModel !== undefined)    { vals.push(update.sttModel);    sets.push(`stt_model = ${p()}`); }
      if (update.sttLanguage !== undefined) { vals.push(update.sttLanguage); sets.push(`stt_language = ${p()}`); }
      if (update.ttsProvider !== undefined) { vals.push(update.ttsProvider); sets.push(`tts_provider = ${p()}`); }
      if (update.ttsModel !== undefined)    { vals.push(update.ttsModel);    sets.push(`tts_model = ${p()}`); }
      if (update.ttsVoice !== undefined)    { vals.push(update.ttsVoice);    sets.push(`tts_voice = ${p()}`); }
      if (update.ttsSpeed !== undefined)    { vals.push(update.ttsSpeed);    sets.push(`tts_speed = ${p()}`); }
      if (update.ttsFormat !== undefined)   { vals.push(update.ttsFormat);   sets.push(`tts_format = ${p()}`); }
      if (update.enabledTools !== undefined){ vals.push(update.enabledTools ? JSON.stringify(update.enabledTools) : null); sets.push(`enabled_tools = ${p()}`); }
      if (update.mode !== undefined)        { vals.push(update.mode);        sets.push(`mode = ${p()}`); }
      if (update.guardrailPolicy !== undefined) { vals.push(update.guardrailPolicy); sets.push(`guardrail_policy = ${p()}`); }
      if (update.costPolicy !== undefined)  { vals.push(update.costPolicy);  sets.push(`cost_policy = ${p()}`); }
      if (update.pipelineMode !== undefined){ vals.push(update.pipelineMode); sets.push(`pipeline_mode = ${p()}`); }
      if (update.realtimeModel !== undefined){ vals.push(update.realtimeModel); sets.push(`realtime_model = ${p()}`); }
      if (sets.length === 1) return this.getVoiceConfig!(userId);
      vals.push(userId);
      await ctx.query(`UPDATE voice_configs SET ${sets.join(', ')} WHERE user_id = $${vals.length}`, vals);
      return this.getVoiceConfig!(userId);
    },

    // ─── Voice sessions ─────────────────────────────────────────────────────
    async createVoiceSession(create: VoiceSessionCreate): Promise<VoiceSessionRow> {
      const { rows } = await ctx.query(
        `
        INSERT INTO voice_sessions (id, user_id, tenant_id, chat_id, config_snapshot)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
        [create.id, create.userId, create.tenantId ?? null, create.chatId, create.configSnapshot],
      );
      return rows[0] as unknown as VoiceSessionRow;
    },

    async getVoiceSession(id: string, userId: string): Promise<VoiceSessionRow | null> {
      const { rows } = await ctx.query('SELECT * FROM voice_sessions WHERE id = $1 AND user_id = $2', [id, userId]);
      return (rows[0] as unknown as VoiceSessionRow | undefined) ?? null;
    },

    async listVoiceSessions(userId: string, filter?: VoiceSessionListFilter): Promise<VoiceSessionRow[]> {
      const where: string[] = ['user_id = $1'];
      const vals: unknown[] = [userId];
      if (filter?.status) { vals.push(filter.status); where.push(`status = $${vals.length}`); }
      const limit = filter?.limit ?? 50;
      const sql = `SELECT * FROM voice_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`;
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as VoiceSessionRow[];
    },

    async updateVoiceSessionStatus(id: string, userId: string, status: VoiceSessionStatus, endedAt?: string | null): Promise<void> {
      await ctx.query(
        `
        UPDATE voice_sessions SET status = $1, ended_at = $2, updated_at = ${ctx.now}
        WHERE id = $3 AND user_id = $4
      `,
        [status, endedAt ?? null, id, userId],
      );
    },

    async updateVoiceSessionStats(id: string, userId: string, delta: {
      turns?: number; sttMs?: number; ttsMs?: number; llmMs?: number;
      costUsd?: number; audioBytes?: number; lastActiveAt?: string; wsConnected?: boolean;
    }): Promise<void> {
      const sets: string[] = [`updated_at = ${ctx.now}`];
      const vals: unknown[] = [];
      const p = () => `$${vals.length}`;
      if (delta.turns !== undefined)       { vals.push(delta.turns);             sets.push(`total_turns = total_turns + ${p()}`); }
      if (delta.sttMs !== undefined)       { vals.push(delta.sttMs);             sets.push(`total_stt_ms = total_stt_ms + ${p()}`); }
      if (delta.ttsMs !== undefined)       { vals.push(delta.ttsMs);             sets.push(`total_tts_ms = total_tts_ms + ${p()}`); }
      if (delta.llmMs !== undefined)       { vals.push(delta.llmMs);             sets.push(`total_llm_ms = total_llm_ms + ${p()}`); }
      if (delta.costUsd !== undefined)     { vals.push(delta.costUsd);           sets.push(`total_cost_usd = total_cost_usd + ${p()}`); }
      if (delta.audioBytes !== undefined)  { vals.push(delta.audioBytes);        sets.push(`total_audio_bytes = total_audio_bytes + ${p()}`); }
      if (delta.lastActiveAt !== undefined){ vals.push(delta.lastActiveAt);      sets.push(`last_active_at = ${p()}`); }
      if (delta.wsConnected !== undefined) { vals.push(delta.wsConnected ? 1 : 0); sets.push(`ws_connected = ${p()}`); }
      vals.push(id);
      const idP = `$${vals.length}`;
      vals.push(userId);
      const userP = `$${vals.length}`;
      await ctx.query(`UPDATE voice_sessions SET ${sets.join(', ')} WHERE id = ${idP} AND user_id = ${userP}`, vals);
    },

    async endVoiceSession(id: string, userId: string): Promise<void> {
      await ctx.query(
        `
        UPDATE voice_sessions
        SET status = 'ended', ended_at = ${ctx.now}, ws_connected = 0, updated_at = ${ctx.now}
        WHERE id = $1 AND user_id = $2
      `,
        [id, userId],
      );
    },

    // ─── Voice session events (audit log) ───────────────────────────────────
    async insertVoiceSessionEvent(event: VoiceSessionEventCreate): Promise<void> {
      await ctx.query(
        `
        INSERT INTO voice_session_events
          (id, session_id, user_id, turn_index, event_type, input_text, output_text,
           audio_bytes_in, audio_bytes_out, stt_provider, stt_model, tts_provider,
           tts_model, tts_voice, llm_provider, llm_model, prompt_tokens,
           completion_tokens, duration_ms, cost_usd, error, guardrail_decision, trace_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      `,
        [
          event.id, event.sessionId, event.userId, event.turnIndex, event.eventType,
          event.inputText ?? null, event.outputText ?? null,
          event.audioBytesIn ?? null, event.audioBytesOut ?? null,
          event.sttProvider ?? null, event.sttModel ?? null,
          event.ttsProvider ?? null, event.ttsModel ?? null, event.ttsVoice ?? null,
          event.llmProvider ?? null, event.llmModel ?? null,
          event.promptTokens ?? null, event.completionTokens ?? null,
          event.durationMs ?? null, event.costUsd ?? null,
          event.error ?? null, event.guardrailDecision ?? null, event.traceId ?? null,
        ],
      );
    },

    async listVoiceSessionEvents(sessionId: string, userId: string, limit = 100): Promise<VoiceSessionEventRow[]> {
      const { rows } = await ctx.query(
        'SELECT * FROM voice_session_events WHERE session_id = $1 AND user_id = $2 ORDER BY turn_index ASC, created_at ASC LIMIT $3',
        [sessionId, userId, limit],
      );
      return rows as unknown as VoiceSessionEventRow[];
    },
  };
}
