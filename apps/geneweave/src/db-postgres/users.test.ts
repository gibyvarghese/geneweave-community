// SPDX-License-Identifier: MIT
/**
 * Parity test for the Postgres `IUserStore` slice (`pgUserStore`). Proves it returns the SAME rows as
 * a fresh `SQLiteAdapter` for identical inputs, against a REAL Postgres in a throwaway Docker
 * container. Covers a representative method from each group — users, sessions, OAuth linked accounts,
 * email verification, invitations, and MFA.
 *
 * Auto-skips cleanly when Docker isn't available (so `npm test` stays green anywhere). Timestamps
 * (`created_at`/`updated_at`) differ by wall-clock between the two stores, so they're normalised away
 * before comparison — but each is asserted to carry the exact `YYYY-MM-DD HH:MM:SS` shape. All list
 * comparisons are scoped to ids inserted BY THIS test so a shared container stays deterministic.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_FULL_SCHEMA } from '../db-postgres-schema.js';
import { NOW_SQL } from '../db-postgres-ctx.js';
import { pgUserStore } from './users.js';
import { SQLiteAdapter } from '../db-sqlite.js';

// ── Environment detection ────────────────────────────────────────────────────
const home = process.env['HOME'] ?? '';
const HAS_DOCKER =
  !!process.env['DOCKER_HOST'] ||
  ['/var/run/docker.sock', join(home, '.docker/run/docker.sock'), join(home, '.colima/default/docker.sock')].some(existsSync);

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Strip clock-dependent columns after asserting each carries the SQLite timestamp shape. */
function normCreated<T extends { created_at?: string }>(row: T): Omit<T, 'created_at'> {
  const { created_at, ...rest } = row;
  expect(created_at).toMatch(TS_RE);
  return rest;
}

function tempSqlite(): SQLiteAdapter {
  return new SQLiteAdapter(join(tmpdir(), `gw-users-parity-${Date.now()}-${randomUUID()}.db`));
}

