// SPDX-License-Identifier: MIT
/**
 * SQL adapter for the collaboration `PresenceManager` port (Collaboration Phase 1).
 *
 * geneWeave stores presence in the `run_presence` current-state table (m94).
 * This adapter makes that table conform to the `@weaveintel/collab`
 * PresenceManager port — the SAME interface the in-memory reference adapter
 * implements — so both pass the shared `presenceManagerContract`. (Same
 * ports-&-adapters pattern as the Phase 0 run substrate.)
 *
 * Presence is EPHEMERAL: every method UPSERTs/DELETEs the current-state table;
 * nothing is ever written to the durable run journal.
 */
import { newUUIDv7, type RunPresenceParticipant } from '@weaveintel/core';
import type { PresenceManager, PresenceScope, PresenceHeartbeat } from '@weaveintel/collab';
import type { RunPresenceRow } from './db-types/adapter-me.js';

/** The slice of the geneWeave DB adapter the presence adapter uses. */
export interface PresenceDb {
  upsertRunPresence(row: {
    id: string; run_id: string; tenant_id?: string | null; user_id: string; display_name: string;
    presence: string; peer_type: string; color?: string | null; cursor_json?: string | null;
    last_heartbeat_at: number; expires_at: number;
  }): Promise<void>;
  listActiveRunPresence(runId: string, now: number): Promise<RunPresenceRow[]>;
  deleteRunPresence(runId: string, userId: string): Promise<number>;
  deleteExpiredRunPresence(now: number): Promise<Array<{ run_id: string; tenant_id: string | null }>>;
}

export interface SqlPresenceManagerOptions {
  /** TTL in ms (from `collaboration_config.presence_ttl_ms`). Default 30000. */
  ttlMs?: number;
  /** Clock injection (tests). Default `Date.now`. */
  now?: () => number;
}

function rowToParticipant(row: RunPresenceRow): RunPresenceParticipant {
  let cursor: Record<string, unknown> | undefined;
  if (row.cursor_json) { try { cursor = JSON.parse(row.cursor_json) as Record<string, unknown>; } catch { /* tolerate */ } }
  return {
    userId: row.user_id,
    displayName: row.display_name,
    presence: row.presence,
    peerType: row.peer_type === 'agent' ? 'agent' : 'human',
    ...(row.color ? { color: row.color } : {}),
    lastHeartbeatAt: row.last_heartbeat_at,
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * Agent-as-peer (the mid-2026 Liveblocks pattern): the running agent is a
 * first-class presence participant. Rather than write+expire an agent row on
 * every run (extra DB churn + lifecycle coupling), we SYNTHESIZE the agent peer
 * from the run's status at snapshot time — it appears exactly while the run is
 * `running` and disappears the moment it completes. `userId: '__agent'` is a
 * reserved, non-human id.
 */
export function withAgentPeer(
  participants: RunPresenceParticipant[],
  runStatus: string,
  showAgentPresence: boolean,
): RunPresenceParticipant[] {
  if (!showAgentPresence || runStatus !== 'running') return participants;
  if (participants.some((p) => p.userId === '__agent')) return participants;
  return [...participants, { userId: '__agent', displayName: 'Agent', presence: 'working', peerType: 'agent' }];
}

/** A minimal view of the executor's ephemeral broadcast (avoids a hard import). */
export interface EphemeralBroadcaster {
  broadcastEphemeral(runId: string, kind: string, payload: Record<string, unknown>): void;
}

/**
 * Start the periodic presence sweeper (Collaboration Phase 1).
 *
 * Every `intervalMs`, reaps participants whose TTL elapsed (the fallback for
 * ungraceful disconnects — the common case is an explicit `leave`), and
 * re-broadcasts the updated snapshot to each affected run's live subscribers so
 * a departed peer disappears. Returns a `stop()` function; the interval is
 * `unref`'d so it never keeps the process alive (safe in tests).
 */
export function startPresenceSweeper(
  db: PresenceDb & { listActiveRunPresence(runId: string, now: number): Promise<RunPresenceRow[]> },
  bus: EphemeralBroadcaster,
  opts: { intervalMs?: number; now?: () => number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 10_000;
  const presence = createSqlPresenceManager(db, opts);
  const timer = setInterval(() => {
    void (async () => {
      try {
        const affected = await presence.sweep();
        for (const scope of affected) {
          const participants = await presence.list(scope);
          bus.broadcastEphemeral(scope.runId, 'presence.update', { participants });
        }
      } catch { /* sweep is best-effort */ }
    })();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export function createSqlPresenceManager(db: PresenceDb, opts: SqlPresenceManagerOptions = {}): PresenceManager {
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());

  async function snapshot(scope: PresenceScope): Promise<RunPresenceParticipant[]> {
    const rows = await db.listActiveRunPresence(scope.runId, now());
    return rows.map(rowToParticipant);
  }

  return {
    async heartbeat(scope: PresenceScope, beat: PresenceHeartbeat) {
      const t = now();
      await db.upsertRunPresence({
        id: newUUIDv7(),
        run_id: scope.runId,
        tenant_id: scope.tenantId,
        user_id: beat.userId,
        display_name: beat.displayName,
        presence: beat.presence,
        peer_type: beat.peerType ?? 'human',
        color: beat.color ?? null,
        cursor_json: beat.cursor ? JSON.stringify(beat.cursor) : null,
        last_heartbeat_at: t,
        expires_at: t + ttlMs,
      });
      return snapshot(scope);
    },

    async leave(scope: PresenceScope, userId: string) {
      await db.deleteRunPresence(scope.runId, userId);
      return snapshot(scope);
    },

    async list(scope: PresenceScope) {
      return snapshot(scope);
    },

    async sweep() {
      const affected = await db.deleteExpiredRunPresence(now());
      return affected.map((a) => ({ runId: a.run_id, tenantId: a.tenant_id ?? '__default__' }));
    },
  };
}
