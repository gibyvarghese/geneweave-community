/**
 * Run/stream config loader (Client Phase 0).
 *
 * Reads the single-row `run_stream_config` table and maps it onto the
 * `RunStreamConfig` shape from `@weaveintel/core`, with a 60s in-process cache
 * (mirrors `chat-semantic-utils.ts`). The SSE route uses it for the keepalive
 * interval; `GET /api/me/runs/config` serves the client-facing subset; and a
 * boot/interval sweep uses it for journal retention. The admin PUT calls
 * `_resetRunStreamConfigCache()` so a config change takes effect immediately.
 */
import { RUN_STREAM_CONFIG_DEFAULTS, type RunStreamConfig } from '@weaveintel/core';
import type { RunStreamConfigRow } from './db-types/admin.js';

const TTL_MS = 60_000;
let _cfgCache: { ts: number; cfg: RunStreamConfig } | null = null;

interface RunStreamConfigReader {
  getRunStreamConfig?: () => Promise<RunStreamConfigRow | null>;
}

function rowToConfig(row: RunStreamConfigRow | null | undefined): RunStreamConfig {
  if (!row) return RUN_STREAM_CONFIG_DEFAULTS;
  let backoffMs = RUN_STREAM_CONFIG_DEFAULTS.backoffMs;
  try {
    const parsed: unknown = JSON.parse(row.backoff_ms);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((n) => typeof n === 'number' && n >= 0)) {
      backoffMs = parsed as number[];
    }
  } catch { /* keep default */ }
  const d = RUN_STREAM_CONFIG_DEFAULTS;
  return {
    heartbeatMs: row.heartbeat_ms ?? d.heartbeatMs,
    maxReconnects: row.max_reconnects ?? d.maxReconnects,
    backoffMs,
    stallTimeoutMs: row.stall_timeout_ms ?? d.stallTimeoutMs,
    throttleMs: row.throttle_ms ?? d.throttleMs,
    journalRetentionHours: row.journal_retention_hours ?? d.journalRetentionHours,
    journalMaxEvents: row.journal_max_events ?? d.journalMaxEvents,
    resumeWindowSeconds: row.resume_window_seconds ?? d.resumeWindowSeconds,
  };
}

/** Load the run/stream config (cached 60s). Falls back to defaults on any error. */
export async function loadRunStreamConfig(db: RunStreamConfigReader, now: number = Date.now()): Promise<RunStreamConfig> {
  if (_cfgCache && now - _cfgCache.ts < TTL_MS) return _cfgCache.cfg;
  let cfg = RUN_STREAM_CONFIG_DEFAULTS;
  try {
    cfg = rowToConfig(await db.getRunStreamConfig?.());
  } catch { /* table may be absent on a brand-new DB — use defaults */ }
  _cfgCache = { ts: now, cfg };
  return cfg;
}

/** The client-facing subset, served by `GET /api/me/runs/config`. */
export function clientStreamConfig(cfg: RunStreamConfig): {
  heartbeatMs: number;
  maxReconnects: number;
  backoffMs: number[];
  stallTimeoutMs: number;
  throttleMs: number;
  resumeWindowSeconds: number;
} {
  return {
    heartbeatMs: cfg.heartbeatMs,
    maxReconnects: cfg.maxReconnects,
    backoffMs: cfg.backoffMs,
    stallTimeoutMs: cfg.stallTimeoutMs,
    throttleMs: cfg.throttleMs,
    resumeWindowSeconds: cfg.resumeWindowSeconds,
  };
}

/** Invalidate the cache (called by the admin PUT so changes apply immediately). */
export function _resetRunStreamConfigCache(): void {
  _cfgCache = null;
}
