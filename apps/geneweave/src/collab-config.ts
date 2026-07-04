// SPDX-License-Identifier: MIT
/**
 * Collaboration config loader (Collaboration Phase 1).
 *
 * Reads the single-row `collaboration_config` table (m94) into a typed object,
 * falling back to the Yjs-canonical defaults when the row is missing. Mirrors
 * `chat-run-stream-utils.loadRunStreamConfig` so the presence heartbeat/TTL/sweep
 * cadence is DB-driven (admin-editable) rather than hardcoded.
 *
 * For someone new: this just turns a database row of numbers into a small typed
 * settings object, so the rest of the code can ask "how often should clients send
 * a heartbeat?" without knowing where the answer is stored.
 */
import type { CollaborationConfigRow } from './db-types/adapter-me.js';

export interface CollaborationConfig {
  enabled: boolean;
  /** How often clients should heartbeat (ms). */
  presenceHeartbeatMs: number;
  /** A participant is reaped this long after their last heartbeat (ms). */
  presenceTtlMs: number;
  /** How often the server sweeps expired participants (ms). */
  presenceSweepMs: number;
  /** Safety cap on participants per run. */
  maxParticipantsPerRun: number;
  /** Whether the running agent is shown as a presence peer. */
  showAgentPresence: boolean;
}

/** Defaults — TTL = 2× heartbeat (Yjs canon: one missed beat never drops a peer). */
export const COLLABORATION_CONFIG_DEFAULTS: CollaborationConfig = {
  enabled: true,
  presenceHeartbeatMs: 15000,
  presenceTtlMs: 30000,
  presenceSweepMs: 10000,
  maxParticipantsPerRun: 50,
  showAgentPresence: true,
};

export interface CollaborationConfigReader {
  getCollaborationConfig?: () => Promise<CollaborationConfigRow | null>;
}

export async function loadCollaborationConfig(db: CollaborationConfigReader): Promise<CollaborationConfig> {
  const row = await db.getCollaborationConfig?.();
  if (!row) return COLLABORATION_CONFIG_DEFAULTS;
  const d = COLLABORATION_CONFIG_DEFAULTS;
  return {
    enabled: row.enabled !== 0,
    presenceHeartbeatMs: row.presence_heartbeat_ms ?? d.presenceHeartbeatMs,
    presenceTtlMs: row.presence_ttl_ms ?? d.presenceTtlMs,
    presenceSweepMs: row.presence_sweep_ms ?? d.presenceSweepMs,
    maxParticipantsPerRun: row.max_participants_per_run ?? d.maxParticipantsPerRun,
    showAgentPresence: (row.show_agent_presence ?? 1) !== 0,
  };
}

/** The client-facing subset served at GET /api/me/collab/config. */
export function clientCollabConfig(cfg: CollaborationConfig): {
  enabled: boolean;
  presenceHeartbeatMs: number;
  presenceTtlMs: number;
} {
  return {
    enabled: cfg.enabled,
    presenceHeartbeatMs: cfg.presenceHeartbeatMs,
    presenceTtlMs: cfg.presenceTtlMs,
  };
}
