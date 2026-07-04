import type { UserRow, SessionRow, OAuthLinkedAccountRow } from './core.js';
import type { IdempotencyRecordRow, OAuthFlowStateRow } from './agents.js';

export interface EmailVerificationRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface UserInvitationRow {
  id: string;
  email: string;
  persona: string;
  token_hash: string;
  invited_by: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
}

export interface IUserStore {
  // Users
  createUser(user: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null; emailBidx?: string | null }): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  getUserByEmailBidx(bidx: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  listUsers(filter?: { tenantId?: string | null }): Promise<UserRow[]>;
  listUsersForBidxRebuild(limit: number, afterId: string | null): Promise<Array<{ id: string; email: string }>>;
  setUserEmailBidx(userId: string, bidx: string | null): Promise<void>;
  updateUser(userId: string, updates: { email?: string; name?: string; persona?: string; tenantId?: string | null; passwordHash?: string; emailBidx?: string | null }): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  updateUserPersona(userId: string, persona: string): Promise<void>;

  // Sessions
  createSession(session: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;
  /** 4.17: Stamp the session with the ISO timestamp of a successful step-up MFA challenge. */
  setSessionMfaVerifiedAt(sessionId: string, verifiedAt: string): Promise<void>;

  // User MFA (4.17)
  /** 4.17: Return 1 if the user has MFA enabled, 0 if not. */
  getUserMfaEnabled(userId: string): Promise<boolean>;
  /** 4.17: Enable or disable MFA for a user. */
  setUserMfaEnabled(userId: string, enabled: boolean): Promise<void>;
  /** 4.17: Read the raw (possibly encrypted) TOTP secret for a user. */
  getUserMfaSecret(userId: string): Promise<string | null>;
  /** 4.17: Write (or clear) the raw TOTP secret for a user. */
  setUserMfaSecret(userId: string, secret: string | null): Promise<void>;

  // Idempotency records
  createIdempotencyRecord(record: Omit<IdempotencyRecordRow, 'created_at'>): Promise<void>;
  getIdempotencyRecordByKey(key: string): Promise<IdempotencyRecordRow | null>;
  deleteExpiredIdempotencyRecords(nowIso?: string): Promise<void>;
  trimIdempotencyRecords(maxEntries: number): Promise<void>;
  clearIdempotencyRecords(): Promise<void>;

  // OAuth flow state
  createOAuthFlowState(state: Omit<OAuthFlowStateRow, 'created_at'>): Promise<void>;
  consumeOAuthFlowStateByKey(stateKey: string): Promise<OAuthFlowStateRow | null>;
  deleteOAuthFlowStateByKey(stateKey: string): Promise<void>;
  deleteExpiredOAuthFlowStates(nowIso?: string): Promise<void>;

  // OAuth Linked Accounts
  createOAuthLinkedAccount(account: Omit<OAuthLinkedAccountRow, 'linked_at'>): Promise<void>;
  getOAuthLinkedAccount(userId: string, provider: string): Promise<OAuthLinkedAccountRow | null>;
  getOAuthLinkedAccountByProviderUserId(provider: string, providerUserId: string): Promise<OAuthLinkedAccountRow | null>;
  listOAuthLinkedAccounts(userId: string): Promise<OAuthLinkedAccountRow[]>;
  updateOAuthAccountLastUsed(userId: string, provider: string): Promise<void>;
  deleteOAuthLinkedAccount(userId: string, provider: string): Promise<void>;

  // Email verification
  createEmailVerification(v: { id: string; userId: string; tokenHash: string; expiresAt: string }): Promise<void>;
  getEmailVerificationByTokenHash(tokenHash: string): Promise<EmailVerificationRow | null>;
  getLatestEmailVerification(userId: string): Promise<EmailVerificationRow | null>;
  markEmailVerificationUsed(verificationId: string, userId: string): Promise<void>;
  markUserEmailVerified(userId: string): Promise<void>;
  deleteExpiredEmailVerifications(nowIso?: string): Promise<void>;

  // User invitations
  createUserInvitation(inv: { id: string; email: string; persona: string; tokenHash: string; invitedBy: string; expiresAt: string }): Promise<void>;
  getInvitationByTokenHash(tokenHash: string): Promise<UserInvitationRow | null>;
  getInvitationById(id: string): Promise<UserInvitationRow | null>;
  markInvitationUsed(invitationId: string, usedBy: string): Promise<void>;
  listInvitations(opts?: { limit?: number }): Promise<UserInvitationRow[]>;
  deleteExpiredInvitations(nowIso?: string): Promise<void>;

  // WebAuthn passkeys (4.1)
  createPasskeyCredential(c: { id: string; userId: string; credentialId: string; publicKeyCose: string; aaguid: string; counter: number; transports: string | null }): Promise<void>;
  getPasskeyCredentialById(credentialId: string): Promise<PasskeyCredentialRow | null>;
  listPasskeyCredentials(userId: string): Promise<PasskeyCredentialRow[]>;
  deletePasskeyCredential(id: string): Promise<void>;
  updatePasskeyCounter(id: string, counter: number): Promise<void>;

  createWebAuthnChallenge(c: { id: string; userId: string | null; challenge: string; type: string; expiresAt: string }): Promise<void>;
  consumeWebAuthnChallenge(userId: string, type: 'registration' | 'authentication'): Promise<WebAuthnChallengeRow | null>;
  consumeWebAuthnChallengeById(id: string): Promise<WebAuthnChallengeRow | null>;
  deleteExpiredWebAuthnChallenges(nowIso?: string): Promise<void>;
}

export interface PasskeyCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key_cose: string;
  aaguid: string;
  counter: number;
  transports: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface WebAuthnChallengeRow {
  id: string;
  user_id: string | null;
  challenge: string;
  type: string;
  used: number;
  expires_at: string;
  created_at: string;
}
