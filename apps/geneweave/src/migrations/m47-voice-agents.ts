/**
 * Migration m47 — Voice agent sessions, config, and audit events
 *
 * Three new tables:
 *
 *   voice_configs — per-user (and per-tenant) voice preferences.  Stores the
 *     STT provider/model, TTS provider/model, voice name, speed, and default
 *     language.  One row per user; created on first use and mutable by the
 *     user.
 *
 *   voice_sessions — one row per voice conversation turn-batch. Each session
 *     is pinned to an existing `chats` row so the underlying LLM conversation
 *     state (memory, tools, guardrails, cost ledger, trace) is shared with the
 *     text-based agent.  Sessions carry a status (active | paused | ended) and
 *     a JSON snapshot of the voice config that was active when the session was
 *     created.
 *
 *   voice_session_events — append-only audit log for every STT transcription,
 *     TTS synthesis, and LLM turn that happens inside a voice session.  Each
 *     event records duration, token cost, and an optional error payload so
 *     operations can replay or investigate failures.
 *
 * Two new task_type_definitions rows (idempotent via INSERT OR IGNORE):
 *   text_to_speech — output modality 'audio', capability-first routing.
 *   voice_agent    — combined STT+LLM+TTS round-trip, output modality 'audio'.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { newUUIDv7 } from '@weaveintel/core';

export function applyM47VoiceAgents(db: BetterSqlite3.Database): void {
  // ── Voice configs ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_configs (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL UNIQUE,
      tenant_id          TEXT,
      -- STT settings
      stt_provider       TEXT NOT NULL DEFAULT 'openai',
      stt_model          TEXT NOT NULL DEFAULT 'whisper-1',
      stt_language       TEXT,
      -- TTS settings
      tts_provider       TEXT NOT NULL DEFAULT 'openai',
      tts_model          TEXT NOT NULL DEFAULT 'tts-1',
      tts_voice          TEXT NOT NULL DEFAULT 'alloy',
      tts_speed          REAL NOT NULL DEFAULT 1.0,
      tts_format         TEXT NOT NULL DEFAULT 'mp3',
      -- Agent settings (same defaults as text agent)
      enabled_tools      TEXT,          -- JSON string[] | null → null means "all default"
      mode               TEXT NOT NULL DEFAULT 'agent',
      -- Guardrail + cost policy overrides (optional; fallback to tenant defaults)
      guardrail_policy   TEXT,
      cost_policy        TEXT,
      -- Metadata
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_voice_configs_user ON voice_configs(user_id);
    CREATE INDEX IF NOT EXISTS idx_voice_configs_tenant ON voice_configs(tenant_id);
  `);

  // ── Voice sessions ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      tenant_id          TEXT,
      chat_id            TEXT NOT NULL,          -- FK → chats.id (LLM context shared)
      status             TEXT NOT NULL DEFAULT 'active',   -- active | paused | ended | error
      -- Config snapshot at session-creation time (immutable; changes to voice_configs
      -- only affect future sessions, not the running one)
      config_snapshot    TEXT NOT NULL,          -- JSON VoiceConfig
      -- Cumulative counters (updated on each turn)
      total_turns        INTEGER NOT NULL DEFAULT 0,
      total_stt_ms       INTEGER NOT NULL DEFAULT 0,
      total_tts_ms       INTEGER NOT NULL DEFAULT 0,
      total_llm_ms       INTEGER NOT NULL DEFAULT 0,
      total_cost_usd     REAL NOT NULL DEFAULT 0,
      total_audio_bytes  INTEGER NOT NULL DEFAULT 0,
      -- WebSocket state
      ws_connected       INTEGER NOT NULL DEFAULT 0,   -- 0 | 1
      last_active_at     TEXT,
      ended_at           TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_user   ON voice_sessions(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_chat   ON voice_sessions(chat_id);
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_tenant ON voice_sessions(tenant_id, status);
  `);

  // ── Voice session events ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_session_events (
      id                 TEXT PRIMARY KEY,
      session_id         TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      turn_index         INTEGER NOT NULL DEFAULT 0,   -- 0-based turn within session
      -- Event classification
      event_type         TEXT NOT NULL,    -- stt | llm | tts | error | session_start | session_end
      -- Input / output payload (truncated to 4 KB for storage efficiency)
      input_text         TEXT,            -- transcript (after STT) or user text
      output_text        TEXT,            -- LLM response text
      audio_bytes_in     INTEGER,         -- size of incoming audio chunk
      audio_bytes_out    INTEGER,         -- size of outgoing TTS audio
      -- Model telemetry
      stt_provider       TEXT,
      stt_model          TEXT,
      tts_provider       TEXT,
      tts_model          TEXT,
      tts_voice          TEXT,
      llm_provider       TEXT,
      llm_model          TEXT,
      prompt_tokens      INTEGER,
      completion_tokens  INTEGER,
      -- Perf
      duration_ms        INTEGER,
      cost_usd           REAL,
      -- Error
      error              TEXT,            -- JSON error payload
      -- Guardrail decision
      guardrail_decision TEXT,            -- allow | warn | deny
      -- Trace
      trace_id           TEXT,
      -- Timestamps
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vse_session ON voice_session_events(session_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_vse_user    ON voice_session_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vse_type    ON voice_session_events(event_type, session_id);
  `);

  // ── Task type definitions (idempotent) ────────────────────────────────────
  const insertTaskType = db.prepare(`
    INSERT OR IGNORE INTO task_type_definitions
      (id, task_key, display_name, category, description, output_modality,
       default_strategy, default_weights, inference_hints, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const textToSpeechId = newUUIDv7();
  insertTaskType.run(
    textToSpeechId,
    'text_to_speech',
    'Text-to-Speech',
    'multimodal-output',
    'Synthesise natural-sounding speech audio from text.',
    'audio',
    'capability',
    JSON.stringify({ cost: 0.20, speed: 0.40, quality: 0.30, capability: 0.10 }),
    JSON.stringify({ keywords: ['speak', 'tts', 'voice', 'synthesize', 'narrate', 'read aloud'] }),
  );

  const voiceAgentId = newUUIDv7();
  insertTaskType.run(
    voiceAgentId,
    'voice_agent',
    'Voice Agent Round-Trip',
    'multimodal-io',
    'Full STT→LLM→TTS pipeline: transcribe incoming audio, run agent turn, synthesise response audio.',
    'audio',
    'capability',
    JSON.stringify({ cost: 0.25, speed: 0.35, quality: 0.30, capability: 0.10 }),
    JSON.stringify({ keywords: ['voice agent', 'voice chat', 'audio turn', 'spoken response'] }),
  );
}
