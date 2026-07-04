/**
 * Conformance + unit tests — geneWeave's SQL SessionManager + access control
 * (Collaboration Phase 2). Runs the SAME sessionManagerContract the in-memory
 * adapter passes, then exercises resolveRunAccess, the share-token util, and
 * annotatePresenceRoles directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionManagerContract, type SessionManager } from '@weaveintel/collab';
import { SQLiteAdapter } from './db-sqlite.js';
import { createSqlSessionManager, resolveRunAccess, mintShareToken, hashShareToken, annotatePresenceRoles } from './shared-session-sql.js';
import type { RunPresenceParticipant } from '@weaveintel/core';

function tmpDb(): string {
  return join(tmpdir(), `gw-session-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize(); await db.seedDefaultData();
  await db.createUser({ id: 'owner', email: 'owner@x.dev', name: 'Owner', passwordHash: 'x' });
  return db;
}

// The contract creates sessions for dynamically-generated run ids; shared_sessions
// has a FK to user_runs, so wrap createSession to ensure the parent run exists.
async function makeSessionManager(): Promise<SessionManager> {
  const db = await freshDb();
  const mgr = createSqlSessionManager(db);
  return {
    ...mgr,
    createSession: async (input) => {
      await db.createUserRun({ id: input.runId, user_id: input.ownerId, status: 'running', tenant_id: input.tenantId }).catch(() => {});
      return mgr.createSession(input);
    },
  };
}

sessionManagerContract(makeSessionManager, { describe, it, beforeEach, expect } as unknown as Parameters<typeof sessionManagerContract>[1]);

describe('mintShareToken / hashShareToken', () => {
  it('mints a long URL-safe token whose hash is deterministic', () => {
    const a = mintShareToken();
    expect(a.token.length).toBeGreaterThan(40);             // 256 bits base64url ≈ 43 chars
    expect(/^[A-Za-z0-9_-]+$/.test(a.token)).toBe(true);    // URL-safe
    expect(hashShareToken(a.token)).toBe(a.hash);           // hash matches
    expect(a.hash).not.toBe(a.token);                        // stored value != secret
    expect(mintShareToken().token).not.toBe(a.token);        // unique each mint
  });
});

describe('resolveRunAccess', () => {
  it('owner gets role owner; a participant gets their role; a stranger gets null', async () => {
    const db = await freshDb();
    await db.createUser({ id: 'bob', email: 'bob@x.dev', name: 'Bob', passwordHash: 'x' });
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'running', tenant_id: 'tA' });
    // Owner.
    expect((await resolveRunAccess(db, 'r1', 'owner'))?.role).toBe('owner');
    // Stranger before sharing → no access.
    expect(await resolveRunAccess(db, 'r1', 'bob')).toBeNull();
    // Share + join bob as viewer.
    const sessions = createSqlSessionManager(db);
    const s = await sessions.createSession({ id: 'sess-1', runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    await sessions.join(s.id, 'bob', 'viewer');
    const acc = await resolveRunAccess(db, 'r1', 'bob');
    expect(acc?.role).toBe('viewer');
    expect(acc?.run.id).toBe('r1');
  });

  it('returns null once the session is ended (access revoked)', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'running', tenant_id: 'tA' });
    const sessions = createSqlSessionManager(db);
    const s = await sessions.createSession({ id: 'sess-1', runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    await sessions.join(s.id, 'bob', 'viewer');
    await sessions.endSession(s.id, 'owner');
    expect(await resolveRunAccess(db, 'r1', 'bob')).toBeNull(); // ended → no access
    expect((await resolveRunAccess(db, 'r1', 'owner'))?.role).toBe('owner'); // owner still owns it
  });
});

describe('annotatePresenceRoles', () => {
  it('badges the owner + participants with their roles; agents untouched', async () => {
    const db = await freshDb();
    await db.createUserRun({ id: 'r1', user_id: 'owner', status: 'running', tenant_id: 'tA' });
    const sessions = createSqlSessionManager(db);
    const s = await sessions.createSession({ id: 'sess-1', runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    await sessions.join(s.id, 'bob', 'collaborator');
    const parts: RunPresenceParticipant[] = [
      { userId: 'owner', displayName: 'Owner', presence: 'online', peerType: 'human' },
      { userId: 'bob', displayName: 'Bob', presence: 'online', peerType: 'human' },
      { userId: '__agent', displayName: 'Agent', presence: 'working', peerType: 'agent' },
    ];
    const out = await annotatePresenceRoles(parts, db, { id: 'r1', user_id: 'owner' });
    expect(out.find((p) => p.userId === 'owner')?.role).toBe('owner');
    expect(out.find((p) => p.userId === 'bob')?.role).toBe('collaborator');
    expect(out.find((p) => p.userId === '__agent')?.role).toBeUndefined();
  });
});
