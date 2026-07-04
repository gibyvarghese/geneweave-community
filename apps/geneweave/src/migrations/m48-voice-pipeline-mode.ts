/**
 * Migration m48 — Voice pipeline mode (chained vs realtime)
 *
 * Adds two columns to voice_configs:
 *   pipeline_mode   — 'chained' (default: Whisper→LLM→TTS) or 'realtime' (OpenAI Realtime API)
 *   realtime_model  — OpenAI Realtime model ID (only used when pipeline_mode = 'realtime')
 *
 * Both columns are added with ADD COLUMN IF NOT EXISTS so the migration is
 * idempotent and safe to re-run.
 */

import type BetterSqlite3 from 'better-sqlite3';

export function applyM48VoicePipelineMode(db: BetterSqlite3.Database): void {
  // SQLite does not support IF NOT EXISTS for ADD COLUMN, so we check the
  // column list first and skip if already present.
  const cols = (db.pragma('table_info(voice_configs)') as { name: string }[]).map((c) => c.name);

  if (!cols.includes('pipeline_mode')) {
    db.exec(`ALTER TABLE voice_configs ADD COLUMN pipeline_mode TEXT NOT NULL DEFAULT 'chained'`);
  }
  if (!cols.includes('realtime_model')) {
    db.exec(`ALTER TABLE voice_configs ADD COLUMN realtime_model TEXT NOT NULL DEFAULT 'gpt-realtime-2'`);
  }
}
