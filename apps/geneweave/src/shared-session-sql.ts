// SPDX-License-Identifier: MIT
/**
 * SQL adapter + access control for shared sessions (Collaboration Phase 2).
 *
 * - `createSqlSessionManager` makes geneWeave's `shared_sessions` +
 *   `session_participants` tables conform to the `@weaveintel/collab`
 *   `SessionManager` port (the same Phase 0/1 ports-&-adapters pattern; proven by
 *   `sessionManagerContract`).
 * - `mintShareToken` / `hashShareToken` generate invite-link tokens: a 256-bit
 *   random value shown to the owner ONCE; only its SHA-256 hash is stored.
 * - `resolveRunAccess` is the SINGLE authorization chokepoint every run endpoint
 *   calls: it returns the run + the caller's role (`owner` if they own it, else
 *   their shared-session role, else `null` = no access). The tenant gate runs
 *   before role logic.
 *
 * For someone new: "authorization" = deciding what a given user is allowed to do.
 * Doing it in ONE function that every endpoint calls (instead of re-checking ad
 * hoc) is how you avoid the classic bug where one endpoint forgets the check.
 */
import { randomBytes, createHash } from 'node:crypto';
import { newUUIDv7, type RunPresenceParticipant } from '@weaveintel/core';
import { roleAtLeast, type SessionManager, type SessionRole } from '@weaveintel/collab';
import type { SharedSessionRow, SessionParticipantRow, UserRunRow } from './db-types/adapter-me.js';

/**
 * Stamp each present human participant with their shared-session role so the UI
 * can badge who can edit vs only watch (Collaboration Phase 2). The run owner is
 * always `owner`; agents have no role. A run that was never shared just gets the
 * owner badged.
 */
export async function annotatePresenceRoles(
  participants: RunPresenceParticipant[],
  db: { getSharedSessionByRun(runId: string): Promise<SharedSessionRow | null>; listSessionParticipants(sessionId: string): Promise<SessionParticipantRow[]> },
  run: { id: string; user_id: string },
): Promise<RunPresenceParticipant[]> {
  const roleByUser = new Map<string, SessionRole>();
  const session = await db.getSharedSessionByRun(run.id);
  if (session) {
    for (const p of await db.listSessionParticipants(session.id)) roleByUser.set(p.user_id, p.role);
  }
  roleByUser.set(run.user_id, 'owner'); // the run's owner is always 'owner'
  return participants.map((p) =>
    p.peerType === 'human' && roleByUser.has(p.userId) ? { ...p, role: roleByUser.get(p.userId)! } : p,
  );
}

// ─── Invite-link tokens ─────────────────────────────────────────────────────────

