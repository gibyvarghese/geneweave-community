/**
 * DB adapter — voice agent tables (m47)
 *
 * Covers: voice_configs, voice_sessions, voice_session_events.
 */

// ── Voice config row ──────────────────────────────────────────

export interface VoiceConfigRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  stt_provider: string;
  stt_model: string;
  stt_language: string | null;
  tts_provider: string;
  tts_model: string;
  tts_voice: string;
  tts_speed: number;
  tts_format: string;
  enabled_tools: string | null;     // JSON string[] | null
  mode: string;
  guardrail_policy: string | null;
  cost_policy: string | null;
  pipeline_mode: string;            // 'chained' | 'realtime'
  realtime_model: string;
  created_at: string;
  updated_at: string;
}

export interface VoiceConfigCreate {
  userId: string;
  tenantId?: string | null;
  sttProvider?: string;
  sttModel?: string;
  sttLanguage?: string | null;
  ttsProvider?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
  ttsFormat?: string;
  enabledTools?: string[] | null;
  mode?: string;
  guardrailPolicy?: string | null;
  costPolicy?: string | null;
  pipelineMode?: 'chained' | 'realtime';
  realtimeModel?: string;
}

export interface VoiceConfigUpdate extends Partial<Omit<VoiceConfigCreate, 'userId' | 'tenantId'>> {}

// ── Voice session row ─────────────────────────────────────────

export type VoiceSessionStatus = 'active' | 'paused' | 'ended' | 'error';

export interface VoiceSessionRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  chat_id: string;
  status: VoiceSessionStatus;
  config_snapshot: string;         // JSON VoiceConfig
  total_turns: number;
  total_stt_ms: number;
  total_tts_ms: number;
  total_llm_ms: number;
  total_cost_usd: number;
  total_audio_bytes: number;
  ws_connected: number;            // 0 | 1
  last_active_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceSessionCreate {
  id: string;
  userId: string;
  tenantId?: string | null;
  chatId: string;
  configSnapshot: string;          // JSON
}

export interface VoiceSessionListFilter {
  status?: VoiceSessionStatus;
  limit?: number;
}

// ── Voice session event row ───────────────────────────────────

export type VoiceSessionEventType = 'stt' | 'llm' | 'tts' | 'error' | 'session_start' | 'session_end';

export interface VoiceSessionEventRow {
  id: string;
  session_id: string;
  user_id: string;
  turn_index: number;
  event_type: VoiceSessionEventType;
  input_text: string | null;
  output_text: string | null;
  audio_bytes_in: number | null;
  audio_bytes_out: number | null;
  stt_provider: string | null;
  stt_model: string | null;
  tts_provider: string | null;
  tts_model: string | null;
  tts_voice: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  error: string | null;
  guardrail_decision: string | null;
  trace_id: string | null;
  created_at: string;
}

export interface VoiceSessionEventCreate {
  id: string;
  sessionId: string;
  userId: string;
  turnIndex: number;
  eventType: VoiceSessionEventType;
  inputText?: string | null;
  outputText?: string | null;
  audioBytesIn?: number | null;
  audioBytesOut?: number | null;
  sttProvider?: string | null;
  sttModel?: string | null;
  ttsProvider?: string | null;
  ttsModel?: string | null;
  ttsVoice?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  durationMs?: number | null;
  costUsd?: number | null;
  error?: string | null;
  guardrailDecision?: string | null;
  traceId?: string | null;
}

// ── Store interface ───────────────────────────────────────────

export interface IVoiceStore {
  // ── Voice config (per-user preferences) ──────────────────
  getVoiceConfig(userId: string): Promise<VoiceConfigRow | null>;
  upsertVoiceConfig(create: VoiceConfigCreate): Promise<VoiceConfigRow>;
  updateVoiceConfig(userId: string, update: VoiceConfigUpdate): Promise<VoiceConfigRow | null>;

  // ── Voice sessions ────────────────────────────────────────
  createVoiceSession(create: VoiceSessionCreate): Promise<VoiceSessionRow>;
  getVoiceSession(id: string, userId: string): Promise<VoiceSessionRow | null>;
  listVoiceSessions(userId: string, filter?: VoiceSessionListFilter): Promise<VoiceSessionRow[]>;
  updateVoiceSessionStatus(id: string, userId: string, status: VoiceSessionStatus, endedAt?: string | null): Promise<void>;
  updateVoiceSessionStats(id: string, userId: string, delta: {
    turns?: number;
    sttMs?: number;
    ttsMs?: number;
    llmMs?: number;
    costUsd?: number;
    audioBytes?: number;
    lastActiveAt?: string;
    wsConnected?: boolean;
  }): Promise<void>;
  endVoiceSession(id: string, userId: string): Promise<void>;

  // ── Voice session events (audit log) ─────────────────────
  insertVoiceSessionEvent(event: VoiceSessionEventCreate): Promise<void>;
  listVoiceSessionEvents(sessionId: string, userId: string, limit?: number): Promise<VoiceSessionEventRow[]>;
}
