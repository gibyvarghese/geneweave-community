// SPDX-License-Identifier: MIT
/**
 * Postgres store for the FULL `IUserStore` slice of the geneWeave `DatabaseAdapter` — users,
 * sessions, per-user MFA, idempotency records, OAuth flow-state, OAuth linked accounts, email
 * verification, user invitations, and WebAuthn passkeys/challenges.
 *
 * This module implements EVERY `IUserStore` method and is composed on top of the core chat/skills
 * slice in `db-postgres.ts` (which already inlined a few — `createUser`, `getUserByEmail`,
 * `getUserById`); layered last, these re-ported methods SUPERSEDE the slice's copies.
 *
 * Each method mirrors the SQLite implementation in `db-sqlite.ts` statement-for-statement: identical
 * SQL, same column order, same return shapes. SQLite-isms are translated per the porting convention —
 * `?`→`$n` (dynamic builders renumber), `datetime('now')`→`${ctx.now}`, text `ORDER BY`→`COLLATE "C"`
 * (byte order parity), `INSERT OR REPLACE`/upsert→`ON CONFLICT (...) DO UPDATE SET ...=EXCLUDED...`,
 * and SQLite's `LIMIT -1 OFFSET n` (skip-first-n) → Postgres `OFFSET n` with no LIMIT. Booleans are
 * INTEGER 0/1 (numbers, never true/false); JSON columns are TEXT pass-through; every value is a bound
 * parameter. INTEGER columns are BIGINT in the schema but read back as JS numbers.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type { UserRow, SessionRow, OAuthLinkedAccountRow } from '../db-types/core.js';
import type { IdempotencyRecordRow, OAuthFlowStateRow } from '../db-types/agents.js';
import type {
  EmailVerificationRow,
  UserInvitationRow,
  PasskeyCredentialRow,
  WebAuthnChallengeRow,
} from '../db-types/adapter-users.js';

export function pgUserStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ─── Users ─────────────────────────────────────────────────────────────────
    async createUser(u: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null; emailBidx?: string | null }): Promise<void> {
      await ctx.query(
        'INSERT INTO users (id, email, name, persona, tenant_id, password_hash, email_bidx) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [u.id, u.email, u.name, u.persona ?? 'tenant_user', u.tenantId ?? null, u.passwordHash, u.emailBidx ?? null],
      );
    },

    async getUserByEmail(email: string): Promise<UserRow | null> {
      const { rows } = await ctx.query('SELECT * FROM users WHERE email = $1', [email]);
      return (rows[0] as UserRow | undefined) ?? null;
    },

    async getUserByEmailBidx(bidx: string): Promise<UserRow | null> {
      const { rows } = await ctx.query('SELECT * FROM users WHERE email_bidx = $1', [bidx]);
      return (rows[0] as UserRow | undefined) ?? null;
    },

    async getUserById(id: string): Promise<UserRow | null> {
      const { rows } = await ctx.query('SELECT * FROM users WHERE id = $1', [id]);
      return (rows[0] as UserRow | undefined) ?? null;
    },

    async listUsers(filter?: { tenantId?: string | null }): Promise<UserRow[]> {
      if (filter?.tenantId !== undefined) {
        if (filter.tenantId === null) {
          const { rows } = await ctx.query(
            'SELECT id, email, name, persona, tenant_id, email_bidx, created_at FROM users WHERE tenant_id IS NULL ORDER BY created_at COLLATE "C" ASC',
          );
          return rows as unknown as UserRow[];
        }
        const { rows } = await ctx.query(
          'SELECT id, email, name, persona, tenant_id, email_bidx, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at COLLATE "C" ASC',
          [filter.tenantId],
        );
        return rows as unknown as UserRow[];
      }
      const { rows } = await ctx.query(
        'SELECT id, email, name, persona, tenant_id, email_bidx, created_at FROM users ORDER BY created_at COLLATE "C" ASC',
      );
      return rows as unknown as UserRow[];
    },

    async listUsersForBidxRebuild(limit: number, afterId: string | null): Promise<Array<{ id: string; email: string }>> {
      if (afterId) {
        const { rows } = await ctx.query('SELECT id, email FROM users WHERE id > $1 ORDER BY id COLLATE "C" ASC LIMIT $2', [afterId, limit]);
        return rows as unknown as Array<{ id: string; email: string }>;
      }
      const { rows } = await ctx.query('SELECT id, email FROM users ORDER BY id COLLATE "C" ASC LIMIT $1', [limit]);
      return rows as unknown as Array<{ id: string; email: string }>;
    },

    async setUserEmailBidx(userId: string, bidx: string | null): Promise<void> {
      await ctx.query('UPDATE users SET email_bidx = $1 WHERE id = $2', [bidx, userId]);
    },

    async updateUser(userId: string, updates: {
      email?: string;
      name?: string;
      persona?: string;
      tenantId?: string | null;
      passwordHash?: string;
      emailBidx?: string | null;
    }): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (updates.email !== undefined) {
        fields.push(`email = $${values.length + 1}`);
        values.push(updates.email);
      }
      if (updates.name !== undefined) {
        fields.push(`name = $${values.length + 1}`);
        values.push(updates.name);
      }
      if (updates.persona !== undefined) {
        fields.push(`persona = $${values.length + 1}`);
        values.push(updates.persona);
      }
      if (updates.tenantId !== undefined) {
        fields.push(`tenant_id = $${values.length + 1}`);
        values.push(updates.tenantId);
      }
      if (updates.passwordHash !== undefined) {
        fields.push(`password_hash = $${values.length + 1}`);
        values.push(updates.passwordHash);
      }
      if (updates.emailBidx !== undefined) {
        fields.push(`email_bidx = $${values.length + 1}`);
        values.push(updates.emailBidx);
      }
      if (fields.length === 0) return;
      values.push(userId);
      await ctx.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
    },

    async deleteUser(userId: string): Promise<void> {
      await ctx.query('DELETE FROM users WHERE id = $1', [userId]);
    },

    async updateUserPersona(userId: string, persona: string): Promise<void> {
      await ctx.query('UPDATE users SET persona = $1 WHERE id = $2', [persona, userId]);
    },

    // ─── Sessions ──────────────────────────────────────────────────────────────
    async createSession(s: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void> {
      await ctx.query('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)', [s.id, s.userId, s.csrfToken, s.expiresAt]);
    },

    async getSession(id: string): Promise<SessionRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM sessions WHERE id = $1 AND expires_at > ${ctx.now}`, [id]);
      return (rows[0] as SessionRow | undefined) ?? null;
    },

    async deleteSession(id: string): Promise<void> {
      await ctx.query('DELETE FROM sessions WHERE id = $1', [id]);
    },

    async deleteExpiredSessions(): Promise<void> {
      await ctx.query(`DELETE FROM sessions WHERE expires_at <= ${ctx.now}`, []);
    },

    async setSessionMfaVerifiedAt(sessionId: string, verifiedAt: string): Promise<void> {
      await ctx.query('UPDATE sessions SET mfa_verified_at = $1 WHERE id = $2', [verifiedAt, sessionId]);
    },

    // ─── User MFA (4.17) ───────────────────────────────────────────────────────
    async getUserMfaEnabled(userId: string): Promise<boolean> {
      const { rows } = await ctx.query('SELECT mfa_enabled FROM users WHERE id = $1', [userId]);
      const row = rows[0] as { mfa_enabled?: number } | undefined;
      return (row?.mfa_enabled ?? 0) === 1;
    },

    async setUserMfaEnabled(userId: string, enabled: boolean): Promise<void> {
      await ctx.query('UPDATE users SET mfa_enabled = $1 WHERE id = $2', [enabled ? 1 : 0, userId]);
    },

    async getUserMfaSecret(userId: string): Promise<string | null> {
      const { rows } = await ctx.query('SELECT mfa_totp_secret FROM users WHERE id = $1', [userId]);
      const row = rows[0] as { mfa_totp_secret?: string | null } | undefined;
      return row?.mfa_totp_secret ?? null;
    },

    async setUserMfaSecret(userId: string, secret: string | null): Promise<void> {
      await ctx.query('UPDATE users SET mfa_totp_secret = $1 WHERE id = $2', [secret, userId]);
    },

    // ─── Idempotency records ───────────────────────────────────────────────────
    async createIdempotencyRecord(record: Omit<IdempotencyRecordRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO idempotency_records (id, key, result_json, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET
           id = EXCLUDED.id,
           result_json = EXCLUDED.result_json,
           expires_at = EXCLUDED.expires_at`,
        [record.id, record.key, record.result_json, record.expires_at],
      );
    },

    async getIdempotencyRecordByKey(key: string): Promise<IdempotencyRecordRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM idempotency_records WHERE key = $1 AND expires_at > ${ctx.now}`, [key]);
      return (rows[0] as IdempotencyRecordRow | undefined) ?? null;
    },

    async deleteExpiredIdempotencyRecords(nowIso?: string): Promise<void> {
      if (nowIso) {
        await ctx.query('DELETE FROM idempotency_records WHERE expires_at <= $1', [nowIso]);
        return;
      }
      await ctx.query(`DELETE FROM idempotency_records WHERE expires_at <= ${ctx.now}`, []);
    },

    async trimIdempotencyRecords(maxEntries: number): Promise<void> {
      if (maxEntries <= 0) {
        await ctx.query('DELETE FROM idempotency_records', []);
        return;
      }
      // SQLite `LIMIT -1 OFFSET n` = "all rows after skipping the first n". Postgres expresses the
      // unbounded tail as `OFFSET n` with no LIMIT.
      const { rows: stale } = await ctx.query(
        'SELECT id FROM idempotency_records ORDER BY created_at COLLATE "C" DESC, id COLLATE "C" DESC OFFSET $1',
        [maxEntries],
      );
      const ids = stale as unknown as Array<{ id: string }>;
      if (ids.length === 0) return;
      for (const row of ids) {
        await ctx.query('DELETE FROM idempotency_records WHERE id = $1', [row.id]);
      }
    },

    async clearIdempotencyRecords(): Promise<void> {
      await ctx.query('DELETE FROM idempotency_records', []);
    },

    // ─── OAuth flow state ──────────────────────────────────────────────────────
    async createOAuthFlowState(state: Omit<OAuthFlowStateRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO oauth_flow_states (id, state_key, user_id, provider, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (state_key) DO UPDATE SET
           id = EXCLUDED.id,
           user_id = EXCLUDED.user_id,
           provider = EXCLUDED.provider,
           expires_at = EXCLUDED.expires_at`,
        [state.id, state.state_key, state.user_id ?? null, state.provider, state.expires_at],
      );
    },

    async consumeOAuthFlowStateByKey(stateKey: string): Promise<OAuthFlowStateRow | null> {
      const { rows } = await ctx.query(
        `SELECT * FROM oauth_flow_states WHERE state_key = $1 AND expires_at > ${ctx.now}`,
        [stateKey],
      );
      const row = (rows[0] as OAuthFlowStateRow | undefined) ?? null;
      if (!row) return null;
      await ctx.query('DELETE FROM oauth_flow_states WHERE state_key = $1', [stateKey]);
      return row;
    },

    async deleteOAuthFlowStateByKey(stateKey: string): Promise<void> {
      await ctx.query('DELETE FROM oauth_flow_states WHERE state_key = $1', [stateKey]);
    },

    async deleteExpiredOAuthFlowStates(nowIso?: string): Promise<void> {
      if (nowIso) {
        await ctx.query('DELETE FROM oauth_flow_states WHERE expires_at <= $1', [nowIso]);
        return;
      }
      await ctx.query(`DELETE FROM oauth_flow_states WHERE expires_at <= ${ctx.now}`, []);
    },

    // ─── OAuth Linked Accounts ─────────────────────────────────────────────────
    async createOAuthLinkedAccount(account: Omit<OAuthLinkedAccountRow, 'linked_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO oauth_linked_accounts (id, user_id, provider, provider_user_id, email, name, picture_url, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           id = EXCLUDED.id,
           provider_user_id = EXCLUDED.provider_user_id,
           email = EXCLUDED.email,
           name = EXCLUDED.name,
           picture_url = EXCLUDED.picture_url,
           last_used_at = EXCLUDED.last_used_at`,
        [account.id, account.user_id, account.provider, account.provider_user_id, account.email, account.name, account.picture_url ?? null, account.last_used_at ?? null],
      );
    },

    async getOAuthLinkedAccount(userId: string, provider: string): Promise<OAuthLinkedAccountRow | null> {
      const { rows } = await ctx.query('SELECT * FROM oauth_linked_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
      return (rows[0] as OAuthLinkedAccountRow | undefined) ?? null;
    },

    async getOAuthLinkedAccountByProviderUserId(provider: string, providerUserId: string): Promise<OAuthLinkedAccountRow | null> {
      const { rows } = await ctx.query('SELECT * FROM oauth_linked_accounts WHERE provider = $1 AND provider_user_id = $2', [provider, providerUserId]);
      return (rows[0] as OAuthLinkedAccountRow | undefined) ?? null;
    },

    async listOAuthLinkedAccounts(userId: string): Promise<OAuthLinkedAccountRow[]> {
      const { rows } = await ctx.query('SELECT * FROM oauth_linked_accounts WHERE user_id = $1 ORDER BY linked_at COLLATE "C" DESC', [userId]);
      return rows as unknown as OAuthLinkedAccountRow[];
    },

    async updateOAuthAccountLastUsed(userId: string, provider: string): Promise<void> {
      await ctx.query(`UPDATE oauth_linked_accounts SET last_used_at = ${ctx.now} WHERE user_id = $1 AND provider = $2`, [userId, provider]);
    },

    async deleteOAuthLinkedAccount(userId: string, provider: string): Promise<void> {
      await ctx.query('DELETE FROM oauth_linked_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
    },

    // ─── Email verification ────────────────────────────────────────────────────
    async createEmailVerification(v: { id: string; userId: string; tokenHash: string; expiresAt: string }): Promise<void> {
      await ctx.query('INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [v.id, v.userId, v.tokenHash, v.expiresAt]);
    },

    async getEmailVerificationByTokenHash(tokenHash: string): Promise<EmailVerificationRow | null> {
      const { rows } = await ctx.query('SELECT * FROM email_verifications WHERE token_hash = $1', [tokenHash]);
      return (rows[0] as EmailVerificationRow | undefined) ?? null;
    },

    async getLatestEmailVerification(userId: string): Promise<EmailVerificationRow | null> {
      const { rows } = await ctx.query('SELECT * FROM email_verifications WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC LIMIT 1', [userId]);
      return (rows[0] as EmailVerificationRow | undefined) ?? null;
    },

    async markEmailVerificationUsed(verificationId: string, userId: string): Promise<void> {
      await ctx.query(`UPDATE email_verifications SET used_at = ${ctx.now} WHERE id = $1`, [verificationId]);
      await ctx.query(`UPDATE users SET email_verified = 1, email_verified_at = ${ctx.now} WHERE id = $1`, [userId]);
    },

    async markUserEmailVerified(userId: string): Promise<void> {
      await ctx.query(`UPDATE users SET email_verified = 1, email_verified_at = ${ctx.now} WHERE id = $1`, [userId]);
    },

    async deleteExpiredEmailVerifications(nowIso?: string): Promise<void> {
      const cutoff = nowIso ?? new Date().toISOString();
      await ctx.query('DELETE FROM email_verifications WHERE expires_at < $1 AND used_at IS NULL', [cutoff]);
    },

    // ─── User invitations ──────────────────────────────────────────────────────
    async createUserInvitation(inv: { id: string; email: string; persona: string; tokenHash: string; invitedBy: string; expiresAt: string }): Promise<void> {
      await ctx.query('INSERT INTO user_invitations (id, email, persona, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [inv.id, inv.email, inv.persona, inv.tokenHash, inv.invitedBy, inv.expiresAt]);
    },

    async getInvitationByTokenHash(tokenHash: string): Promise<UserInvitationRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_invitations WHERE token_hash = $1', [tokenHash]);
      return (rows[0] as UserInvitationRow | undefined) ?? null;
    },

    async getInvitationById(id: string): Promise<UserInvitationRow | null> {
      const { rows } = await ctx.query('SELECT * FROM user_invitations WHERE id = $1', [id]);
      return (rows[0] as UserInvitationRow | undefined) ?? null;
    },

    async markInvitationUsed(invitationId: string, usedBy: string): Promise<void> {
      await ctx.query(`UPDATE user_invitations SET used_at = ${ctx.now}, used_by = $1 WHERE id = $2`, [usedBy, invitationId]);
    },

    async listInvitations(opts?: { limit?: number }): Promise<UserInvitationRow[]> {
      const limit = Math.min(opts?.limit ?? 100, 500);
      const { rows } = await ctx.query('SELECT * FROM user_invitations ORDER BY created_at COLLATE "C" DESC LIMIT $1', [limit]);
      return rows as unknown as UserInvitationRow[];
    },

    async deleteExpiredInvitations(nowIso?: string): Promise<void> {
      const cutoff = nowIso ?? new Date().toISOString();
      await ctx.query('DELETE FROM user_invitations WHERE expires_at < $1 AND used_at IS NULL', [cutoff]);
    },

    // ─── WebAuthn passkeys (4.1) ───────────────────────────────────────────────
    async createPasskeyCredential(c: { id: string; userId: string; credentialId: string; publicKeyCose: string; aaguid: string; counter: number; transports: string | null }): Promise<void> {
      await ctx.query(
        `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key_cose, aaguid, counter, transports)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [c.id, c.userId, c.credentialId, c.publicKeyCose, c.aaguid, c.counter, c.transports],
      );
    },

    async getPasskeyCredentialById(credentialId: string): Promise<PasskeyCredentialRow | null> {
      const { rows } = await ctx.query('SELECT * FROM passkey_credentials WHERE credential_id = $1', [credentialId]);
      return (rows[0] as PasskeyCredentialRow | undefined) ?? null;
    },

    async listPasskeyCredentials(userId: string): Promise<PasskeyCredentialRow[]> {
      const { rows } = await ctx.query('SELECT * FROM passkey_credentials WHERE user_id = $1 ORDER BY created_at COLLATE "C" DESC', [userId]);
      return rows as unknown as PasskeyCredentialRow[];
    },

    async deletePasskeyCredential(id: string): Promise<void> {
      await ctx.query('DELETE FROM passkey_credentials WHERE id = $1', [id]);
    },

    async updatePasskeyCounter(id: string, counter: number): Promise<void> {
      await ctx.query(`UPDATE passkey_credentials SET counter = $1, last_used_at = ${ctx.now} WHERE id = $2`, [counter, id]);
    },

    async createWebAuthnChallenge(c: { id: string; userId: string | null; challenge: string; type: string; expiresAt: string }): Promise<void> {
      await ctx.query(
        `INSERT INTO webauthn_challenges (id, user_id, challenge, type, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [c.id, c.userId, c.challenge, c.type, c.expiresAt],
      );
    },

    async consumeWebAuthnChallenge(userId: string, type: 'registration' | 'authentication'): Promise<WebAuthnChallengeRow | null> {
      const { rows } = await ctx.query(
        `SELECT * FROM webauthn_challenges WHERE user_id = $1 AND type = $2 AND used = 0 ORDER BY created_at COLLATE "C" DESC LIMIT 1`,
        [userId, type],
      );
      const row = rows[0] as WebAuthnChallengeRow | undefined;
      if (!row) return null;
      await ctx.query('UPDATE webauthn_challenges SET used = 1 WHERE id = $1', [row.id]);
      return row;
    },

    async consumeWebAuthnChallengeById(id: string): Promise<WebAuthnChallengeRow | null> {
      const { rows } = await ctx.query(
        `SELECT * FROM webauthn_challenges WHERE id = $1 AND used = 0`,
        [id],
      );
      const row = rows[0] as WebAuthnChallengeRow | undefined;
      if (!row) return null;
      await ctx.query('UPDATE webauthn_challenges SET used = 1 WHERE id = $1', [id]);
      return row;
    },

    async deleteExpiredWebAuthnChallenges(nowIso?: string): Promise<void> {
      const cutoff = nowIso ?? new Date().toISOString();
      await ctx.query('DELETE FROM webauthn_challenges WHERE expires_at < $1', [cutoff]);
    },
  };
}