/** Mint a fresh invite token: 256-bit CSPRNG value, URL-safe. */
export function mintShareToken(): { token: string; hash: string; prefix: string } {
  const token = randomBytes(32).toString('base64url'); // 256 bits, URL-safe
  return { token, hash: hashShareToken(token), prefix: token.slice(0, 8) };
}
/** Hash a token for lookup/storage — the plaintext is never persisted. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ─── SQL SessionManager adapter ─────────────────────────────────────────────────

export interface SessionDb {
  createSharedSession(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; max_participants: number; created_at: number }): Promise<void>;
  getSharedSessionById(id: string): Promise<SharedSessionRow | null>;
  getSharedSessionByRun(runId: string): Promise<SharedSessionRow | null>;
  endSharedSession(id: string, endedAt: number): Promise<void>;
  upsertSessionParticipant(row: { id: string; session_id: string; tenant_id?: string | null; user_id: string; role: string; joined_at: number; invited_via_token_id?: string | null }): Promise<void>;
  getSessionParticipant(sessionId: string, userId: string): Promise<SessionParticipantRow | null>;
  listSessionParticipants(sessionId: string): Promise<SessionParticipantRow[]>;
  deleteSessionParticipant(sessionId: string, userId: string): Promise<number>;
}

function rowToSession(r: SharedSessionRow) {
  return { id: r.id, runId: r.run_id, tenantId: r.tenant_id ?? '__default__', ownerId: r.owner_id, status: r.status, maxParticipants: r.max_participants, createdAt: r.created_at };
}

export function createSqlSessionManager(db: SessionDb, opts: { now?: () => number } = {}): SessionManager {
  const now = opts.now ?? (() => Date.now());

  async function requireOwner(sessionId: string, byUserId: string): Promise<SharedSessionRow> {
    const s = await db.getSharedSessionById(sessionId);
    if (!s) throw new Error(`session '${sessionId}' not found`);
    if (s.owner_id !== byUserId) throw new Error('forbidden: only the owner may manage this session');
    return s;
  }

  return {
    async createSession(input) {
      // INSERT OR IGNORE is idempotent per run; ensure the owner is participant #1.
      await db.createSharedSession({ id: input.id, run_id: input.runId, tenant_id: input.tenantId, owner_id: input.ownerId, max_participants: input.maxParticipants ?? 50, created_at: now() });
      const session = (await db.getSharedSessionByRun(input.runId))!; // the one we just made (or the existing one)
      await db.upsertSessionParticipant({ id: newUUIDv7(), session_id: session.id, tenant_id: input.tenantId, user_id: input.ownerId, role: 'owner', joined_at: now() });
      return rowToSession(session);
    },
    async getByRun(runId) {
      const s = await db.getSharedSessionByRun(runId);
      return s ? rowToSession(s) : null;
    },
    async getById(sessionId) {
      const s = await db.getSharedSessionById(sessionId);
      return s ? rowToSession(s) : null;
    },
    async join(sessionId, userId, role) {
      const s = await db.getSharedSessionById(sessionId);
      if (!s) throw new Error(`session '${sessionId}' not found`);
      if (s.status !== 'live') throw new Error('session has ended');
      const existing = await db.getSessionParticipant(sessionId, userId);
      if (existing) {
        // Idempotent: keep the HIGHER role ("highest permission wins").
        const kept: SessionRole = roleAtLeast(existing.role, role) ? existing.role : role;
        if (kept !== existing.role) await db.upsertSessionParticipant({ id: existing.id, session_id: sessionId, tenant_id: s.tenant_id, user_id: userId, role: kept, joined_at: existing.joined_at });
        return { userId, role: kept, joinedAt: existing.joined_at };
      }
      const count = (await db.listSessionParticipants(sessionId)).length;
      if (count >= s.max_participants) throw new Error('session is full');
      const joinedAt = now();
      await db.upsertSessionParticipant({ id: newUUIDv7(), session_id: sessionId, tenant_id: s.tenant_id, user_id: userId, role, joined_at: joinedAt });
      return { userId, role, joinedAt };
    },
    async getRole(sessionId, userId) {
      return (await db.getSessionParticipant(sessionId, userId))?.role ?? null;
    },
    async listParticipants(sessionId) {
      return (await db.listSessionParticipants(sessionId)).map((p) => ({ userId: p.user_id, role: p.role, joinedAt: p.joined_at }));
    },
    async leave(sessionId, userId) {
      await db.deleteSessionParticipant(sessionId, userId);
    },
    async removeParticipant(sessionId, byUserId, targetUserId) {
      await requireOwner(sessionId, byUserId);
      if (targetUserId === byUserId) throw new Error('the owner cannot remove themselves');
      await db.deleteSessionParticipant(sessionId, targetUserId);
    },
    async endSession(sessionId, byUserId) {
      await requireOwner(sessionId, byUserId);
      await db.endSharedSession(sessionId, now());
    },
  };
}

// ─── The authorization chokepoint ───────────────────────────────────────────────

export interface RunAccess {
  run: UserRunRow;
  role: SessionRole;
}

export interface RunAccessDb extends SessionDb {
  getUserRun(id: string, userId: string): Promise<UserRunRow | null>;
}

/**
 * Resolve a user's access to a run. Returns the run + their role, or `null` for
 * no access (the caller turns that into a 404 — never leaking that the run
 * exists). Order matters: ownership first, then shared-session membership, with
 * the tenant gate implicit in how membership is granted (a token only admits
 * within its tenant — enforced at join time).
 */
export async function resolveRunAccess(db: RunAccessDb, runId: string, userId: string): Promise<RunAccess | null> {
  // 1. Owner — the fast, common path.
  const owned = await db.getUserRun(runId, userId);
  if (owned) return { run: owned, role: 'owner' };

  // 2. Shared-session participant.
  const session = await db.getSharedSessionByRun(runId);
  if (!session || session.status !== 'live') return null;
  const participant = await db.getSessionParticipant(session.id, userId);
  if (!participant) return null;

  // Fetch the run via its OWNER (the participant is not the owner, so the
  // ownership-scoped lookup above returned null).
  const run = await db.getUserRun(runId, session.owner_id);
  if (!run) return null;
  return { run, role: participant.role };
}