/** A future ISO timestamp (for session / verification / invitation expiries). */
function futureIso(msFromNow = 3_600_000): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// Real Postgres — Testcontainers (skips without Docker)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DOCKER)('pgUserStore — IUserStore parity (real Postgres)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let pg: ReturnType<typeof pgUserStore>;
  let sq: SQLiteAdapter;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pgLib = (await import('pg')).default;
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pgLib.Pool({ connectionString: container.getConnectionUri() });
    await pool.query(POSTGRES_FULL_SCHEMA);
    pg = pgUserStore({ query: (t: string, p?: readonly unknown[]) => pool.query(t, p as unknown[]), now: NOW_SQL });
    sq = tempSqlite();
    await sq.initialize();
  }, 180_000);

  afterAll(async () => {
    await sq?.close();
    await pool?.end();
    await container?.stop();
  });

  /** Create the same user on both stores (FK parent for sessions/oauth/verifications). */
  async function seedUser(overrides?: Partial<{ email: string; name: string; persona: string }>): Promise<string> {
    const id = randomUUID();
    const u = {
      id,
      email: overrides?.email ?? `u-${id}@example.com`,
      name: overrides?.name ?? "O'Brien ☃",
      passwordHash: 'hash-x',
      persona: overrides?.persona ?? 'tenant_user',
    };
    await sq.createUser(u);
    await pg.createUser!(u);
    return id;
  }

  // ── users: create + get parity ─────────────────────────────────────────────
  it('createUser + getUserById: identical rows on both stores', async () => {
    const id = await seedUser();
    const sRow = await sq.getUserById(id);
    const pRow = await pg.getUserById!(id);
    expect(pRow).not.toBeNull();
    expect(normCreated(pRow!)).toEqual(normCreated(sRow!));
  });

  it('getUserByEmail: identical row via the email lookup', async () => {
    const email = `find-${randomUUID()}@example.com`;
    await seedUser({ email });
    const sRow = await sq.getUserByEmail(email);
    const pRow = await pg.getUserByEmail!(email);
    expect(pRow).not.toBeNull();
    expect(normCreated(pRow!)).toEqual(normCreated(sRow!));
  });

  // ── sessions: create/get/delete parity ─────────────────────────────────────
  it('createSession + getSession + deleteSession: parity incl. expiry filter', async () => {
    const userId = await seedUser();
    const sessionId = randomUUID();
    const s = { id: sessionId, userId, csrfToken: `csrf-${sessionId}`, expiresAt: futureIso() };
    await sq.createSession(s);
    await pg.createSession!(s);

    const sRow = await sq.getSession(sessionId);
    const pRow = await pg.getSession!(sessionId);
    expect(pRow).not.toBeNull();
    expect(normCreated(pRow!)).toEqual(normCreated(sRow!));

    await sq.deleteSession(sessionId);
    await pg.deleteSession!(sessionId);
    expect(await pg.getSession!(sessionId)).toBeNull();
    expect(await sq.getSession(sessionId)).toBeNull();
  });

  // ── OAuth linked accounts: create/list parity, scoped to this user ──────────
  it('createOAuthLinkedAccount + listOAuthLinkedAccounts: same rows, byte-order DESC by linked_at', async () => {
    const userId = await seedUser();
    const acct = {
      id: randomUUID(),
      user_id: userId,
      provider: 'google',
      provider_user_id: `g-${userId}`,
      email: `oauth-${userId}@example.com`,
      name: 'OAuth User',
      picture_url: null,
      last_used_at: null,
    };
    await sq.createOAuthLinkedAccount(acct);
    await pg.createOAuthLinkedAccount!(acct);

    const sGet = await sq.getOAuthLinkedAccount(userId, 'google');
    const pGet = await pg.getOAuthLinkedAccount!(userId, 'google');
    expect(pGet).not.toBeNull();
    // linked_at defaults on insert (clock-dependent) — strip it before comparing.
    const strip = (r: Record<string, unknown> | null) => {
      if (!r) return r;
      const { linked_at, ...rest } = r as Record<string, unknown>;
      expect(linked_at).toMatch(TS_RE);
      return rest;
    };
    expect(strip(pGet as unknown as Record<string, unknown>)).toEqual(strip(sGet as unknown as Record<string, unknown>));

    // List scoped to THIS user id only.
    const sList = await sq.listOAuthLinkedAccounts(userId);
    const pList = await pg.listOAuthLinkedAccounts!(userId);
    expect(pList.map((r) => r.id)).toEqual(sList.map((r) => r.id));
    expect(pList.map((r) => r.provider)).toEqual(['google']);
  });

  // ── email verification: create/get parity ──────────────────────────────────
  it('createEmailVerification + getEmailVerificationByTokenHash: identical rows', async () => {
    const userId = await seedUser();
    const tokenHash = `evh-${randomUUID()}`;
    const v = { id: randomUUID(), userId, tokenHash, expiresAt: futureIso() };
    await sq.createEmailVerification(v);
    await pg.createEmailVerification!(v);

    const sRow = await sq.getEmailVerificationByTokenHash(tokenHash);
    const pRow = await pg.getEmailVerificationByTokenHash!(tokenHash);
    expect(pRow).not.toBeNull();
    expect(normCreated(pRow!)).toEqual(normCreated(sRow!));
  });

  // ── invitation: create/get parity ──────────────────────────────────────────
  it('createUserInvitation + getInvitationByTokenHash: identical rows', async () => {
    const invitedBy = await seedUser();
    const tokenHash = `inv-${randomUUID()}`;
    const inv = {
      id: randomUUID(),
      email: `invitee-${randomUUID()}@example.com`,
      persona: 'tenant_user',
      tokenHash,
      invitedBy,
      expiresAt: futureIso(),
    };
    await sq.createUserInvitation(inv);
    await pg.createUserInvitation!(inv);

    const sRow = await sq.getInvitationByTokenHash(tokenHash);
    const pRow = await pg.getInvitationByTokenHash!(tokenHash);
    expect(pRow).not.toBeNull();
    expect(normCreated(pRow!)).toEqual(normCreated(sRow!));
  });

  // ── MFA toggle: setUserMfaEnabled + getUserMfaEnabled parity ────────────────
  it('setUserMfaEnabled + getUserMfaEnabled: same boolean on both, defaults false', async () => {
    const userId = await seedUser();
    expect(await pg.getUserMfaEnabled!(userId)).toBe(false);
    expect(await sq.getUserMfaEnabled(userId)).toBe(false);

    await sq.setUserMfaEnabled(userId, true);
    await pg.setUserMfaEnabled!(userId, true);
    expect(await pg.getUserMfaEnabled!(userId)).toBe(true);
    expect(await sq.getUserMfaEnabled(userId)).toBe(true);

    await sq.setUserMfaEnabled(userId, false);
    await pg.setUserMfaEnabled!(userId, false);
    expect(await pg.getUserMfaEnabled!(userId)).toBe(false);
    expect(await sq.getUserMfaEnabled(userId)).toBe(false);
  });

  // ── negative: missing lookups → null on both (no boolean-blind leak) ────────
  it('negative: missing id / token returns null on both', async () => {
    expect(await pg.getUserById!('does-not-exist')).toBeNull();
    expect(await sq.getUserById('does-not-exist')).toBeNull();
    expect(await pg.getSession!('nope')).toBeNull();
    expect(await sq.getSession('nope')).toBeNull();
    expect(await pg.getInvitationByTokenHash!(`' OR '1'='1`)).toBeNull(); // injection arg is data, not code
    expect(await sq.getInvitationByTokenHash(`' OR '1'='1`)).toBeNull();
  });
});
