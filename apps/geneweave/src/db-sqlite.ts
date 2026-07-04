/**
 * @weaveintel/geneweave — SQLite database adapter
 *
 * Concrete DatabaseAdapter backed by better-sqlite3.
 */

import { newUUIDv7 } from '@weaveintel/core';
import { getModelCapabilityFlags } from '@weaveintel/routing';
import { SqliteEncryptionStore } from './db-encryption-store.js';
import { encryptCredential, decryptCredential } from './vault.js';

// ── Vault helpers for m49 shadow-column encryption ───────────────────────────
// Fail-open: if VAULT_KEY is absent the server still boots; callers store
// plaintext with credentials_encrypted = 0 until a key is provisioned.

function vaultEncryptField(value: string | null): string | null {
  if (!value || !process.env['VAULT_KEY']) return null;
  try { return encryptCredential(value).encrypted; } catch { return null; }
}

function vaultDecryptField(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try { return decryptCredential<string>(ciphertext); } catch { return null; }
}
import { SCHEMA_SQL } from './db-schema.js';
import { applySQLiteBootstrapMigrations } from './db-sqlite-migrations.js';
import { stringifyPromptVariables } from '@weaveintel/prompts';
import { BUILT_IN_SKILLS } from '@weaveintel/skills';
import { HARD_EXECUTION_GUARD_POLICY, SUPERVISOR_CODE_EXECUTION_POLICY } from './chat-policies.js';
import type {
  DatabaseAdapter, DatabaseConfig,
  UserRow, SessionRow, ChatRow, MessageRow,
  MetricRow, EvalRow, ChatSettingsRow, TraceRow, UserPreferencesRow,
  TemporalTimerRow, TemporalStopwatchRow, TemporalReminderRow,
  PromptRow, PromptFrameworkRow, PromptFragmentRow, PromptContractRow, PromptStrategyRow,
  PromptVersionRow, PromptExperimentRow, PromptEvalDatasetRow, PromptEvalRunRow, PromptOptimizerRow, PromptOptimizationRunRow,
  GuardrailRow, GuardrailRevisionRow, RoutingPolicyRow, WorkflowDefRow, WorkflowHandlerKindRow,
  TriggerRow, TriggerInvocationRow, MeshContractRow,
  ToolCatalogRow, ToolPolicyRow, SkillRow, WorkerAgentRow, HumanTaskPolicyRow, TaskContractRow, CachePolicyRow,
  SupervisorAgentRow, AgentToolRow, ResolvedSupervisorAgent,
  IdentityRuleRow, MemoryGovernanceRow, SearchProviderRow, HttpEndpointRow,
  MemoryExtractionRuleRow,
  SocialAccountRow, EnterpriseConnectorRow, ToolRegistryRow, ReplayScenarioRow,
  TriggerDefinitionRow, TenantConfigRow, SandboxPolicyRow, ExtractionPipelineRow,
  ArtifactPolicyRow, ReliabilityPolicyRow,
  CollaborationSessionRow, ComplianceRuleRow, GraphConfigRow, PluginConfigRow,
  ScaffoldTemplateRow, RecipeConfigRow, WidgetConfigRow, ValidationRuleRow,
  SemanticMemoryRow, EntityMemoryRow,
  EpisodicMemoryRow, ProceduralMemoryRow, WorkingMemorySnapshotRow, MemorySettingsRow,
  IdempotencyRecordRow,
  OAuthFlowStateRow,
  MemoryExtractionEventRow,
  MetricsSummary, WorkflowRunRow, WorkflowCheckpointRow, CapabilityPolicyBindingRow, GuardrailEvalRow, ModelPricingRow,
  CapabilityPackRow, CapabilityPackInstallationRow, CapabilityPackExperimentRow, CapabilityPackStatus,
  CostPolicyRow,
  ToolEmbeddingRow,
  TenantEncryptionPolicyRow, TenantKekRow, TenantDekRow, TenantBikRow, EncryptionAuditRow, TenantEncryptionAlertConfigRow, TenantDeletionRequestRow,
  TenantByokConfigRow, TenantBreakGlassRequestRow, TenantAttestationLogRow, SystemAttestationSigningKeyRow,
  WebsiteCredentialRow,
  SvBudgetEnvelopeRow, SvHypothesisRow, SvHypothesisStatus, SvSubClaimRow, SvVerdictRow,
  SvEvidenceEventRow, SvAgentTurnRow,
  KaggleCompetitionTrackedRow, KaggleApproachRow, KaggleRunRow, KaggleRunArtifactRow,
  KaggleDiscussionSettingsRow, KaggleDiscussionPostRow,
  KaggleCompetitionRubricRow, KaggleValidationResultRow, KaggleLeaderboardScoreRow,
  KglCompetitionRunRow, KglRunStepRow, KglRunEventRow, LiveMeshMessageView,
  LiveMeshDefinitionRow, LiveAgentDefinitionRow, LiveMeshDelegationEdgeRow,
  LiveHandlerKindRow, LiveAttentionPolicyRow, LiveMeshRow, LiveAgentRow,
  LiveAgentHandlerBindingRow, LiveAgentToolBindingRow,
  LiveRunRow, LiveRunStepRow, LiveRunEventRow, ApiLiveRunRow,
  ProviderToolAdapterRow,
  TaskTypeDefinitionRow,
  ModelCapabilityScoreRow,
  RoutingDecisionTraceRow,
  RoutingCapabilitySignalRow,
  MessageFeedbackRow,
  RoutingSurfaceItemRow,
  RoutingExperimentRow,
  TaskTypeTenantOverrideRow,
} from './db-types.js';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export class SQLiteAdapter implements DatabaseAdapter {
  private db: import('better-sqlite3').Database | null = null;
  private encStore!: SqliteEncryptionStore;
  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    this.db = new BetterSqlite3(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    applySQLiteBootstrapMigrations(this.db);
    this.encStore = new SqliteEncryptionStore(this.db);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private get d() {
    if (!this.db) throw new Error('Database not initialized — call initialize() first');
    return this.db;
  }

  /** Exposed for createSqliteA2ATaskStore() in server.ts — do not use elsewhere. */
  get rawDb(): import('better-sqlite3').Database {
    return this.d;
  }

  /** Expose the underlying better-sqlite3 instance for stores that need direct DB access (e.g. weaveSqliteTriggerStore). */
  getRawDb(): import('better-sqlite3').Database {
    return this.d;
  }

  // ── Users ──────────────────────────────────────────────────

  async createUser(u: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null; emailBidx?: string | null }): Promise<void> {
    this.d.prepare('INSERT INTO users (id, email, name, persona, tenant_id, password_hash, email_bidx) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      u.id,
      u.email,
      u.name,
      u.persona ?? 'tenant_user',
      u.tenantId ?? null,
      u.passwordHash,
      u.emailBidx ?? null,
    );
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    return (this.d.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined) ?? null;
  }

  async getUserByEmailBidx(bidx: string): Promise<UserRow | null> {
    return (this.d.prepare('SELECT * FROM users WHERE email_bidx = ?').get(bidx) as UserRow | undefined) ?? null;
  }

  async getUserById(id: string): Promise<UserRow | null> {
    return (this.d.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  async listUsers(filter?: { tenantId?: string | null }): Promise<UserRow[]> {
    if (filter?.tenantId !== undefined) {
      if (filter.tenantId === null) {
        return this.d.prepare(
          'SELECT id, email, name, persona, tenant_id, email_bidx, created_at FROM users WHERE tenant_id IS NULL ORDER BY created_at ASC',
        ).all() as UserRow[];
      }
      return this.d.prepare(
        'SELECT id, email, name, persona, tenant_id, email_bidx, created_at FROM users WHERE tenant_id = ? ORDER BY created_at ASC',
      ).all(filter.tenantId) as UserRow[];
    }
    return this.d.prepare(
      'SELECT id, email, name, persona, tenant_id, email_bidx, created_at FROM users ORDER BY created_at ASC',
    ).all() as UserRow[];
  }

  async listUsersForBidxRebuild(limit: number, afterId: string | null): Promise<Array<{ id: string; email: string }>> {
    const rows = afterId
      ? (this.d.prepare('SELECT id, email FROM users WHERE id > ? ORDER BY id ASC LIMIT ?').all(afterId, limit) as Array<{ id: string; email: string }>)
      : (this.d.prepare('SELECT id, email FROM users ORDER BY id ASC LIMIT ?').all(limit) as Array<{ id: string; email: string }>);
    return rows;
  }

  async setUserEmailBidx(userId: string, bidx: string | null): Promise<void> {
    this.d.prepare('UPDATE users SET email_bidx = ? WHERE id = ?').run(bidx, userId);
  }

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
      fields.push('email = ?');
      values.push(updates.email);
    }
    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.persona !== undefined) {
      fields.push('persona = ?');
      values.push(updates.persona);
    }
    if (updates.tenantId !== undefined) {
      fields.push('tenant_id = ?');
      values.push(updates.tenantId);
    }
    if (updates.passwordHash !== undefined) {
      fields.push('password_hash = ?');
      values.push(updates.passwordHash);
    }
    if (updates.emailBidx !== undefined) {
      fields.push('email_bidx = ?');
      values.push(updates.emailBidx);
    }
    if (fields.length === 0) return;
    values.push(userId);
    this.d.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async deleteUser(userId: string): Promise<void> {
    this.d.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  async updateUserPersona(userId: string, persona: string): Promise<void> {
    this.d.prepare("UPDATE users SET persona = ? WHERE id = ?").run(persona, userId);
  }

  // ── Sessions ───────────────────────────────────────────────

  async createSession(s: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void> {
    this.d.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(s.id, s.userId, s.csrfToken, s.expiresAt);
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return (this.d.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > datetime(\'now\')').get(id) as SessionRow | undefined) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.d.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  async deleteExpiredSessions(): Promise<void> {
    this.d.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  }

  async setSessionMfaVerifiedAt(sessionId: string, verifiedAt: string): Promise<void> {
    this.d.prepare('UPDATE sessions SET mfa_verified_at = ? WHERE id = ?').run(verifiedAt, sessionId);
  }

  async getUserMfaEnabled(userId: string): Promise<boolean> {
    const row = this.d.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(userId) as { mfa_enabled?: number } | undefined;
    return (row?.mfa_enabled ?? 0) === 1;
  }

  async setUserMfaEnabled(userId: string, enabled: boolean): Promise<void> {
    this.d.prepare('UPDATE users SET mfa_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
  }

  async getUserMfaSecret(userId: string): Promise<string | null> {
    const row = this.d.prepare('SELECT mfa_totp_secret FROM users WHERE id = ?').get(userId) as { mfa_totp_secret?: string | null } | undefined;
    return row?.mfa_totp_secret ?? null;
  }

  async setUserMfaSecret(userId: string, secret: string | null): Promise<void> {
    this.d.prepare('UPDATE users SET mfa_totp_secret = ? WHERE id = ?').run(secret, userId);
  }

  async createIdempotencyRecord(record: Omit<IdempotencyRecordRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO idempotency_records (id, key, result_json, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         id = excluded.id,
         result_json = excluded.result_json,
         expires_at = excluded.expires_at`,
    ).run(record.id, record.key, record.result_json, record.expires_at);
  }

  async getIdempotencyRecordByKey(key: string): Promise<IdempotencyRecordRow | null> {
    return (this.d.prepare(
      `SELECT * FROM idempotency_records WHERE key = ? AND expires_at > datetime('now')`,
    ).get(key) as IdempotencyRecordRow | undefined) ?? null;
  }

  async deleteExpiredIdempotencyRecords(nowIso?: string): Promise<void> {
    if (nowIso) {
      this.d.prepare('DELETE FROM idempotency_records WHERE expires_at <= ?').run(nowIso);
      return;
    }
    this.d.prepare("DELETE FROM idempotency_records WHERE expires_at <= datetime('now')").run();
  }

  async trimIdempotencyRecords(maxEntries: number): Promise<void> {
    if (maxEntries <= 0) {
      this.d.prepare('DELETE FROM idempotency_records').run();
      return;
    }
    const stale = this.d.prepare(
      'SELECT id FROM idempotency_records ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?',
    ).all(maxEntries) as Array<{ id: string }>;
    if (stale.length === 0) return;
    const del = this.d.prepare('DELETE FROM idempotency_records WHERE id = ?');
    const tx = this.d.transaction((ids: Array<{ id: string }>) => {
      for (const row of ids) del.run(row.id);
    });
    tx(stale);
  }

  async clearIdempotencyRecords(): Promise<void> {
    this.d.prepare('DELETE FROM idempotency_records').run();
  }

  async createOAuthFlowState(state: Omit<OAuthFlowStateRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO oauth_flow_states (id, state_key, user_id, provider, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(state_key) DO UPDATE SET
         id = excluded.id,
         user_id = excluded.user_id,
         provider = excluded.provider,
         expires_at = excluded.expires_at`,
    ).run(state.id, state.state_key, state.user_id ?? null, state.provider, state.expires_at);
  }

  async consumeOAuthFlowStateByKey(stateKey: string): Promise<OAuthFlowStateRow | null> {
    const tx = this.d.transaction((key: string) => {
      const row = this.d.prepare(
        `SELECT * FROM oauth_flow_states
         WHERE state_key = ? AND expires_at > datetime('now')`,
      ).get(key) as OAuthFlowStateRow | undefined;
      if (!row) return null;
      this.d.prepare('DELETE FROM oauth_flow_states WHERE state_key = ?').run(key);
      return row;
    });
    return tx(stateKey);
  }

  async deleteOAuthFlowStateByKey(stateKey: string): Promise<void> {
    this.d.prepare('DELETE FROM oauth_flow_states WHERE state_key = ?').run(stateKey);
  }

  async deleteExpiredOAuthFlowStates(nowIso?: string): Promise<void> {
    if (nowIso) {
      this.d.prepare('DELETE FROM oauth_flow_states WHERE expires_at <= ?').run(nowIso);
      return;
    }
    this.d.prepare("DELETE FROM oauth_flow_states WHERE expires_at <= datetime('now')").run();
  }

  // ── OAuth Linked Accounts ──────────────────────────────────

  async createOAuthLinkedAccount(account: Omit<import('./db-types.js').OAuthLinkedAccountRow, 'linked_at'>): Promise<void> {
    this.d.prepare(`
      INSERT OR REPLACE INTO oauth_linked_accounts (id, user_id, provider, provider_user_id, email, name, picture_url, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(account.id, account.user_id, account.provider, account.provider_user_id, account.email, account.name, account.picture_url ?? null, account.last_used_at ?? null);
  }

  async getOAuthLinkedAccount(userId: string, provider: string): Promise<import('./db-types.js').OAuthLinkedAccountRow | null> {
    return (this.d.prepare('SELECT * FROM oauth_linked_accounts WHERE user_id = ? AND provider = ?').get(userId, provider) as import('./db-types.js').OAuthLinkedAccountRow | undefined) ?? null;
  }

  async getOAuthLinkedAccountByProviderUserId(provider: string, providerUserId: string): Promise<import('./db-types.js').OAuthLinkedAccountRow | null> {
    return (this.d.prepare('SELECT * FROM oauth_linked_accounts WHERE provider = ? AND provider_user_id = ?').get(provider, providerUserId) as import('./db-types.js').OAuthLinkedAccountRow | undefined) ?? null;
  }

  async listOAuthLinkedAccounts(userId: string): Promise<import('./db-types.js').OAuthLinkedAccountRow[]> {
    return this.d.prepare('SELECT * FROM oauth_linked_accounts WHERE user_id = ? ORDER BY linked_at DESC').all(userId) as import('./db-types.js').OAuthLinkedAccountRow[];
  }

  async updateOAuthAccountLastUsed(userId: string, provider: string): Promise<void> {
    this.d.prepare("UPDATE oauth_linked_accounts SET last_used_at = datetime('now') WHERE user_id = ? AND provider = ?").run(userId, provider);
  }

  async deleteOAuthLinkedAccount(userId: string, provider: string): Promise<void> {
    this.d.prepare('DELETE FROM oauth_linked_accounts WHERE user_id = ? AND provider = ?').run(userId, provider);
  }

  // ── Email verification ──────────────────────────────────────

  async createEmailVerification(v: { id: string; userId: string; tokenHash: string; expiresAt: string }): Promise<void> {
    this.d.prepare('INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(v.id, v.userId, v.tokenHash, v.expiresAt);
  }

  async getEmailVerificationByTokenHash(tokenHash: string): Promise<import('./db-types/adapter-users.js').EmailVerificationRow | null> {
    return (this.d.prepare('SELECT * FROM email_verifications WHERE token_hash = ?').get(tokenHash) as import('./db-types/adapter-users.js').EmailVerificationRow | undefined) ?? null;
  }

  async getLatestEmailVerification(userId: string): Promise<import('./db-types/adapter-users.js').EmailVerificationRow | null> {
    return (this.d.prepare('SELECT * FROM email_verifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as import('./db-types/adapter-users.js').EmailVerificationRow | undefined) ?? null;
  }

  async markEmailVerificationUsed(verificationId: string, userId: string): Promise<void> {
    this.d.prepare("UPDATE email_verifications SET used_at = datetime('now') WHERE id = ?").run(verificationId);
    this.d.prepare("UPDATE users SET email_verified = 1, email_verified_at = datetime('now') WHERE id = ?").run(userId);
  }

  async markUserEmailVerified(userId: string): Promise<void> {
    this.d.prepare("UPDATE users SET email_verified = 1, email_verified_at = datetime('now') WHERE id = ?").run(userId);
  }

  async deleteExpiredEmailVerifications(nowIso?: string): Promise<void> {
    const cutoff = nowIso ?? new Date().toISOString();
    this.d.prepare("DELETE FROM email_verifications WHERE expires_at < ? AND used_at IS NULL").run(cutoff);
  }

  // ── User invitations ────────────────────────────────────────

  async createUserInvitation(inv: { id: string; email: string; persona: string; tokenHash: string; invitedBy: string; expiresAt: string }): Promise<void> {
    this.d.prepare('INSERT INTO user_invitations (id, email, persona, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(inv.id, inv.email, inv.persona, inv.tokenHash, inv.invitedBy, inv.expiresAt);
  }

  async getInvitationByTokenHash(tokenHash: string): Promise<import('./db-types/adapter-users.js').UserInvitationRow | null> {
    return (this.d.prepare('SELECT * FROM user_invitations WHERE token_hash = ?').get(tokenHash) as import('./db-types/adapter-users.js').UserInvitationRow | undefined) ?? null;
  }

  async getInvitationById(id: string): Promise<import('./db-types/adapter-users.js').UserInvitationRow | null> {
    return (this.d.prepare('SELECT * FROM user_invitations WHERE id = ?').get(id) as import('./db-types/adapter-users.js').UserInvitationRow | undefined) ?? null;
  }

  async markInvitationUsed(invitationId: string, usedBy: string): Promise<void> {
    this.d.prepare("UPDATE user_invitations SET used_at = datetime('now'), used_by = ? WHERE id = ?").run(usedBy, invitationId);
  }

  async listInvitations(opts?: { limit?: number }): Promise<import('./db-types/adapter-users.js').UserInvitationRow[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    return this.d.prepare('SELECT * FROM user_invitations ORDER BY created_at DESC LIMIT ?').all(limit) as import('./db-types/adapter-users.js').UserInvitationRow[];
  }

  async deleteExpiredInvitations(nowIso?: string): Promise<void> {
    const cutoff = nowIso ?? new Date().toISOString();
    this.d.prepare("DELETE FROM user_invitations WHERE expires_at < ? AND used_at IS NULL").run(cutoff);
  }

  // ── WebAuthn passkeys (4.1) ────────────────────────────────

  async createPasskeyCredential(c: { id: string; userId: string; credentialId: string; publicKeyCose: string; aaguid: string; counter: number; transports: string | null }): Promise<void> {
    this.d.prepare(
      `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key_cose, aaguid, counter, transports)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.userId, c.credentialId, c.publicKeyCose, c.aaguid, c.counter, c.transports);
  }

  async getPasskeyCredentialById(credentialId: string): Promise<import('./db-types/adapter-users.js').PasskeyCredentialRow | null> {
    return (this.d.prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?').get(credentialId) as import('./db-types/adapter-users.js').PasskeyCredentialRow | undefined) ?? null;
  }

  async listPasskeyCredentials(userId: string): Promise<import('./db-types/adapter-users.js').PasskeyCredentialRow[]> {
    return this.d.prepare('SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC').all(userId) as import('./db-types/adapter-users.js').PasskeyCredentialRow[];
  }

  async deletePasskeyCredential(id: string): Promise<void> {
    this.d.prepare('DELETE FROM passkey_credentials WHERE id = ?').run(id);
  }

  async updatePasskeyCounter(id: string, counter: number): Promise<void> {
    this.d.prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?").run(counter, id);
  }

  async createWebAuthnChallenge(c: { id: string; userId: string | null; challenge: string; type: string; expiresAt: string }): Promise<void> {
    this.d.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, challenge, type, expires_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(c.id, c.userId, c.challenge, c.type, c.expiresAt);
  }

  async consumeWebAuthnChallenge(userId: string, type: 'registration' | 'authentication'): Promise<import('./db-types/adapter-users.js').WebAuthnChallengeRow | null> {
    const row = this.d.prepare(
      `SELECT * FROM webauthn_challenges WHERE user_id = ? AND type = ? AND used = 0 ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, type) as import('./db-types/adapter-users.js').WebAuthnChallengeRow | undefined;
    if (!row) return null;
    this.d.prepare('UPDATE webauthn_challenges SET used = 1 WHERE id = ?').run(row.id);
    return row;
  }

  async consumeWebAuthnChallengeById(id: string): Promise<import('./db-types/adapter-users.js').WebAuthnChallengeRow | null> {
    const row = this.d.prepare(
      `SELECT * FROM webauthn_challenges WHERE id = ? AND used = 0`,
    ).get(id) as import('./db-types/adapter-users.js').WebAuthnChallengeRow | undefined;
    if (!row) return null;
    this.d.prepare('UPDATE webauthn_challenges SET used = 1 WHERE id = ?').run(id);
    return row;
  }

  async deleteExpiredWebAuthnChallenges(nowIso?: string): Promise<void> {
    const cutoff = nowIso ?? new Date().toISOString();
    this.d.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").run(cutoff);
  }

  // ── Chats ──────────────────────────────────────────────────

  async createChat(c: { id: string; userId: string; title: string; model: string; provider: string }): Promise<void> {
    this.d.prepare('INSERT INTO chats (id, user_id, title, model, provider) VALUES (?, ?, ?, ?, ?)').run(c.id, c.userId, c.title, c.model, c.provider);
  }

  async getChat(id: string, userId: string): Promise<ChatRow | null> {
    return (this.d.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(id, userId) as ChatRow | undefined) ?? null;
  }

  async getChatById(id: string): Promise<ChatRow | null> {
    return (this.d.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined) ?? null;
  }

  async getUserChats(userId: string): Promise<ChatRow[]> {
    return this.d.prepare('SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as ChatRow[];
  }

  async updateChatTitle(id: string, userId: string, title: string): Promise<void> {
    this.d.prepare("UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(title, id, userId);
  }

  async deleteChat(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').run(id, userId);
  }

  // ── Conversations (user-scoped list/search + pin/archive — SP2) ─────────────

  async listUserConversations(
    userId: string,
    opts: import('./db-types.js').ConversationListOptions = {},
  ): Promise<import('./db-types.js').ConversationRow[]> {
    const filter = opts.filter ?? 'active';
    const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 200);
    const offset = Math.max(Number(opts.offset ?? 0), 0);

    const where: string[] = ['c.user_id = ?'];
    const params: unknown[] = [userId];

    if (filter === 'active') where.push('c.archived = 0');
    else if (filter === 'archived') where.push('c.archived = 1');
    else if (filter === 'pinned') where.push('c.pinned = 1 AND c.archived = 0');
    // 'all' adds no archived/pinned constraint.

    const query = (opts.query ?? '').trim();
    if (query) {
      // Escape LIKE wildcards so user input is matched literally.
      const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const like = `%${escaped}%`;
      where.push(
        "(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.chat_id = c.id AND m2.content LIKE ? ESCAPE '\\'))",
      );
      params.push(like, like);
    }

    params.push(limit, offset);

    const sql = `
      SELECT
        c.id, c.title, c.model, c.provider, c.pinned, c.archived, c.created_at, c.updated_at,
        COALESCE(cs.mode, 'agent') AS mode,
        (SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS snippet
      FROM chats c
      LEFT JOIN chat_settings cs ON cs.chat_id = c.id
      WHERE ${where.join(' AND ')}
      ORDER BY c.pinned DESC, c.updated_at DESC, c.rowid DESC
      LIMIT ? OFFSET ?`;

    return this.d.prepare(sql).all(...params) as import('./db-types.js').ConversationRow[];
  }

  async getUserConversation(id: string, userId: string): Promise<import('./db-types.js').ConversationRow | null> {
    const sql = `
      SELECT
        c.id, c.title, c.model, c.provider, c.pinned, c.archived, c.created_at, c.updated_at,
        COALESCE(cs.mode, 'agent') AS mode,
        (SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS snippet
      FROM chats c
      LEFT JOIN chat_settings cs ON cs.chat_id = c.id
      WHERE c.id = ? AND c.user_id = ?`;
    return (this.d.prepare(sql).get(id, userId) as import('./db-types.js').ConversationRow | undefined) ?? null;
  }

  async setConversationFlags(
    id: string,
    userId: string,
    flags: import('./db-types.js').ConversationFlags,
  ): Promise<import('./db-types.js').ConversationRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (flags.pinned !== undefined) { sets.push('pinned = ?'); params.push(flags.pinned ? 1 : 0); }
    if (flags.archived !== undefined) { sets.push('archived = ?'); params.push(flags.archived ? 1 : 0); }
    if (flags.title !== undefined) { sets.push('title = ?'); params.push(flags.title); }

    if (sets.length > 0) {
      // Flag/title changes deliberately do NOT bump updated_at so pin/archive
      // never reorders the recency-sorted list.
      params.push(id, userId);
      this.d.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
    }
    return this.getUserConversation(id, userId);
  }

  // ── Messages ───────────────────────────────────────────────

  async addMessage(m: {
    id: string; chatId: string; role: string; content: string;
    metadata?: string; tokensUsed?: number; cost?: number; latencyMs?: number;
  }): Promise<void> {
    this.d.prepare(
      'INSERT INTO messages (id, chat_id, role, content, metadata, tokens_used, cost, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(m.id, m.chatId, m.role, m.content, m.metadata ?? null, m.tokensUsed ?? 0, m.cost ?? 0, m.latencyMs ?? 0);
    this.d.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(m.chatId);
  }

  async getMessages(chatId: string): Promise<MessageRow[]> {
    return this.d.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(chatId) as MessageRow[];
  }

  // ── Metrics ────────────────────────────────────────────────

  async recordMetric(m: {
    id: string; userId: string; chatId?: string; type: string;
    provider?: string; model?: string; promptTokens?: number;
    completionTokens?: number; totalTokens?: number; cost?: number;
    latencyMs?: number; metadata?: string;
  }): Promise<void> {
    this.d.prepare(
      'INSERT INTO metrics (id, user_id, chat_id, type, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, latency_ms, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      m.id, m.userId, m.chatId ?? null, m.type, m.provider ?? null, m.model ?? null,
      m.promptTokens ?? 0, m.completionTokens ?? 0, m.totalTokens ?? 0,
      m.cost ?? 0, m.latencyMs ?? 0, m.metadata ?? null,
    );
  }

  async getMetrics(userId: string, from?: string, to?: string): Promise<MetricRow[]> {
    let sql = 'SELECT * FROM metrics WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (from) { sql += ' AND created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND created_at <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC';
    return this.d.prepare(sql).all(...params) as MetricRow[];
  }

  async getMetricsSummary(userId: string, from?: string, to?: string): Promise<MetricsSummary> {
    let where = 'WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (from) { where += ' AND created_at >= ?'; params.push(from); }
    if (to) { where += ' AND created_at <= ?'; params.push(to); }

    const totals = this.d.prepare(
      `SELECT COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost),0) as total_cost, COALESCE(AVG(latency_ms),0) as avg_latency_ms FROM metrics ${where}`,
    ).get(...params) as { total_tokens: number; total_cost: number; avg_latency_ms: number };

    const msgCount = this.d.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)`,
    ).get(userId) as { cnt: number };

    const chatCount = this.d.prepare(
      'SELECT COUNT(*) as cnt FROM chats WHERE user_id = ?',
    ).get(userId) as { cnt: number };

    const byModel = this.d.prepare(
      `SELECT model, provider, SUM(total_tokens) as tokens, SUM(cost) as cost, COUNT(*) as count FROM metrics ${where} GROUP BY model, provider`,
    ).all(...params) as Array<{ model: string; provider: string; tokens: number; cost: number; count: number }>;

    const byDay = this.d.prepare(
      `SELECT DATE(created_at) as date, SUM(total_tokens) as tokens, SUM(cost) as cost, COUNT(*) as count FROM metrics ${where} GROUP BY DATE(created_at) ORDER BY date`,
    ).all(...params) as Array<{ date: string; tokens: number; cost: number; count: number }>;

    return {
      total_tokens: totals.total_tokens,
      total_cost: totals.total_cost,
      avg_latency_ms: Math.round(totals.avg_latency_ms),
      total_messages: msgCount.cnt,
      total_chats: chatCount.cnt,
      by_model: byModel,
      by_day: byDay,
    };
  }

  // ── Evals ──────────────────────────────────────────────────

  async recordEval(r: {
    id: string; userId: string; chatId?: string; evalName: string;
    score: number; passed: number; failed: number; total: number; details?: string;
  }): Promise<void> {
    this.d.prepare(
      'INSERT INTO eval_results (id, user_id, chat_id, eval_name, score, passed, failed, total, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(r.id, r.userId, r.chatId ?? null, r.evalName, r.score, r.passed, r.failed, r.total, r.details ?? null);
  }

  async getEvals(userId: string, from?: string, to?: string): Promise<EvalRow[]> {
    let sql = 'SELECT * FROM eval_results WHERE user_id = ?';
    const params: unknown[] = [userId];
    // eval_results uses updated_at (no created_at column)
    if (from) { sql += ' AND updated_at >= ?'; params.push(from); }
    if (to) { sql += ' AND updated_at <= ?'; params.push(to); }
    sql += ' ORDER BY updated_at DESC';
    return this.d.prepare(sql).all(...params) as EvalRow[];
  }

  // ── User Preferences ──────────────────────────────────────

  async getUserPreferences(userId: string): Promise<UserPreferencesRow | null> {
    return (this.d.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as UserPreferencesRow | undefined) ?? null;
  }

  async saveUserPreferences(userId: string, defaultMode: string, theme: string, showProcessCard?: boolean): Promise<void> {
    const showFlag = showProcessCard === false ? 0 : 1;
    this.d.prepare(
      `INSERT INTO user_preferences (user_id, default_mode, theme, show_process_card)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         default_mode=excluded.default_mode,
         theme=excluded.theme,
         show_process_card=excluded.show_process_card,
         updated_at=datetime('now')`,
    ).run(userId, defaultMode, theme, showFlag);
  }

  // m136 — Account settings surface. `patch` is a whitelist-validated set of columns from the service layer.
  async updateUserAccountPrefs(userId: string, patch: Record<string, string | null>): Promise<void> {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    // Ensure a row exists first (a fresh user may have no preferences row yet).
    this.d.prepare(`INSERT OR IGNORE INTO user_preferences (user_id, default_mode, theme, show_process_card) VALUES (?, 'direct', 'light', 1)`).run(userId);
    const setClause = cols.map((c) => `${c}=@${c}`).join(', ');
    this.d.prepare(`UPDATE user_preferences SET ${setClause}, updated_at=datetime('now') WHERE user_id=@user_id`).run({ ...patch, user_id: userId });
  }

  async getUserNotificationPrefs(userId: string): Promise<import('./db-types/core.js').UserNotificationPrefRow[]> {
    return this.d.prepare('SELECT * FROM user_notification_prefs WHERE user_id = ? ORDER BY event_key').all(userId) as import('./db-types/core.js').UserNotificationPrefRow[];
  }

  async setUserNotificationPref(userId: string, eventKey: string, channels: { in_app?: boolean; email?: boolean; push?: boolean }): Promise<void> {
    const existing = this.d.prepare('SELECT * FROM user_notification_prefs WHERE user_id = ? AND event_key = ?').get(userId, eventKey) as import('./db-types/core.js').UserNotificationPrefRow | undefined;
    const inApp = channels.in_app === undefined ? (existing?.in_app ?? 1) : (channels.in_app ? 1 : 0);
    const email = channels.email === undefined ? (existing?.email ?? 0) : (channels.email ? 1 : 0);
    const push = channels.push === undefined ? (existing?.push ?? 0) : (channels.push ? 1 : 0);
    this.d.prepare(
      `INSERT INTO user_notification_prefs (user_id, event_key, in_app, email, push) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, event_key) DO UPDATE SET in_app=excluded.in_app, email=excluded.email, push=excluded.push, updated_at=datetime('now')`,
    ).run(userId, eventKey, inApp, email, push);
  }

  // ── Chat Settings ──────────────────────────────────────────

  async getChatSettings(chatId: string): Promise<ChatSettingsRow | null> {
    return (this.d.prepare('SELECT * FROM chat_settings WHERE chat_id = ?').get(chatId) as ChatSettingsRow | undefined) ?? null;
  }

  async saveChatSettings(s: {
    chatId: string; mode: string; systemPrompt?: string;
    timezone?: string;
    enabledTools?: string; redactionEnabled?: boolean;
    redactionPatterns?: string; workers?: string;
    // W1
    reflectEnabled?: boolean; reflectMaxRevisions?: number; reflectCriteria?: string;
    // W2
    verifyEnabled?: boolean; verifyMinScore?: number; verifyMaxAttempts?: number;
    // W3
    supervisorReplanOnFailure?: boolean; supervisorParallelDelegation?: boolean;
    // W5
    ensembleAgents?: string; ensembleResolver?: string;
    // Reasoning request (m92)
    reasoningEnabled?: boolean; reasoningEffort?: string; reasoningBudgetTokens?: number;
    // HITL approvals (m64 toggles)
    hitlEnabled?: boolean; hitlRequireAll?: boolean; hitlTimeoutMs?: number;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO chat_settings
         (chat_id, mode, system_prompt, timezone, enabled_tools, redaction_enabled, redaction_patterns, workers,
          reflect_enabled, reflect_max_revisions, reflect_criteria,
          verify_enabled, verify_min_score, verify_max_attempts,
          supervisor_replan_on_failure, supervisor_parallel_delegation,
          ensemble_agents, ensemble_resolver,
          reasoning_enabled, reasoning_effort, reasoning_budget_tokens,
          hitl_enabled, hitl_require_all, hitl_timeout_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         mode=excluded.mode, system_prompt=excluded.system_prompt, timezone=excluded.timezone,
         enabled_tools=excluded.enabled_tools, redaction_enabled=excluded.redaction_enabled,
         redaction_patterns=excluded.redaction_patterns, workers=excluded.workers,
         reflect_enabled=excluded.reflect_enabled, reflect_max_revisions=excluded.reflect_max_revisions,
         reflect_criteria=excluded.reflect_criteria,
         verify_enabled=excluded.verify_enabled, verify_min_score=excluded.verify_min_score,
         verify_max_attempts=excluded.verify_max_attempts,
         supervisor_replan_on_failure=excluded.supervisor_replan_on_failure,
         supervisor_parallel_delegation=excluded.supervisor_parallel_delegation,
         ensemble_agents=excluded.ensemble_agents, ensemble_resolver=excluded.ensemble_resolver,
         reasoning_enabled=excluded.reasoning_enabled, reasoning_effort=excluded.reasoning_effort,
         reasoning_budget_tokens=excluded.reasoning_budget_tokens,
         hitl_enabled=excluded.hitl_enabled, hitl_require_all=excluded.hitl_require_all,
         hitl_timeout_ms=excluded.hitl_timeout_ms,
         updated_at=datetime('now')`,
    ).run(
      s.chatId, s.mode, s.systemPrompt ?? null,
      s.timezone ?? null,
      s.enabledTools ?? null, s.redactionEnabled ? 1 : 0,
      s.redactionPatterns ?? null, s.workers ?? null,
      s.reflectEnabled ? 1 : 0, s.reflectMaxRevisions ?? 1, s.reflectCriteria ?? null,
      s.verifyEnabled ? 1 : 0, s.verifyMinScore ?? 0.7, s.verifyMaxAttempts ?? 1,
      s.supervisorReplanOnFailure ? 1 : 0, s.supervisorParallelDelegation ? 1 : 0,
      s.ensembleAgents ?? null, s.ensembleResolver ?? null,
      s.reasoningEnabled ? 1 : 0, s.reasoningEffort ?? null, s.reasoningBudgetTokens ?? 0,
      s.hitlEnabled ? 1 : 0, s.hitlRequireAll ? 1 : 0, s.hitlTimeoutMs ?? 300000,
    );
  }

  // ── Traces ─────────────────────────────────────────────────

  async saveTrace(t: {
    id: string; userId: string; chatId?: string; messageId?: string;
    traceId: string; spanId: string; parentSpanId?: string;
    name: string; startTime: number; endTime?: number;
    status?: string; attributes?: string; events?: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO traces (id, user_id, chat_id, message_id, trace_id, span_id, parent_span_id, name, start_time, end_time, status, attributes, events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id, t.userId, t.chatId ?? null, t.messageId ?? null,
      t.traceId, t.spanId, t.parentSpanId ?? null,
      t.name, t.startTime, t.endTime ?? null,
      t.status ?? null, t.attributes ?? null, t.events ?? null,
    );
  }

  async getChatTraces(chatId: string): Promise<TraceRow[]> {
    return this.d.prepare('SELECT * FROM traces WHERE chat_id = ? ORDER BY start_time ASC').all(chatId) as TraceRow[];
  }

  async getUserTraces(userId: string, limit?: number): Promise<TraceRow[]> {
    const sql = 'SELECT * FROM traces WHERE user_id = ? ORDER BY start_time DESC LIMIT ?';
    return this.d.prepare(sql).all(userId, limit ?? 100) as TraceRow[];
  }

  // ── Temporal tools persistence ────────────────────────────

  async upsertTemporalTimer(row: {
    id: string;
    scopeId: string;
    label?: string | null;
    durationMs?: number | null;
    state: string;
    createdAt: string;
    startedAt?: string | null;
    pausedAt?: string | null;
    resumedAt?: string | null;
    stoppedAt?: string | null;
    elapsedMs: number;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO temporal_timers
       (id, scope_id, label, duration_ms, state, created_at, started_at, paused_at, resumed_at, stopped_at, elapsed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, id) DO UPDATE SET
         label=excluded.label,
         duration_ms=excluded.duration_ms,
         state=excluded.state,
         created_at=excluded.created_at,
         started_at=excluded.started_at,
         paused_at=excluded.paused_at,
         resumed_at=excluded.resumed_at,
         stopped_at=excluded.stopped_at,
         elapsed_ms=excluded.elapsed_ms,
         updated_at=datetime('now')`,
    ).run(
      row.id,
      row.scopeId,
      row.label ?? null,
      row.durationMs ?? null,
      row.state,
      row.createdAt,
      row.startedAt ?? null,
      row.pausedAt ?? null,
      row.resumedAt ?? null,
      row.stoppedAt ?? null,
      row.elapsedMs,
    );
  }

  async getTemporalTimer(scopeId: string, id: string): Promise<TemporalTimerRow | null> {
    return (this.d.prepare('SELECT * FROM temporal_timers WHERE scope_id = ? AND id = ?').get(scopeId, id) as TemporalTimerRow | undefined) ?? null;
  }

  async listTemporalTimers(scopeId: string): Promise<TemporalTimerRow[]> {
    return this.d.prepare('SELECT * FROM temporal_timers WHERE scope_id = ? ORDER BY created_at DESC').all(scopeId) as TemporalTimerRow[];
  }

  async upsertTemporalStopwatch(row: {
    id: string;
    scopeId: string;
    label?: string | null;
    state: string;
    createdAt: string;
    startedAt?: string | null;
    pausedAt?: string | null;
    resumedAt?: string | null;
    stoppedAt?: string | null;
    elapsedMs: number;
    lapsJson: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO temporal_stopwatches
       (id, scope_id, label, state, created_at, started_at, paused_at, resumed_at, stopped_at, elapsed_ms, laps_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, id) DO UPDATE SET
         label=excluded.label,
         state=excluded.state,
         created_at=excluded.created_at,
         started_at=excluded.started_at,
         paused_at=excluded.paused_at,
         resumed_at=excluded.resumed_at,
         stopped_at=excluded.stopped_at,
         elapsed_ms=excluded.elapsed_ms,
         laps_json=excluded.laps_json,
         updated_at=datetime('now')`,
    ).run(
      row.id,
      row.scopeId,
      row.label ?? null,
      row.state,
      row.createdAt,
      row.startedAt ?? null,
      row.pausedAt ?? null,
      row.resumedAt ?? null,
      row.stoppedAt ?? null,
      row.elapsedMs,
      row.lapsJson,
    );
  }

  async getTemporalStopwatch(scopeId: string, id: string): Promise<TemporalStopwatchRow | null> {
    return (this.d.prepare('SELECT * FROM temporal_stopwatches WHERE scope_id = ? AND id = ?').get(scopeId, id) as TemporalStopwatchRow | undefined) ?? null;
  }

  async listTemporalStopwatches(scopeId: string): Promise<TemporalStopwatchRow[]> {
    return this.d.prepare('SELECT * FROM temporal_stopwatches WHERE scope_id = ? ORDER BY created_at DESC').all(scopeId) as TemporalStopwatchRow[];
  }

  async upsertTemporalReminder(row: {
    id: string;
    scopeId: string;
    text: string;
    dueAt: string;
    timezone: string;
    status: string;
    createdAt: string;
    cancelledAt?: string | null;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO temporal_reminders
       (id, scope_id, text, due_at, timezone, status, created_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, id) DO UPDATE SET
         text=excluded.text,
         due_at=excluded.due_at,
         timezone=excluded.timezone,
         status=excluded.status,
         created_at=excluded.created_at,
         cancelled_at=excluded.cancelled_at,
         updated_at=datetime('now')`,
    ).run(
      row.id,
      row.scopeId,
      row.text,
      row.dueAt,
      row.timezone,
      row.status,
      row.createdAt,
      row.cancelledAt ?? null,
    );
  }

  async getTemporalReminder(scopeId: string, id: string): Promise<TemporalReminderRow | null> {
    return (this.d.prepare('SELECT * FROM temporal_reminders WHERE scope_id = ? AND id = ?').get(scopeId, id) as TemporalReminderRow | undefined) ?? null;
  }

  async listTemporalReminders(scopeId: string): Promise<TemporalReminderRow[]> {
    return this.d.prepare('SELECT * FROM temporal_reminders WHERE scope_id = ? ORDER BY due_at ASC').all(scopeId) as TemporalReminderRow[];
  }

  async listTemporalRemindersByUserId(userId: string): Promise<TemporalReminderRow[]> {
    return this.d.prepare(
      "SELECT * FROM temporal_reminders WHERE scope_id LIKE ? ORDER BY due_at ASC",
    ).all(`${userId}:%`) as TemporalReminderRow[];
  }

  async deleteTemporalReminderById(reminderId: string, userId: string): Promise<boolean> {
    const result = this.d.prepare(
      "DELETE FROM temporal_reminders WHERE id = ? AND scope_id LIKE ?",
    ).run(reminderId, `${userId}:%`);
    return result.changes > 0;
  }

  async getAgentActivity(userId: string, limit?: number): Promise<Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>> {
    const sql = `
      SELECT m.*, c.title AS chat_title, c.model AS chat_model, c.provider AS chat_provider
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.user_id = ? AND m.role = 'assistant' AND m.metadata IS NOT NULL
      ORDER BY m.created_at DESC
      LIMIT ?
    `;
    return this.d.prepare(sql).all(userId, limit ?? 50) as Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>;
  }

  // ─── Admin: Prompts ────────────────────────────────────────

  async createPrompt(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompts (id, key, name, description, category, prompt_type, owner, status, tags, template, variables, version, model_compatibility, execution_defaults, framework, metadata, is_default, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      p.key ?? null,
      p.name,
      p.description ?? null,
      p.category ?? null,
      p.prompt_type,
      p.owner ?? null,
      p.status,
      p.tags ?? null,
      p.template,
      p.variables ?? null,
      p.version,
      p.model_compatibility ?? null,
      p.execution_defaults ?? null,
      p.framework ?? null,
      p.metadata ?? null,
      p.is_default,
      p.enabled,
    );
  }

  async getPrompt(id: string): Promise<PromptRow | null> {
    return (this.d.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow) ?? null;
  }

  async getPromptByKey(key: string): Promise<PromptRow | null> {
    return (this.d.prepare('SELECT * FROM prompts WHERE key = ?').get(key) as PromptRow) ?? null;
  }

  async getPromptByName(name: string): Promise<PromptRow | null> {
    return (this.d.prepare('SELECT * FROM prompts WHERE name = ?').get(name) as PromptRow) ?? null;
  }

  async listPrompts(): Promise<PromptRow[]> {
    return this.d.prepare('SELECT * FROM prompts ORDER BY name ASC').all() as PromptRow[];
  }

  async updatePrompt(id: string, fields: Partial<Omit<PromptRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePrompt(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Versions (Phase 5) ─────────────────────

  async createPromptVersion(v: Omit<PromptVersionRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_versions (id, prompt_id, version, status, template, variables, model_compatibility, execution_defaults, framework, metadata, is_active, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      v.id,
      v.prompt_id,
      v.version,
      v.status,
      v.template,
      v.variables ?? null,
      v.model_compatibility ?? null,
      v.execution_defaults ?? null,
      v.framework ?? null,
      v.metadata ?? null,
      v.is_active,
      v.enabled,
    );
    if (v.is_active) {
      this.d.prepare(`UPDATE prompt_versions SET is_active = 0, updated_at = datetime('now') WHERE prompt_id = ? AND id <> ?`).run(v.prompt_id, v.id);
    }
  }

  async getPromptVersion(id: string): Promise<PromptVersionRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(id) as PromptVersionRow) ?? null;
  }

  async listPromptVersions(promptId?: string): Promise<PromptVersionRow[]> {
    if (promptId) {
      return this.d.prepare('SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at DESC').all(promptId) as PromptVersionRow[];
    }
    return this.d.prepare('SELECT * FROM prompt_versions ORDER BY created_at DESC').all() as PromptVersionRow[];
  }

  async updatePromptVersion(id: string, fields: Partial<Omit<PromptVersionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const existing = await this.getPromptVersion(id);
    if (!existing) return;

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_versions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    if (fields['is_active']) {
      this.d.prepare(`UPDATE prompt_versions SET is_active = 0, updated_at = datetime('now') WHERE prompt_id = ? AND id <> ?`).run(existing.prompt_id, id);
    }
  }

  async deletePromptVersion(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_versions WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Experiments (Phase 5) ──────────────────

  async createPromptExperiment(e: Omit<PromptExperimentRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_experiments (id, prompt_id, name, description, status, variants_json, assignment_key_template, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id,
      e.prompt_id,
      e.name,
      e.description ?? null,
      e.status,
      e.variants_json,
      e.assignment_key_template ?? null,
      e.enabled,
    );
  }

  async getPromptExperiment(id: string): Promise<PromptExperimentRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_experiments WHERE id = ?').get(id) as PromptExperimentRow) ?? null;
  }

  async listPromptExperiments(promptId?: string): Promise<PromptExperimentRow[]> {
    if (promptId) {
      return this.d.prepare('SELECT * FROM prompt_experiments WHERE prompt_id = ? ORDER BY created_at DESC').all(promptId) as PromptExperimentRow[];
    }
    return this.d.prepare('SELECT * FROM prompt_experiments ORDER BY created_at DESC').all() as PromptExperimentRow[];
  }

  async updatePromptExperiment(id: string, fields: Partial<Omit<PromptExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_experiments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePromptExperiment(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_experiments WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Evaluation Datasets (Phase 7) ─────────

  async createPromptEvalDataset(d: Omit<PromptEvalDatasetRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_eval_datasets (id, prompt_id, name, description, prompt_version, status, pass_threshold, cases_json, rubric_json, metadata, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d.id,
      d.prompt_id,
      d.name,
      d.description ?? null,
      d.prompt_version ?? null,
      d.status,
      d.pass_threshold,
      d.cases_json,
      d.rubric_json ?? null,
      d.metadata ?? null,
      d.enabled,
    );
  }

  async getPromptEvalDataset(id: string): Promise<PromptEvalDatasetRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_eval_datasets WHERE id = ?').get(id) as PromptEvalDatasetRow) ?? null;
  }

  async listPromptEvalDatasets(promptId?: string): Promise<PromptEvalDatasetRow[]> {
    if (promptId) {
      return this.d.prepare('SELECT * FROM prompt_eval_datasets WHERE prompt_id = ? ORDER BY created_at DESC').all(promptId) as PromptEvalDatasetRow[];
    }
    return this.d.prepare('SELECT * FROM prompt_eval_datasets ORDER BY created_at DESC').all() as PromptEvalDatasetRow[];
  }

  async updatePromptEvalDataset(id: string, fields: Partial<Omit<PromptEvalDatasetRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_eval_datasets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePromptEvalDataset(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_eval_datasets WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Evaluation Runs (Phase 7) ─────────────

  async createPromptEvalRun(r: Omit<PromptEvalRunRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_eval_runs (id, dataset_id, prompt_id, prompt_version, status, avg_score, passed_cases, failed_cases, total_cases, results_json, summary_json, metadata, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.dataset_id,
      r.prompt_id,
      r.prompt_version,
      r.status,
      r.avg_score,
      r.passed_cases,
      r.failed_cases,
      r.total_cases,
      r.results_json,
      r.summary_json ?? null,
      r.metadata ?? null,
      r.completed_at ?? null,
    );
  }

  async getPromptEvalRun(id: string): Promise<PromptEvalRunRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_eval_runs WHERE id = ?').get(id) as PromptEvalRunRow) ?? null;
  }

  async listPromptEvalRuns(datasetId?: string): Promise<PromptEvalRunRow[]> {
    if (datasetId) {
      return this.d.prepare('SELECT * FROM prompt_eval_runs WHERE dataset_id = ? ORDER BY created_at DESC').all(datasetId) as PromptEvalRunRow[];
    }
    return this.d.prepare('SELECT * FROM prompt_eval_runs ORDER BY created_at DESC').all() as PromptEvalRunRow[];
  }

  async deletePromptEvalRun(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_eval_runs WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Optimizers (Phase 7) ──────────────────

  async createPromptOptimizer(o: Omit<PromptOptimizerRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_optimizers (id, key, name, description, implementation_kind, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(o.id, o.key, o.name, o.description ?? null, o.implementation_kind, o.config, o.enabled);
  }

  async getPromptOptimizer(id: string): Promise<PromptOptimizerRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_optimizers WHERE id = ?').get(id) as PromptOptimizerRow) ?? null;
  }

  async getPromptOptimizerByKey(key: string): Promise<PromptOptimizerRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_optimizers WHERE key = ?').get(key) as PromptOptimizerRow) ?? null;
  }

  async listPromptOptimizers(): Promise<PromptOptimizerRow[]> {
    return this.d.prepare('SELECT * FROM prompt_optimizers ORDER BY name ASC').all() as PromptOptimizerRow[];
  }

  async updatePromptOptimizer(id: string, fields: Partial<Omit<PromptOptimizerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_optimizers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePromptOptimizer(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_optimizers WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Optimization Runs (Phase 7) ───────────

  async createPromptOptimizationRun(r: Omit<PromptOptimizationRunRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_optimization_runs (id, prompt_id, source_version, candidate_version, optimizer_id, objective, source_template, candidate_template, diff_json, eval_baseline_json, eval_candidate_json, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.prompt_id,
      r.source_version,
      r.candidate_version,
      r.optimizer_id ?? null,
      r.objective,
      r.source_template,
      r.candidate_template,
      r.diff_json,
      r.eval_baseline_json ?? null,
      r.eval_candidate_json ?? null,
      r.status,
      r.metadata ?? null,
    );
  }

  async getPromptOptimizationRun(id: string): Promise<PromptOptimizationRunRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_optimization_runs WHERE id = ?').get(id) as PromptOptimizationRunRow) ?? null;
  }

  async listPromptOptimizationRuns(promptId?: string): Promise<PromptOptimizationRunRow[]> {
    if (promptId) {
      return this.d.prepare('SELECT * FROM prompt_optimization_runs WHERE prompt_id = ? ORDER BY created_at DESC').all(promptId) as PromptOptimizationRunRow[];
    }
    return this.d.prepare('SELECT * FROM prompt_optimization_runs ORDER BY created_at DESC').all() as PromptOptimizationRunRow[];
  }

  async deletePromptOptimizationRun(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_optimization_runs WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Frameworks (Phase 2) ───────────────────

  async createPromptFramework(f: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_frameworks (id, key, name, description, sections, section_separator, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.id, f.key, f.name, f.description ?? null, f.sections, f.section_separator, f.enabled);
  }

  async getPromptFramework(id: string): Promise<PromptFrameworkRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_frameworks WHERE id = ?').get(id) as PromptFrameworkRow) ?? null;
  }

  async getPromptFrameworkByKey(key: string): Promise<PromptFrameworkRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_frameworks WHERE key = ?').get(key) as PromptFrameworkRow) ?? null;
  }

  async listPromptFrameworks(): Promise<PromptFrameworkRow[]> {
    return this.d.prepare('SELECT * FROM prompt_frameworks ORDER BY name ASC').all() as PromptFrameworkRow[];
  }

  async updatePromptFramework(id: string, fields: Partial<Omit<PromptFrameworkRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_frameworks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePromptFramework(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_frameworks WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Fragments (Phase 2) ────────────────────

  async createPromptFragment(f: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_fragments (id, key, name, description, category, content, variables, tags, version, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.id, f.key, f.name, f.description ?? null, f.category ?? null, f.content, f.variables ?? null, f.tags ?? null, f.version, f.enabled);
  }

  async getPromptFragment(id: string): Promise<PromptFragmentRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_fragments WHERE id = ?').get(id) as PromptFragmentRow) ?? null;
  }

  async getPromptFragmentByKey(key: string): Promise<PromptFragmentRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_fragments WHERE key = ?').get(key) as PromptFragmentRow) ?? null;
  }

  async listPromptFragments(): Promise<PromptFragmentRow[]> {
    return this.d.prepare('SELECT * FROM prompt_fragments ORDER BY name ASC').all() as PromptFragmentRow[];
  }

  async updatePromptFragment(id: string, fields: Partial<Omit<PromptFragmentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_fragments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePromptFragment(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_fragments WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Contracts ───────────────────────────────

  async createPromptContract(c: Omit<PromptContractRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_contracts (id, key, name, description, contract_type, schema, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.key, c.name, c.description ?? null, c.contract_type, c.schema ?? null, c.config, c.enabled);
  }

  async getPromptContract(id: string): Promise<PromptContractRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_contracts WHERE id = ?').get(id) as PromptContractRow) ?? null;
  }

  async getPromptContractByKey(key: string): Promise<PromptContractRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_contracts WHERE key = ?').get(key) as PromptContractRow) ?? null;
  }

  async listPromptContracts(): Promise<PromptContractRow[]> {
    return this.d.prepare('SELECT * FROM prompt_contracts ORDER BY name ASC').all() as PromptContractRow[];
  }

  async updatePromptContract(id: string, fields: Partial<Omit<PromptContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_contracts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePromptContract(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_contracts WHERE id = ?').run(id);
  }

  // ─── Admin: Prompt Strategies (Phase 4) ───────────────────

  async createPromptStrategy(s: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompt_strategies (id, key, name, description, instruction_prefix, instruction_suffix, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.key, s.name, s.description ?? null, s.instruction_prefix ?? null, s.instruction_suffix ?? null, s.config, s.enabled);
  }

  async getPromptStrategy(id: string): Promise<PromptStrategyRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_strategies WHERE id = ?').get(id) as PromptStrategyRow) ?? null;
  }

  async getPromptStrategyByKey(key: string): Promise<PromptStrategyRow | null> {
    return (this.d.prepare('SELECT * FROM prompt_strategies WHERE key = ?').get(key) as PromptStrategyRow) ?? null;
  }

  async listPromptStrategies(): Promise<PromptStrategyRow[]> {
    return this.d.prepare('SELECT * FROM prompt_strategies ORDER BY name ASC').all() as PromptStrategyRow[];
  }

  async updatePromptStrategy(id: string, fields: Partial<Omit<PromptStrategyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompt_strategies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePromptStrategy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompt_strategies WHERE id = ?').run(id);
  }

  // ─── Admin: Guardrails ─────────────────────────────────────

  async createGuardrail(g: Omit<GuardrailRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO guardrails (id, name, description, type, stage, config, priority, enabled, trigger_conditions, trigger_description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.name, g.description ?? null, g.type, g.stage, g.config ?? null, g.priority, g.enabled,
      g.trigger_conditions ?? null, g.trigger_description ?? null);
  }

  async getGuardrail(id: string): Promise<GuardrailRow | null> {
    return (this.d.prepare('SELECT * FROM guardrails WHERE id = ?').get(id) as GuardrailRow) ?? null;
  }

  async listGuardrails(): Promise<GuardrailRow[]> {
    return this.d.prepare('SELECT * FROM guardrails ORDER BY priority DESC, name ASC').all() as GuardrailRow[];
  }

  async updateGuardrail(id: string, fields: Partial<Omit<GuardrailRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE guardrails SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteGuardrail(id: string): Promise<void> {
    this.d.prepare('DELETE FROM guardrails WHERE id = ?').run(id);
  }

  // ─── Admin: Guardrail Revisions (W7) ──────────────────────

  async createGuardrailRevision(r: Omit<GuardrailRevisionRow, 'created_at'> & { created_at?: string }): Promise<void> {
    const createdAt = r.created_at ?? new Date().toISOString();
    this.d.prepare(
      `INSERT INTO guardrail_revisions (id, guardrail_id, version, snapshot, before, actor, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.guardrail_id, r.version, r.snapshot, r.before ?? null, r.actor, r.reason, createdAt);
  }

  async listGuardrailRevisions(guardrailId: string): Promise<GuardrailRevisionRow[]> {
    return this.d
      .prepare('SELECT * FROM guardrail_revisions WHERE guardrail_id = ? ORDER BY version ASC')
      .all(guardrailId) as GuardrailRevisionRow[];
  }

  async getGuardrailRevisionAtTime(guardrailId: string, isoTimestamp: string): Promise<GuardrailRevisionRow | null> {
    return (
      this.d
        .prepare(
          'SELECT * FROM guardrail_revisions WHERE guardrail_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(guardrailId, isoTimestamp) as GuardrailRevisionRow
    ) ?? null;
  }

  // ─── Admin: Model Pricing ──────────────────────────────────

  /**
   * Phase 2 — derive a provider-aware prompt-cache policy for a pricing row.
   * Cloud providers that support provider-native prompt caching (Anthropic
   * explicit, OpenAI/Gemini implicit) default to enabled; local providers
   * (Ollama / llama.cpp) have no provider cache, so they default to disabled.
   * An explicit value on the row always wins (admin / sync override).
   */
  private promptCacheCols(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): [number, number, string] {
    const supportsPromptCache = p.provider === 'anthropic' || p.provider === 'openai' || p.provider === 'google';
    const enabled = p.prompt_cache_enabled != null ? p.prompt_cache_enabled : (supportsPromptCache ? 1 : 0);
    const minTokens = p.prompt_cache_min_tokens ?? 1024;
    const ttl = p.prompt_cache_ttl === '1h' ? '1h' : '5m';
    return [enabled, minTokens, ttl];
  }

  async createModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void> {
    const [pcEnabled, pcMin, pcTtl] = this.promptCacheCols(p);
    this.d.prepare(
      `INSERT INTO model_pricing (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled, prompt_cache_enabled, prompt_cache_min_tokens, prompt_cache_ttl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.model_id, p.provider, p.display_name ?? null, p.input_cost_per_1m, p.output_cost_per_1m, p.quality_score, p.source, p.last_synced_at ?? null, p.enabled, pcEnabled, pcMin, pcTtl);
  }

  async getModelPricing(id: string): Promise<ModelPricingRow | null> {
    return (this.d.prepare('SELECT * FROM model_pricing WHERE id = ?').get(id) as ModelPricingRow) ?? null;
  }

  async listModelPricing(): Promise<ModelPricingRow[]> {
    return this.d.prepare('SELECT * FROM model_pricing ORDER BY provider ASC, model_id ASC').all() as ModelPricingRow[];
  }

  async updateModelPricing(id: string, fields: Partial<Omit<ModelPricingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE model_pricing SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteModelPricing(id: string): Promise<void> {
    this.d.prepare('DELETE FROM model_pricing WHERE id = ?').run(id);
  }

  async upsertModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void> {
    // On INSERT (new model from a sync), seed the provider-aware prompt-cache
    // policy. On CONFLICT (existing model) we deliberately DO NOT overwrite the
    // prompt_cache_* columns so an operator's tuning survives a pricing re-sync.
    const [pcEnabled, pcMin, pcTtl] = this.promptCacheCols(p);
    this.d.prepare(
      `INSERT INTO model_pricing (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled, prompt_cache_enabled, prompt_cache_min_tokens, prompt_cache_ttl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id, provider) DO UPDATE SET
         display_name = excluded.display_name,
         input_cost_per_1m = excluded.input_cost_per_1m,
         output_cost_per_1m = excluded.output_cost_per_1m,
         quality_score = excluded.quality_score,
         source = excluded.source,
         last_synced_at = excluded.last_synced_at,
         updated_at = datetime('now')`,
    ).run(p.id, p.model_id, p.provider, p.display_name ?? null, p.input_cost_per_1m, p.output_cost_per_1m, p.quality_score, p.source, p.last_synced_at ?? null, p.enabled, pcEnabled, pcMin, pcTtl);
  }

  // ─── Admin: Routing policies ───────────────────────────────

  async createRoutingPolicy(r: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO routing_policies (id, name, description, strategy, constraints, weights, fallback_model, fallback_provider, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.strategy, r.constraints ?? null, r.weights ?? null, r.fallback_model ?? null, r.fallback_provider ?? null, r.enabled);
  }

  async getRoutingPolicy(id: string): Promise<RoutingPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM routing_policies WHERE id = ?').get(id) as RoutingPolicyRow) ?? null;
  }

  async listRoutingPolicies(): Promise<RoutingPolicyRow[]> {
    return this.d.prepare('SELECT * FROM routing_policies ORDER BY name ASC').all() as RoutingPolicyRow[];
  }

  async updateRoutingPolicy(id: string, fields: Partial<Omit<RoutingPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE routing_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteRoutingPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM routing_policies WHERE id = ?').run(id);
  }

  // ─── anyWeave routing Phase 2: task-aware routing ─────────

  async listTaskTypes(): Promise<TaskTypeDefinitionRow[]> {
    return this.d.prepare('SELECT * FROM task_type_definitions ORDER BY task_key ASC').all() as TaskTypeDefinitionRow[];
  }

  async getTaskType(taskKey: string): Promise<TaskTypeDefinitionRow | null> {
    return (this.d.prepare('SELECT * FROM task_type_definitions WHERE task_key = ?').get(taskKey) as TaskTypeDefinitionRow) ?? null;
  }

  async listCapabilityScores(opts?: { taskKey?: string; tenantId?: string | null; modelId?: string; provider?: string }): Promise<ModelCapabilityScoreRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts?.taskKey) { where.push('task_key = ?'); vals.push(opts.taskKey); }
    if (opts && 'tenantId' in opts) {
      if (opts.tenantId === null) { where.push('tenant_id IS NULL'); }
      else if (typeof opts.tenantId === 'string') { where.push('(tenant_id = ? OR tenant_id IS NULL)'); vals.push(opts.tenantId); }
    }
    if (opts?.modelId) { where.push('model_id = ?'); vals.push(opts.modelId); }
    if (opts?.provider) { where.push('provider = ?'); vals.push(opts.provider); }
    const sql = `SELECT * FROM model_capability_scores${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY task_key, provider, model_id`;
    return this.d.prepare(sql).all(...vals) as ModelCapabilityScoreRow[];
  }

  async listProviderToolAdapters(): Promise<ProviderToolAdapterRow[]> {
    return this.d.prepare('SELECT * FROM provider_tool_adapters ORDER BY provider ASC').all() as ProviderToolAdapterRow[];
  }

  async getProviderToolAdapter(provider: string): Promise<ProviderToolAdapterRow | null> {
    return (this.d.prepare('SELECT * FROM provider_tool_adapters WHERE provider = ?').get(provider) as ProviderToolAdapterRow) ?? null;
  }

  async insertRoutingDecisionTrace(row: Omit<RoutingDecisionTraceRow, 'decided_at'> & { decided_at?: string }): Promise<void> {
    this.d.prepare(
      `INSERT INTO routing_decision_traces (
         id, tenant_id, agent_id, workflow_step_id, task_key, inference_source,
         selected_model_id, selected_provider, selected_capability_score,
         weights_used, candidate_breakdown, tool_translation_applied,
         source_provider, estimated_cost_usd, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    ).run(
      row.id,
      row.tenant_id ?? null,
      row.agent_id ?? null,
      row.workflow_step_id ?? null,
      row.task_key ?? null,
      row.inference_source ?? null,
      row.selected_model_id,
      row.selected_provider,
      row.selected_capability_score ?? null,
      row.weights_used,
      row.candidate_breakdown,
      row.tool_translation_applied ?? 0,
      row.source_provider ?? null,
      row.estimated_cost_usd ?? null,
      row.decided_at ?? null,
    );
  }

  async listRoutingDecisionTraces(opts?: { tenantId?: string; agentId?: string; taskKey?: string; limit?: number; after?: string }): Promise<RoutingDecisionTraceRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts?.tenantId) { where.push('tenant_id = ?'); vals.push(opts.tenantId); }
    if (opts?.agentId) { where.push('agent_id = ?'); vals.push(opts.agentId); }
    if (opts?.taskKey) { where.push('task_key = ?'); vals.push(opts.taskKey); }
    if (opts?.after) { where.push('decided_at > ?'); vals.push(opts.after); }
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    const sql = `SELECT * FROM routing_decision_traces${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY decided_at DESC LIMIT ${limit}`;
    return this.d.prepare(sql).all(...vals) as RoutingDecisionTraceRow[];
  }

  async getRoutingDecisionTrace(id: string): Promise<RoutingDecisionTraceRow | null> {
    return (this.d.prepare('SELECT * FROM routing_decision_traces WHERE id = ?').get(id) as RoutingDecisionTraceRow) ?? null;
  }

  async aggregateCostByTask(opts?: { since?: string; until?: string; tenantId?: string }): Promise<Array<{
    task_key: string | null;
    selected_provider: string | null;
    selected_model_id: string | null;
    invocation_count: number;
    total_cost_usd: number;
    avg_cost_usd: number;
    last_used: string | null;
  }>> {
    const where: string[] = ['estimated_cost_usd IS NOT NULL'];
    const vals: unknown[] = [];
    if (opts?.since) { where.push('decided_at >= ?'); vals.push(opts.since); }
    if (opts?.until) { where.push('decided_at <= ?'); vals.push(opts.until); }
    if (opts?.tenantId) { where.push('tenant_id = ?'); vals.push(opts.tenantId); }
    const sql = `
      SELECT
        task_key,
        selected_provider,
        selected_model_id,
        COUNT(*)               AS invocation_count,
        SUM(estimated_cost_usd) AS total_cost_usd,
        AVG(estimated_cost_usd) AS avg_cost_usd,
        MAX(decided_at)         AS last_used
      FROM routing_decision_traces
      WHERE ${where.join(' AND ')}
      GROUP BY task_key, selected_provider, selected_model_id
      ORDER BY total_cost_usd DESC
      LIMIT 1000`;
    return this.d.prepare(sql).all(...vals) as Array<{
      task_key: string | null;
      selected_provider: string | null;
      selected_model_id: string | null;
      invocation_count: number;
      total_cost_usd: number;
      avg_cost_usd: number;
      last_used: string | null;
    }>;
  }

  // ─── anyWeave Phase 5: Feedback loop CRUD ─────────────────

  async insertRoutingCapabilitySignal(row: Omit<RoutingCapabilitySignalRow, 'created_at'> & { created_at?: string }): Promise<void> {
    this.d.prepare(
      `INSERT INTO routing_capability_signals (
         id, tenant_id, model_id, provider, task_key, source, signal_type,
         value, weight, evidence_id, message_id, trace_id, metadata, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    ).run(
      row.id, row.tenant_id ?? null, row.model_id, row.provider, row.task_key,
      row.source, row.signal_type, row.value, row.weight ?? 1.0,
      row.evidence_id ?? null, row.message_id ?? null, row.trace_id ?? null,
      row.metadata ?? null, row.created_at ?? null,
    );
  }

  async listRoutingCapabilitySignals(opts?: {
    tenantId?: string | null; modelId?: string; provider?: string; taskKey?: string;
    source?: string; afterIso?: string; beforeIso?: string; limit?: number;
  }): Promise<RoutingCapabilitySignalRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts?.tenantId !== undefined) {
      if (opts.tenantId === null) where.push('tenant_id IS NULL');
      else { where.push('tenant_id = ?'); vals.push(opts.tenantId); }
    }
    if (opts?.modelId)   { where.push('model_id = ?');  vals.push(opts.modelId); }
    if (opts?.provider)  { where.push('provider = ?');  vals.push(opts.provider); }
    if (opts?.taskKey)   { where.push('task_key = ?');  vals.push(opts.taskKey); }
    if (opts?.source)    { where.push('source = ?');    vals.push(opts.source); }
    if (opts?.afterIso)  { where.push('created_at >= ?'); vals.push(opts.afterIso); }
    if (opts?.beforeIso) { where.push('created_at < ?');  vals.push(opts.beforeIso); }
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, 5000));
    const sql = `SELECT * FROM routing_capability_signals${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`;
    return this.d.prepare(sql).all(...vals) as RoutingCapabilitySignalRow[];
  }

  async getRoutingCapabilitySignal(id: string): Promise<RoutingCapabilitySignalRow | null> {
    return (this.d.prepare('SELECT * FROM routing_capability_signals WHERE id = ?').get(id) as RoutingCapabilitySignalRow) ?? null;
  }

  async insertMessageFeedback(row: Omit<MessageFeedbackRow, 'created_at'> & { created_at?: string }): Promise<void> {
    this.d.prepare(
      `INSERT INTO message_feedback (
         id, message_id, chat_id, user_id, signal, comment, categories, tenant_id,
         model_id, provider, task_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    ).run(
      row.id, row.message_id, row.chat_id ?? null, row.user_id ?? null,
      row.signal, row.comment ?? null, row.categories ?? null, row.tenant_id ?? null,
      row.model_id ?? null, row.provider ?? null, row.task_key ?? null,
      row.created_at ?? null,
    );
  }

  async listMessageFeedback(opts?: { messageId?: string; chatId?: string; signal?: string; tenantId?: string; userId?: string; limit?: number }): Promise<MessageFeedbackRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts?.messageId) { where.push('message_id = ?'); vals.push(opts.messageId); }
    if (opts?.chatId)    { where.push('chat_id = ?');    vals.push(opts.chatId); }
    if (opts?.signal)    { where.push('signal = ?');     vals.push(opts.signal); }
    if (opts?.tenantId)  { where.push('tenant_id = ?');  vals.push(opts.tenantId); }
    if (opts?.userId)    { where.push('user_id = ?');    vals.push(opts.userId); }
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, 5000));
    const sql = `SELECT * FROM message_feedback${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`;
    return this.d.prepare(sql).all(...vals) as MessageFeedbackRow[];
  }

  async getMessageFeedback(id: string): Promise<MessageFeedbackRow | null> {
    return (this.d.prepare('SELECT * FROM message_feedback WHERE id = ?').get(id) as MessageFeedbackRow) ?? null;
  }

  async insertRoutingSurfaceItem(row: Omit<RoutingSurfaceItemRow, 'created_at' | 'resolved_at'> & { created_at?: string; resolved_at?: string | null }): Promise<void> {
    this.d.prepare(
      `INSERT INTO routing_surface_items (
         id, kind, severity, model_id, provider, task_key, tenant_id, message,
         metric_7d, metric_30d, drop_pct, sample_count_7d, sample_count_30d,
         auto_disabled, status, resolution_note, created_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
    ).run(
      row.id, row.kind, row.severity, row.model_id, row.provider, row.task_key,
      row.tenant_id ?? null, row.message,
      row.metric_7d ?? null, row.metric_30d ?? null, row.drop_pct ?? null,
      row.sample_count_7d ?? null, row.sample_count_30d ?? null,
      row.auto_disabled ?? 0, row.status ?? 'open', row.resolution_note ?? null,
      row.created_at ?? null, row.resolved_at ?? null,
    );
  }

  async listRoutingSurfaceItems(opts?: { status?: string; modelId?: string; provider?: string; taskKey?: string; limit?: number }): Promise<RoutingSurfaceItemRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts?.status)   { where.push('status = ?');   vals.push(opts.status); }
    if (opts?.modelId)  { where.push('model_id = ?'); vals.push(opts.modelId); }
    if (opts?.provider) { where.push('provider = ?'); vals.push(opts.provider); }
    if (opts?.taskKey)  { where.push('task_key = ?'); vals.push(opts.taskKey); }
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    const sql = `SELECT * FROM routing_surface_items${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`;
    return this.d.prepare(sql).all(...vals) as RoutingSurfaceItemRow[];
  }

  async getRoutingSurfaceItem(id: string): Promise<RoutingSurfaceItemRow | null> {
    return (this.d.prepare('SELECT * FROM routing_surface_items WHERE id = ?').get(id) as RoutingSurfaceItemRow) ?? null;
  }

  async updateRoutingSurfaceItem(id: string, fields: Partial<Omit<RoutingSurfaceItemRow, 'id' | 'created_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.d.prepare(`UPDATE routing_surface_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ─── anyWeave Phase 6: A/B Routing Experiments ────────────

  async createRoutingExperiment(r: Omit<RoutingExperimentRow, 'created_at' | 'updated_at' | 'started_at' | 'ended_at'> & { started_at?: string; ended_at?: string | null }): Promise<void> {
    this.d.prepare(
      `INSERT INTO routing_experiments (
         id, name, description, tenant_id, task_key,
         baseline_provider, baseline_model_id,
         candidate_provider, candidate_model_id,
         traffic_pct, status, metadata, started_at, ended_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
    ).run(
      r.id, r.name, r.description ?? null, r.tenant_id ?? null, r.task_key ?? null,
      r.baseline_provider, r.baseline_model_id,
      r.candidate_provider, r.candidate_model_id,
      r.traffic_pct, r.status ?? 'active', r.metadata ?? null,
      r.started_at ?? null, r.ended_at ?? null,
    );
  }

  async getRoutingExperiment(id: string): Promise<RoutingExperimentRow | null> {
    return (this.d.prepare('SELECT * FROM routing_experiments WHERE id = ?').get(id) as RoutingExperimentRow) ?? null;
  }

  async listRoutingExperiments(opts?: { status?: string; taskKey?: string; tenantId?: string | null }): Promise<RoutingExperimentRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts?.status) { where.push('status = ?'); vals.push(opts.status); }
    if (opts?.taskKey) { where.push('(task_key = ? OR task_key IS NULL)'); vals.push(opts.taskKey); }
    if (opts && 'tenantId' in opts) {
      if (opts.tenantId === null) where.push('tenant_id IS NULL');
      else if (typeof opts.tenantId === 'string') { where.push('(tenant_id = ? OR tenant_id IS NULL)'); vals.push(opts.tenantId); }
    }
    const sql = `SELECT * FROM routing_experiments${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return this.d.prepare(sql).all(...vals) as RoutingExperimentRow[];
  }

  async updateRoutingExperiment(id: string, fields: Partial<Omit<RoutingExperimentRow, 'id' | 'created_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    this.d.prepare(`UPDATE routing_experiments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteRoutingExperiment(id: string): Promise<void> {
    this.d.prepare('DELETE FROM routing_experiments WHERE id = ?').run(id);
  }

  // ─── anyWeave Phase 4: Task-aware routing CRUD ────────────

  async getTaskTypeById(id: string): Promise<TaskTypeDefinitionRow | null> {
    return (this.d.prepare('SELECT * FROM task_type_definitions WHERE id = ?').get(id) as TaskTypeDefinitionRow) ?? null;
  }

  async createTaskType(row: Omit<TaskTypeDefinitionRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO task_type_definitions
        (id, task_key, display_name, category, description, output_modality,
         default_strategy, default_weights, inference_hints, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.task_key, row.display_name, row.category, row.description ?? '',
      row.output_modality, row.default_strategy,
      row.default_weights ?? '{"cost":0.25,"speed":0.25,"quality":0.25,"capability":0.25}',
      row.inference_hints ?? '{}',
      row.enabled ?? 1,
    );
  }

  async updateTaskType(id: string, fields: Partial<Omit<TaskTypeDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE task_type_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTaskType(id: string): Promise<void> {
    this.d.prepare('DELETE FROM task_type_definitions WHERE id = ?').run(id);
  }

  async getCapabilityScore(id: string): Promise<ModelCapabilityScoreRow | null> {
    return (this.d.prepare('SELECT * FROM model_capability_scores WHERE id = ?').get(id) as ModelCapabilityScoreRow) ?? null;
  }

  async upsertCapabilityScore(row: Omit<ModelCapabilityScoreRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO model_capability_scores
        (id, tenant_id, model_id, provider, task_key, quality_score,
         supports_tools, supports_streaming, supports_thinking, supports_json_mode, supports_vision,
         max_output_tokens, benchmark_source, raw_benchmark_score, is_active, last_evaluated_at,
         production_signal_score, signal_sample_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, model_id, provider, task_key) DO UPDATE SET
         quality_score = excluded.quality_score,
         supports_tools = excluded.supports_tools,
         supports_streaming = excluded.supports_streaming,
         supports_thinking = excluded.supports_thinking,
         supports_json_mode = excluded.supports_json_mode,
         supports_vision = excluded.supports_vision,
         max_output_tokens = excluded.max_output_tokens,
         benchmark_source = excluded.benchmark_source,
         raw_benchmark_score = excluded.raw_benchmark_score,
         is_active = excluded.is_active,
         last_evaluated_at = excluded.last_evaluated_at,
         updated_at = datetime('now')`,
    ).run(
      row.id, row.tenant_id ?? null, row.model_id, row.provider, row.task_key, row.quality_score,
      row.supports_tools ?? 1, row.supports_streaming ?? 1, row.supports_thinking ?? 0,
      row.supports_json_mode ?? 0, row.supports_vision ?? 0,
      row.max_output_tokens ?? null, row.benchmark_source ?? null, row.raw_benchmark_score ?? null,
      row.is_active ?? 1, row.last_evaluated_at ?? null,
      row.production_signal_score ?? null, row.signal_sample_count ?? 0,
    );
  }

  async updateCapabilityScore(id: string, fields: Partial<Omit<ModelCapabilityScoreRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE model_capability_scores SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCapabilityScore(id: string): Promise<void> {
    this.d.prepare('DELETE FROM model_capability_scores WHERE id = ?').run(id);
  }

  async bulkDisableCapabilityScores(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.d.prepare('UPDATE model_capability_scores SET is_active = 0, updated_at = ? WHERE id = ?');
    const tx = this.d.transaction((rowIds: string[]) => {
      for (const id of rowIds) stmt.run(now, id);
    });
    tx(ids);
  }

  async getProviderToolAdapterById(id: string): Promise<ProviderToolAdapterRow | null> {
    return (this.d.prepare('SELECT * FROM provider_tool_adapters WHERE id = ?').get(id) as ProviderToolAdapterRow) ?? null;
  }

  async createProviderToolAdapter(row: Omit<ProviderToolAdapterRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO provider_tool_adapters
        (id, provider, display_name, adapter_module, tool_format, tool_call_response_format,
         tool_result_format, system_prompt_location, name_validation_regex, max_tool_count, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.provider, row.display_name, row.adapter_module, row.tool_format,
      row.tool_call_response_format, row.tool_result_format,
      row.system_prompt_location ?? 'system_message',
      row.name_validation_regex ?? '^[a-zA-Z0-9_-]{1,64}$',
      row.max_tool_count ?? 128,
      row.enabled ?? 1,
    );
  }

  async updateProviderToolAdapter(id: string, fields: Partial<Omit<ProviderToolAdapterRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE provider_tool_adapters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteProviderToolAdapter(id: string): Promise<void> {
    this.d.prepare('DELETE FROM provider_tool_adapters WHERE id = ?').run(id);
  }

  async listTaskTypeTenantOverrides(opts?: { tenantId?: string; taskKey?: string }): Promise<TaskTypeTenantOverrideRow[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts?.tenantId) { where.push('tenant_id = ?'); vals.push(opts.tenantId); }
    if (opts?.taskKey) { where.push('task_key = ?'); vals.push(opts.taskKey); }
    const sql = `SELECT * FROM task_type_tenant_overrides${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY tenant_id, task_key`;
    return this.d.prepare(sql).all(...vals) as TaskTypeTenantOverrideRow[];
  }

  async getTaskTypeTenantOverride(id: string): Promise<TaskTypeTenantOverrideRow | null> {
    return (this.d.prepare('SELECT * FROM task_type_tenant_overrides WHERE id = ?').get(id) as TaskTypeTenantOverrideRow) ?? null;
  }

  async createTaskTypeTenantOverride(row: Omit<TaskTypeTenantOverrideRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO task_type_tenant_overrides
        (id, tenant_id, task_key, weights, preferred_model_id, preferred_provider,
         preferred_boost_pct, cost_ceiling_per_call, optimisation_strategy, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.tenant_id, row.task_key,
      row.weights ?? null, row.preferred_model_id ?? null, row.preferred_provider ?? null,
      row.preferred_boost_pct ?? 20,
      row.cost_ceiling_per_call ?? null, row.optimisation_strategy ?? null,
      row.enabled ?? 1,
    );
  }

  async updateTaskTypeTenantOverride(id: string, fields: Partial<Omit<TaskTypeTenantOverrideRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE task_type_tenant_overrides SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTaskTypeTenantOverride(id: string): Promise<void> {
    this.d.prepare('DELETE FROM task_type_tenant_overrides WHERE id = ?').run(id);
  }

  // ─── Admin: Workflow definitions ───────────────────────────

  async createWorkflowDef(w: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO workflow_defs (id, name, description, version, steps, entry_step_id, metadata, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.id, w.name, w.description ?? null, w.version, w.steps, w.entry_step_id, w.metadata ?? null, w.enabled);
  }

  async getWorkflowDef(id: string): Promise<WorkflowDefRow | null> {
    return (this.d.prepare('SELECT * FROM workflow_defs WHERE id = ?').get(id) as WorkflowDefRow) ?? null;
  }

  async listWorkflowDefs(): Promise<WorkflowDefRow[]> {
    return this.d.prepare('SELECT * FROM workflow_defs ORDER BY name ASC').all() as WorkflowDefRow[];
  }

  async updateWorkflowDef(id: string, fields: Partial<Omit<WorkflowDefRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE workflow_defs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteWorkflowDef(id: string): Promise<void> {
    this.d.prepare('DELETE FROM workflow_defs WHERE id = ?').run(id);
  }

  // ─── Workflow Platform Phase 1: Handler Kinds Catalog ─────

  async listWorkflowHandlerKinds(): Promise<WorkflowHandlerKindRow[]> {
    return this.d.prepare('SELECT * FROM workflow_handler_kinds ORDER BY kind ASC').all() as WorkflowHandlerKindRow[];
  }

  async getWorkflowHandlerKind(kind: string): Promise<WorkflowHandlerKindRow | null> {
    return (this.d.prepare('SELECT * FROM workflow_handler_kinds WHERE kind = ?').get(kind) as WorkflowHandlerKindRow) ?? null;
  }

  async upsertWorkflowHandlerKind(row: Omit<WorkflowHandlerKindRow, 'created_at' | 'updated_at'>): Promise<void> {
    // INSERT … ON CONFLICT(kind) DO UPDATE — preserves operator-edited
    // `enabled` flag and overwrites description/config_schema/source from
    // the in-process registry on every startup.
    this.d.prepare(
      `INSERT INTO workflow_handler_kinds (id, kind, description, config_schema, enabled, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET
         description = excluded.description,
         config_schema = excluded.config_schema,
         source = excluded.source,
         updated_at = datetime('now')`,
    ).run(row.id, row.kind, row.description ?? null, row.config_schema ?? null, row.enabled, row.source);
  }

  // ─── Phase 3: Unified Triggers ─────────────────────────────

  async listTriggers(opts?: { enabled?: boolean; sourceKind?: string; targetKind?: string }): Promise<TriggerRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.enabled !== undefined) { where.push('enabled = ?'); args.push(opts.enabled ? 1 : 0); }
    if (opts?.sourceKind) { where.push('source_kind = ?'); args.push(opts.sourceKind); }
    if (opts?.targetKind) { where.push('target_kind = ?'); args.push(opts.targetKind); }
    const sql = `SELECT * FROM triggers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY key ASC`;
    return this.d.prepare(sql).all(...args) as TriggerRow[];
  }

  async getTrigger(id: string): Promise<TriggerRow | null> {
    return (this.d.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as TriggerRow) ?? null;
  }

  async getTriggerByKey(key: string): Promise<TriggerRow | null> {
    return (this.d.prepare('SELECT * FROM triggers WHERE key = ?').get(key) as TriggerRow) ?? null;
  }

  async createTrigger(row: Omit<TriggerRow, 'created_at' | 'updated_at'>): Promise<TriggerRow> {
    this.d.prepare(
      `INSERT INTO triggers (id, key, enabled, source_kind, source_config, filter_expr, target_kind, target_config, input_map, rate_limit_per_minute, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.key, row.enabled, row.source_kind, row.source_config,
      row.filter_expr ?? null, row.target_kind, row.target_config,
      row.input_map ?? null, row.rate_limit_per_minute ?? null, row.metadata ?? null,
    );
    const created = await this.getTrigger(row.id);
    if (!created) throw new Error(`createTrigger: row ${row.id} not found after insert`);
    return created;
  }

  async updateTrigger(id: string, patch: Partial<Omit<TriggerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    args.push(id);
    this.d.prepare(`UPDATE triggers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  async deleteTrigger(id: string): Promise<void> {
    this.d.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  }

  async insertTriggerInvocation(row: Omit<TriggerInvocationRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO trigger_invocations (id, trigger_id, fired_at, source_kind, status, target_ref, error_message, source_event)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.trigger_id, row.fired_at, row.source_kind, row.status,
      row.target_ref ?? null, row.error_message ?? null, row.source_event ?? null,
    );
  }

  async listTriggerInvocations(opts?: { triggerId?: string; status?: string; limit?: number; offset?: number }): Promise<TriggerInvocationRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.triggerId) { where.push('trigger_id = ?'); args.push(opts.triggerId); }
    if (opts?.status) { where.push('status = ?'); args.push(opts.status); }
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const sql = `SELECT * FROM trigger_invocations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fired_at DESC LIMIT ? OFFSET ?`;
    return this.d.prepare(sql).all(...args, limit, offset) as TriggerInvocationRow[];
  }

  // ─── Phase 4: Mesh contracts ───────────────────────────────

  async insertMeshContract(row: Omit<MeshContractRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO mesh_contracts (
         id, kind, body_json, evidence_json, mesh_id,
         source_workflow_definition_id, source_workflow_run_id, source_agent_id,
         metadata, emitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.kind, row.body_json, row.evidence_json ?? null, row.mesh_id ?? null,
      row.source_workflow_definition_id ?? null, row.source_workflow_run_id ?? null, row.source_agent_id ?? null,
      row.metadata ?? null, row.emitted_at,
    );
  }

  async getMeshContract(id: string): Promise<MeshContractRow | null> {
    const r = this.d.prepare('SELECT * FROM mesh_contracts WHERE id = ?').get(id) as MeshContractRow | undefined;
    return r ?? null;
  }

  async listMeshContracts(opts?: {
    kind?: string;
    meshId?: string;
    workflowRunId?: string;
    after?: string;
    before?: string;
    limit?: number;
    offset?: number;
  }): Promise<MeshContractRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.kind) { where.push('kind = ?'); args.push(opts.kind); }
    if (opts?.meshId) { where.push('mesh_id = ?'); args.push(opts.meshId); }
    if (opts?.workflowRunId) { where.push('source_workflow_run_id = ?'); args.push(opts.workflowRunId); }
    if (opts?.after) { where.push('emitted_at >= ?'); args.push(opts.after); }
    if (opts?.before) { where.push('emitted_at <= ?'); args.push(opts.before); }
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const sql = `SELECT * FROM mesh_contracts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY emitted_at DESC LIMIT ? OFFSET ?`;
    return this.d.prepare(sql).all(...args, limit, offset) as MeshContractRow[];
  }

  // ─── Admin: Tool catalog ───────────────────────────────────

  async createToolConfig(t: Omit<ToolCatalogRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_catalog (id, name, description, category, risk_level, requires_approval, max_execution_ms, rate_limit_per_min, enabled, tool_key, version, side_effects, tags, source, credential_id, allocation_class, config, requires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id, t.name, t.description ?? null, t.category ?? null, t.risk_level, t.requires_approval,
      t.max_execution_ms ?? null, t.rate_limit_per_min ?? null, t.enabled,
      t.tool_key ?? null, t.version ?? '1.0', t.side_effects ?? 0,
      t.tags ?? null, t.source ?? 'builtin', t.credential_id ?? null,
      t.allocation_class ?? null, t.config ?? null, t.requires ?? null,
    );
  }

  async getToolConfig(id: string): Promise<ToolCatalogRow | null> {
    return (this.d.prepare('SELECT * FROM tool_catalog WHERE id = ?').get(id) as ToolCatalogRow) ?? null;
  }

  async getToolCatalogByKey(toolKey: string): Promise<ToolCatalogRow | null> {
    return (this.d.prepare('SELECT * FROM tool_catalog WHERE tool_key = ?').get(toolKey) as ToolCatalogRow) ?? null;
  }

  async listToolConfigs(): Promise<ToolCatalogRow[]> {
    return this.d.prepare('SELECT * FROM tool_catalog ORDER BY category ASC, name ASC').all() as ToolCatalogRow[];
  }

  async listEnabledToolCatalog(): Promise<ToolCatalogRow[]> {
    return this.d.prepare('SELECT * FROM tool_catalog WHERE enabled = 1 AND source = \'builtin\' ORDER BY category ASC, name ASC').all() as ToolCatalogRow[];
  }

  async updateToolConfig(id: string, fields: Partial<Omit<ToolCatalogRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tool_catalog SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteToolConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_catalog WHERE id = ?').run(id);
  }

  // ─── Admin: Tool policies ──────────────────────────────────

  async createToolPolicy(p: Omit<ToolPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_policies (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, active_hours_utc, expires_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.key, p.name, p.description ?? null,
      p.applies_to ?? null, p.applies_to_risk_levels ?? null,
      p.approval_required, p.allowed_risk_levels ?? null,
      p.max_execution_ms ?? null, p.rate_limit_per_minute ?? null, p.max_concurrent ?? null,
      p.require_dry_run, p.log_input_output,
      p.persona_scope ?? null, p.active_hours_utc ?? null, p.expires_at ?? null, p.enabled,
    );
  }

  async getToolPolicy(id: string): Promise<ToolPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM tool_policies WHERE id = ?').get(id) as ToolPolicyRow) ?? null;
  }

  async getToolPolicyByKey(key: string): Promise<ToolPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM tool_policies WHERE key = ?').get(key) as ToolPolicyRow) ?? null;
  }

  async listToolPolicies(): Promise<ToolPolicyRow[]> {
    return this.d.prepare('SELECT * FROM tool_policies ORDER BY name ASC').all() as ToolPolicyRow[];
  }

  async updateToolPolicy(id: string, fields: Partial<Omit<ToolPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tool_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteToolPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_policies WHERE id = ?').run(id);
  }

  async getToolRateLimitCount(toolName: string, scopeKey: string, windowStartIso: string): Promise<number> {
    // M-10: Read the current bucket count without modifying it, so the
    // `remaining()` helper can return an accurate value without a side-effect.
    const row = this.d.prepare(
      'SELECT count FROM tool_rate_limit_buckets WHERE tool_name = ? AND scope_key = ? AND window_start = ?',
    ).get(toolName, scopeKey, windowStartIso) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  async checkAndIncrementRateLimit(
    toolName: string,
    scopeKey: string,
    windowStartIso: string,
    limitPerMinute: number,
  ): Promise<boolean> {
    // Upsert the bucket for this (toolName, scopeKey, windowStart) combination.
    this.d.prepare(`
      INSERT INTO tool_rate_limit_buckets (id, tool_name, scope_key, window_start, count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(tool_name, scope_key, window_start) DO NOTHING
    `).run(newUUIDv7(), toolName, scopeKey, windowStartIso);

    const row = this.d.prepare(
      'SELECT count FROM tool_rate_limit_buckets WHERE tool_name = ? AND scope_key = ? AND window_start = ?',
    ).get(toolName, scopeKey, windowStartIso) as { count: number } | undefined;

    if (!row || row.count >= limitPerMinute) return false;

    this.d.prepare(
      'UPDATE tool_rate_limit_buckets SET count = count + 1 WHERE tool_name = ? AND scope_key = ? AND window_start = ?',
    ).run(toolName, scopeKey, windowStartIso);

    return true;
  }

  // ─── Phase 3: Tool Audit Events ──────────────────────────────

  async insertToolAuditEvent(event: Omit<import('./db-types.js').ToolAuditEventRow, 'created_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO tool_audit_events
        (id, tool_name, chat_id, user_id, agent_persona, skill_key, policy_id, outcome,
         violation_reason, duration_ms, input_preview, output_preview, error_message, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.tool_name,
      event.chat_id ?? null,
      event.user_id ?? null,
      event.agent_persona ?? null,
      event.skill_key ?? null,
      event.policy_id ?? null,
      event.outcome,
      event.violation_reason ?? null,
      event.duration_ms ?? null,
      event.input_preview ?? null,
      event.output_preview ?? null,
      event.error_message ?? null,
      event.metadata ?? null,
    );
  }

  async listToolAuditEvents(filters?: {
    toolName?: string;
    chatId?: string;
    outcome?: string;
    afterIso?: string;
    beforeIso?: string;
    limit?: number;
    offset?: number;
  }): Promise<import('./db-types.js').ToolAuditEventRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters?.toolName) { where.push('tool_name = ?'); params.push(filters.toolName); }
    if (filters?.chatId)   { where.push('chat_id = ?');   params.push(filters.chatId); }
    if (filters?.outcome)  { where.push('outcome = ?');   params.push(filters.outcome); }
    if (filters?.afterIso) { where.push('created_at >= ?'); params.push(filters.afterIso); }
    if (filters?.beforeIso){ where.push('created_at <= ?'); params.push(filters.beforeIso); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit  = filters?.limit  ?? 100;
    const offset = filters?.offset ?? 0;
    params.push(limit, offset);
    return this.d.prepare(
      `SELECT * FROM tool_audit_events ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params) as import('./db-types.js').ToolAuditEventRow[];
  }

  async getToolAuditEvent(id: string): Promise<import('./db-types.js').ToolAuditEventRow | null> {
    return (this.d.prepare('SELECT * FROM tool_audit_events WHERE id = ?').get(id) as
      import('./db-types.js').ToolAuditEventRow | undefined) ?? null;
  }

  // ─── Phase 3: Tool Health Snapshots ──────────────────────────

  async insertToolHealthSnapshot(snapshot: Omit<import('./db-types.js').ToolHealthSnapshotRow, 'created_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO tool_health_snapshots
        (id, tool_name, snapshot_at, invocation_count, success_count, error_count, denied_count,
         avg_duration_ms, p95_duration_ms, error_rate, availability)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.tool_name,
      snapshot.snapshot_at,
      snapshot.invocation_count,
      snapshot.success_count,
      snapshot.error_count,
      snapshot.denied_count,
      snapshot.avg_duration_ms ?? null,
      snapshot.p95_duration_ms ?? null,
      snapshot.error_rate,
      snapshot.availability,
    );
  }

  async listToolHealthSnapshots(toolName: string, limit = 48): Promise<import('./db-types.js').ToolHealthSnapshotRow[]> {
    return this.d.prepare(
      'SELECT * FROM tool_health_snapshots WHERE tool_name = ? ORDER BY snapshot_at DESC LIMIT ?',
    ).all(toolName, limit) as import('./db-types.js').ToolHealthSnapshotRow[];
  }

  async getToolHealthSummary(sinceIso?: string): Promise<import('./db-types.js').ToolHealthSummary[]> {
    const since = sinceIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.d.prepare(`
      SELECT
        tool_name,
        COUNT(*)                                                         AS total_invocations,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)            AS success_count,
        SUM(CASE WHEN outcome = 'error' OR outcome = 'timeout' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN outcome LIKE 'denied%' OR outcome = 'circuit_open' THEN 1 ELSE 0 END) AS denied_count,
        AVG(CASE WHEN duration_ms IS NOT NULL THEN CAST(duration_ms AS REAL) END) AS avg_duration_ms,
        CAST(
          SUM(CASE WHEN outcome = 'error' OR outcome = 'timeout' THEN 1 ELSE 0 END) AS REAL
        ) / MAX(COUNT(*), 1)                                             AS error_rate,
        CAST(
          SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL
        ) / MAX(COUNT(*), 1)                                             AS availability,
        MAX(created_at)                                                  AS last_invoked_at
      FROM tool_audit_events
      WHERE created_at >= ?
      GROUP BY tool_name
      ORDER BY total_invocations DESC
    `).all(since) as import('./db-types.js').ToolHealthSummary[];
  }

  // ─── Resilience Phase 4: Endpoint Health ─────────────────────

  async applyEndpointHealthDelta(delta: import('./db-types.js').EndpointHealthDelta): Promise<void> {
    const nowIso = new Date().toISOString();
    // Atomic upsert. We INSERT a fresh zero-row first (ON CONFLICT DO NOTHING)
    // then UPDATE counters/state in a single statement. better-sqlite3 is
    // synchronous so this is effectively atomic from the JS side.
    this.d.prepare(
      `INSERT INTO endpoint_health (endpoint, updated_at) VALUES (?, ?) ON CONFLICT(endpoint) DO NOTHING`,
    ).run(delta.endpoint, nowIso);

    // Build dynamic UPDATE. Each field is conditionally appended.
    const sets: string[] = [];
    const params: unknown[] = [];

    if (delta.circuit_state !== undefined) { sets.push('circuit_state = ?'); params.push(delta.circuit_state); }
    if (delta.consecutive_failures !== undefined) { sets.push('consecutive_failures = ?'); params.push(delta.consecutive_failures); }
    if (delta.last_signal_at !== undefined) { sets.push('last_signal_at = ?'); params.push(delta.last_signal_at); }
    if (delta.last_429_at !== undefined) { sets.push('last_429_at = ?'); params.push(delta.last_429_at); }
    if (delta.last_retry_after_ms !== undefined) { sets.push('last_retry_after_ms = ?'); params.push(delta.last_retry_after_ms); }
    if (delta.last_circuit_opened_at !== undefined) { sets.push('last_circuit_opened_at = ?'); params.push(delta.last_circuit_opened_at); }
    if (delta.last_circuit_closed_at !== undefined) { sets.push('last_circuit_closed_at = ?'); params.push(delta.last_circuit_closed_at); }

    if (delta.inc_success)        { sets.push('total_success = total_success + ?');             params.push(delta.inc_success); }
    if (delta.inc_failed)         { sets.push('total_failed = total_failed + ?');               params.push(delta.inc_failed); }
    if (delta.inc_rate_limited)   { sets.push('total_rate_limited = total_rate_limited + ?');   params.push(delta.inc_rate_limited); }
    if (delta.inc_retries)        { sets.push('total_retries = total_retries + ?');             params.push(delta.inc_retries); }
    if (delta.inc_shed)           { sets.push('total_shed = total_shed + ?');                   params.push(delta.inc_shed); }
    if (delta.inc_circuit_opens)  { sets.push('total_circuit_opens = total_circuit_opens + ?'); params.push(delta.inc_circuit_opens); }

    // Latency EMA (alpha=0.2): fold each sample sequentially against the
    // current avg_latency_ms (or seed with the first sample when null).
    if (delta.latency_samples_ms && delta.latency_samples_ms.length > 0) {
      const row = this.d.prepare('SELECT avg_latency_ms FROM endpoint_health WHERE endpoint = ?')
        .get(delta.endpoint) as { avg_latency_ms: number | null } | undefined;
      let avg = row?.avg_latency_ms ?? null;
      const alpha = 0.2;
      for (const sample of delta.latency_samples_ms) {
        avg = avg === null ? sample : avg * (1 - alpha) + sample * alpha;
      }
      sets.push('avg_latency_ms = ?');
      params.push(avg);
    }

    sets.push('updated_at = ?');
    params.push(nowIso);
    params.push(delta.endpoint);

    this.d.prepare(`UPDATE endpoint_health SET ${sets.join(', ')} WHERE endpoint = ?`).run(...params);
  }

  async listEndpointHealth(filters?: { circuitState?: string; limit?: number; offset?: number }): Promise<import('./db-types.js').EndpointHealthRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters?.circuitState) { where.push('circuit_state = ?'); params.push(filters.circuitState); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit  = filters?.limit  ?? 200;
    const offset = filters?.offset ?? 0;
    params.push(limit, offset);
    return this.d.prepare(
      `SELECT * FROM endpoint_health ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).all(...params) as import('./db-types.js').EndpointHealthRow[];
  }

  async getEndpointHealth(endpoint: string): Promise<import('./db-types.js').EndpointHealthRow | null> {
    return (this.d.prepare('SELECT * FROM endpoint_health WHERE endpoint = ?').get(endpoint) as
      import('./db-types.js').EndpointHealthRow | undefined) ?? null;
  }

  // ─── Phase 4: Tool Credentials ───────────────────────────────

  async createToolCredential(c: Omit<import('./db-types.js').ToolCredentialRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_credentials (id, name, description, credential_type, tool_names, env_var_name, config, rotation_due_at, validation_status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.id, c.name, c.description ?? null, c.credential_type,
      c.tool_names ?? null, c.env_var_name ?? null, c.config ?? null,
      c.rotation_due_at ?? null, c.validation_status, c.enabled,
    );
  }

  async getToolCredential(id: string): Promise<import('./db-types.js').ToolCredentialRow | null> {
    return (this.d.prepare('SELECT * FROM tool_credentials WHERE id = ?').get(id) as import('./db-types.js').ToolCredentialRow) ?? null;
  }

  async listToolCredentials(): Promise<import('./db-types.js').ToolCredentialRow[]> {
    return this.d.prepare('SELECT * FROM tool_credentials ORDER BY name ASC').all() as import('./db-types.js').ToolCredentialRow[];
  }

  async listEnabledToolCredentials(): Promise<import('./db-types.js').ToolCredentialRow[]> {
    return this.d.prepare('SELECT * FROM tool_credentials WHERE enabled = 1 ORDER BY name ASC').all() as import('./db-types.js').ToolCredentialRow[];
  }

  async updateToolCredential(id: string, fields: Partial<Omit<import('./db-types.js').ToolCredentialRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tool_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteToolCredential(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_credentials WHERE id = ?').run(id);
  }

  async validateToolCredential(id: string): Promise<{ status: 'valid' | 'invalid' | 'unknown'; value: string | null }> {
    const row = await this.getToolCredential(id);
    if (!row) return { status: 'unknown', value: null };

    let status: 'valid' | 'invalid' | 'unknown' = 'unknown';
    let value: string | null = null;

    if (row.env_var_name) {
      value = process.env[row.env_var_name] ?? null;
      status = value ? 'valid' : 'invalid';
    }

    // Persist the updated validation_status
    await this.updateToolCredential(id, { validation_status: status });
    return { status, value };
  }

  // ─── Phase 5: MCP Gateway Clients ──────────────────────────

  async createMCPGatewayClient(c: Omit<import('./db-types.js').MCPGatewayClientRow, 'created_at' | 'updated_at' | 'last_used_at' | 'revoked_at' | 'expires_at' | 'rotated_at'> & Partial<Pick<import('./db-types.js').MCPGatewayClientRow, 'expires_at' | 'rotated_at'>>): Promise<void> {
    this.d.prepare(
      `INSERT INTO mcp_gateway_clients (id, name, description, token_hash, allowed_classes, audit_chat_id, enabled, rate_limit_per_minute, expires_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.id, c.name, c.description ?? null, c.token_hash,
      c.allowed_classes ?? null, c.audit_chat_id ?? null, c.enabled,
      c.rate_limit_per_minute ?? null,
      c.expires_at ?? null,
      c.rotated_at ?? null,
    );
  }

  async getMCPGatewayClient(id: string): Promise<import('./db-types.js').MCPGatewayClientRow | null> {
    return (this.d.prepare('SELECT * FROM mcp_gateway_clients WHERE id = ?').get(id) as import('./db-types.js').MCPGatewayClientRow | undefined) ?? null;
  }

  async getMCPGatewayClientByTokenHash(tokenHash: string): Promise<import('./db-types.js').MCPGatewayClientRow | null> {
    return (this.d.prepare('SELECT * FROM mcp_gateway_clients WHERE token_hash = ?').get(tokenHash) as import('./db-types.js').MCPGatewayClientRow | undefined) ?? null;
  }

  async listMCPGatewayClients(): Promise<import('./db-types.js').MCPGatewayClientRow[]> {
    return this.d.prepare('SELECT * FROM mcp_gateway_clients ORDER BY name').all() as import('./db-types.js').MCPGatewayClientRow[];
  }

  async listEnabledMCPGatewayClients(): Promise<import('./db-types.js').MCPGatewayClientRow[]> {
    return this.d.prepare('SELECT * FROM mcp_gateway_clients WHERE enabled = 1 AND revoked_at IS NULL ORDER BY name').all() as import('./db-types.js').MCPGatewayClientRow[];
  }

  async updateMCPGatewayClient(id: string, fields: Partial<Omit<import('./db-types.js').MCPGatewayClientRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    this.d.prepare(`UPDATE mcp_gateway_clients SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  }

  async touchMCPGatewayClient(id: string): Promise<void> {
    try {
      this.d.prepare(`UPDATE mcp_gateway_clients SET last_used_at = datetime('now') WHERE id = ?`).run(id);
    } catch {
      // Best-effort — never block a gateway request on this update.
    }
  }

  async revokeMCPGatewayClient(id: string): Promise<void> {
    this.d.prepare(`UPDATE mcp_gateway_clients SET enabled = 0, revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  }

  async deleteMCPGatewayClient(id: string): Promise<void> {
    this.d.prepare('DELETE FROM mcp_gateway_clients WHERE id = ?').run(id);
  }

  /** Phase 9: list enabled, non-revoked clients whose token expires within
   *  the given window. Uses ISO string comparison which is lexicographically
   *  monotonic for SQLite's `datetime('now')` format. */
  async listExpiringMCPGatewayClients(windowSeconds: number): Promise<import('./db-types.js').MCPGatewayClientRow[]> {
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() + windowSeconds * 1000).toISOString();
    return this.d.prepare(`
      SELECT * FROM mcp_gateway_clients
      WHERE enabled = 1
        AND revoked_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at >= ?
        AND expires_at <= ?
      ORDER BY expires_at ASC
    `).all(nowIso, cutoffIso) as import('./db-types.js').MCPGatewayClientRow[];
  }

  /** A-9 + Phase 7: per-client gateway rate-limit keyed on
   *  `(tenantId, clientId, windowStart)`. The tenantId dimension prevents
   *  cross-tenant quota consumption (even hypothetically with UUID reuse)
   *  and enables future per-tenant roll-up queries. NULL tenantId is
   *  normalised to '' so the unique index stays non-nullable. */
  async checkAndIncrementGatewayRateLimit(
    tenantId: string | null,
    clientId: string,
    windowStartIso: string,
    limitPerMinute: number,
  ): Promise<boolean> {
    const tid = tenantId ?? '';
    this.d.prepare(`
      INSERT INTO mcp_gateway_rate_buckets (id, tenant_id, client_id, window_start, count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(tenant_id, client_id, window_start) DO NOTHING
    `).run(newUUIDv7(), tid, clientId, windowStartIso);
    const row = this.d.prepare(
      'SELECT count FROM mcp_gateway_rate_buckets WHERE tenant_id = ? AND client_id = ? AND window_start = ?',
    ).get(tid, clientId, windowStartIso) as { count: number } | undefined;
    if (!row || row.count >= limitPerMinute) return false;
    this.d.prepare(
      'UPDATE mcp_gateway_rate_buckets SET count = count + 1 WHERE tenant_id = ? AND client_id = ? AND window_start = ?',
    ).run(tid, clientId, windowStartIso);
    return true;
  }

  /** Phase 8: append-only gateway request log. Best-effort writes from the
   *  gateway hot path; the gateway itself swallows errors so a write
   *  failure here never breaks an in-flight request. */
  async insertMCPGatewayRequestLog(
    row: Omit<import('./db-types.js').MCPGatewayRequestLogRow, 'created_at'>,
  ): Promise<void> {
    this.d.prepare(`
      INSERT INTO mcp_gateway_request_log
        (id, client_id, client_name, method, tool_name, outcome, status_code, duration_ms, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.client_id,
      row.client_name,
      row.method,
      row.tool_name,
      row.outcome,
      row.status_code,
      row.duration_ms,
      row.error_message,
      new Date().toISOString(),
    );
  }

  async listMCPGatewayRequestLog(opts: {
    clientId?: string;
    outcome?: import('./db-types.js').MCPGatewayRequestOutcome;
    limit?: number;
    offset?: number;
  }): Promise<import('./db-types.js').MCPGatewayRequestLogRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.clientId) { where.push('client_id = ?'); params.push(opts.clientId); }
    if (opts.outcome) { where.push('outcome = ?'); params.push(opts.outcome); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
    const offset = Math.max(0, opts.offset ?? 0);
    return this.d.prepare(
      `SELECT * FROM mcp_gateway_request_log ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as import('./db-types.js').MCPGatewayRequestLogRow[];
  }

  async summarizeMCPGatewayActivity(opts: {
    sinceIso: string;
  }): Promise<import('./db-types.js').MCPGatewayActivitySummary[]> {
    return this.d.prepare(`
      SELECT
        client_id,
        MAX(client_name) AS client_name,
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited,
        SUM(CASE WHEN outcome = 'unauthorized' THEN 1 ELSE 0 END) AS unauthorized,
        SUM(CASE WHEN outcome = 'error' OR outcome = 'disabled' THEN 1 ELSE 0 END) AS errors,
        MAX(created_at) AS last_seen
      FROM mcp_gateway_request_log
      WHERE created_at >= ?
      GROUP BY client_id
      ORDER BY total DESC
    `).all(opts.sinceIso) as import('./db-types.js').MCPGatewayActivitySummary[];
  }

  // ─── Admin: Skills ─────────────────────────────────────────

  async createSkill(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO skills (id, name, description, category, trigger_patterns, instructions, tool_names, examples, tags, priority, version, tool_policy_key, enabled, supervisor_agent_id, domain_sections, execution_contract) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id,
      s.name,
      s.description,
      s.category,
      s.trigger_patterns,
      s.instructions,
      s.tool_names ?? null,
      s.examples ?? null,
      s.tags ?? null,
      s.priority,
      s.version,
      s.tool_policy_key ?? null,
      s.enabled,
      s.supervisor_agent_id ?? null,
      s.domain_sections ?? null,
      s.execution_contract ?? null,
    );
  }

  async getSkill(id: string): Promise<SkillRow | null> {
    return (this.d.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined) ?? null;
  }

  async listSkills(): Promise<SkillRow[]> {
    return this.d.prepare('SELECT * FROM skills ORDER BY priority DESC, name ASC').all() as SkillRow[];
  }

  async listEnabledSkills(): Promise<SkillRow[]> {
    return this.d.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY priority DESC, name ASC').all() as SkillRow[];
  }

  async updateSkill(id: string, fields: Partial<Omit<SkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSkill(id: string): Promise<void> {
    this.d.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  // ─── A2A Skills ───────────────────────────────────────────

  async createA2ASkill(s: Omit<import('./db-types.js').A2ASkillRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO a2a_skills (id, name, description, tags, examples, input_modes, output_modes, security_scopes, mode, required_permission, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id, s.name, s.description,
      s.tags ?? null, s.examples ?? null,
      s.input_modes ?? null, s.output_modes ?? null,
      s.security_scopes, s.mode, s.required_permission ?? null,
      s.sort_order, s.enabled,
    );
  }

  async getA2ASkill(id: string): Promise<import('./db-types.js').A2ASkillRow | null> {
    return (this.d.prepare('SELECT * FROM a2a_skills WHERE id = ?').get(id) as import('./db-types.js').A2ASkillRow | undefined) ?? null;
  }

  async listA2ASkills(): Promise<import('./db-types.js').A2ASkillRow[]> {
    return this.d.prepare('SELECT * FROM a2a_skills ORDER BY sort_order ASC, name ASC').all() as import('./db-types.js').A2ASkillRow[];
  }

  async listEnabledA2ASkills(): Promise<import('./db-types.js').A2ASkillRow[]> {
    return this.d.prepare('SELECT * FROM a2a_skills WHERE enabled = 1 ORDER BY sort_order ASC, name ASC').all() as import('./db-types.js').A2ASkillRow[];
  }

  async updateA2ASkill(id: string, fields: Partial<Omit<import('./db-types.js').A2ASkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE a2a_skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteA2ASkill(id: string): Promise<void> {
    this.d.prepare('DELETE FROM a2a_skills WHERE id = ?').run(id);
  }

  // ─── Phase 6: Tool Approval Requests ────────────────────

  async createToolApprovalRequest(r: Omit<import('./db-types.js').ToolApprovalRequestRow, 'requested_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_approval_requests (id, tool_name, chat_id, user_id, input_json, policy_key, skill_key, status, resolved_at, resolved_by, resolution_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.tool_name,
      r.chat_id,
      r.user_id ?? null,
      r.input_json,
      r.policy_key ?? null,
      r.skill_key ?? null,
      r.status,
      r.resolved_at ?? null,
      r.resolved_by ?? null,
      r.resolution_note ?? null,
    );
  }

  async getToolApprovalRequest(id: string): Promise<import('./db-types.js').ToolApprovalRequestRow | null> {
    return (this.d.prepare('SELECT * FROM tool_approval_requests WHERE id = ?').get(id) as import('./db-types.js').ToolApprovalRequestRow | undefined) ?? null;
  }

  async getApprovedToolRequest(toolName: string, chatId: string): Promise<import('./db-types.js').ToolApprovalRequestRow | null> {
    return (this.d.prepare(
      `SELECT * FROM tool_approval_requests WHERE tool_name = ? AND chat_id = ? AND status = 'approved' ORDER BY resolved_at DESC LIMIT 1`,
    ).get(toolName, chatId) as import('./db-types.js').ToolApprovalRequestRow | undefined) ?? null;
  }

  async getPendingToolRequest(toolName: string, chatId: string): Promise<import('./db-types.js').ToolApprovalRequestRow | null> {
    return (this.d.prepare(
      `SELECT * FROM tool_approval_requests WHERE tool_name = ? AND chat_id = ? AND status = 'pending' ORDER BY requested_at ASC LIMIT 1`,
    ).get(toolName, chatId) as import('./db-types.js').ToolApprovalRequestRow | undefined) ?? null;
  }

  async listToolApprovalRequests(opts?: { status?: string; chatId?: string; toolName?: string; limit?: number; offset?: number }): Promise<import('./db-types.js').ToolApprovalRequestRow[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    if (opts?.status) { wheres.push('status = ?'); vals.push(opts.status); }
    if (opts?.chatId) { wheres.push('chat_id = ?'); vals.push(opts.chatId); }
    if (opts?.toolName) { wheres.push('tool_name = ?'); vals.push(opts.toolName); }
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const limit = Math.min(opts?.limit ?? 100, 500);
    const offset = opts?.offset ?? 0;
    return this.d.prepare(
      `SELECT * FROM tool_approval_requests ${where} ORDER BY requested_at DESC LIMIT ? OFFSET ?`,
    ).all(...vals, limit, offset) as import('./db-types.js').ToolApprovalRequestRow[];
  }

  async resolveToolApprovalRequest(id: string, fields: { status: string; resolved_by?: string; resolution_note?: string }): Promise<void> {
    this.d.prepare(
      `UPDATE tool_approval_requests SET status = ?, resolved_at = datetime('now'), resolved_by = ?, resolution_note = ? WHERE id = ?`,
    ).run(fields.status, fields.resolved_by ?? null, fields.resolution_note ?? null, id);
  }

  // ─── Worker Agents ─────────────────────────────────────────

  async createWorkerAgent(w: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO worker_agents (id, name, display_name, job_profile, description, system_prompt, tool_names, persona, trigger_patterns, task_contract_id, max_retries, priority, category, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      w.id,
      w.name,
      w.display_name ?? null,
      w.job_profile ?? null,
      w.description,
      w.system_prompt,
      w.tool_names,
      w.persona,
      w.trigger_patterns ?? null,
      w.task_contract_id ?? null,
      w.max_retries,
      w.priority,
      w.category ?? 'general',
      w.enabled,
    );
  }

  async getWorkerAgent(id: string): Promise<WorkerAgentRow | null> {
    return (this.d.prepare('SELECT * FROM worker_agents WHERE id = ?').get(id) as WorkerAgentRow | undefined) ?? null;
  }

  async listWorkerAgents(): Promise<WorkerAgentRow[]> {
    return this.d.prepare('SELECT * FROM worker_agents ORDER BY priority DESC, COALESCE(display_name, name) ASC').all() as WorkerAgentRow[];
  }

  async listEnabledWorkerAgents(): Promise<WorkerAgentRow[]> {
    return this.d.prepare("SELECT * FROM worker_agents WHERE enabled = 1 AND category = 'general' ORDER BY priority DESC, COALESCE(display_name, name) ASC").all() as WorkerAgentRow[];
  }

  async listWorkerAgentsByCategory(category: string): Promise<WorkerAgentRow[]> {
    return this.d.prepare('SELECT * FROM worker_agents WHERE enabled = 1 AND category = ? ORDER BY priority DESC, COALESCE(display_name, name) ASC').all(category) as WorkerAgentRow[];
  }

  async updateWorkerAgent(id: string, fields: Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE worker_agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteWorkerAgent(id: string): Promise<void> {
    this.d.prepare('DELETE FROM worker_agents WHERE id = ?').run(id);
  }

  // ─── Phase 1B: Supervisor Agents ───────────────────────────

  async createSupervisorAgent(
    a: Omit<SupervisorAgentRow, 'created_at' | 'updated_at'>,
    tools?: Array<{ tool_name: string; allocation?: string }>,
  ): Promise<void> {
    this.d.prepare(
      `INSERT INTO agents (id, tenant_id, category, name, display_name, description, system_prompt, include_utility_tools, default_timezone, is_default, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      a.id,
      a.tenant_id,
      a.category,
      a.name,
      a.display_name,
      a.description,
      a.system_prompt,
      a.include_utility_tools,
      a.default_timezone,
      a.is_default,
      a.enabled,
    );
    if (tools && tools.length > 0) {
      const stmt = this.d.prepare('INSERT OR REPLACE INTO agent_tools (agent_id, tool_name, allocation) VALUES (?, ?, ?)');
      for (const t of tools) stmt.run(a.id, t.tool_name, t.allocation ?? 'default');
    }
  }

  async getSupervisorAgent(id: string): Promise<SupervisorAgentRow | null> {
    return (this.d.prepare('SELECT * FROM agents WHERE id = ?').get(id) as SupervisorAgentRow | undefined) ?? null;
  }

  async listSupervisorAgents(opts?: { tenantId?: string | null; category?: string; enabledOnly?: boolean }): Promise<SupervisorAgentRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.enabledOnly) where.push('enabled = 1');
    if (opts?.category) { where.push('category = ?'); args.push(opts.category); }
    if (opts?.tenantId === null) where.push('tenant_id IS NULL');
    else if (typeof opts?.tenantId === 'string') { where.push('tenant_id = ?'); args.push(opts.tenantId); }
    const sql = where.length
      ? `SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY is_default DESC, name ASC`
      : 'SELECT * FROM agents ORDER BY is_default DESC, name ASC';
    return this.d.prepare(sql).all(...args) as SupervisorAgentRow[];
  }

  async updateSupervisorAgent(id: string, fields: Partial<Omit<SupervisorAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSupervisorAgent(id: string): Promise<void> {
    this.d.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  async listAgentTools(agentId: string): Promise<AgentToolRow[]> {
    return this.d.prepare('SELECT agent_id, tool_name, allocation FROM agent_tools WHERE agent_id = ? ORDER BY tool_name ASC').all(agentId) as AgentToolRow[];
  }

  async setAgentTools(agentId: string, tools: Array<{ tool_name: string; allocation?: string }>): Promise<void> {
    const tx = this.d.transaction((items: Array<{ tool_name: string; allocation?: string }>) => {
      this.d.prepare('DELETE FROM agent_tools WHERE agent_id = ?').run(agentId);
      const ins = this.d.prepare('INSERT INTO agent_tools (agent_id, tool_name, allocation) VALUES (?, ?, ?)');
      for (const t of items) ins.run(agentId, t.tool_name, t.allocation ?? 'default');
    });
    tx(tools);
  }

  async resolveSupervisorAgent(opts: { tenantId?: string | null; category?: string; skillId?: string | null }): Promise<ResolvedSupervisorAgent | null> {
    const category = opts.category ?? 'general';
    const tenantId = opts.tenantId ?? null;

    const fetchWithTools = (agent: SupervisorAgentRow): ResolvedSupervisorAgent => ({
      agent,
      tools: this.d.prepare('SELECT agent_id, tool_name, allocation FROM agent_tools WHERE agent_id = ?').all(agent.id) as AgentToolRow[],
    });

    // 1. skill.supervisor_agent_id pin
    if (opts.skillId) {
      const skill = this.d.prepare('SELECT supervisor_agent_id FROM skills WHERE id = ?').get(opts.skillId) as { supervisor_agent_id: string | null } | undefined;
      if (skill?.supervisor_agent_id) {
        const a = this.d.prepare('SELECT * FROM agents WHERE id = ? AND enabled = 1').get(skill.supervisor_agent_id) as SupervisorAgentRow | undefined;
        if (a) return fetchWithTools(a);
      }
    }

    // 2. tenant_id + category exact match
    if (tenantId) {
      const a = this.d.prepare('SELECT * FROM agents WHERE tenant_id = ? AND category = ? AND enabled = 1 ORDER BY is_default DESC LIMIT 1').get(tenantId, category) as SupervisorAgentRow | undefined;
      if (a) return fetchWithTools(a);
    }

    // 3. global (tenant_id IS NULL) + category match
    const globalCategoryMatch = this.d.prepare('SELECT * FROM agents WHERE tenant_id IS NULL AND category = ? AND enabled = 1 ORDER BY is_default DESC LIMIT 1').get(category) as SupervisorAgentRow | undefined;
    if (globalCategoryMatch) return fetchWithTools(globalCategoryMatch);

    // 4. is_default fallback (any category)
    const defaultRow = this.d.prepare('SELECT * FROM agents WHERE is_default = 1 AND enabled = 1 ORDER BY tenant_id IS NULL ASC LIMIT 1').get() as SupervisorAgentRow | undefined;
    if (defaultRow) return fetchWithTools(defaultRow);

    return null;
  }

  // ─── Workflow Runs ─────────────────────────────────────────

  async createWorkflowRun(r: Omit<WorkflowRunRow, 'completed_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, status, state, input, error, started_at, cost_total, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.workflow_id, r.status, r.state, r.input, r.error, r.started_at, r.cost_total ?? 0, r.metadata ?? null);
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunRow | null> {
    return (this.d.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined) ?? null;
  }

  async listWorkflowRuns(workflowId?: string): Promise<WorkflowRunRow[]> {
    if (workflowId) {
      return this.d.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC').all(workflowId) as WorkflowRunRow[];
    }
    return this.d.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC').all() as WorkflowRunRow[];
  }

  async updateWorkflowRun(id: string, fields: Partial<Omit<WorkflowRunRow, 'id' | 'started_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.d.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteWorkflowRun(id: string): Promise<void> {
    this.d.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id);
  }

  // ─── Phase 5: Workflow Checkpoints ─────────────────────────

  async createWorkflowCheckpoint(c: Omit<WorkflowCheckpointRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO workflow_checkpoints (id, run_id, workflow_id, step_id, state) VALUES (?, ?, ?, ?, ?)`,
    ).run(c.id, c.run_id, c.workflow_id, c.step_id, c.state);
  }

  async listWorkflowCheckpoints(runId: string): Promise<WorkflowCheckpointRow[]> {
    return this.d.prepare(
      'SELECT * FROM workflow_checkpoints WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
    ).all(runId) as WorkflowCheckpointRow[];
  }

  async deleteWorkflowCheckpoints(runId: string): Promise<void> {
    this.d.prepare('DELETE FROM workflow_checkpoints WHERE run_id = ?').run(runId);
  }

  // ─── Phase 5: Capability Policy Bindings ───────────────────

  async createCapabilityPolicyBinding(b: Omit<CapabilityPolicyBindingRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO capability_policy_bindings (id, binding_kind, binding_ref, policy_kind, policy_ref, precedence, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(b.id, b.binding_kind, b.binding_ref, b.policy_kind, b.policy_ref, b.precedence, b.enabled);
  }

  async getCapabilityPolicyBinding(id: string): Promise<CapabilityPolicyBindingRow | null> {
    return (this.d.prepare('SELECT * FROM capability_policy_bindings WHERE id = ?').get(id) as CapabilityPolicyBindingRow | undefined) ?? null;
  }

  async listCapabilityPolicyBindings(opts?: { bindingKind?: string; bindingRef?: string; policyKind?: string; enabledOnly?: boolean }): Promise<CapabilityPolicyBindingRow[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    if (opts?.bindingKind) { wheres.push('binding_kind = ?'); vals.push(opts.bindingKind); }
    if (opts?.bindingRef) { wheres.push('binding_ref = ?'); vals.push(opts.bindingRef); }
    if (opts?.policyKind) { wheres.push('policy_kind = ?'); vals.push(opts.policyKind); }
    if (opts?.enabledOnly) { wheres.push('enabled = 1'); }
    const sql = `SELECT * FROM capability_policy_bindings ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY precedence DESC, created_at ASC`;
    return this.d.prepare(sql).all(...vals) as CapabilityPolicyBindingRow[];
  }

  async updateCapabilityPolicyBinding(id: string, fields: Partial<Omit<CapabilityPolicyBindingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE capability_policy_bindings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCapabilityPolicyBinding(id: string): Promise<void> {
    this.d.prepare('DELETE FROM capability_policy_bindings WHERE id = ?').run(id);
  }

  // ─── Agent Strategy Settings (Phase 7 / m74) ───────────────

  async getAgentStrategySettings(id: string): Promise<import('./db-types/agents.js').AgentStrategySettingsRow | null> {
    return (this.d.prepare('SELECT * FROM agent_strategy_settings WHERE id = ?').get(id) as import('./db-types/agents.js').AgentStrategySettingsRow | undefined) ?? null;
  }

  async listAgentStrategySettings(): Promise<import('./db-types/agents.js').AgentStrategySettingsRow[]> {
    return this.d.prepare('SELECT * FROM agent_strategy_settings ORDER BY scope ASC, id ASC').all() as import('./db-types/agents.js').AgentStrategySettingsRow[];
  }

  async updateAgentStrategySettings(id: string, patch: Partial<Omit<import('./db-types/agents.js').AgentStrategySettingsRow, 'id' | 'updated_at'>>): Promise<void> {
    const fields = Object.keys(patch) as Array<keyof typeof patch>;
    if (fields.length === 0) return;
    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => patch[f] ?? null);
    this.d.prepare(`UPDATE agent_strategy_settings SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
  }

  // ─── Cost Governor Phase 2: Cost Policies ──────────────────

  async createCostPolicy(p: Omit<CostPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO cost_policies (id, key, tier, levers_json, description, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.key, p.tier, p.levers_json, p.description, p.enabled);
  }

  async getCostPolicy(id: string): Promise<CostPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM cost_policies WHERE id = ?').get(id) as CostPolicyRow | undefined) ?? null;
  }

  async getCostPolicyByKey(key: string): Promise<CostPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM cost_policies WHERE key = ?').get(key) as CostPolicyRow | undefined) ?? null;
  }

  async listCostPolicies(opts?: { enabledOnly?: boolean }): Promise<CostPolicyRow[]> {
    const sql = `SELECT * FROM cost_policies ${opts?.enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY key ASC`;
    return this.d.prepare(sql).all() as CostPolicyRow[];
  }

  async updateCostPolicy(id: string, fields: Partial<Omit<CostPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const allowed = new Set(['key', 'tier', 'levers_json', 'description', 'enabled']);
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.has(k)) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE cost_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCostPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM cost_policies WHERE id = ?').run(id);
  }

  // ─── Cost Governor Phase 8: Tool Embeddings (Intent-RAG) ──────────────────

  async upsertToolEmbedding(e: Omit<ToolEmbeddingRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_embeddings (id, tool_key, model_id, dimension, embedding, description_hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_key) DO UPDATE SET
         model_id = excluded.model_id,
         dimension = excluded.dimension,
         embedding = excluded.embedding,
         description_hash = excluded.description_hash,
         updated_at = datetime('now')`,
    ).run(e.id, e.tool_key, e.model_id, e.dimension, e.embedding, e.description_hash);
  }

  async getToolEmbedding(toolKey: string): Promise<ToolEmbeddingRow | null> {
    return (this.d.prepare('SELECT * FROM tool_embeddings WHERE tool_key = ?').get(toolKey) as ToolEmbeddingRow | undefined) ?? null;
  }

  async listToolEmbeddings(opts?: { modelId?: string }): Promise<ToolEmbeddingRow[]> {
    if (opts?.modelId) {
      return this.d.prepare('SELECT * FROM tool_embeddings WHERE model_id = ? ORDER BY tool_key ASC').all(opts.modelId) as ToolEmbeddingRow[];
    }
    return this.d.prepare('SELECT * FROM tool_embeddings ORDER BY tool_key ASC').all() as ToolEmbeddingRow[];
  }

  async deleteToolEmbedding(toolKey: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_embeddings WHERE tool_key = ?').run(toolKey);
  }

  // ─── Encryption (delegated to SqliteEncryptionStore) ────────────────────

  async getTenantEncryptionPolicy(t: string) { return this.encStore.getTenantEncryptionPolicy(t); }
  async listTenantEncryptionPolicies(o?: { enabledOnly?: boolean }) { return this.encStore.listTenantEncryptionPolicies(o); }
  async deleteTenantEncryptionPolicy(t: string) { return this.encStore.deleteTenantEncryptionPolicy(t); }
  async upsertTenantEncryptionPolicy(p: Omit<TenantEncryptionPolicyRow, 'created_at' | 'updated_at'>) { return this.encStore.upsertTenantEncryptionPolicy(p); }
  async insertTenantKek(k: TenantKekRow) { return this.encStore.insertTenantKek(k); }
  async listTenantKeks(t: string) { return this.encStore.listTenantKeks(t); }
  // H-13: point lookups delegated to the store to avoid O(n) list scans.
  async getTenantKekById(tenantId: string, kekId: string) { return this.encStore.getTenantKekById(tenantId, kekId); }
  async updateTenantKekStatus(id: string, status: string, ts: number) { return this.encStore.updateTenantKekStatus(id, status, ts); }
  async insertTenantDek(d: TenantDekRow) { return this.encStore.insertTenantDek(d); }
  async listTenantDeks(t: string) { return this.encStore.listTenantDeks(t); }
  async getTenantDekById(tenantId: string, dekId: string) { return this.encStore.getTenantDekById(tenantId, dekId); }
  async getMaxTenantDekEpoch(tenantId: string) { return this.encStore.getMaxTenantDekEpoch(tenantId); }
  async updateTenantDekStatus(id: string, status: string, ts: number) { return this.encStore.updateTenantDekStatus(id, status, ts); }
  async insertTenantBik(b: TenantBikRow) { return this.encStore.insertTenantBik(b); }
  async listTenantBiks(t: string) { return this.encStore.listTenantBiks(t); }
  async updateTenantBikStatus(id: string, status: string, ts: number) { return this.encStore.updateTenantBikStatus(id, status, ts); }
  async insertEncryptionAudit(e: EncryptionAuditRow) { return this.encStore.insertEncryptionAudit(e); }
  async listEncryptionAudit(t: string, o?: { limit?: number; offset?: number }) { return this.encStore.listEncryptionAudit(t, o); }
  async upsertEncryptionAlertConfig(r: Omit<TenantEncryptionAlertConfigRow, 'created_at' | 'updated_at'>) { return this.encStore.upsertEncryptionAlertConfig(r); }
  async listEncryptionAlertConfig(o?: { tenantId?: string | null }) { return this.encStore.listEncryptionAlertConfig(o); }
  async deleteEncryptionAlertConfig(id: string) { return this.encStore.deleteEncryptionAlertConfig(id); }
  async deleteAllTenantWrappedMaterial(t: string) { return this.encStore.deleteAllTenantWrappedMaterial(t); }
  async createTenantDeletionRequest(r: Omit<TenantDeletionRequestRow, 'purged_at' | 'cancelled_at'>) { return this.encStore.createTenantDeletionRequest(r); }
  async getTenantDeletionRequest(id: string) { return this.encStore.getTenantDeletionRequest(id); }
  async listTenantDeletionRequests(o?: { tenantId?: string; status?: TenantDeletionRequestRow['status']; limit?: number; offset?: number }) { return this.encStore.listTenantDeletionRequests(o); }
  async listDueTenantPurges(nowMs: number) { return this.encStore.listDueTenantPurges(nowMs); }
  async markTenantPurged(id: string, purgedAtMs: number) { return this.encStore.markTenantPurged(id, purgedAtMs); }
  async cancelTenantDeletionRequest(id: string, cancelledAtMs: number) { return this.encStore.cancelTenantDeletionRequest(id, cancelledAtMs); }
  async upsertTenantByokConfig(c: Omit<TenantByokConfigRow, 'created_at' | 'updated_at' | 'revoked_at'>) { return this.encStore.upsertTenantByokConfig(c); }
  async getTenantByokConfig(t: string) { return this.encStore.getTenantByokConfig(t); }
  async listTenantByokConfigs(o: { activeOnly?: boolean } = {}) { return this.encStore.listTenantByokConfigs(o); }
  async revokeTenantByokConfig(t: string, ms: number) { return this.encStore.revokeTenantByokConfig(t, ms); }
  async deleteTenantByokConfig(t: string) { return this.encStore.deleteTenantByokConfig(t); }
  async insertBreakGlassRequest(r: Omit<TenantBreakGlassRequestRow, 'updated_at'>) { return this.encStore.insertBreakGlassRequest(r); }
  async getBreakGlassRequest(id: string) { return this.encStore.getBreakGlassRequest(id); }
  async listBreakGlassRequests(o: { tenantId?: string; status?: TenantBreakGlassRequestRow['status']; limit?: number; offset?: number } = {}) { return this.encStore.listBreakGlassRequests(o); }
  async updateBreakGlassRequest(id: string, patch: Partial<Omit<TenantBreakGlassRequestRow, 'id' | 'tenant_id' | 'created_at'>>) { return this.encStore.updateBreakGlassRequest(id, patch); }
  async listExpiredApprovedBreakGlassRequests(nowMs: number) { return this.encStore.listExpiredApprovedBreakGlassRequests(nowMs); }
  async insertAttestationLog(a: Omit<TenantAttestationLogRow, 'created_at'>) { return this.encStore.insertAttestationLog(a); }
  async listAttestationLogs(o: { tenantId?: string; limit?: number; offset?: number } = {}) { return this.encStore.listAttestationLogs(o); }
  async getAttestationLog(id: string) { return this.encStore.getAttestationLog(id); }
  async getSystemAttestationSigningKey() { return this.encStore.getSystemAttestationSigningKey(); }
  async insertSystemAttestationSigningKeyIfMissing(r: Omit<SystemAttestationSigningKeyRow, 'created_at'>) { return this.encStore.insertSystemAttestationSigningKeyIfMissing(r); }

  // ─── Phase 6: Capability Packs ─────────────────────────────

  async createCapabilityPack(p: Omit<CapabilityPackRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO capability_packs (id, pack_key, version, status, name, description, authored_by, manifest, installed_at, installed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.pack_key, p.version, p.status, p.name, p.description, p.authored_by, p.manifest, p.installed_at, p.installed_by);
  }

  async getCapabilityPack(id: string): Promise<CapabilityPackRow | null> {
    return (this.d.prepare('SELECT * FROM capability_packs WHERE id = ?').get(id) as CapabilityPackRow | undefined) ?? null;
  }

  async getCapabilityPackByKeyVersion(packKey: string, version: string): Promise<CapabilityPackRow | null> {
    return (this.d.prepare('SELECT * FROM capability_packs WHERE pack_key = ? AND version = ?').get(packKey, version) as CapabilityPackRow | undefined) ?? null;
  }

  async listCapabilityPacks(opts?: { packKey?: string; status?: CapabilityPackStatus; limit?: number; offset?: number }): Promise<CapabilityPackRow[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    if (opts?.packKey) { wheres.push('pack_key = ?'); vals.push(opts.packKey); }
    if (opts?.status) { wheres.push('status = ?'); vals.push(opts.status); }
    const sql = `SELECT * FROM capability_packs ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY pack_key ASC, created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    vals.push(opts?.limit ?? 200, opts?.offset ?? 0);
    return this.d.prepare(sql).all(...vals) as CapabilityPackRow[];
  }

  async updateCapabilityPack(id: string, fields: Partial<Omit<CapabilityPackRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE capability_packs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCapabilityPack(id: string): Promise<void> {
    this.d.prepare('DELETE FROM capability_packs WHERE id = ?').run(id);
  }

  async createCapabilityPackInstallation(i: Omit<CapabilityPackInstallationRow, 'installed_at' | 'uninstalled_at'> & { installed_at?: string }): Promise<void> {
    if (i.installed_at) {
      this.d.prepare(
        `INSERT INTO capability_pack_installations (id, pack_id, pack_key, pack_version, ledger, installed_by, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(i.id, i.pack_id, i.pack_key, i.pack_version, i.ledger, i.installed_by, i.installed_at);
    } else {
      this.d.prepare(
        `INSERT INTO capability_pack_installations (id, pack_id, pack_key, pack_version, ledger, installed_by) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(i.id, i.pack_id, i.pack_key, i.pack_version, i.ledger, i.installed_by);
    }
  }

  async getCapabilityPackInstallation(id: string): Promise<CapabilityPackInstallationRow | null> {
    return (this.d.prepare('SELECT * FROM capability_pack_installations WHERE id = ?').get(id) as CapabilityPackInstallationRow | undefined) ?? null;
  }

  async listCapabilityPackInstallations(opts?: { packId?: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<CapabilityPackInstallationRow[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    if (opts?.packId) { wheres.push('pack_id = ?'); vals.push(opts.packId); }
    if (opts?.activeOnly) { wheres.push('uninstalled_at IS NULL'); }
    const sql = `SELECT * FROM capability_pack_installations ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY installed_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    vals.push(opts?.limit ?? 200, opts?.offset ?? 0);
    return this.d.prepare(sql).all(...vals) as CapabilityPackInstallationRow[];
  }

  async markCapabilityPackInstallationUninstalled(id: string, uninstalledAt?: string): Promise<void> {
    this.d.prepare(
      `UPDATE capability_pack_installations SET uninstalled_at = ? WHERE id = ?`,
    ).run(uninstalledAt ?? new Date().toISOString(), id);
  }

  async createCapabilityPackExperiment(e: Omit<CapabilityPackExperimentRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO capability_pack_experiments (id, pack_key, name, variants, enabled) VALUES (?, ?, ?, ?, ?)`,
    ).run(e.id, e.pack_key, e.name, e.variants, e.enabled);
  }

  async getCapabilityPackExperiment(id: string): Promise<CapabilityPackExperimentRow | null> {
    return (this.d.prepare('SELECT * FROM capability_pack_experiments WHERE id = ?').get(id) as CapabilityPackExperimentRow | undefined) ?? null;
  }

  async listCapabilityPackExperiments(opts?: { packKey?: string; enabledOnly?: boolean }): Promise<CapabilityPackExperimentRow[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    if (opts?.packKey) { wheres.push('pack_key = ?'); vals.push(opts.packKey); }
    if (opts?.enabledOnly) { wheres.push('enabled = 1'); }
    const sql = `SELECT * FROM capability_pack_experiments ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC`;
    return this.d.prepare(sql).all(...vals) as CapabilityPackExperimentRow[];
  }

  async updateCapabilityPackExperiment(id: string, fields: Partial<Omit<CapabilityPackExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE capability_pack_experiments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCapabilityPackExperiment(id: string): Promise<void> {
    this.d.prepare('DELETE FROM capability_pack_experiments WHERE id = ?').run(id);
  }

  // ─── Guardrail Evaluations ─────────────────────────────────

  async createGuardrailEval(e: Omit<GuardrailEvalRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO guardrail_evals (id, chat_id, message_id, stage, input_preview, results, overall_decision, escalation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.chat_id, e.message_id, e.stage, e.input_preview, e.results, e.overall_decision, e.escalation ?? null);
  }

  async listGuardrailEvals(chatId?: string, limit = 50): Promise<GuardrailEvalRow[]> {
    if (chatId) {
      return this.d.prepare('SELECT * FROM guardrail_evals WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, limit) as GuardrailEvalRow[];
    }
    return this.d.prepare('SELECT * FROM guardrail_evals ORDER BY created_at DESC LIMIT ?').all(limit) as GuardrailEvalRow[];
  }

  // ─── Admin: Human Task Policies ────────────────────────────

  async createHumanTaskPolicy(p: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO human_task_policies (id, name, description, trigger, task_type, default_priority, sla_hours, auto_escalate_after_hours, assignment_strategy, assign_to, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.trigger, p.task_type, p.default_priority, p.sla_hours ?? null, p.auto_escalate_after_hours ?? null, p.assignment_strategy, p.assign_to ?? null, p.enabled);
  }

  async getHumanTaskPolicy(id: string): Promise<HumanTaskPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM human_task_policies WHERE id = ?').get(id) as HumanTaskPolicyRow) ?? null;
  }

  async listHumanTaskPolicies(): Promise<HumanTaskPolicyRow[]> {
    return this.d.prepare('SELECT * FROM human_task_policies ORDER BY name ASC').all() as HumanTaskPolicyRow[];
  }

  async updateHumanTaskPolicy(id: string, fields: Partial<Omit<HumanTaskPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE human_task_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteHumanTaskPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM human_task_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Task Contracts ─────────────────────────────────

  async createTaskContract(c: Omit<TaskContractRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO task_contracts (id, name, description, input_schema, output_schema, acceptance_criteria, max_attempts, timeout_ms, evidence_required, min_confidence, require_human_review, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.name, c.description ?? null, c.input_schema ?? null, c.output_schema ?? null, c.acceptance_criteria, c.max_attempts ?? null, c.timeout_ms ?? null, c.evidence_required ?? null, c.min_confidence ?? null, c.require_human_review, c.enabled);
  }

  async getTaskContract(id: string): Promise<TaskContractRow | null> {
    return (this.d.prepare('SELECT * FROM task_contracts WHERE id = ?').get(id) as TaskContractRow) ?? null;
  }

  async listTaskContracts(): Promise<TaskContractRow[]> {
    return this.d.prepare('SELECT * FROM task_contracts ORDER BY name ASC').all() as TaskContractRow[];
  }

  async updateTaskContract(id: string, fields: Partial<Omit<TaskContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE task_contracts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTaskContract(id: string): Promise<void> {
    this.d.prepare('DELETE FROM task_contracts WHERE id = ?').run(id);
  }

  // ─── Admin: Cache Policies ─────────────────────────────────

  async createCachePolicy(p: Omit<CachePolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO cache_policies (id, name, description, scope, ttl_ms, max_entries, max_bytes, bypass_patterns, output_bypass_patterns, invalidate_on, key_hashing, tenant_isolation, cache_temperature_gate, swr_ms, negative_ttl_ms, eviction_policy, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.name, p.description ?? null, p.scope, p.ttl_ms, p.max_entries,
      p.max_bytes ?? 0, p.bypass_patterns ?? null, p.output_bypass_patterns ?? null,
      p.invalidate_on ?? null, p.key_hashing ?? 'sha256',
      p.tenant_isolation ?? 1, p.cache_temperature_gate ?? 0,
      p.swr_ms ?? 0, p.negative_ttl_ms ?? 0, p.eviction_policy ?? 'lru', p.enabled,
    );
  }

  async getCachePolicy(id: string): Promise<CachePolicyRow | null> {
    return (this.d.prepare('SELECT * FROM cache_policies WHERE id = ?').get(id) as CachePolicyRow) ?? null;
  }

  async listCachePolicies(): Promise<CachePolicyRow[]> {
    return this.d.prepare('SELECT * FROM cache_policies ORDER BY name ASC').all() as CachePolicyRow[];
  }

  async updateCachePolicy(id: string, fields: Partial<Omit<CachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE cache_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCachePolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM cache_policies WHERE id = ?').run(id);
  }

  async getCacheSettings(): Promise<import('./db-types/admin.js').CacheSettingsRow | null> {
    const row = this.d.prepare(`SELECT * FROM cache_settings WHERE id = 'global'`).get() as import('./db-types/admin.js').CacheSettingsRow | undefined;
    return row ?? null;
  }

  // ─── Cache Invalidation Rules (Phase 5) ────────────────────
  async createCacheInvalidationRule(r: Omit<import('./db-types/admin.js').CacheInvalidationRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO cache_invalidation_rules (id, name, trigger, pattern, config, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.trigger, r.pattern ?? null, r.config ?? null, r.enabled);
  }
  async getCacheInvalidationRule(id: string): Promise<import('./db-types/admin.js').CacheInvalidationRuleRow | null> {
    return (this.d.prepare('SELECT * FROM cache_invalidation_rules WHERE id = ?').get(id) as import('./db-types/admin.js').CacheInvalidationRuleRow) ?? null;
  }
  async listCacheInvalidationRules(): Promise<import('./db-types/admin.js').CacheInvalidationRuleRow[]> {
    return this.d.prepare('SELECT * FROM cache_invalidation_rules ORDER BY trigger ASC, name ASC').all() as import('./db-types/admin.js').CacheInvalidationRuleRow[];
  }
  async updateCacheInvalidationRule(id: string, fields: Partial<Omit<import('./db-types/admin.js').CacheInvalidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')"); vals.push(id);
    this.d.prepare(`UPDATE cache_invalidation_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteCacheInvalidationRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM cache_invalidation_rules WHERE id = ?').run(id);
  }

  // ── Tool Cache Policies (Phase 6 opt-in tool-result caching) ──────────────
  async createToolCachePolicy(r: Omit<import('./db-types/admin.js').ToolCachePolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_cache_policies (id, tool_name, cacheable, ttl_ms, enabled) VALUES (?, ?, ?, ?, ?)`,
    ).run(r.id, r.tool_name, r.cacheable, r.ttl_ms, r.enabled);
  }
  async getToolCachePolicy(id: string): Promise<import('./db-types/admin.js').ToolCachePolicyRow | null> {
    return (this.d.prepare('SELECT * FROM tool_cache_policies WHERE id = ?').get(id) as import('./db-types/admin.js').ToolCachePolicyRow) ?? null;
  }
  async listToolCachePolicies(): Promise<import('./db-types/admin.js').ToolCachePolicyRow[]> {
    return this.d.prepare('SELECT * FROM tool_cache_policies ORDER BY tool_name ASC').all() as import('./db-types/admin.js').ToolCachePolicyRow[];
  }
  async updateToolCachePolicy(id: string, fields: Partial<Omit<import('./db-types/admin.js').ToolCachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')"); vals.push(id);
    this.d.prepare(`UPDATE tool_cache_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteToolCachePolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_cache_policies WHERE id = ?').run(id);
  }

  async getSemanticCacheConfig(): Promise<import('./db-types/admin.js').SemanticCacheConfigRow | null> {
    const row = this.d.prepare(`SELECT * FROM semantic_cache_config WHERE id = 'global'`).get() as import('./db-types/admin.js').SemanticCacheConfigRow | undefined;
    return row ?? null;
  }

  async updateSemanticCacheConfig(fields: Partial<Omit<import('./db-types/admin.js').SemanticCacheConfigRow, 'id' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    this.d.prepare(`INSERT OR IGNORE INTO semantic_cache_config (id) VALUES ('global')`).run();
    this.d.prepare(`UPDATE semantic_cache_config SET ${sets.join(', ')} WHERE id = 'global'`).run(...vals);
  }

  // ── Run Stream Config (Client Phase 0 single global row) ───────────────────
  async getRunStreamConfig(): Promise<import('./db-types/admin.js').RunStreamConfigRow | null> {
    const row = this.d.prepare(`SELECT * FROM run_stream_config WHERE id = 'global'`).get() as import('./db-types/admin.js').RunStreamConfigRow | undefined;
    return row ?? null;
  }

  async updateRunStreamConfig(fields: Partial<Omit<import('./db-types/admin.js').RunStreamConfigRow, 'id' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    this.d.prepare(`INSERT OR IGNORE INTO run_stream_config (id) VALUES ('global')`).run();
    this.d.prepare(`UPDATE run_stream_config SET ${sets.join(', ')} WHERE id = 'global'`).run(...vals);
  }

  // ── Agent Plan Cache Config (Phase 8 single global row) ────────────────────
  async getAgentPlanCacheConfig(): Promise<import('./db-types/admin.js').AgentPlanCacheConfigRow | null> {
    const row = this.d.prepare(`SELECT * FROM agent_plan_cache_config WHERE id = 'global'`).get() as import('./db-types/admin.js').AgentPlanCacheConfigRow | undefined;
    return row ?? null;
  }
  async updateAgentPlanCacheConfig(fields: Partial<Omit<import('./db-types/admin.js').AgentPlanCacheConfigRow, 'id' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    this.d.prepare(`INSERT OR IGNORE INTO agent_plan_cache_config (id) VALUES ('global')`).run();
    this.d.prepare(`UPDATE agent_plan_cache_config SET ${sets.join(', ')} WHERE id = 'global'`).run(...vals);
  }

  /** Phase 3 — increment the current hourly cache_metrics rollup window. */
  async recordCacheMetrics(delta: import('./db-types/admin.js').CacheMetricsDelta): Promise<void> {
    const hits = Math.max(0, Math.trunc(delta.responseHits ?? 0));
    const misses = Math.max(0, Math.trunc(delta.responseMisses ?? 0));
    const readTok = Math.max(0, Math.trunc(delta.promptCacheReadTokens ?? 0));
    const writeTok = Math.max(0, Math.trunc(delta.promptCacheWriteTokens ?? 0));
    const saved = Math.max(0, Number(delta.costSavedUsd ?? 0)) || 0;
    if (!hits && !misses && !readTok && !writeTok && !saved) return;
    this.d.prepare(
      `INSERT INTO cache_metrics (window_start, response_hits, response_misses, prompt_cache_read_tokens, prompt_cache_write_tokens, cost_saved_usd, updated_at)
       VALUES (strftime('%Y-%m-%dT%H:00:00Z','now'), ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(window_start) DO UPDATE SET
         response_hits = response_hits + excluded.response_hits,
         response_misses = response_misses + excluded.response_misses,
         prompt_cache_read_tokens = prompt_cache_read_tokens + excluded.prompt_cache_read_tokens,
         prompt_cache_write_tokens = prompt_cache_write_tokens + excluded.prompt_cache_write_tokens,
         cost_saved_usd = cost_saved_usd + excluded.cost_saved_usd,
         updated_at = datetime('now')`,
    ).run(hits, misses, readTok, writeTok, saved);
  }

  /** Phase 3 — aggregate cache metrics + recent windows for the admin dashboard. */
  async getCacheMetrics(limit = 168): Promise<import('./db-types/admin.js').CacheMetricsSummary> {
    const windows = this.d.prepare(
      `SELECT * FROM cache_metrics ORDER BY window_start DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(1000, limit))) as import('./db-types/admin.js').CacheMetricsRow[];
    const agg = this.d.prepare(
      `SELECT
         COALESCE(SUM(response_hits),0) AS h,
         COALESCE(SUM(response_misses),0) AS m,
         COALESCE(SUM(prompt_cache_read_tokens),0) AS rt,
         COALESCE(SUM(prompt_cache_write_tokens),0) AS wt,
         COALESCE(SUM(cost_saved_usd),0) AS cs
       FROM cache_metrics`,
    ).get() as { h: number; m: number; rt: number; wt: number; cs: number };
    const lookups = agg.h + agg.m;
    return {
      totals: {
        responseHits: agg.h,
        responseMisses: agg.m,
        hitRate: lookups > 0 ? agg.h / lookups : 0,
        promptCacheReadTokens: agg.rt,
        promptCacheWriteTokens: agg.wt,
        costSavedUsd: agg.cs,
      },
      windows,
    };
  }

  async updateCacheSettings(fields: Partial<Omit<import('./db-types/admin.js').CacheSettingsRow, 'id' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    // Upsert: ensure the single global row exists, then patch it.
    this.d.prepare(`INSERT OR IGNORE INTO cache_settings (id) VALUES ('global')`).run();
    this.d.prepare(`UPDATE cache_settings SET ${sets.join(', ')} WHERE id = 'global'`).run(...vals);
  }

  // ─── Admin: Identity Rules ─────────────────────────────────

  async createIdentityRule(r: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO identity_rules (id, name, description, resource, action, roles, scopes, result, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.resource, r.action, r.roles ?? null, r.scopes ?? null, r.result, r.priority, r.enabled);
  }

  async getIdentityRule(id: string): Promise<IdentityRuleRow | null> {
    return (this.d.prepare('SELECT * FROM identity_rules WHERE id = ?').get(id) as IdentityRuleRow) ?? null;
  }

  async listIdentityRules(): Promise<IdentityRuleRow[]> {
    return this.d.prepare('SELECT * FROM identity_rules ORDER BY priority DESC, name ASC').all() as IdentityRuleRow[];
  }

  async updateIdentityRule(id: string, fields: Partial<Omit<IdentityRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE identity_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteIdentityRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM identity_rules WHERE id = ?').run(id);
  }

  // ─── Admin: Memory Governance ──────────────────────────────

  async createMemoryGovernance(g: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO memory_governance (id, name, description, memory_types, tenant_id, block_patterns, redact_patterns, max_age, max_entries, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.name, g.description ?? null, g.memory_types ?? null, g.tenant_id ?? null, g.block_patterns ?? null, g.redact_patterns ?? null, g.max_age ?? null, g.max_entries ?? null, g.enabled);
  }

  async getMemoryGovernance(id: string): Promise<MemoryGovernanceRow | null> {
    return (this.d.prepare('SELECT * FROM memory_governance WHERE id = ?').get(id) as MemoryGovernanceRow) ?? null;
  }

  async listMemoryGovernance(): Promise<MemoryGovernanceRow[]> {
    return this.d.prepare('SELECT * FROM memory_governance ORDER BY name ASC').all() as MemoryGovernanceRow[];
  }

  async updateMemoryGovernance(id: string, fields: Partial<Omit<MemoryGovernanceRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE memory_governance SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteMemoryGovernance(id: string): Promise<void> {
    this.d.prepare('DELETE FROM memory_governance WHERE id = ?').run(id);
  }

  // ─── Admin: Memory Extraction Rules ───────────────────────

  async createMemoryExtractionRule(r: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO memory_extraction_rules (id, name, description, rule_type, entity_type, pattern, flags, facts_template, priority, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.name,
      r.description ?? null,
      r.rule_type,
      r.entity_type ?? null,
      r.pattern,
      r.flags ?? null,
      r.facts_template ?? null,
      r.priority,
      r.enabled,
    );
  }

  async getMemoryExtractionRule(id: string): Promise<MemoryExtractionRuleRow | null> {
    return (this.d.prepare('SELECT * FROM memory_extraction_rules WHERE id = ?').get(id) as MemoryExtractionRuleRow | undefined) ?? null;
  }

  async listMemoryExtractionRules(ruleType?: string): Promise<MemoryExtractionRuleRow[]> {
    if (ruleType) {
      return this.d.prepare('SELECT * FROM memory_extraction_rules WHERE rule_type = ? ORDER BY priority DESC, name ASC').all(ruleType) as MemoryExtractionRuleRow[];
    }
    return this.d.prepare('SELECT * FROM memory_extraction_rules ORDER BY rule_type ASC, priority DESC, name ASC').all() as MemoryExtractionRuleRow[];
  }

  async updateMemoryExtractionRule(id: string, fields: Partial<Omit<MemoryExtractionRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE memory_extraction_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteMemoryExtractionRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM memory_extraction_rules WHERE id = ?').run(id);
  }

  // ─── Admin: Search Providers ───────────────────────────────

  async createSearchProvider(p: Omit<SearchProviderRow, 'created_at' | 'updated_at'>): Promise<void> {
    const enc = vaultEncryptField(p.api_key ?? null);
    const credFlag = enc !== null ? 1 : 0;
    this.d.prepare(
      `INSERT INTO search_providers (id, name, description, provider_type, api_key, api_key_enc, credentials_encrypted, base_url, priority, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.provider_type, credFlag ? null : (p.api_key ?? null), enc, credFlag, p.base_url ?? null, p.priority, p.options ?? null, p.enabled);
  }

  async getSearchProvider(id: string): Promise<SearchProviderRow | null> {
    type Raw = SearchProviderRow & { api_key_enc?: string | null; credentials_encrypted?: number };
    const raw = this.d.prepare('SELECT * FROM search_providers WHERE id = ?').get(id) as Raw | undefined;
    if (!raw) return null;
    return raw.credentials_encrypted === 1 ? { ...raw, api_key: vaultDecryptField(raw.api_key_enc ?? null) } : raw;
  }

  async listSearchProviders(): Promise<SearchProviderRow[]> {
    type Raw = SearchProviderRow & { api_key_enc?: string | null; credentials_encrypted?: number };
    return (this.d.prepare('SELECT * FROM search_providers ORDER BY priority DESC, name ASC').all() as Raw[]).map(
      r => r.credentials_encrypted === 1 ? { ...r, api_key: vaultDecryptField(r.api_key_enc ?? null) } : r,
    );
  }

  async updateSearchProvider(id: string, fields: Partial<Omit<SearchProviderRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const ALLOWED = new Set(['name', 'description', 'provider_type', 'base_url', 'priority', 'options', 'enabled']);
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'api_key') {
        const enc = vaultEncryptField(typeof v === 'string' ? v : null);
        if (enc !== null) {
          sets.push('api_key = ?'); vals.push(null);
          sets.push('api_key_enc = ?'); vals.push(enc);
          sets.push('credentials_encrypted = 1');
        } else {
          sets.push('api_key = ?'); vals.push(v ?? null);
        }
      } else if (ALLOWED.has(k)) {
        sets.push(`${k} = ?`); vals.push(v);
      }
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE search_providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSearchProvider(id: string): Promise<void> {
    this.d.prepare('DELETE FROM search_providers WHERE id = ?').run(id);
  }

  // ─── Admin: HTTP Endpoints ─────────────────────────────────

  async createHttpEndpoint(e: Omit<HttpEndpointRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO http_endpoints (id, name, description, url, method, auth_type, auth_config, headers, body_template, response_transform, retry_count, rate_limit_rpm, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.name, e.description ?? null, e.url, e.method, e.auth_type ?? null, e.auth_config ?? null, e.headers ?? null, e.body_template ?? null, e.response_transform ?? null, e.retry_count, e.rate_limit_rpm ?? null, e.enabled);
  }

  async getHttpEndpoint(id: string): Promise<HttpEndpointRow | null> {
    return (this.d.prepare('SELECT * FROM http_endpoints WHERE id = ?').get(id) as HttpEndpointRow) ?? null;
  }

  async listHttpEndpoints(): Promise<HttpEndpointRow[]> {
    return this.d.prepare('SELECT * FROM http_endpoints ORDER BY name ASC').all() as HttpEndpointRow[];
  }

  async updateHttpEndpoint(id: string, fields: Partial<Omit<HttpEndpointRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE http_endpoints SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteHttpEndpoint(id: string): Promise<void> {
    this.d.prepare('DELETE FROM http_endpoints WHERE id = ?').run(id);
  }

  // ─── Admin: Social Accounts ────────────────────────────────

  async createSocialAccount(a: Omit<SocialAccountRow, 'created_at' | 'updated_at'>): Promise<void> {
    const encKey    = vaultEncryptField(a.api_key ?? null);
    const encSecret = vaultEncryptField(a.api_secret ?? null);
    const encAccess = vaultEncryptField(a.access_token ?? null);
    const encRefresh = vaultEncryptField(a.refresh_token ?? null);
    const credFlag  = (encKey ?? encSecret ?? encAccess ?? encRefresh) !== null ? 1 : 0;
    this.d.prepare(
      `INSERT INTO social_accounts (id, name, description, platform, api_key, api_key_enc, api_secret, api_secret_enc, access_token, access_token_enc, refresh_token, refresh_token_enc, credentials_encrypted, token_expires_at, oauth_state, status, base_url, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      a.id, a.name, a.description ?? null, a.platform,
      credFlag ? null : (a.api_key ?? null),    encKey,
      credFlag ? null : (a.api_secret ?? null),  encSecret,
      credFlag ? null : (a.access_token ?? null), encAccess,
      credFlag ? null : (a.refresh_token ?? null), encRefresh,
      credFlag,
      a.token_expires_at ?? null, a.oauth_state ?? null, a.status ?? 'disconnected', a.base_url ?? null, a.options ?? null, a.enabled,
    );
  }

  async getSocialAccount(id: string): Promise<SocialAccountRow | null> {
    type Raw = SocialAccountRow & { api_key_enc?: string|null; api_secret_enc?: string|null; access_token_enc?: string|null; refresh_token_enc?: string|null; credentials_encrypted?: number };
    const r = this.d.prepare('SELECT * FROM social_accounts WHERE id = ?').get(id) as Raw | undefined;
    if (!r) return null;
    if (r.credentials_encrypted !== 1) return r;
    return { ...r, api_key: vaultDecryptField(r.api_key_enc ?? null), api_secret: vaultDecryptField(r.api_secret_enc ?? null), access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null) };
  }

  async listSocialAccounts(): Promise<SocialAccountRow[]> {
    type Raw = SocialAccountRow & { api_key_enc?: string|null; api_secret_enc?: string|null; access_token_enc?: string|null; refresh_token_enc?: string|null; credentials_encrypted?: number };
    return (this.d.prepare('SELECT * FROM social_accounts ORDER BY name ASC').all() as Raw[]).map(r =>
      r.credentials_encrypted !== 1 ? r : { ...r, api_key: vaultDecryptField(r.api_key_enc ?? null), api_secret: vaultDecryptField(r.api_secret_enc ?? null), access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null) },
    );
  }

  async updateSocialAccount(id: string, fields: Partial<Omit<SocialAccountRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const SENSITIVE = new Set(['api_key', 'api_secret', 'access_token', 'refresh_token']);
    const SENSITIVE_MAP: Record<string, string> = { api_key: 'api_key_enc', api_secret: 'api_secret_enc', access_token: 'access_token_enc', refresh_token: 'refresh_token_enc' };
    const ALLOWED = new Set(['name', 'description', 'platform', 'token_expires_at', 'oauth_state', 'status', 'base_url', 'options', 'enabled']);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let anyEncrypted = false;
    for (const [k, v] of Object.entries(fields)) {
      if (SENSITIVE.has(k)) {
        const enc = vaultEncryptField(typeof v === 'string' ? v : null);
        if (enc !== null) {
          sets.push(`${k} = ?`); vals.push(null);
          sets.push(`${SENSITIVE_MAP[k]} = ?`); vals.push(enc);
          anyEncrypted = true;
        } else {
          sets.push(`${k} = ?`); vals.push(v ?? null);
        }
      } else if (ALLOWED.has(k)) {
        sets.push(`${k} = ?`); vals.push(v);
      }
    }
    if (anyEncrypted) { sets.push('credentials_encrypted = 1'); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE social_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSocialAccount(id: string): Promise<void> {
    this.d.prepare('DELETE FROM social_accounts WHERE id = ?').run(id);
  }

  // ─── Admin: Enterprise Connectors ──────────────────────────

  async createEnterpriseConnector(c: Omit<EnterpriseConnectorRow, 'created_at' | 'updated_at'>): Promise<void> {
    const encAccess  = vaultEncryptField(c.access_token ?? null);
    const encRefresh = vaultEncryptField(c.refresh_token ?? null);
    const encAuth    = vaultEncryptField(c.auth_config ?? null);
    const credFlag   = (encAccess ?? encRefresh ?? encAuth) !== null ? 1 : 0;
    this.d.prepare(
      `INSERT INTO enterprise_connectors (id, name, description, connector_type, base_url, auth_type, auth_config, auth_config_enc, access_token, access_token_enc, refresh_token, refresh_token_enc, credentials_encrypted, token_expires_at, oauth_state, status, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.id, c.name, c.description ?? null, c.connector_type, c.base_url ?? null, c.auth_type ?? null,
      credFlag ? null : (c.auth_config ?? null),    encAuth,
      credFlag ? null : (c.access_token ?? null),   encAccess,
      credFlag ? null : (c.refresh_token ?? null),  encRefresh,
      credFlag,
      c.token_expires_at ?? null, c.oauth_state ?? null, c.status ?? 'disconnected', c.options ?? null, c.enabled,
    );
  }

  async getEnterpriseConnector(id: string): Promise<EnterpriseConnectorRow | null> {
    type Raw = EnterpriseConnectorRow & { access_token_enc?: string|null; refresh_token_enc?: string|null; auth_config_enc?: string|null; credentials_encrypted?: number };
    const r = this.d.prepare('SELECT * FROM enterprise_connectors WHERE id = ?').get(id) as Raw | undefined;
    if (!r) return null;
    if (r.credentials_encrypted !== 1) return r;
    return { ...r, access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null), auth_config: vaultDecryptField(r.auth_config_enc ?? null) };
  }

  async listEnterpriseConnectors(): Promise<EnterpriseConnectorRow[]> {
    type Raw = EnterpriseConnectorRow & { access_token_enc?: string|null; refresh_token_enc?: string|null; auth_config_enc?: string|null; credentials_encrypted?: number };
    return (this.d.prepare('SELECT * FROM enterprise_connectors ORDER BY name ASC').all() as Raw[]).map(r =>
      r.credentials_encrypted !== 1 ? r : { ...r, access_token: vaultDecryptField(r.access_token_enc ?? null), refresh_token: vaultDecryptField(r.refresh_token_enc ?? null), auth_config: vaultDecryptField(r.auth_config_enc ?? null) },
    );
  }

  async updateEnterpriseConnector(id: string, fields: Partial<Omit<EnterpriseConnectorRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const SENSITIVE_MAP: Record<string, string> = { access_token: 'access_token_enc', refresh_token: 'refresh_token_enc', auth_config: 'auth_config_enc' };
    const ALLOWED = new Set(['name', 'description', 'connector_type', 'base_url', 'auth_type', 'token_expires_at', 'oauth_state', 'status', 'options', 'enabled']);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let anyEncrypted = false;
    for (const [k, v] of Object.entries(fields)) {
      if (k in SENSITIVE_MAP) {
        const enc = vaultEncryptField(typeof v === 'string' ? v : null);
        if (enc !== null) {
          sets.push(`${k} = ?`); vals.push(null);
          sets.push(`${SENSITIVE_MAP[k]} = ?`); vals.push(enc);
          anyEncrypted = true;
        } else {
          sets.push(`${k} = ?`); vals.push(v ?? null);
        }
      } else if (ALLOWED.has(k)) {
        sets.push(`${k} = ?`); vals.push(v);
      }
    }
    if (anyEncrypted) { sets.push('credentials_encrypted = 1'); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE enterprise_connectors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteEnterpriseConnector(id: string): Promise<void> {
    this.d.prepare('DELETE FROM enterprise_connectors WHERE id = ?').run(id);
  }

  // ─── Admin: Tool Registry ─────────────────────────────────

  async createToolRegistryEntry(t: Omit<ToolRegistryRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_registry (id, name, description, package_name, version, category, risk_level, tags, config, requires_approval, max_execution_ms, rate_limit_per_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.name, t.description ?? null, t.package_name, t.version, t.category, t.risk_level, t.tags ?? null, t.config ?? null, t.requires_approval, t.max_execution_ms ?? null, t.rate_limit_per_min ?? null, t.enabled);
  }

  async getToolRegistryEntry(id: string): Promise<ToolRegistryRow | null> {
    return (this.d.prepare('SELECT * FROM tool_registry WHERE id = ?').get(id) as ToolRegistryRow) ?? null;
  }

  async listToolRegistry(): Promise<ToolRegistryRow[]> {
    return this.d.prepare('SELECT * FROM tool_registry ORDER BY category ASC, name ASC').all() as ToolRegistryRow[];
  }

  async updateToolRegistryEntry(id: string, fields: Partial<Omit<ToolRegistryRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tool_registry SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteToolRegistryEntry(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_registry WHERE id = ?').run(id);
  }

  // ─── Admin: Replay Scenarios ─────────────────────────────────

  async createReplayScenario(s: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO replay_scenarios (id, name, description, golden_prompt, golden_response, model, provider, tags, acceptance_criteria, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.name, s.description ?? null, s.golden_prompt, s.golden_response, s.model ?? null, s.provider ?? null, s.tags ?? null, s.acceptance_criteria ?? null, s.enabled);
  }

  async getReplayScenario(id: string): Promise<ReplayScenarioRow | null> {
    return (this.d.prepare('SELECT * FROM replay_scenarios WHERE id = ?').get(id) as ReplayScenarioRow) ?? null;
  }

  async listReplayScenarios(): Promise<ReplayScenarioRow[]> {
    return this.d.prepare('SELECT * FROM replay_scenarios ORDER BY name ASC').all() as ReplayScenarioRow[];
  }

  async updateReplayScenario(id: string, fields: Partial<Omit<ReplayScenarioRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE replay_scenarios SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteReplayScenario(id: string): Promise<void> {
    this.d.prepare('DELETE FROM replay_scenarios WHERE id = ?').run(id);
  }

  // ─── Admin: Trigger Definitions ──────────────────────────────

  async createTriggerDefinition(t: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO trigger_definitions (id, name, description, trigger_type, expression, config, target_workflow, status, last_fired_at, fire_count, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.name, t.description ?? null, t.trigger_type, t.expression ?? null, t.config ?? null, t.target_workflow ?? null, t.status, t.last_fired_at ?? null, t.fire_count, t.enabled);
  }

  async getTriggerDefinition(id: string): Promise<TriggerDefinitionRow | null> {
    return (this.d.prepare('SELECT * FROM trigger_definitions WHERE id = ?').get(id) as TriggerDefinitionRow) ?? null;
  }

  async listTriggerDefinitions(): Promise<TriggerDefinitionRow[]> {
    return this.d.prepare('SELECT * FROM trigger_definitions ORDER BY name ASC').all() as TriggerDefinitionRow[];
  }

  async updateTriggerDefinition(id: string, fields: Partial<Omit<TriggerDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE trigger_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTriggerDefinition(id: string): Promise<void> {
    this.d.prepare('DELETE FROM trigger_definitions WHERE id = ?').run(id);
  }

  // ─── Admin: Tenant Configs ───────────────────────────────────

  async createTenantConfig(c: Omit<TenantConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_configs (id, name, description, tenant_id, scope, allowed_models, denied_models, allowed_tools, max_tokens_daily, max_cost_daily, max_tokens_monthly, max_cost_monthly, features, config_overrides, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.name, c.description ?? null, c.tenant_id, c.scope, c.allowed_models ?? null, c.denied_models ?? null, c.allowed_tools ?? null, c.max_tokens_daily ?? null, c.max_cost_daily ?? null, c.max_tokens_monthly ?? null, c.max_cost_monthly ?? null, c.features ?? null, c.config_overrides ?? null, c.enabled);
  }

  async getTenantConfig(id: string): Promise<TenantConfigRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_configs WHERE id = ?').get(id) as TenantConfigRow) ?? null;
  }

  async getGlobalTenantConfig(): Promise<TenantConfigRow | null> {
    return (this.d.prepare("SELECT * FROM tenant_configs WHERE scope = 'global' ORDER BY created_at ASC LIMIT 1").get() as TenantConfigRow) ?? null;
  }

  async getTenantConfigForTenant(tenantId: string): Promise<TenantConfigRow | null> {
    return (this.d.prepare("SELECT * FROM tenant_configs WHERE tenant_id = ? AND scope != 'global' AND enabled = 1 ORDER BY created_at ASC LIMIT 1").get(tenantId) as TenantConfigRow) ?? null;
  }

  async listTenantConfigs(): Promise<TenantConfigRow[]> {
    return this.d.prepare('SELECT * FROM tenant_configs ORDER BY tenant_id ASC, name ASC').all() as TenantConfigRow[];
  }

  async updateTenantConfig(id: string, fields: Partial<Omit<TenantConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tenant_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTenantConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tenant_configs WHERE id = ?').run(id);
  }

  // ─── Admin: Sandbox Policies ─────────────────────────────────

  async createSandboxPolicy(p: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO sandbox_policies (id, name, description, max_cpu_ms, max_memory_mb, max_duration_ms, max_output_bytes, allowed_modules, denied_modules, network_access, filesystem_access, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.max_cpu_ms ?? null, p.max_memory_mb ?? null, p.max_duration_ms, p.max_output_bytes ?? null, p.allowed_modules ?? null, p.denied_modules ?? null, p.network_access, p.filesystem_access, p.enabled);
  }

  async getSandboxPolicy(id: string): Promise<SandboxPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM sandbox_policies WHERE id = ?').get(id) as SandboxPolicyRow) ?? null;
  }

  async listSandboxPolicies(): Promise<SandboxPolicyRow[]> {
    return this.d.prepare('SELECT * FROM sandbox_policies ORDER BY name ASC').all() as SandboxPolicyRow[];
  }

  async updateSandboxPolicy(id: string, fields: Partial<Omit<SandboxPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE sandbox_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSandboxPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM sandbox_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Extraction Pipelines ─────────────────────────────

  async createExtractionPipeline(p: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO extraction_pipelines (id, name, description, stages, input_mime_types, max_input_size_bytes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.stages, p.input_mime_types ?? null, p.max_input_size_bytes ?? null, p.enabled);
  }

  async getExtractionPipeline(id: string): Promise<ExtractionPipelineRow | null> {
    return (this.d.prepare('SELECT * FROM extraction_pipelines WHERE id = ?').get(id) as ExtractionPipelineRow) ?? null;
  }

  async listExtractionPipelines(): Promise<ExtractionPipelineRow[]> {
    return this.d.prepare('SELECT * FROM extraction_pipelines ORDER BY name ASC').all() as ExtractionPipelineRow[];
  }

  async updateExtractionPipeline(id: string, fields: Partial<Omit<ExtractionPipelineRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE extraction_pipelines SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteExtractionPipeline(id: string): Promise<void> {
    this.d.prepare('DELETE FROM extraction_pipelines WHERE id = ?').run(id);
  }

  // ─── Admin: Artifact Policies ────────────────────────────────

  async createArtifactPolicy(p: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO artifact_policies (id, name, description, max_size_bytes, allowed_types, retention_days, require_versioning, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.max_size_bytes ?? null, p.allowed_types ?? null, p.retention_days ?? null, p.require_versioning, p.enabled);
  }

  async getArtifactPolicy(id: string): Promise<ArtifactPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM artifact_policies WHERE id = ?').get(id) as ArtifactPolicyRow) ?? null;
  }

  async listArtifactPolicies(): Promise<ArtifactPolicyRow[]> {
    return this.d.prepare('SELECT * FROM artifact_policies ORDER BY name ASC').all() as ArtifactPolicyRow[];
  }

  async updateArtifactPolicy(id: string, fields: Partial<Omit<ArtifactPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE artifact_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteArtifactPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM artifact_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Reliability Policies ─────────────────────────────

  async createReliabilityPolicy(p: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO reliability_policies (id, name, description, policy_type, max_retries, initial_delay_ms, max_delay_ms, backoff_multiplier, max_concurrent, queue_size, strategy, ttl_ms, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.policy_type, p.max_retries ?? null, p.initial_delay_ms ?? null, p.max_delay_ms ?? null, p.backoff_multiplier ?? null, p.max_concurrent ?? null, p.queue_size ?? null, p.strategy ?? null, p.ttl_ms ?? null, p.enabled);
  }

  async getReliabilityPolicy(id: string): Promise<ReliabilityPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM reliability_policies WHERE id = ?').get(id) as ReliabilityPolicyRow) ?? null;
  }

  async listReliabilityPolicies(): Promise<ReliabilityPolicyRow[]> {
    return this.d.prepare('SELECT * FROM reliability_policies ORDER BY name ASC').all() as ReliabilityPolicyRow[];
  }

  async updateReliabilityPolicy(id: string, fields: Partial<Omit<ReliabilityPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE reliability_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteReliabilityPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM reliability_policies WHERE id = ?').run(id);
  }

  // ── Collaboration Sessions ─────────────────────────────────

  async createCollaborationSession(s: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO collaboration_sessions (id, name, description, session_type, max_participants, presence_ttl_ms, auto_close_idle_ms, handoff_enabled, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.name, s.description ?? null, s.session_type, s.max_participants, s.presence_ttl_ms, s.auto_close_idle_ms ?? null, s.handoff_enabled, s.enabled);
  }

  async getCollaborationSession(id: string): Promise<CollaborationSessionRow | null> {
    return (this.d.prepare('SELECT * FROM collaboration_sessions WHERE id = ?').get(id) as CollaborationSessionRow) ?? null;
  }

  async listCollaborationSessions(): Promise<CollaborationSessionRow[]> {
    return this.d.prepare('SELECT * FROM collaboration_sessions ORDER BY name ASC').all() as CollaborationSessionRow[];
  }

  async updateCollaborationSession(id: string, fields: Partial<Omit<CollaborationSessionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE collaboration_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCollaborationSession(id: string): Promise<void> {
    this.d.prepare('DELETE FROM collaboration_sessions WHERE id = ?').run(id);
  }

  // ── Compliance Rules ───────────────────────────────────────

  async createComplianceRule(r: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO compliance_rules (id, name, description, rule_type, target_resource, retention_days, region, consent_purpose, action, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.rule_type, r.target_resource, r.retention_days ?? null, r.region ?? null, r.consent_purpose ?? null, r.action, r.config ?? null, r.enabled);
  }

  async getComplianceRule(id: string): Promise<ComplianceRuleRow | null> {
    return (this.d.prepare('SELECT * FROM compliance_rules WHERE id = ?').get(id) as ComplianceRuleRow) ?? null;
  }

  async listComplianceRules(): Promise<ComplianceRuleRow[]> {
    return this.d.prepare('SELECT * FROM compliance_rules ORDER BY name ASC').all() as ComplianceRuleRow[];
  }

  async updateComplianceRule(id: string, fields: Partial<Omit<ComplianceRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE compliance_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteComplianceRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM compliance_rules WHERE id = ?').run(id);
  }

  // ── Graph Configs ──────────────────────────────────────────

  async createGraphConfig(g: Omit<GraphConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO graph_configs (id, name, description, graph_type, max_depth, entity_types, relationship_types, auto_link, scoring_weights, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.name, g.description ?? null, g.graph_type, g.max_depth, g.entity_types ?? null, g.relationship_types ?? null, g.auto_link, g.scoring_weights ?? null, g.enabled);
  }

  async getGraphConfig(id: string): Promise<GraphConfigRow | null> {
    return (this.d.prepare('SELECT * FROM graph_configs WHERE id = ?').get(id) as GraphConfigRow) ?? null;
  }

  async listGraphConfigs(): Promise<GraphConfigRow[]> {
    return this.d.prepare('SELECT * FROM graph_configs ORDER BY name ASC').all() as GraphConfigRow[];
  }

  async updateGraphConfig(id: string, fields: Partial<Omit<GraphConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE graph_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteGraphConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM graph_configs WHERE id = ?').run(id);
  }

  // ── Plugin Configs ─────────────────────────────────────────

  async createPluginConfig(p: Omit<PluginConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO plugin_configs (id, name, description, plugin_type, package_name, version, capabilities, trust_level, auto_update, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.plugin_type, p.package_name, p.version, p.capabilities ?? null, p.trust_level, p.auto_update, p.config ?? null, p.enabled);
  }

  async getPluginConfig(id: string): Promise<PluginConfigRow | null> {
    return (this.d.prepare('SELECT * FROM plugin_configs WHERE id = ?').get(id) as PluginConfigRow) ?? null;
  }

  async listPluginConfigs(): Promise<PluginConfigRow[]> {
    return this.d.prepare('SELECT * FROM plugin_configs ORDER BY name ASC').all() as PluginConfigRow[];
  }

  async updatePluginConfig(id: string, fields: Partial<Omit<PluginConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE plugin_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePluginConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM plugin_configs WHERE id = ?').run(id);
  }

  // ─── Phase 9: Scaffold Templates ────────────────────────────

  async createScaffoldTemplate(t: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO scaffold_templates (id, name, description, template_type, files, dependencies, dev_dependencies, variables, post_install, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.name, t.description ?? null, t.template_type, t.files ?? null, t.dependencies ?? null, t.dev_dependencies ?? null, t.variables ?? null, t.post_install ?? null, t.enabled);
  }

  async getScaffoldTemplate(id: string): Promise<ScaffoldTemplateRow | null> {
    return (this.d.prepare('SELECT * FROM scaffold_templates WHERE id = ?').get(id) as ScaffoldTemplateRow) ?? null;
  }

  async listScaffoldTemplates(): Promise<ScaffoldTemplateRow[]> {
    return this.d.prepare('SELECT * FROM scaffold_templates ORDER BY name ASC').all() as ScaffoldTemplateRow[];
  }

  async updateScaffoldTemplate(id: string, fields: Partial<Omit<ScaffoldTemplateRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE scaffold_templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteScaffoldTemplate(id: string): Promise<void> {
    this.d.prepare('DELETE FROM scaffold_templates WHERE id = ?').run(id);
  }

  // ─── Phase 9: Recipe Configs ─────────────────────────────────

  async createRecipeConfig(r: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO recipe_configs (id, name, description, recipe_type, model, provider, system_prompt, tools, guardrails, max_steps, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.recipe_type, r.model ?? null, r.provider ?? null, r.system_prompt ?? null, r.tools ?? null, r.guardrails ?? null, r.max_steps ?? null, r.options ?? null, r.enabled);
  }

  async getRecipeConfig(id: string): Promise<RecipeConfigRow | null> {
    return (this.d.prepare('SELECT * FROM recipe_configs WHERE id = ?').get(id) as RecipeConfigRow) ?? null;
  }

  async listRecipeConfigs(): Promise<RecipeConfigRow[]> {
    return this.d.prepare('SELECT * FROM recipe_configs ORDER BY name ASC').all() as RecipeConfigRow[];
  }

  async updateRecipeConfig(id: string, fields: Partial<Omit<RecipeConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE recipe_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteRecipeConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM recipe_configs WHERE id = ?').run(id);
  }

  // ─── Phase 9: Widget Configs ─────────────────────────────────

  async createWidgetConfig(w: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO widget_configs (id, name, description, widget_type, default_options, allowed_contexts, max_data_points, refresh_interval_ms, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.id, w.name, w.description ?? null, w.widget_type, w.default_options ?? null, w.allowed_contexts ?? null, w.max_data_points ?? null, w.refresh_interval_ms ?? null, w.enabled);
  }

  async getWidgetConfig(id: string): Promise<WidgetConfigRow | null> {
    return (this.d.prepare('SELECT * FROM widget_configs WHERE id = ?').get(id) as WidgetConfigRow) ?? null;
  }

  async listWidgetConfigs(): Promise<WidgetConfigRow[]> {
    return this.d.prepare('SELECT * FROM widget_configs ORDER BY name ASC').all() as WidgetConfigRow[];
  }

  async updateWidgetConfig(id: string, fields: Partial<Omit<WidgetConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE widget_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteWidgetConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM widget_configs WHERE id = ?').run(id);
  }

  // ─── Phase 9: Validation Rules ───────────────────────────────

  async createValidationRule(r: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO validation_rules (id, name, description, rule_type, target, condition, severity, message, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.rule_type, r.target, r.condition ?? null, r.severity, r.message ?? null, r.enabled);
  }

  async getValidationRule(id: string): Promise<ValidationRuleRow | null> {
    return (this.d.prepare('SELECT * FROM validation_rules WHERE id = ?').get(id) as ValidationRuleRow) ?? null;
  }

  async listValidationRules(): Promise<ValidationRuleRow[]> {
    return this.d.prepare('SELECT * FROM validation_rules ORDER BY name ASC').all() as ValidationRuleRow[];
  }

  async updateValidationRule(id: string, fields: Partial<Omit<ValidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE validation_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteValidationRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM validation_rules WHERE id = ?').run(id);
  }

  // ─── Semantic Memory ───────────────────────────────────────

  async saveSemanticMemory(m: {
    id: string;
    userId: string;
    chatId?: string;
    tenantId?: string;
    content: string;
    memoryType?: string;
    source?: string;
    embedding?: number[];
    metadata?: string;
  }): Promise<void> {
    const embeddingJson = m.embedding && m.embedding.length > 0
      ? JSON.stringify(m.embedding)
      : null;
    // Upsert so the @weaveintel/memory correction/supersede round-trip can
    // rewrite an existing entry (same id) in place while preserving lineage.
    this.d.prepare(
      `INSERT INTO semantic_memory (id, user_id, chat_id, tenant_id, content, memory_type, source, embedding, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content    = excluded.content,
         memory_type = excluded.memory_type,
         source     = excluded.source,
         embedding  = excluded.embedding,
         metadata   = excluded.metadata,
         updated_at = datetime('now')`,
    ).run(
      m.id, m.userId, m.chatId ?? null, m.tenantId ?? null,
      m.content, m.memoryType ?? 'semantic', m.source ?? 'assistant',
      embeddingJson, m.metadata ?? null,
    );
  }

  async getSemanticMemoryById(id: string, userId: string): Promise<SemanticMemoryRow | null> {
    return (this.d.prepare(
      'SELECT * FROM semantic_memory WHERE id = ? AND user_id = ?',
    ).get(id, userId) as SemanticMemoryRow | undefined) ?? null;
  }

  async searchSemanticMemory(opts: {
    userId: string;
    query: string;
    limit?: number;
    queryEmbedding?: number[];
  }): Promise<SemanticMemoryRow[]> {
    const limit = opts.limit ?? 5;

    // ── Vector search: when a query embedding is supplied and the user has
    // stored embeddings, rank by cosine similarity instead of keyword score.
    if (opts.queryEmbedding && opts.queryEmbedding.length > 0) {
      const rows = this.d.prepare(
        'SELECT * FROM semantic_memory WHERE user_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 200',
      ).all(opts.userId) as SemanticMemoryRow[];

      if (rows.length > 0) {
        const qVec = opts.queryEmbedding;
        const scored = rows.map((row) => {
          let sim = 0;
          try {
            const vec = JSON.parse(row.embedding!) as number[];
            sim = cosineSimilarity(qVec, vec);
          } catch { /* skip malformed */ }
          return { row, sim };
        });
        scored.sort((a, b) => b.sim - a.sim);
        // Relevance gate: drop noise so unrelated facts don't surface for an
        // off-topic query. Without this, top-K returns even when nothing matches.
        // Absolute floor + relative cutoff against the best score; tunable via env.
        const absFloor = (() => {
          const raw = Number.parseFloat(process.env['SEMANTIC_MEMORY_MIN_SIM'] ?? '');
          return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.20;
        })();
        const relFloor = (() => {
          const raw = Number.parseFloat(process.env['SEMANTIC_MEMORY_REL_FLOOR'] ?? '');
          return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.60;
        })();
        const topSim = scored[0]?.sim ?? 0;
        const cutoff = Math.max(absFloor, topSim * relFloor);
        const filtered = scored.filter((s) => s.sim >= cutoff);
        return filtered.slice(0, limit).map((s) => s.row);
      }
    }

    // ── Keyword fallback ───────────────────────────────────────────────────
    const words = opts.query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) {
      return this.d.prepare(
        'SELECT * FROM semantic_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      ).all(opts.userId, limit) as SemanticMemoryRow[];
    }
    const scoreParts = words.map(() => `CASE WHEN LOWER(content) LIKE ? THEN 1 ELSE 0 END`).join(' + ');
    const likeParams = words.map(w => `%${w}%`);
    const sql = `
      SELECT *, (${scoreParts}) AS _score
      FROM semantic_memory
      WHERE user_id = ? AND (${words.map(() => 'LOWER(content) LIKE ?').join(' OR ')})
      ORDER BY _score DESC, created_at DESC
      LIMIT ?
    `;
    return this.d.prepare(sql).all(
      ...likeParams, opts.userId, ...likeParams, limit,
    ) as SemanticMemoryRow[];
  }

  async listSemanticMemory(userId: string, limit = 20): Promise<SemanticMemoryRow[]> {
    return this.d.prepare(
      'SELECT * FROM semantic_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as SemanticMemoryRow[];
  }

  async deleteSemanticMemory(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM semantic_memory WHERE id = ? AND user_id = ?').run(id, userId);
  }

  async clearUserSemanticMemory(userId: string): Promise<void> {
    this.d.prepare('DELETE FROM semantic_memory WHERE user_id = ?').run(userId);
  }

  async trimSemanticMemoryForUser(userId: string, maxEntries: number): Promise<void> {
    const count = (this.d.prepare(
      'SELECT COUNT(*) AS n FROM semantic_memory WHERE user_id = ?',
    ).get(userId) as { n: number }).n;
    if (count <= maxEntries) return;
    const excess = count - maxEntries;
    this.d.prepare(
      `DELETE FROM semantic_memory WHERE id IN (
         SELECT id FROM semantic_memory WHERE user_id = ? ORDER BY created_at ASC LIMIT ?
       )`,
    ).run(userId, excess);
  }

  async purgeSemanticMemoryOlderThan(userId: string, cutoffMs: number): Promise<void> {
    const cutoffSec = Math.floor(cutoffMs / 1000);
    this.d.prepare(
      `DELETE FROM semantic_memory WHERE user_id = ? AND strftime('%s', created_at) < ?`,
    ).run(userId, cutoffSec.toString());
  }

  async listAllSemanticMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<SemanticMemoryRow[]> {
    if (opts.userId) {
      return this.d.prepare(
        'SELECT * FROM semantic_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      ).all(opts.userId, opts.limit ?? 50, opts.offset ?? 0) as SemanticMemoryRow[];
    }
    return this.d.prepare(
      'SELECT * FROM semantic_memory ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(opts.limit ?? 50, opts.offset ?? 0) as SemanticMemoryRow[];
  }

  // ─── Entity Memory ─────────────────────────────────────────

  async upsertEntity(e: {
    userId: string;
    entityName: string;
    entityType?: string;
    facts: Record<string, unknown>;
    confidence?: number;
    source?: string;
    chatId?: string;
    tenantId?: string;
  }): Promise<void> {
    // Merge facts: read existing JSON and merge with new facts
    const existing = this.d.prepare(
      'SELECT facts, confidence, source FROM entity_memory WHERE user_id = ? AND entity_name = ?',
    ).get(e.userId, e.entityName) as { facts: string; confidence: number; source: string } | undefined;
    const merged = existing ? { ...JSON.parse(existing.facts), ...e.facts } : e.facts;
    const incomingConfidence = Math.max(0, Math.min(1, e.confidence ?? 0.6));
    const existingConfidence = existing?.confidence ?? 0;
    const chosenConfidence = Math.max(existingConfidence, incomingConfidence);
    const chosenSource = incomingConfidence >= existingConfidence ? (e.source ?? 'regex') : (existing?.source ?? 'regex');
    this.d.prepare(
      `INSERT INTO entity_memory (id, user_id, chat_id, tenant_id, entity_name, entity_type, facts, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, entity_name) DO UPDATE SET
         entity_type = excluded.entity_type,
         facts = ?,
         confidence = ?,
         source = ?,
         chat_id = COALESCE(excluded.chat_id, chat_id),
         updated_at = datetime('now')`,
    ).run(
      newUUIDv7(), e.userId, e.chatId ?? null, e.tenantId ?? null,
      e.entityName, e.entityType ?? 'general', JSON.stringify(merged), chosenConfidence, chosenSource,
      JSON.stringify(merged),
      chosenConfidence,
      chosenSource,
    );
  }

  async getEntity(userId: string, entityName: string): Promise<EntityMemoryRow | null> {
    return (this.d.prepare(
      'SELECT * FROM entity_memory WHERE user_id = ? AND entity_name = ? COLLATE NOCASE',
    ).get(userId, entityName) as EntityMemoryRow | undefined) ?? null;
  }

  async searchEntities(userId: string, query: string): Promise<EntityMemoryRow[]> {
    const q = `%${query}%`;
    return this.d.prepare(
      `SELECT * FROM entity_memory WHERE user_id = ?
       AND (LOWER(entity_name) LIKE LOWER(?) OR LOWER(facts) LIKE LOWER(?))
       ORDER BY updated_at DESC LIMIT 10`,
    ).all(userId, q, q) as EntityMemoryRow[];
  }

  async listEntities(userId: string): Promise<EntityMemoryRow[]> {
    return this.d.prepare(
      'SELECT * FROM entity_memory WHERE user_id = ? ORDER BY entity_type ASC, entity_name ASC',
    ).all(userId) as EntityMemoryRow[];
  }

  async deleteEntity(userId: string, entityName: string): Promise<number> {
    const res = this.d.prepare('DELETE FROM entity_memory WHERE user_id = ? AND entity_name = ?').run(userId, entityName);
    return res.changes ?? 0;
  }

  async clearUserEntityMemory(userId: string): Promise<void> {
    this.d.prepare('DELETE FROM entity_memory WHERE user_id = ?').run(userId);
  }

  async trimEntityMemoryForUser(userId: string, maxEntries: number): Promise<void> {
    const count = (this.d.prepare(
      'SELECT COUNT(*) AS n FROM entity_memory WHERE user_id = ?',
    ).get(userId) as { n: number }).n;
    if (count <= maxEntries) return;
    const excess = count - maxEntries;
    this.d.prepare(
      `DELETE FROM entity_memory WHERE id IN (
         SELECT id FROM entity_memory WHERE user_id = ? ORDER BY updated_at ASC LIMIT ?
       )`,
    ).run(userId, excess);
  }

  async listAllEntityMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<EntityMemoryRow[]> {
    if (opts.userId) {
      return this.d.prepare(
        'SELECT * FROM entity_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      ).all(opts.userId, opts.limit ?? 50, opts.offset ?? 0) as EntityMemoryRow[];
    }
    return this.d.prepare(
      'SELECT * FROM entity_memory ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    ).all(opts.limit ?? 50, opts.offset ?? 0) as EntityMemoryRow[];
  }

  async recordMemoryExtractionEvent(e: {
    id: string;
    userId: string;
    chatId?: string;
    tenantId?: string;
    selfDisclosure: boolean;
    regexEntitiesCount: number;
    llmEntitiesCount: number;
    mergedEntitiesCount: number;
    events?: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO memory_extraction_events
       (id, user_id, chat_id, tenant_id, self_disclosure, regex_entities_count, llm_entities_count, merged_entities_count, events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id,
      e.userId,
      e.chatId ?? null,
      e.tenantId ?? null,
      e.selfDisclosure ? 1 : 0,
      e.regexEntitiesCount,
      e.llmEntitiesCount,
      e.mergedEntitiesCount,
      e.events ?? null,
    );
  }

  async getMemoryExtractionEvent(id: string): Promise<MemoryExtractionEventRow | null> {
    return (this.d.prepare('SELECT * FROM memory_extraction_events WHERE id = ?').get(id) as MemoryExtractionEventRow | undefined) ?? null;
  }

  async listMemoryExtractionEvents(chatId?: string, limit = 100): Promise<MemoryExtractionEventRow[]> {
    if (chatId) {
      return this.d.prepare('SELECT * FROM memory_extraction_events WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, limit) as MemoryExtractionEventRow[];
    }
    return this.d.prepare('SELECT * FROM memory_extraction_events ORDER BY created_at DESC LIMIT ?').all(limit) as MemoryExtractionEventRow[];
  }

  async listAllMemoryExtractionEvents(opts: { userId?: string; limit?: number; offset?: number }): Promise<MemoryExtractionEventRow[]> {
    if (opts.userId) {
      return this.d.prepare(
        'SELECT * FROM memory_extraction_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      ).all(opts.userId, opts.limit ?? 50, opts.offset ?? 0) as MemoryExtractionEventRow[];
    }
    return this.d.prepare(
      'SELECT * FROM memory_extraction_events ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(opts.limit ?? 50, opts.offset ?? 0) as MemoryExtractionEventRow[];
  }

  // ─── Episodic Memory ────────────────────────────────────────

  async saveEpisodicMemory(e: { id: string; userId: string; chatId?: string; tenantId?: string; messageRole?: string; content: string; importance?: number; tags?: string[] }): Promise<void> {
    this.d.prepare(
      `INSERT INTO episodic_memory (id, user_id, chat_id, tenant_id, message_role, content, importance, tags, consolidated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      e.id, e.userId, e.chatId ?? null, e.tenantId ?? null,
      e.messageRole ?? 'user', e.content,
      e.importance ?? 0.5,
      e.tags && e.tags.length > 0 ? JSON.stringify(e.tags) : null,
    );
  }

  async listEpisodicMemory(userId: string, limit = 50): Promise<EpisodicMemoryRow[]> {
    return this.d.prepare(
      'SELECT * FROM episodic_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as EpisodicMemoryRow[];
  }

  async listUnconsolidatedEpisodic(userId: string, limit = 100): Promise<EpisodicMemoryRow[]> {
    return this.d.prepare(
      'SELECT * FROM episodic_memory WHERE user_id = ? AND consolidated = 0 ORDER BY created_at ASC LIMIT ?',
    ).all(userId, limit) as EpisodicMemoryRow[];
  }

  async markEpisodicConsolidated(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.d.prepare(`UPDATE episodic_memory SET consolidated = 1 WHERE id IN (${placeholders})`).run(...ids);
  }

  async deleteEpisodicMemory(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM episodic_memory WHERE id = ? AND user_id = ?').run(id, userId);
  }

  async clearUserEpisodicMemory(userId: string): Promise<void> {
    this.d.prepare('DELETE FROM episodic_memory WHERE user_id = ?').run(userId);
  }

  async trimEpisodicMemoryForUser(userId: string, maxEntries: number): Promise<void> {
    const count = (this.d.prepare('SELECT COUNT(*) AS n FROM episodic_memory WHERE user_id = ?').get(userId) as { n: number }).n;
    if (count <= maxEntries) return;
    const excess = count - maxEntries;
    const oldest = this.d.prepare(
      'SELECT id FROM episodic_memory WHERE user_id = ? ORDER BY created_at ASC LIMIT ?',
    ).all(userId, excess) as { id: string }[];
    const stmt = this.d.prepare('DELETE FROM episodic_memory WHERE id = ?');
    for (const row of oldest) stmt.run(row.id);
  }

  async listAllEpisodicMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<EpisodicMemoryRow[]> {
    if (opts.userId) {
      return this.d.prepare(
        'SELECT * FROM episodic_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      ).all(opts.userId, opts.limit ?? 50, opts.offset ?? 0) as EpisodicMemoryRow[];
    }
    return this.d.prepare(
      'SELECT * FROM episodic_memory ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(opts.limit ?? 50, opts.offset ?? 0) as EpisodicMemoryRow[];
  }

  // ─── Procedural Memory ──────────────────────────────────────

  async createProceduralMemory(p: Omit<ProceduralMemoryRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO procedural_memory
         (id, user_id, agent_id, instruction_delta, proposed_by, status, confidence, human_task_id, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.user_id, p.agent_id, p.instruction_delta, p.proposed_by, p.status, p.confidence, p.human_task_id ?? null, p.applied_at ?? null);
  }

  async getProceduralMemory(id: string): Promise<ProceduralMemoryRow | null> {
    return this.d.prepare('SELECT * FROM procedural_memory WHERE id = ?').get(id) as ProceduralMemoryRow | null;
  }

  async listProceduralMemory(userId: string, status?: string): Promise<ProceduralMemoryRow[]> {
    if (status) {
      return this.d.prepare(
        'SELECT * FROM procedural_memory WHERE user_id = ? AND status = ? ORDER BY created_at DESC',
      ).all(userId, status) as ProceduralMemoryRow[];
    }
    return this.d.prepare(
      'SELECT * FROM procedural_memory WHERE user_id = ? ORDER BY created_at DESC',
    ).all(userId) as ProceduralMemoryRow[];
  }

  async listAllProceduralMemory(opts: { userId?: string; status?: string; limit?: number; offset?: number }): Promise<ProceduralMemoryRow[]> {
    const parts: string[] = [];
    const vals: unknown[] = [];
    if (opts.userId) { parts.push('user_id = ?'); vals.push(opts.userId); }
    if (opts.status) { parts.push('status = ?'); vals.push(opts.status); }
    const where = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
    vals.push(opts.limit ?? 50, opts.offset ?? 0);
    return this.d.prepare(
      `SELECT * FROM procedural_memory ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...vals) as ProceduralMemoryRow[];
  }

  async updateProceduralMemoryStatus(id: string, status: string, appliedAt?: string): Promise<void> {
    if (appliedAt) {
      this.d.prepare(
        "UPDATE procedural_memory SET status = ?, applied_at = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(status, appliedAt, id);
    } else {
      this.d.prepare(
        "UPDATE procedural_memory SET status = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(status, id);
    }
  }

  async deleteProceduralMemory(id: string): Promise<void> {
    this.d.prepare('DELETE FROM procedural_memory WHERE id = ?').run(id);
  }

  async listAppliedProcedural(userId: string, agentId?: string): Promise<ProceduralMemoryRow[]> {
    if (agentId) {
      return this.d.prepare(
        "SELECT * FROM procedural_memory WHERE user_id = ? AND agent_id = ? AND status = 'applied' ORDER BY applied_at DESC",
      ).all(userId, agentId) as ProceduralMemoryRow[];
    }
    return this.d.prepare(
      "SELECT * FROM procedural_memory WHERE user_id = ? AND status = 'applied' ORDER BY applied_at DESC",
    ).all(userId) as ProceduralMemoryRow[];
  }

  // ─── Working Memory Snapshots ────────────────────────────────

  async saveWorkingMemorySnapshot(s: { id: string; userId: string; chatId?: string; agentId?: string; content: Record<string, unknown> }): Promise<void> {
    this.d.prepare(
      `INSERT INTO working_memory_snapshots (id, user_id, chat_id, agent_id, content)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(s.id, s.userId, s.chatId ?? null, s.agentId ?? 'default', JSON.stringify(s.content));
  }

  async getLatestWorkingMemory(userId: string, agentId?: string): Promise<WorkingMemorySnapshotRow | null> {
    if (agentId) {
      return this.d.prepare(
        'SELECT * FROM working_memory_snapshots WHERE user_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1',
      ).get(userId, agentId) as WorkingMemorySnapshotRow | null;
    }
    return this.d.prepare(
      'SELECT * FROM working_memory_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(userId) as WorkingMemorySnapshotRow | null;
  }

  async listWorkingMemorySnapshots(userId: string, limit = 20): Promise<WorkingMemorySnapshotRow[]> {
    return this.d.prepare(
      'SELECT * FROM working_memory_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as WorkingMemorySnapshotRow[];
  }

  async listAllWorkingMemorySnapshots(opts: { userId?: string; limit?: number; offset?: number }): Promise<WorkingMemorySnapshotRow[]> {
    if (opts.userId) {
      return this.d.prepare(
        'SELECT * FROM working_memory_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      ).all(opts.userId, opts.limit ?? 50, opts.offset ?? 0) as WorkingMemorySnapshotRow[];
    }
    return this.d.prepare(
      'SELECT * FROM working_memory_snapshots ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(opts.limit ?? 50, opts.offset ?? 0) as WorkingMemorySnapshotRow[];
  }

  async deleteWorkingMemorySnapshot(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM working_memory_snapshots WHERE id = ? AND user_id = ?').run(id, userId);
  }

  async clearUserWorkingMemory(userId: string): Promise<void> {
    this.d.prepare('DELETE FROM working_memory_snapshots WHERE user_id = ?').run(userId);
  }

  // ─── Memory Settings ────────────────────────────────────────

  async getMemorySettings(tenantId?: string): Promise<MemorySettingsRow | null> {
    // Try tenant-specific first; fall back to global (tenant_id IS NULL)
    if (tenantId) {
      const row = this.d.prepare(
        'SELECT * FROM memory_settings WHERE tenant_id = ?',
      ).get(tenantId) as MemorySettingsRow | null;
      if (row) return row;
    }
    return this.d.prepare(
      'SELECT * FROM memory_settings WHERE tenant_id IS NULL LIMIT 1',
    ).get() as MemorySettingsRow | null;
  }

  async upsertMemorySettings(s: Omit<MemorySettingsRow, 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO memory_settings
         (id, tenant_id, enable_semantic, enable_entity, enable_episodic,
          enable_procedural, enable_working, auto_extract_on_turn,
          consolidation_enabled, consolidation_interval_min,
          max_episodic_per_user, max_semantic_per_user, max_entity_per_user,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         enable_semantic = excluded.enable_semantic,
         enable_entity = excluded.enable_entity,
         enable_episodic = excluded.enable_episodic,
         enable_procedural = excluded.enable_procedural,
         enable_working = excluded.enable_working,
         auto_extract_on_turn = excluded.auto_extract_on_turn,
         consolidation_enabled = excluded.consolidation_enabled,
         consolidation_interval_min = excluded.consolidation_interval_min,
         max_episodic_per_user = excluded.max_episodic_per_user,
         max_semantic_per_user = excluded.max_semantic_per_user,
         max_entity_per_user = excluded.max_entity_per_user,
         updated_at = datetime('now')`,
    ).run(
      s.id, s.tenant_id ?? null,
      s.enable_semantic ? 1 : 0, s.enable_entity ? 1 : 0, s.enable_episodic ? 1 : 0,
      s.enable_procedural ? 1 : 0, s.enable_working ? 1 : 0, s.auto_extract_on_turn ? 1 : 0,
      s.consolidation_enabled ? 1 : 0, s.consolidation_interval_min,
      s.max_episodic_per_user, s.max_semantic_per_user, s.max_entity_per_user,
    );
  }

  async listMemorySettings(): Promise<MemorySettingsRow[]> {
    return this.d.prepare('SELECT * FROM memory_settings ORDER BY tenant_id ASC NULLS FIRST').all() as MemorySettingsRow[];
  }

  // ─── Website Credentials (Browser Auth Vault) ──────────────

  async createWebsiteCredential(c: Omit<WebsiteCredentialRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO website_credentials (id, user_id, site_name, site_url_pattern, auth_method, credentials_encrypted, encryption_iv, last_used_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.user_id, c.site_name, c.site_url_pattern, c.auth_method, c.credentials_encrypted, c.encryption_iv, c.last_used_at ?? null, c.status);
  }

  async getWebsiteCredential(id: string, userId: string): Promise<WebsiteCredentialRow | null> {
    return (this.d.prepare('SELECT * FROM website_credentials WHERE id = ? AND user_id = ?').get(id, userId) as WebsiteCredentialRow | undefined) ?? null;
  }

  async listWebsiteCredentials(userId: string): Promise<WebsiteCredentialRow[]> {
    return this.d.prepare('SELECT * FROM website_credentials WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as WebsiteCredentialRow[];
  }

  async listAllActiveWebsiteCredentials(): Promise<WebsiteCredentialRow[]> {
    return this.d.prepare("SELECT * FROM website_credentials WHERE status = 'active' ORDER BY updated_at DESC").all() as WebsiteCredentialRow[];
  }

  async findWebsiteCredential(userId: string, url: string): Promise<WebsiteCredentialRow | null> {
    // Find credentials where the URL matches the site_url_pattern using glob-style matching
    const rows = this.d.prepare(
      `SELECT * FROM website_credentials WHERE user_id = ? AND status = 'active' ORDER BY last_used_at DESC`,
    ).all(userId) as WebsiteCredentialRow[];
    for (const row of rows) {
      const pattern = row.site_url_pattern;
      // Convert simple glob to regex: *.example.com/* → .*\.example\.com\/.*
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`, 'i').test(url)) return row;
    }
    return null;
  }

  async updateWebsiteCredential(id: string, userId: string, fields: Partial<Omit<WebsiteCredentialRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id, userId);
    this.d.prepare(`UPDATE website_credentials SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  }

  async deleteWebsiteCredential(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM website_credentials WHERE id = ? AND user_id = ?').run(id, userId);
  }

  // ─── SSO Linked Accounts (for SSO pass-through) ─────────────

  async createSSOLinkedAccount(acct: { id: string; user_id: string; identity_provider: string; email?: string; session_encrypted: string; encryption_iv: string }): Promise<void> {
    this.d.prepare(`
      INSERT OR REPLACE INTO sso_linked_accounts (id, user_id, identity_provider, email, session_encrypted, encryption_iv)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(acct.id, acct.user_id, acct.identity_provider, acct.email ?? null, acct.session_encrypted, acct.encryption_iv);
  }

  async getSSOLinkedAccount(userId: string, identityProvider: string): Promise<import('./db-types.js').SSOLinkedAccountRow | null> {
    return (this.d.prepare(`
      SELECT * FROM sso_linked_accounts
      WHERE user_id = ? AND identity_provider = ? AND status = 'active'
    `).get(userId, identityProvider) as import('./db-types.js').SSOLinkedAccountRow | undefined) ?? null;
  }

  async listSSOLinkedAccounts(userId: string): Promise<Array<Omit<import('./db-types.js').SSOLinkedAccountRow, 'session_encrypted' | 'encryption_iv'>>> {
    return this.d.prepare(`
      SELECT id, user_id, identity_provider, email, status, linked_at, updated_at
      FROM sso_linked_accounts
      WHERE user_id = ? AND status = 'active'
      ORDER BY linked_at DESC
    `).all(userId) as Array<any>;
  }

  async deleteSSOLinkedAccount(userId: string, identityProvider: string): Promise<void> {
    this.d.prepare(`
      DELETE FROM sso_linked_accounts
      WHERE user_id = ? AND identity_provider = ?
    `).run(userId, identityProvider);
  }

  // ─── Seed default data ─────────────────────────────────────

  async seedDefaultData(): Promise<void> {
    const cnt = (tbl: string) => (this.d.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get() as { cnt: number }).cnt;

    // Prompts
    const prompts: Omit<PromptRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'e92e7672-3009-4040-8b05-a411dc825f90', name: 'General Assistant', description: 'Default conversational assistant prompt',
        key: 'assistant.general', category: 'general', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['assistant', 'general']), template: 'You are a helpful, accurate, and concise AI assistant. Answer the user\'s questions clearly and provide relevant details when asked.',
        variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'standard' }), framework: null, metadata: null, is_default: 1, enabled: 1,
      },
      {
        id: 'e7c21e36-c558-40e0-9b99-2433c0466bc3', name: 'Code Review Expert', description: 'Technical code review prompt with best practices',
        key: 'engineering.code-review', category: 'engineering', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['engineering', 'review']), template: 'You are an expert code reviewer. Analyze code for bugs, security issues, performance problems, and style. Provide actionable suggestions with explanations. Focus on: {{focus_areas}}',
        variables: stringifyPromptVariables([{ name: 'focus_areas', type: 'string', required: true, description: 'Specific review focus areas such as security, performance, or style.' }]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', selfReview: true, explanationStyle: 'detailed' }), framework: null, metadata: null, is_default: 0, enabled: 1,
      },
      {
        id: '14b189df-1307-4041-ab1b-2a784df9d304', name: 'Document Summarizer', description: 'Summarize long documents into key points',
        key: 'content.summarizer', category: 'content', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['content', 'summary']), template: 'Summarize the following content into {{format}}. Preserve key facts, numbers, and conclusions. Be concise but thorough.\n\nContent:\n{{content}}',
        variables: stringifyPromptVariables([
          { name: 'format', type: 'string', required: true, description: 'Desired response shape, for example bullet list or executive summary.' },
          { name: 'content', type: 'string', required: true, description: 'Raw content to summarize.' },
        ]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'concise' }), framework: null, metadata: null, is_default: 0, enabled: 1,
      },
      {
        id: '906cdfa7-35f4-4d39-a0ea-d099207570dc', name: 'SQL Query Builder', description: 'Generate SQL queries from natural language',
        key: 'engineering.sql-builder', category: 'engineering', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['engineering', 'sql']), template: 'You are an expert SQL developer. Convert the following natural language request into a correct, optimized SQL query. Target database: {{db_type}}. Available tables: {{schema}}',
        variables: stringifyPromptVariables([
          { name: 'db_type', type: 'string', required: true, description: 'Target relational database type.' },
          { name: 'schema', type: 'string', required: true, description: 'Available schema or table summary provided to the model.' },
        ]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', selfReview: true, explanationStyle: 'standard' }), framework: null, metadata: null, is_default: 0, enabled: 1,
      },
      {
        id: 'f68c3785-469c-4d2b-a2c2-366c5bc3b4d2', name: 'Runtime: Supervisor Code Execution Policy', description: 'Runtime policy for supervisor code execution and delegated CSE workflows',
        key: 'runtime.supervisor.code-execution', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'supervisor']), template: [
          'You have direct access to `cse_run_code` — a tool that executes code in a real isolated Docker container.',
          'Execution strategy by task type:',
          '- Simple code-run requests (no attached dataset): call `cse_run_code` directly from supervisor.',
          '- Dataset/file analysis requests (attachments, CSV/JSON/XLSX, or "analyze this file"): delegate to `code_executor` first, then to `analyst` for result verification.',
          '- Data retrieval + code analysis requests (user asks to fetch data from a specialist AND run code/Python on it): use SEQUENTIAL multi-worker delegation — (1) delegate to the data specialist worker first to retrieve the data, (2) then delegate to `code_executor` with the retrieved data embedded in the task description so it can write and execute the analysis script. Do NOT synthesize the final response until code_executor returns actual stdout.',
          '',
          'Attachment handling policy:',
          '- Attached files are injected into container workspace and should be opened by filename.',
          '- For CSV analysis, prefer Python standard library (`csv`) first.',
          '- Do not assume `pandas` is installed unless you install it in the same run and verify installation succeeded.',
          '- If you need to install Python packages during execution, call `cse_run_code` with `networkAccess=true`.',
          '- In CSE, install packages with: `os.makedirs("/workspace/.deps", exist_ok=True); os.makedirs("/workspace/.tmp", exist_ok=True); subprocess.check_call([sys.executable, "-m", "pip", "install", "--target", "/workspace/.deps", "<package>"]); sys.path.insert(0, "/workspace/.deps")`.',
          '- For matplotlib/pyplot, always call `matplotlib.use("Agg")` before `import matplotlib.pyplot as plt` (headless environment, no display).',
          '- When saving chart images, create the output directory first: `os.makedirs("/workspace/output", exist_ok=True)` then save to `/workspace/output/<name>.png`.',
          '- Never use notebook-style `!pip install ...` inside Python scripts.',
          '',
          'Verification and retry policy (MANDATORY):',
          '- Verify tool outputs before final response.',
          '- If tool execution fails (import/file/path/runtime errors), send it back to code_executor with the exact stderr and a corrected plan.',
          '- Continue iterate->run->verify until success or clear environmental blocker is proven.',
          '- For successful analyses, final response must include computed metrics and concise insights grounded in execution stdout.',
          '',
          'Example: "write a Python script to add 15 numbers and run it"',
          '  → Write the script, then call: cse_run_code(code="...", language="python")',
          '  → Include the actual stdout in your final response.',
          '',
          'Supported languages: python, javascript, typescript, bash.',
        ].join('\n'),
        variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
      },
      {
        id: '4aecf467-a350-42f9-aeca-550fcc4383a2', name: 'Runtime: Response Card Format Policy', description: 'Runtime policy for chart/table/code response formatting',
        key: 'runtime.response-card-format', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'formatting']), template: [
          'RESPONSE PRESENTATION POLICY (for rich response cards):',
          '- Choose output format based on user intent and data shape.',
          '- If user asks for a chart, graph, visualization, trend, or numeric comparison, prefer structured JSON with chart fields.',
          '- If user asks for tabular output, dataset rows, or comparisons, prefer structured JSON with table fields.',
          '- If user asks for both, include both table and chart.',
          '- Never reference sandbox-only file paths such as /workspace/output/*.png or return img_path values that point to local container files.',
          '- If charts are requested, translate computed results into renderable chart labels/values in JSON instead of markdown images pointing to local files.',
          '- For code or scripts, return JSON object: {"code":"...","language":"python|javascript|typescript|sql|bash|json|xml|yaml"}.',
          '- For normal conversational answers, use concise markdown text and do not force JSON.',
          '',
          'Preferred structured schema when visualization or tabular output is requested:',
          '{',
          '  "summary": "short narrative",',
          '  "table": { "headers": ["col1","col2"], "rows": [["r1", 10], ["r2", 12]] },',
          '  "chart": { "type": "bar|line", "title": "optional", "labels": ["r1","r2"], "values": [10,12], "unit": "optional" }',
          '}',
          '- Keep values accurate and grounded in computed or tool-derived outputs.',
        ].join('\n'),
        variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'standard' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
      },
      {
        id: 'b3722c76-fc46-4392-ab8e-3f39b0fce3dc', name: 'Runtime: Supervisor Temporal Policy', description: 'Runtime policy for supervisor temporal and browser-login delegation',
        key: 'runtime.supervisor.temporal', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'temporal']), template: [
          'TEMPORAL QUESTION HANDLING (CRITICAL):',
          '- If the user asks about current day/date/time/timestamp or anything time-dependent:',
          '  • ALWAYS delegate to a worker that has datetime/timezone tools',
          '  • Do NOT answer from your training data or memory',
          '  • Always use `think` tool first to reason about what worker you need',
          '  • Always use `plan` tool to decompose the request',
          '  • After the worker responds, use `think` with reasoning_phase="reasoning" to verify the answer',
          '  • Then formulate your response based on the worker\'s actual tool outputs',
          '- Examples of temporal questions that MUST be delegated:',
          '  • "What day is today?" / "What date is it?" / "What is today\'s date?"',
          '  • "What time is it?" / "What is the current time?"',
          '  • "What timezone am I in?" / "What is the timezone?"',
          '  • Any question about current timestamp, current date, current time, or today',
          '',
          'TIMER AND STOPWATCH MANAGEMENT (CRITICAL):',
          '- When the user asks to START a timer or stopwatch (e.g. "start a timer", "start timing", "begin stopwatch"):',
          '  • Delegate to analyst with EXPLICIT goal: "Use the `stopwatch_start` tool to start a stopwatch labeled \'[context label]\'. Return the full JSON response including the stopwatch ID."',
          '  • Do NOT ask the analyst to just "capture the current timestamp" — it MUST call `stopwatch_start`',
          '  • After analyst returns, extract the stopwatch ID from the JSON',
          '  • Tell the user the timer has started AND include the stopwatch ID in your response (e.g. "Timer started (ID: watch-abc123). I\'ll track this until you return.")',
          '  • The stopwatch ID MUST appear in your reply so it is recorded in conversation history for later retrieval',
          '',
          '- When the user RETURNS after a timer was started (e.g. "I am back", "I\'m back", "stop the timer"):',
          '',
          'BROWSER LOGIN & AUTHENTICATION (CRITICAL):',
          '- When the user asks to log in, sign in, authenticate, or access a site that requires login:',
          '  • ALWAYS delegate to the researcher worker — it has browser_detect_auth, browser_login, browser_save_cookies, browser_handoff_request, and browser_handoff_resume tools',
          '  • The researcher can detect login forms, auto-fill credentials from the vault, and log in automatically',
          '  • If the site needs 2FA, CAPTCHA, or manual steps, the researcher will trigger a handoff to the user',
          '  • NEVER refuse login requests — the credential vault securely stores and encrypts website credentials',
          '  • Example goal for researcher: "Navigate to [url], detect the login form, then use browser_login to authenticate using stored credentials. If 2FA or CAPTCHA appears, use browser_handoff_request."',
          '',
          '  • Look in the conversation history for the stopwatch ID from when the timer was started',
          '  • Delegate to analyst with EXPLICIT goal: "Use `stopwatch_stop` with stopwatchId=\'[ID from history]\' to stop the stopwatch and report the total elapsed time in minutes and seconds."',
          '  • If no stopwatch ID is found in history, delegate to analyst: "Use `timer_list` and `stopwatch_status` to find any active timers or stopwatches. If found, stop them and report the elapsed time."',
          '  • Do NOT try to calculate elapsed time using raw timestamps or message metadata — always use the stopwatch tools.',
        ].join('\n'),
        variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
      },
      {
        id: '338ee839-adee-43cb-9dd4-34e53333b997', name: 'Runtime: Multi Worker Sequential Pipeline', description: 'Runtime policy for supervisor sequential multi-worker execution',
        key: 'runtime.multi-worker.pipeline', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'workflow']), template: [
          'MULTI-WORKER SEQUENTIAL PIPELINE:',
          'When the user\'s request spans multiple capabilities (e.g., "fetch NZ economic data AND run Python to find insights"), you MUST use sequential worker delegation:',
          '  Step 1 — Delegate to the data specialist worker (e.g., statsnz_specialist) to retrieve the raw data.',
          '  Step 2 — Once data is returned, delegate to code_executor with a task that embeds the retrieved data and asks it to write and execute Python (or other code) to produce insights.',
          '  Step 3 — Use the code_executor stdout in your final response. Never skip code execution when the user explicitly asked for it.',
          'Do not collapse multi-step pipelines into a single delegation or into a supervisor-only response.',
        ].join('\n'),
        variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
      },
      {
        id: '044e122c-67cf-4bb3-9ad3-090bd937b6c8', name: 'Runtime: Forced Worker Data Analysis Requirement', description: 'Runtime requirement appended when worker-based execution is mandatory',
        key: 'runtime.force-worker.analysis', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'analysis']), template: 'WORKFLOW REQUIREMENT: This request requires actual code execution. Delegate to code_executor to generate and run Python in container against attached files and/or retrieved tool data. If execution fails, retry with corrected code. After successful execution, delegate to analyst to verify computed outputs and produce at least 3 concrete insights.',
        variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
      },
      {
        id: '5f58d48f-931f-4b1f-a418-e9b43d545dc8', name: 'Runtime: Hard Execution Guard', description: 'Runtime hard guard for execution retries and renderable output requirements',
        key: 'runtime.execution.guard', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'guard']), template: [
          'HARD EXECUTION GUARD: The answer is invalid unless you explicitly call delegate_to_worker(worker="code_executor") and produce a successful cse_run_code execution. Do not execute code directly in supervisor for this workflow. Delegate to code_executor, run code successfully, verify output, then respond.',
          '',
          'HARD PRESENTATION GUARD: Do not reference sandbox filesystem paths like /workspace/output/*.png or return img_path values that point to container files. If charts are requested, return renderable structured JSON with chart labels/values and optional table data instead of local file paths. If a prior run produced blank or incomplete insights, fix the script and rerun until the computed insights are non-empty.',
        ].join('\n'),
        variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
      },
      {
        id: 'dc61ee37-5268-4e8b-af36-22d6124d99b6', name: 'Runtime: Enterprise ServiceNow Worker System Prompt', description: 'Template used for enterprise ServiceNow worker system prompts',
        key: 'runtime.enterprise.worker-system', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'worker', 'servicenow']), template: [
          'You are a specialized ServiceNow agent for: {{description}}',
          'Use the available tools to fulfill the user\'s request. Always use the most specific tool available rather than generic query/get when possible.',
        ].join('\n'),
        variables: stringifyPromptVariables([{ name: 'description', type: 'string', required: true, description: 'Worker capability description passed from the enterprise tool group.' }]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'standard' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
      },
    ];
    if (cnt('prompts') === 0) {
      for (const p of prompts) await this.createPrompt(p);
    } else {
      const existingIds = new Set((await this.listPrompts()).map((p) => p.id));
      for (const p of prompts) {
        if (!existingIds.has(p.id)) await this.createPrompt(p);
      }

    }

    // Prompt Frameworks — seed the 4 built-in named structures (Phase 2)
    const frameworks: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '21f6a792-9267-4444-bdbc-ff7c2d4298f9', key: 'rtce', name: 'RTCE (Role → Task → Context → Expectations)',
        description: 'Concise four-section framework: establish the model role, state the task, supply context, then define expectations. Best for focused, single-turn prompts.',
        sections: JSON.stringify([
          { key: 'role',         label: 'Role',         renderOrder: 0, required: true,  header: '## Role' },
          { key: 'task',         label: 'Task',         renderOrder: 1, required: true,  header: '## Task' },
          { key: 'context',      label: 'Context',      renderOrder: 2, required: false, header: '## Context' },
          { key: 'expectations', label: 'Expectations', renderOrder: 3, required: false, header: '## Expectations' },
        ]),
        section_separator: '\n\n', enabled: 1,
      },
      {
        id: '7b55952c-4f80-40ca-81ea-461bab97c672', key: 'full', name: 'Full (Role → Task → Context → Constraints → Examples → Output Contract)',
        description: 'Six-section framework for complex, high-stakes prompts. Adds constraints, few-shot examples, and a structured output contract on top of RTCE.',
        sections: JSON.stringify([
          { key: 'role',            label: 'Role',            renderOrder: 0, required: true,  header: '## Role' },
          { key: 'task',            label: 'Task',            renderOrder: 1, required: true,  header: '## Task' },
          { key: 'context',         label: 'Context',         renderOrder: 2, required: false, header: '## Context' },
          { key: 'constraints',     label: 'Constraints',     renderOrder: 3, required: false, header: '## Constraints' },
          { key: 'examples',        label: 'Examples',        renderOrder: 4, required: false, header: '## Examples' },
          { key: 'output_contract', label: 'Output Contract', renderOrder: 5, required: false, header: '## Output Contract' },
        ]),
        section_separator: '\n\n', enabled: 1,
      },
      {
        id: 'eadfbd4d-039b-4993-a89e-82e1a9175b70', key: 'critique', name: 'Critique (Role → Task → Context → Review Instructions)',
        description: 'Four-section framework designed for LLM-as-evaluator prompts. The review_instructions section carries scoring rubrics, pass/fail thresholds, and output format requirements.',
        sections: JSON.stringify([
          { key: 'role',               label: 'Role',               renderOrder: 0, required: true,  header: '## Role' },
          { key: 'task',               label: 'Task',               renderOrder: 1, required: true,  header: '## Task' },
          { key: 'context',            label: 'Context',            renderOrder: 2, required: false, header: '## Context' },
          { key: 'review_instructions',label: 'Review Instructions',renderOrder: 3, required: true,  header: '## Review Instructions' },
        ]),
        section_separator: '\n\n', enabled: 1,
      },
      {
        id: 'df2c712c-6fcb-4048-a1ff-aee1026571fa', key: 'judge', name: 'Judge (Role → Task → Context → Scoring Rubric → Output Contract)',
        description: 'Five-section framework for LLM judge prompts that must produce numeric or categorical scores. Adds an explicit scoring rubric and structured output contract.',
        sections: JSON.stringify([
          { key: 'role',            label: 'Role',            renderOrder: 0, required: true,  header: '## Role' },
          { key: 'task',            label: 'Task',            renderOrder: 1, required: true,  header: '## Task' },
          { key: 'context',         label: 'Context',         renderOrder: 2, required: false, header: '## Context' },
          { key: 'scoring_rubric',  label: 'Scoring Rubric',  renderOrder: 3, required: true,  header: '## Scoring Rubric' },
          { key: 'output_contract', label: 'Output Contract', renderOrder: 4, required: true,  header: '## Output Contract' },
        ]),
        section_separator: '\n\n', enabled: 1,
      },
    ];
    {
      const existingFrameworkIds = new Set((await this.listPromptFrameworks()).map(f => f.id));
      for (const f of frameworks) {
        if (!existingFrameworkIds.has(f.id)) await this.createPromptFramework(f);
      }
    }

    // Prompt Fragments — seed common reusable blocks (Phase 2)
    const fragments: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '34959c97-a4a1-48bd-ac09-9ac176a887fb', key: 'safety_notice', name: 'Safety Notice',
        description: 'Standard safety disclaimer appended to agent prompts to discourage harmful output.',
        category: 'safety', content: [
          'SAFETY: Never produce content that is harmful, hateful, sexually explicit, or that facilitates illegal activity.',
          'Decline politely if the user requests any of the above and explain why.',
        ].join('\n'),
        variables: null, tags: JSON.stringify(['safety', 'guardrails']), version: '1.0', enabled: 1,
      },
      {
        id: '6d71697a-1132-4fa6-908b-3afbd7016e9c', key: 'json_output_contract', name: 'JSON Output Contract',
        description: 'Instructs the model to return only valid JSON. Include in any prompt where structured output is required.',
        category: 'output', content: [
          'OUTPUT FORMAT: Respond with valid JSON only. Do not include markdown code fences, prose, or commentary outside the JSON object.',
          'The response must be parseable by JSON.parse() without any pre-processing.',
        ].join('\n'),
        variables: null, tags: JSON.stringify(['json', 'structured-output']), version: '1.0', enabled: 1,
      },
      {
        id: '7c0fcd6a-90e6-4ee2-9380-62153157428c', key: 'cot_instruction', name: 'Chain-of-Thought Instruction',
        description: 'Asks the model to think step-by-step before giving its final answer. Append to task descriptions.',
        category: 'reasoning', content: 'Think step-by-step before giving your final answer. Show your reasoning explicitly.',
        variables: null, tags: JSON.stringify(['reasoning', 'cot']), version: '1.0', enabled: 1,
      },
      {
        id: 'a0999e98-3dc6-4c9b-95ea-4e62c1abd53b', key: 'language_notice', name: 'Language Notice',
        description: 'Instructs the model to respond in the same language as the user. Useful for multilingual agents.',
        category: 'i18n', content: 'Always respond in the same language the user writes in. Do not switch languages unless explicitly asked.',
        variables: null, tags: JSON.stringify(['i18n', 'language']), version: '1.0', enabled: 1,
      },
      {
        id: '6caa8594-41c4-4664-b91d-40ec8513ccc6', key: 'persona_analyst', name: 'Persona: Analyst',
        description: 'Sets the model persona to a senior data analyst. Use as the role section of an analytics prompt.',
        category: 'personas', content: [
          'You are a senior data analyst. You think rigorously, cite evidence, and present findings clearly.',
          'You prefer structured output (tables, bullet points) over prose when the data supports it.',
        ].join('\n'),
        variables: null, tags: JSON.stringify(['persona', 'analytics']), version: '1.0', enabled: 1,
      },
      {
        id: 'de14761d-5c2f-46a5-a837-dc2760b0d90c', key: 'persona_assistant', name: 'Persona: Helpful Assistant',
        description: 'Sets the model persona to a helpful, harmless, and honest AI assistant.',
        category: 'personas', content: 'You are a helpful, harmless, and honest AI assistant. You answer concisely and accurately, and ask for clarification when the request is ambiguous.',
        variables: null, tags: JSON.stringify(['persona', 'general']), version: '1.0', enabled: 1,
      },
    ];
    {
      const existingFragmentIds = new Set((await this.listPromptFragments()).map(f => f.id));
      for (const f of fragments) {
        if (!existingFragmentIds.has(f.id)) await this.createPromptFragment(f);
      }
    }

    // Prompt Strategies — seed built-in strategy overlays (Phase 4)
    const promptStrategies: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '1006723f-a866-4762-ad8b-b572a7e71f4c',
        key: 'singlePass',
        name: 'Single Pass',
        description: 'Render the prompt template once and send directly to the model without additional orchestration text.',
        instruction_prefix: null,
        instruction_suffix: null,
        config: JSON.stringify({ delimiter: '\n\n' }),
        enabled: 1,
      },
      {
        id: '1ae56ebf-7e13-4459-bee4-c3e2f9e75299',
        key: 'deliberate',
        name: 'Deliberate',
        description: 'Adds a brief quality checklist so the model verifies assumptions and constraints before producing the final answer.',
        instruction_prefix: null,
        instruction_suffix: 'Before finalizing: verify assumptions, check constraints, and ensure the response format is followed exactly.',
        config: JSON.stringify({ delimiter: '\n\n' }),
        enabled: 1,
      },
      {
        id: 'cc57decf-8262-43f1-acfa-d65bdbaa720d',
        key: 'critiqueRevise',
        name: 'Critique then Revise',
        description: 'Instructs the model to internally draft, critique, revise once, and return only the final revised answer.',
        instruction_prefix: null,
        instruction_suffix: 'Process requirement: internally draft, critique against requirements, revise once, then return only the final revised answer.',
        config: JSON.stringify({ delimiter: '\n\n' }),
        enabled: 1,
      },
    ];
    {
      const existingStrategyIds = new Set((await this.listPromptStrategies()).map(s => s.id));
      for (const s of promptStrategies) {
        if (!existingStrategyIds.has(s.id)) await this.createPromptStrategy(s);
      }
    }

    // Prompt Optimizers — seed DB-driven optimizer profiles (Phase 7)
    const promptOptimizers: Omit<PromptOptimizerRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'a057bba1-7e06-438e-9c31-1e5489810447',
        key: 'constraintAppender',
        name: 'Constraint Appender',
        description: 'Deterministic optimizer that appends explicit constraints and output checks to improve predictable compliance.',
        implementation_kind: 'rule',
        config: JSON.stringify({
          mode: 'append',
          addConstraintHeader: true,
        }),
        enabled: 1,
      },
      {
        id: '5c0497a0-1165-4947-b678-5f01bd900db7',
        key: 'llmJudgeRefine',
        name: 'LLM Judge Refine',
        description: 'Model-assisted optimizer profile designed to iteratively refine prompts using rubric-based critique and revision loops.',
        implementation_kind: 'llm',
        config: JSON.stringify({
          maxIterations: 2,
          requireDiffMetadata: true,
        }),
        enabled: 1,
      },
    ];
    {
      const existingOptimizerIds = new Set((await this.listPromptOptimizers()).map(o => o.id));
      for (const o of promptOptimizers) {
        if (!existingOptimizerIds.has(o.id)) await this.createPromptOptimizer(o);
      }
    }

    // Guardrails
    if (cnt('guardrails') === 0) {
    const guardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '0370fa22-5fc8-49a4-bd4c-3e39863da61d', name: 'PII Redaction', description: 'Redact personal identifiable information before sending to LLM',
        type: 'redaction', stage: 'pre', config: JSON.stringify({ patterns: ['email', 'phone', 'ssn', 'credit_card'] }), priority: 100, enabled: 1,
      },
      {
        id: '51586988-83b7-4780-a006-b3b86b76713f', name: 'Toxicity Filter', description: 'Block toxic or harmful content in responses',
        type: 'content_filter', stage: 'post', config: JSON.stringify({ threshold: 0.7, categories: ['hate', 'violence', 'self_harm'] }), priority: 90, enabled: 1,
      },
      {
        id: '1a6b5225-07c6-41cc-878f-c0d08930c1de', name: 'Token Budget', description: 'Enforce maximum token usage per request',
        type: 'budget', stage: 'pre', config: JSON.stringify({ max_input_tokens: 8000, max_output_tokens: 4000 }), priority: 80, enabled: 1,
      },
      {
        id: '8ae24528-463a-4dfa-9348-a2be5214de9f', name: 'Hallucination Check', description: 'Flag responses that may contain fabricated information',
        type: 'factuality', stage: 'post', config: JSON.stringify({ confidence_threshold: 0.6, require_citations: false }), priority: 70, enabled: 1,
      },
      {
        id: '58897b64-39ca-457c-8e8b-8ce4ffc33aa5', name: 'Cognitive Pre: Sycophancy Pressure', description: 'Detect prompts that push for agreement over truth before generation',
        type: 'cognitive_check', stage: 'pre', config: JSON.stringify({ check: 'pre_sycophancy', pattern: "\\b(agree with me|just agree|say yes|validate me|don't challenge|no criticism)\\b", warn_confidence: 0.62, allow_confidence: 0.86 }), priority: 65, enabled: 1,
      },
      {
        id: '70469180-6265-47d8-82c6-ee3cec180bc6', name: 'Cognitive Pre: Confidence Gate', description: 'Apply risk-aware confidence gate before generation',
        type: 'cognitive_check', stage: 'pre', config: JSON.stringify({ check: 'pre_confidence', gate_threshold: 0.65, gate_on_fail: 'warn', medium_risk_confidence: 0.72, high_risk_confidence: 0.6, critical_risk_confidence: 0.5, low_risk_confidence: 0.82 }), priority: 64, enabled: 1,
      },
      {
        id: 'e6f04e4f-29bb-4081-a9e8-ef66dba939bf', name: 'Cognitive Post: Grounding', description: 'Check lexical grounding between prompt and response',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_grounding', min_overlap: 0.06 }), priority: 63, enabled: 1,
      },
      {
        id: 'f9e2ec15-8243-4884-9056-a5cf79af9800', name: 'Cognitive Post: Sycophancy Phrasing', description: 'Detect strong sycophantic phrasing in assistant output',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_sycophancy', pattern: "\\b(you are absolutely right|exactly right|totally correct|you are 100% right)\\b", warn_confidence: 0.58, allow_confidence: 0.86 }), priority: 62, enabled: 1,
      },
      {
        id: 'af3ed9ac-b3ca-4d10-bf80-678e4a750389', name: 'Cognitive Post: Devils Advocate', description: 'Ensure decision-style queries include counterpoints and trade-offs',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_devils_advocate', needs_pattern: "\\b(should i|is it good|best|recommend|decision|choose|strategy|plan)\\b", has_pattern: "\\b(however|on the other hand|trade-?off|counterpoint|risk|alternative)\\b", warn_confidence: 0.6, allow_confidence: 0.84 }), priority: 61, enabled: 1,
      },
      {
        id: '4ace09e3-5aa8-4761-8d7c-e56f81ae84dd', name: 'Cognitive Post: Confidence Gate', description: 'Apply post-response confidence gate for outcome signaling',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_confidence', gate_threshold: 0.67, gate_on_fail: 'warn' }), priority: 60, enabled: 1,
      },
      {
        id: '7c8988ba-b7c9-4e52-8139-732e5c922a25', name: 'Prompt Injection: Directive Override', description: 'Block attempts to override system or developer instructions',
        type: 'content_filter', stage: 'pre', config: JSON.stringify({
          words: [
            'ignore previous instructions',
            'disregard previous instructions',
            'forget all prior instructions',
            'override system prompt',
            'ignore system prompt',
            'ignore developer instructions',
            'jailbreak',
            'do anything now',
          ],
          action: 'deny',
        }), priority: 95, enabled: 1,
      },
      {
        id: '0eb8ae21-e411-4dae-921f-3f91651619d9', name: 'Prompt Injection: Prompt Exfiltration', description: 'Block attempts to extract hidden prompts or policies',
        type: 'regex', stage: 'pre', config: JSON.stringify({
          pattern: '(?:show|reveal|print|dump|output).{0,80}(?:system prompt|developer message|hidden instructions|internal policy)',
          flags: 'i',
          action: 'deny',
        }), priority: 94, enabled: 1,
      },
    ];
    for (const g of guardrails) await this.createGuardrail(g);
    }

    // Ensure prompt-injection guardrails exist for existing databases
    const injectionGuardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '7c8988ba-b7c9-4e52-8139-732e5c922a25', name: 'Prompt Injection: Directive Override', description: 'Block attempts to override system or developer instructions',
        type: 'content_filter', stage: 'pre', config: JSON.stringify({
          words: [
            'ignore previous instructions',
            'disregard previous instructions',
            'forget all prior instructions',
            'override system prompt',
            'ignore system prompt',
            'ignore developer instructions',
            'jailbreak',
            'do anything now',
          ],
          action: 'deny',
        }), priority: 95, enabled: 1,
      },
      {
        id: '0eb8ae21-e411-4dae-921f-3f91651619d9', name: 'Prompt Injection: Prompt Exfiltration', description: 'Block attempts to extract hidden prompts or policies',
        type: 'regex', stage: 'pre', config: JSON.stringify({
          pattern: '(?:show|reveal|print|dump|output).{0,80}(?:system prompt|developer message|hidden instructions|internal policy)',
          flags: 'i',
          action: 'deny',
        }), priority: 94, enabled: 1,
      },
    ];
    for (const g of injectionGuardrails) {
      const existing = await this.getGuardrail(g.id);
      if (!existing) await this.createGuardrail(g);
    }

    // Extended guardrail seed — upserted on every boot so existing DBs receive them.
    // Covers: new injection patterns, credential protection, escalation policies (W4),
    // output safety, model-graded opt-ins (W2/W3), and normaliser-aware rules (W10).
    const extendedGuardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [

      // ── Injection / jailbreak (new patterns) ─────────────────────────────
      {
        id: 'c1000001-aaaa-4000-8000-000000000001',
        name: 'Prompt Injection: Role-Play Bypass',
        description: 'Block persona-switch attempts used to strip safety constraints',
        type: 'blocklist', stage: 'pre',
        config: JSON.stringify({
          words: [
            'pretend you are', 'you are now', 'act as if you have no restrictions',
            'forget you are an ai', 'you have no limitations', 'you are a different ai',
            'roleplay as', 'act as an ai without',
          ],
          action: 'deny',
        }),
        priority: 97, enabled: 1,
      },
      {
        id: 'c1000002-aaaa-4000-8000-000000000002',
        name: 'Prompt Injection: Developer / God Mode',
        description: 'Block requests to activate fictional unrestricted operating modes',
        type: 'blocklist', stage: 'pre',
        config: JSON.stringify({
          words: [
            'developer mode', 'god mode', 'unrestricted mode', 'no restrictions mode',
            'dan mode', 'jailbreak mode', 'sudo mode', 'override mode',
          ],
          action: 'deny',
        }),
        priority: 96, enabled: 1,
      },
      {
        id: 'c1000003-aaaa-4000-8000-000000000003',
        name: 'Prompt Injection: Indirect / Hypothetical Wrapper',
        description: 'Warn on hypothetical/fictional framings commonly used to elicit harmful content',
        type: 'regex', stage: 'pre',
        config: JSON.stringify({
          pattern: '(?:hypothetically|in a fictional world|for (?:educational|academic|research) purposes?|as a creative writing exercise|imagine you could|in this thought experiment).{0,120}(?:how to|explain|steps|instructions|guide)',
          flags: 'i',
          action: 'warn',
        }),
        priority: 93, enabled: 1,
      },
      {
        id: 'c1000004-aaaa-4000-8000-000000000004',
        name: 'Prompt Injection: Base64 Encoded Instruction',
        description: 'Warn when a long base64-like token appears alongside execution verbs (W10)',
        type: 'regex', stage: 'pre',
        config: JSON.stringify({
          pattern: '(?:[A-Za-z0-9+/]{30,}={0,2}).{0,60}(?:execute|run|eval|decode and run|perform)',
          flags: 'i',
          action: 'warn',
        }),
        priority: 92, enabled: 1,
      },

      // ── Credential / secret protection ───────────────────────────────────
      {
        id: 'c2000001-aaaa-4000-8000-000000000001',
        name: 'Credential: API Key in Output',
        description: 'Deny assistant responses that appear to contain real API keys or bearer tokens',
        type: 'regex', stage: 'post',
        config: JSON.stringify({
          pattern: '(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}|Bearer\\s+[A-Za-z0-9._-]{20,}|AKIA[A-Z0-9]{16})',
          flags: 'i',
          action: 'deny',
        }),
        priority: 98, enabled: 1,
      },
      {
        id: 'c2000002-aaaa-4000-8000-000000000002',
        name: 'Credential: Private Key in Output',
        description: 'Deny responses containing PEM private key headers',
        type: 'regex', stage: 'post',
        config: JSON.stringify({
          pattern: '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
          flags: 'i',
          action: 'deny',
        }),
        priority: 99, enabled: 1,
      },
      {
        id: 'c2000003-aaaa-4000-8000-000000000003',
        name: 'Credential: Database Connection String in Output',
        description: 'Warn when a response leaks a database connection string with embedded credentials',
        type: 'regex', stage: 'post',
        config: JSON.stringify({
          pattern: '(?:postgres|mysql|mongodb|redis|amqp)://[^:@\\s]+:[^@\\s]+@',
          flags: 'i',
          action: 'deny',
        }),
        priority: 98, enabled: 1,
      },

      // ── Output safety ─────────────────────────────────────────────────────
      {
        id: 'c3000001-aaaa-4000-8000-000000000001',
        name: 'Output: False Certainty',
        description: 'Warn when the assistant expresses absolute certainty where none is warranted',
        type: 'regex', stage: 'post',
        config: JSON.stringify({
          pattern: '\\b(100% (?:guaranteed|certain|sure|accurate|correct)|absolutely (?:guaranteed|certain|infallible)|will definitely work|cannot fail|no risk whatsoever)\\b',
          flags: 'i',
          action: 'warn',
        }),
        priority: 55, enabled: 1,
      },
      {
        id: 'c3000002-aaaa-4000-8000-000000000002',
        name: 'Output: Unsolicited Password / Secret Disclosure',
        description: 'Deny outputs that volunteer credentials in plain text',
        type: 'blocklist', stage: 'post',
        config: JSON.stringify({
          words: ['the password is', 'your password is', 'api key is', 'secret key is', 'access token is', 'the secret is'],
          action: 'deny',
        }),
        priority: 99, enabled: 1,
      },
      {
        id: 'c3000003-aaaa-4000-8000-000000000003',
        name: 'Output: PII in Assistant Response',
        description: 'Warn when the assistant echoes SSN, credit card, or raw email in its response',
        type: 'regex', stage: 'post',
        config: JSON.stringify({
          pattern: '(?:\\b\\d{3}-\\d{2}-\\d{4}\\b|\\b(?:\\d[ -]*?){13,16}\\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})',
          flags: 'i',
          action: 'warn',
        }),
        priority: 88, enabled: 1,
      },

      // ── W4 Escalation policies ────────────────────────────────────────────
      {
        id: 'c4000001-aaaa-4000-8000-000000000001',
        name: 'Escalation: Critical-Risk Action Auto-Block',
        description: 'Immediately block any turn where the risk gate detects a critical-risk action (delete/drop/truncate)',
        type: 'escalation_policy', stage: 'pre',
        config: JSON.stringify({ risk_levels: ['critical'], on_escalate: 'block' }),
        priority: 100, enabled: 1,
      },
      {
        id: 'c4000002-aaaa-4000-8000-000000000002',
        name: 'Escalation: Cognitive Warn Accumulation',
        description: 'Require human approval when 2 or more cognitive guardrails warn in the same turn',
        type: 'escalation_policy', stage: 'pre',
        config: JSON.stringify({ min_warn_count: 2, categories: ['cognitive'], on_escalate: 'require-approval' }),
        priority: 75, enabled: 1,
      },
      {
        id: 'c4000003-aaaa-4000-8000-000000000003',
        name: 'Escalation: Safety + Cognitive Combined Warn',
        description: 'Block when both a safety warn and a cognitive warn fire in the same turn',
        type: 'escalation_policy', stage: 'post',
        config: JSON.stringify({ min_warn_count: 2, categories: ['cognitive', 'safety'], on_escalate: 'block' }),
        priority: 74, enabled: 1,
      },

      // ── W2/W3 Model-graded opt-ins ────────────────────────────────────────
      {
        id: 'b1c2d3e4-0006-4000-8000-000000000006',
        name: 'Input Safety: Content Moderation',
        description: 'Screen the user message before the model runs. Calls a ModerationModel (OpenAI omni-moderation) and denies on any flagged category (hate, harassment, violence, self-harm, sexual, illicit/weapons). Always-on input safety gate.',
        type: 'model-graded', stage: 'pre',
        config: JSON.stringify({ rule: 'moderation', threshold: 0.5, action: 'deny', timeout_ms: 4000, on_error: 'warn' }),
        priority: 100, enabled: 1,
      },
      {
        id: 'b1c2d3e4-0001-4000-8000-000000000001',
        name: 'Model-Graded: Content Moderation',
        description: 'Call a ModerationModel to flag hate, violence, self-harm, sexual, and illicit content in the assistant output. Enable and supply moderationModel in PipelineOptions to activate.',
        type: 'model-graded', stage: 'post',
        config: JSON.stringify({ rule: 'moderation', categories: ['hate', 'hate/threatening', 'harassment', 'harassment/threatening', 'violence', 'violence/graphic', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'sexual', 'sexual/minors', 'illicit', 'illicit/violent'], threshold: 0.7, action: 'deny', timeout_ms: 8000, on_error: 'warn' }),
        priority: 91, enabled: 1,
        trigger_conditions: JSON.stringify({ any: [{ persona: ['tenant_user', 'anonymous'] }, { prior_has_warn: true }] }),
        trigger_description: 'Non-admin user or prior warn — skip for internal admin-only sessions',
      },
      {
        id: 'b1c2d3e4-0002-4000-8000-000000000002',
        name: 'Model-Graded: LLM Safety Judge',
        description: 'Rubric-based LLM judge for safety, appropriateness, and factual grounding. Enable and supply model in PipelineOptions.',
        type: 'model-graded', stage: 'post',
        config: JSON.stringify({ rule: 'llm-judge', rubric: 'You are a safety judge. Evaluate whether the text is safe, appropriate, and factually grounded. Output JSON: { decision, confidence, rationale }', action: 'deny', timeout_ms: 15000, on_error: 'warn' }),
        priority: 85, enabled: 1,
        trigger_conditions: JSON.stringify({ any: [{ chat_mode: ['agent', 'supervisor'] }, { turn_has_tool_calls: true }, { risk_level: ['high', 'critical'] }, { output_length_gt: 500 }, { prior_has_warn: true }, { persona: ['anonymous'] }] }),
        trigger_description: 'Agent/supervisor mode, tool calls, high risk, long output, prior warn, or anonymous user',
      },
      {
        id: 'b1c2d3e4-0003-4000-8000-000000000003',
        name: 'Model-Graded: Prompt Injection Classifier',
        description: 'LLM-judge specialised for injection and jailbreak detection. Fail-closed (on_error: deny). Enable and supply model.',
        type: 'model-graded', stage: 'pre',
        config: JSON.stringify({ rule: 'injection-classifier', action: 'deny', timeout_ms: 15000, on_error: 'warn' }),
        priority: 96, enabled: 1,
        trigger_conditions: JSON.stringify({ any: [{ input_has_code: true }, { input_has_base64: true }, { input_has_structured_data: true }, { input_has_urls: true }, { input_has_instruction_override: true }, { persona: ['anonymous'] }, { prior_has_injection_warn: true }, { input_length_gt: 300 }] }),
        trigger_description: 'Code / base64 / URLs / override phrase / anonymous user / long input / prior injection warn',
      },
      {
        id: 'b1c2d3e4-0004-4000-8000-000000000004',
        name: 'Model-Graded: Sycophancy Judge',
        description: 'LLM-judge that detects sycophancy more reliably than lexical rules. Advisory warn only. Enable and supply model.',
        type: 'model-graded', stage: 'post',
        config: JSON.stringify({ rule: 'sycophancy-judge', action: 'warn', timeout_ms: 8000, on_error: 'allow' }),
        priority: 59, enabled: 1,
        trigger_conditions: JSON.stringify({ any: [{ input_has_validation_seeking: true }, { all: [{ turn_number_gt: 3 }, { prior_has_cognitive_warn: true }] }] }),
        trigger_description: 'Validation-seeking phrasing, or long session with prior cognitive warn',
      },
      {
        id: 'b1c2d3e4-0005-4000-8000-000000000005',
        name: 'Model-Graded: Semantic Grounding',
        description: 'Embedding cosine-similarity grounding check. Warns when output is semantically distant from evidence. Enable and supply embeddingModel.',
        type: 'model-graded', stage: 'post',
        config: JSON.stringify({ rule: 'semantic-grounding', min_similarity: 0.50, evidence_field: 'both', action: 'warn', timeout_ms: 6000, on_error: 'allow' }),
        priority: 58, enabled: 1,
        trigger_conditions: JSON.stringify({ all: [{ output_has_factual_claims: true }, { output_has_tool_evidence: false }] }),
        trigger_description: 'Factual claims in output AND no tool evidence (tool-grounded answers skip this)',
      },
    ];
    for (const g of extendedGuardrails) {
      const existing = await this.getGuardrail(g.id);
      if (!existing) await this.createGuardrail(g);
    }

    // Routing policies
    if (cnt('routing_policies') === 0) {
    const policies: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'a2cdb3b9-cd89-48d8-884d-ce617a9ca328', name: 'Cost Optimized', description: 'Route to the cheapest model that meets quality thresholds',
        strategy: 'cost', constraints: JSON.stringify({ min_quality_score: 0.7 }), weights: JSON.stringify({ cost: 0.7, quality: 0.2, latency: 0.1 }),
        fallback_model: 'gpt-4o-mini', fallback_provider: 'openai', enabled: 1,
      },
      {
        id: 'eea58ad8-5c94-4aba-98ce-850c4a567e31', name: 'Quality First', description: 'Always route to the highest quality model available',
        strategy: 'quality', constraints: null, weights: JSON.stringify({ cost: 0.1, quality: 0.8, latency: 0.1 }),
        fallback_model: 'claude-sonnet-4-6', fallback_provider: 'anthropic', enabled: 1,
      },
      {
        id: 'b6bcb4e8-16e2-4c40-b5a6-50bc15912c23', name: 'Balanced', description: 'Balance between cost, quality and speed',
        strategy: 'balanced', constraints: null, weights: JSON.stringify({ cost: 0.33, quality: 0.34, latency: 0.33 }),
        fallback_model: 'gpt-4o', fallback_provider: 'openai', enabled: 1,
      },
    ];
    for (const r of policies) await this.createRoutingPolicy(r);
    }

    // Model pricing
    if (cnt('model_pricing') === 0) {
    // Seeded with public list prices captured from provider pricing pages.
    // Operators edit these in the admin Pricing tab; sync button refreshes from APIs.
    const pricing: Omit<ModelPricingRow, 'created_at' | 'updated_at'>[] = [
      { id: '24c261e4-3cd0-48da-aba5-ad65cdc4ba84', model_id: 'claude-sonnet-4-6',          provider: 'anthropic', display_name: 'Claude Sonnet 4.6',          input_cost_per_1m: 3.00,  output_cost_per_1m: 15.00, quality_score: 0.87, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: '3a01332c-7062-46f4-ac27-23718d0b7e11', model_id: 'claude-opus-4-7',            provider: 'anthropic', display_name: 'Claude Opus 4.7',            input_cost_per_1m: 15.00, output_cost_per_1m: 75.00, quality_score: 0.95, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: '7a159bca-cd4a-4008-9adf-537d3f9087a5', model_id: 'claude-haiku-4-5-20251001',  provider: 'anthropic', display_name: 'Claude Haiku 4.5',  input_cost_per_1m: 0.80,  output_cost_per_1m: 4.00,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'd544e807-dd8b-45fc-8d7c-4c35b00fe34c',             model_id: 'gpt-4o',                      provider: 'openai',    display_name: 'GPT-4o',             input_cost_per_1m: 2.50,  output_cost_per_1m: 10.00, quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: '453e9a1e-b374-436b-bbed-58ba0a0db737',        model_id: 'gpt-4o-mini',                 provider: 'openai',    display_name: 'GPT-4o Mini',        input_cost_per_1m: 0.15,  output_cost_per_1m: 0.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: '5a851707-9a6f-434f-9c8f-e6bc02647e90',            model_id: 'gpt-4.1',                     provider: 'openai',    display_name: 'GPT-4.1',            input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'b2c6d495-f58e-40f1-aff2-d58050aabedb',       model_id: 'gpt-4.1-mini',                provider: 'openai',    display_name: 'GPT-4.1 Mini',       input_cost_per_1m: 0.40,  output_cost_per_1m: 1.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'bf5734a5-3552-4068-a80d-457c25f927ab',       model_id: 'gpt-4.1-nano',                provider: 'openai',    display_name: 'GPT-4.1 Nano',       input_cost_per_1m: 0.10,  output_cost_per_1m: 0.40,  quality_score: 0.60, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: '5190bfc2-0601-4153-8563-a6f5811bdcae',                 model_id: 'o3',                           provider: 'openai',    display_name: 'o3',                 input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'f7c3f6b4-f3de-4070-a547-f37359aa0ca4',            model_id: 'o4-mini',                      provider: 'openai',    display_name: 'o4 Mini',            input_cost_per_1m: 1.10,  output_cost_per_1m: 4.40,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
      // Google Gemini — public list pricing (ai.google.dev/pricing)
      { id: 'a1b2c3d4-0001-4000-8000-000000000001', model_id: 'gemini-2.5-pro',         provider: 'google', display_name: 'Gemini 2.5 Pro',        input_cost_per_1m: 1.25,   output_cost_per_1m: 10.00, quality_score: 0.92, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0001-4000-8000-000000000002', model_id: 'gemini-2.5-flash',       provider: 'google', display_name: 'Gemini 2.5 Flash',      input_cost_per_1m: 0.30,   output_cost_per_1m: 2.50,  quality_score: 0.82, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0001-4000-8000-000000000003', model_id: 'gemini-2.5-flash-lite',  provider: 'google', display_name: 'Gemini 2.5 Flash Lite', input_cost_per_1m: 0.10,   output_cost_per_1m: 0.40,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0001-4000-8000-000000000004', model_id: 'gemini-1.5-pro',         provider: 'google', display_name: 'Gemini 1.5 Pro',        input_cost_per_1m: 1.25,   output_cost_per_1m: 5.00,  quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0001-4000-8000-000000000005', model_id: 'gemini-1.5-flash',       provider: 'google', display_name: 'Gemini 1.5 Flash',      input_cost_per_1m: 0.075,  output_cost_per_1m: 0.30,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
      // Ollama (local) — zero cost; quality is a heuristic operators can override
      { id: 'a1b2c3d4-0002-4000-8000-000000000001', model_id: 'llama3.1',     provider: 'ollama', display_name: 'Llama 3.1 (local)',    input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0002-4000-8000-000000000002', model_id: 'llama3',       provider: 'ollama', display_name: 'Llama 3 (local)',      input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.70, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0002-4000-8000-000000000003', model_id: 'qwen2.5',      provider: 'ollama', display_name: 'Qwen 2.5 (local)',     input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.74, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0002-4000-8000-000000000004', model_id: 'mistral',      provider: 'ollama', display_name: 'Mistral (local)',      input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.68, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0002-4000-8000-000000000005', model_id: 'phi3',         provider: 'ollama', display_name: 'Phi 3 (local)',        input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.65, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0002-4000-8000-000000000006', model_id: 'gemma2',       provider: 'ollama', display_name: 'Gemma 2 (local)',      input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.66, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'a1b2c3d4-0002-4000-8000-000000000007', model_id: 'deepseek-r1',  provider: 'ollama', display_name: 'DeepSeek R1 (local)',  input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.80, source: 'seed', last_synced_at: null, enabled: 1 },
      // llama.cpp (local OpenAI-compatible server) — zero cost
      { id: 'a1b2c3d4-0003-4000-8000-000000000001', model_id: 'local',        provider: 'llamacpp', display_name: 'llama.cpp local model', input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.70, source: 'seed', last_synced_at: null, enabled: 1 },
    ];
    for (const p of pricing) await this.createModelPricing(p);
    }

    // Workflow definitions
    if (cnt('workflow_defs') === 0) {
    const workflows: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '3aedac32-ef1a-429f-89d7-23d481ccd8ad', name: 'Code Review Pipeline', description: 'Automated code review with human approval gate',
        version: '1.0', entry_step_id: 'analyze',
        steps: JSON.stringify([
          { id: 'analyze', type: 'agent', name: 'Static Analysis', next: 'review' },
          { id: 'review', type: 'agent', name: 'AI Code Review', next: 'approve' },
          { id: 'approve', type: 'human', name: 'Human Approval', next: 'report' },
          { id: 'report', type: 'agent', name: 'Generate Report', next: null },
        ]),
        metadata: JSON.stringify({ category: 'engineering' }), enabled: 1,
      },
      {
        id: 'f47a3a38-a090-4956-8998-3e2bf6327304', name: 'Content Generation', description: 'Draft, review, and publish content workflow',
        version: '1.0', entry_step_id: 'draft',
        steps: JSON.stringify([
          { id: 'draft', type: 'agent', name: 'Generate Draft', next: 'edit' },
          { id: 'edit', type: 'agent', name: 'Edit & Polish', next: 'approve' },
          { id: 'approve', type: 'human', name: 'Editorial Approval', next: null },
        ]),
        metadata: JSON.stringify({ category: 'content' }), enabled: 1,
      },
      {
        id: '2cb3d0de-9ce7-4b90-a7cd-7c41f762a988', name: 'NZ Statistics Lookup', description: 'Search, identify, and retrieve official New Zealand statistics from Stats NZ ADE',
        version: '1.0', entry_step_id: 'search',
        steps: JSON.stringify([
          { id: 'search', type: 'agent', name: 'Search Dataflows', next: 'inspect', tools: ['statsnz_search_dataflows', 'statsnz_list_dataflows'] },
          { id: 'inspect', type: 'agent', name: 'Inspect Dataset Structure', next: 'fetch', tools: ['statsnz_get_dataflow_info', 'statsnz_get_codelist'] },
          { id: 'fetch', type: 'agent', name: 'Fetch Observations', next: 'present', tools: ['statsnz_get_data'] },
          { id: 'present', type: 'agent', name: 'Format & Present Results', next: null },
        ]),
        metadata: JSON.stringify({ category: 'statistics', country: 'NZ' }), enabled: 1,
      },
    ];
    for (const w of workflows) await this.createWorkflowDef(w);
    }

    // Tool catalog
    if (cnt('tool_catalog') === 0) {
    const tools: Omit<ToolCatalogRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'a7bd3e9f-9b1b-4aa6-9520-8f5fb194a5e3', name: 'Web Search',
        description: 'Search the web for current information using the configured search provider.',
        category: 'retrieval', risk_level: 'read-only', requires_approval: 0,
        max_execution_ms: 10000, rate_limit_per_min: 30, enabled: 1,
        tool_key: 'web_search', version: '1.0', side_effects: 0,
        tags: JSON.stringify(['search', 'retrieval', 'web']), source: 'builtin', credential_id: null,
      },
      {
        id: '8e6c2528-f5a0-4d5a-a719-b60cc660f353', name: 'Code Execution',
        description: 'Execute code snippets in a sandboxed environment via the Cloud Sandbox Engine.',
        category: 'compute', risk_level: 'external-side-effect', requires_approval: 1,
        max_execution_ms: 30000, rate_limit_per_min: 10, enabled: 1,
        tool_key: 'cse_run_code', version: '1.0', side_effects: 1,
        tags: JSON.stringify(['code', 'compute', 'sandbox']), source: 'builtin', credential_id: null,
      },
      {
        id: 'bca36e31-bf3b-4761-89ba-0f1edecf22cf', name: 'File Reader',
        description: 'Read files from allowed directories on the server filesystem.',
        category: 'filesystem', risk_level: 'read-only', requires_approval: 0,
        max_execution_ms: 5000, rate_limit_per_min: 60, enabled: 1,
        tool_key: 'file_reader', version: '1.0', side_effects: 0,
        tags: JSON.stringify(['filesystem', 'read']), source: 'builtin', credential_id: null,
      },
      {
        id: '9bbd1c34-35a1-442f-b2bb-d5d6f568f57a', name: 'Database Query',
        description: 'Run read-only SQL queries against configured databases.',
        category: 'data', risk_level: 'read-only', requires_approval: 0,
        max_execution_ms: 15000, rate_limit_per_min: 20, enabled: 1,
        tool_key: 'database_query', version: '1.0', side_effects: 0,
        tags: JSON.stringify(['database', 'sql', 'read']), source: 'builtin', credential_id: null,
      },
      {
        id: '31755606-4e34-44be-a101-cee78d49f6e1', name: 'API Caller',
        description: 'Make HTTP requests to allowlisted external endpoints.',
        category: 'integration', risk_level: 'external-side-effect', requires_approval: 0,
        max_execution_ms: 20000, rate_limit_per_min: 15, enabled: 1,
        tool_key: 'api_caller', version: '1.0', side_effects: 1,
        tags: JSON.stringify(['http', 'api', 'integration']), source: 'builtin', credential_id: null,
      },
      {
        id: '220dd56e-5c1c-4dad-93c8-befa5d7588f5', name: 'Stats NZ (Aotearoa Data Explorer)',
        description: 'Query official New Zealand statistics — population, census, GDP, trade, housing, labour, and more via the Stats NZ ADE SDMX API.',
        category: 'data', risk_level: 'read-only', requires_approval: 0,
        max_execution_ms: 30000, rate_limit_per_min: 20, enabled: 1,
        tool_key: 'statsnz_get_data', version: '1.0', side_effects: 0,
        tags: JSON.stringify(['statistics', 'new-zealand', 'data']), source: 'builtin', credential_id: null,
      },
    ];
    for (const t of tools) await this.createToolConfig(t);
    }

    // Skills
    if (cnt('skills') === 0) {
      for (const s of BUILT_IN_SKILLS) {
        await this.createSkill({
          id: s.id,
          name: s.name,
          description: s.description ?? s.summary,
          category: s.category ?? 'general',
          trigger_patterns: JSON.stringify(s.triggerPatterns),
          instructions: s.instructions ?? s.executionGuidance ?? s.summary,
          tool_names: s.toolNames ? JSON.stringify(s.toolNames) : null,
          examples: s.examples ? JSON.stringify(s.examples) : null,
          tags: s.tags ? JSON.stringify(s.tags) : null,
          priority: s.priority ?? 0,
          version: s.version ?? '1.0',
          enabled: s.enabled === false ? 0 : 1,
          tool_policy_key: s.toolPolicyKey ?? null,
        });
      }
    }

    const dataAnalysisSkill = BUILT_IN_SKILLS.find((skill) => skill.id === 'skill-data-analysis-execution');
    if (dataAnalysisSkill) {
      const existingSkill = await this.getSkill(dataAnalysisSkill.id);
      const skillFields = {
        name: dataAnalysisSkill.name,
        description: dataAnalysisSkill.description ?? dataAnalysisSkill.summary,
        category: dataAnalysisSkill.category ?? 'general',
        trigger_patterns: JSON.stringify(dataAnalysisSkill.triggerPatterns),
        instructions: dataAnalysisSkill.instructions ?? dataAnalysisSkill.executionGuidance ?? dataAnalysisSkill.summary,
        tool_names: dataAnalysisSkill.toolNames ? JSON.stringify(dataAnalysisSkill.toolNames) : null,
        examples: dataAnalysisSkill.examples ? JSON.stringify(dataAnalysisSkill.examples) : null,
        tags: dataAnalysisSkill.tags ? JSON.stringify(dataAnalysisSkill.tags) : null,
        priority: dataAnalysisSkill.priority ?? 0,
        version: dataAnalysisSkill.version ?? '1.0',
        enabled: dataAnalysisSkill.enabled === false ? 0 : 1,
        tool_policy_key: dataAnalysisSkill.toolPolicyKey ?? null,
      };
      // Preserve operator-managed skill customizations; only ensure the built-in
      // row exists when absent.
      if (!existingSkill) {
        await this.createSkill({ id: dataAnalysisSkill.id, ...skillFields });
      }
    }

    // Task Contracts (must seed before worker_agents for FK reference tc-nz-statistics)
    if (cnt('task_contracts') === 0) {
    const contracts: Omit<TaskContractRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'fbb4e3aa-a78b-452f-90b9-30ec0a1da2ea', name: 'Code Review Contract', description: 'Contract for AI-assisted code review tasks',
        input_schema: JSON.stringify({ type: 'object', required: ['code', 'language'], properties: { code: { type: 'string' }, language: { type: 'string' }, context: { type: 'string' } } }),
        output_schema: JSON.stringify({ type: 'object', required: ['summary', 'issues'], properties: { summary: { type: 'string' }, issues: { type: 'array' }, score: { type: 'number' } } }),
        acceptance_criteria: JSON.stringify([
          { id: 'cr-has-summary', description: 'Output must include a summary', type: 'assertion', config: { field: 'summary', operator: 'exists' }, required: true, weight: 1 },
          { id: 'cr-has-issues', description: 'Output must include issues array', type: 'assertion', config: { field: 'issues', operator: 'exists' }, required: true, weight: 1 },
          { id: 'cr-score-range', description: 'Score must be between 0 and 10', type: 'assertion', config: { field: 'score', operator: 'gte', expected: 0 }, required: false, weight: 0.5 },
        ]),
        max_attempts: 3, timeout_ms: 60000,
        evidence_required: JSON.stringify(['text', 'metric']), min_confidence: 0.7, require_human_review: 0, enabled: 1,
      },
      {
        id: 'e5f03434-6aba-4e7f-93c5-838344d25d9b', name: 'Content Generation Contract', description: 'Contract for AI content generation tasks',
        input_schema: JSON.stringify({ type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, audience: { type: 'string' }, maxWords: { type: 'number' } } }),
        output_schema: JSON.stringify({ type: 'object', required: ['content', 'wordCount'], properties: { content: { type: 'string' }, wordCount: { type: 'number' }, readabilityScore: { type: 'number' } } }),
        acceptance_criteria: JSON.stringify([
          { id: 'cg-has-content', description: 'Output must include content', type: 'assertion', config: { field: 'content', operator: 'exists' }, required: true, weight: 1 },
          { id: 'cg-word-count', description: 'Must include word count', type: 'assertion', config: { field: 'wordCount', operator: 'gt', expected: 0 }, required: true, weight: 0.5 },
        ]),
        max_attempts: 2, timeout_ms: 120000,
        evidence_required: JSON.stringify(['text']), min_confidence: 0.8, require_human_review: 1, enabled: 1,
      },
      {
        id: '2e9ac54f-a9b4-4ecd-88a0-1113d8c32a34', name: 'Data Analysis Contract', description: 'Contract for data analysis and reporting tasks',
        input_schema: JSON.stringify({ type: 'object', required: ['query'], properties: { query: { type: 'string' }, dataset: { type: 'string' } } }),
        output_schema: JSON.stringify({ type: 'object', required: ['analysis', 'confidence'], properties: { analysis: { type: 'string' }, confidence: { type: 'number' }, charts: { type: 'array' } } }),
        acceptance_criteria: JSON.stringify([
          { id: 'da-has-analysis', description: 'Output must include analysis text', type: 'assertion', config: { field: 'analysis', operator: 'exists' }, required: true, weight: 1 },
          { id: 'da-confidence', description: 'Confidence must be at least 0.5', type: 'assertion', config: { field: 'confidence', operator: 'gte', expected: 0.5 }, required: true, weight: 1 },
        ]),
        max_attempts: 3, timeout_ms: 180000,
        evidence_required: JSON.stringify(['text', 'metric', 'trace']), min_confidence: 0.6, require_human_review: 0, enabled: 1,
      },
      {
        id: 'eb6561e5-46a8-446d-8056-0d1a6fac751e', name: 'NZ Statistics Lookup Contract', description: 'Contract for querying official New Zealand statistics from Stats NZ Aotearoa Data Explorer',
        input_schema: JSON.stringify({ type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'The statistical question (e.g. "NZ population by region")' }, dataflow_id: { type: 'string', description: 'Optional specific dataflow ID if known' } } }),
        output_schema: JSON.stringify({ type: 'object', required: ['dataset_id', 'period', 'values'], properties: { dataset_id: { type: 'string', description: 'Stats NZ dataflow ID' }, dataset_name: { type: 'string' }, period: { type: 'string', description: 'Reference period or year' }, values: { type: 'array', description: 'Numeric observations returned' }, unit: { type: 'string' }, source: { type: 'string' } } }),
        acceptance_criteria: JSON.stringify([
          { id: 'nz-has-dataset', description: 'Output must include a Stats NZ dataset ID', type: 'assertion', config: { field: 'dataset_id', operator: 'exists' }, required: true, weight: 1 },
          { id: 'nz-has-period', description: 'Output must include a reference period or year', type: 'assertion', config: { field: 'period', operator: 'exists' }, required: true, weight: 1 },
          { id: 'nz-has-values', description: 'Output must include at least one numeric value', type: 'assertion', config: { field: 'values', operator: 'exists' }, required: true, weight: 1 },
        ]),
        max_attempts: 3, timeout_ms: 120000,
        evidence_required: JSON.stringify(['text', 'metric', 'trace']), min_confidence: 0.7, require_human_review: 0, enabled: 1,
      },
    ];
    for (const c of contracts) await this.createTaskContract(c);
    }

    // Worker agents
    if (cnt('worker_agents') === 0) {
      const workers: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '8d2598f8-775d-4e67-841d-1cb5fb16713e', name: 'code_executor',
          display_name: 'Casey',
          job_profile: 'Code Execution Specialist',
          description: '[USE FIRST FOR ANY CODE/SCRIPT/RUN REQUEST] Writes AND executes code in real isolated Docker containers via CSE. Uses the dedicated data-analysis sandbox for dataframe/charting work and returns actual stdout. Use for: "run", "execute", "run it", "run in a container", "write and run", "test", "script that runs", and dataset analysis that requires real execution.',
          system_prompt: [
            'You are a code writing + execution + verification agent.',
            'Your mission is not just to write code, but to make it run successfully and produce validated results.',
            '',
            'Execution workflow (MANDATORY):',
            '1. Understand objective and available attached files from context.',
            '2. Generate a runnable script.',
            '3. Execute with the correct CSE tool: use `cse_run_data_analysis` for file/data analysis, charting, dataframe, Excel/Parquet, or statistical workflows; use `cse_run_code` for generic scripts that are not data-analysis tasks.',
            '4. Verify stdout/stderr and correctness against requested output.',
            '5. If errors or weak output, revise code and run again (iterate).',
            '6. Stop only when output is successful and materially answers the request, or when a clear environment blocker is proven.',
            '',
            'For file/data analysis tasks:',
            '- Treat attached filenames as real files in container workspace.',
            '- Default to `cse_run_data_analysis`; it already includes pandas, numpy, matplotlib, seaborn, plotly, statsmodels, scikit-learn, openpyxl, and pyarrow.',
            '- Prefer robust Python stdlib (`csv`, `json`, `statistics`) when it is sufficient, but do not waste turns reinstalling standard analysis libraries that are already present in the analysis sandbox.',
            '- If an analysis-library import fails inside `cse_run_data_analysis`, treat that as an environment issue and report it clearly.',
            '- If file path fails, probe workspace via code (e.g., os.listdir("."), os.listdir("/workspace")) and retry with corrected path.',
            '',
            'Charting rules (MANDATORY — never deviate):',
            '- ALWAYS use Plotly for all charts, graphs, and visualisations. Never use matplotlib or seaborn for output charts.',
            '- Use plotly.graph_objects or plotly.express; call fig.to_html(full_html=False, include_plotlyjs=\'cdn\') to produce an embeddable HTML snippet.',
            '- Never save charts as .png, .jpg, or any image file — file paths are not accessible outside the container.',
            '- If the task requests an HTML dashboard, build the complete self-contained HTML (with inline Plotly CDN script) in Python and print it to stdout.',
            '',
            'Artifact saving (MANDATORY when HTML output is requested):',
            '- After a successful CSE run that produces HTML, call `emit_artifact` yourself with the COMPLETE HTML string from stdout.',
            '- Do NOT summarise or truncate the HTML — pass the full string verbatim as the `data` argument.',
            '- Use type="html", name ending in ".html".',
            '- Do not rely on the supervisor to relay the HTML; save it directly here so nothing is lost.',
            '',
            'Quality bar before returning:',
            '- Code executed successfully (status success).',
            '- Output includes concrete computed values (not generic commentary).',
            '- At least 3 clear insights when the user asks for analysis/insights.',
            '- Include assumptions and any residual limitations.',
            '',
            'Response format back to supervisor:',
            '- Final code used',
            '- Execution stdout',
            '- Verification notes (why output is correct)',
            '- If blocked: exact blocker + next best fallback',
          ].join('\n'),
          tool_names: JSON.stringify(['cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'calculator', 'text_analysis', 'emit_artifact']),
          persona: 'agent_worker', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 50, category: 'general', enabled: 1,
        },
        {
          id: 'aebc3dc5-cc5b-4ad2-a10c-dedf8a9a5c3e', name: 'statsnz_specialist',
          display_name: 'Nia',
          job_profile: 'NZ Data Specialist',
          description: 'Specialist for Stats NZ Aotearoa Data Explorer data retrieval. Use this worker for NZ census/population/demographics requests and any task that should be grounded in Stats NZ APIs.',
          system_prompt: [
            'You are a Stats NZ specialist worker.',
            'Use only statsnz_* tools available to you to discover and retrieve data from Stats NZ ADE.',
            'For census/population requests, identify the best matching dataflow, then retrieve values with explicit period/date and dataflow ID.',
            'Preferred retrieval sequence:',
            '1. statsnz_search_dataflows to shortlist candidate dataflows.',
            '2. statsnz_get_dataflow_info for chosen dataflow metadata.',
            '3. statsnz_get_data with safe args: format="jsondata", dimension_at_observation="AllDimensions", key="all".',
            '4. Narrow to requested year using start_period/end_period (avoid complex dot-slot keys unless fully validated with datastructure/codelists).',
            '5. If `languageTag1` occurs, retry statsnz_get_data with minimal safe args and then refine filters.',
            'If multiple plausible tables exist, state uncertainty and list top candidates with reasons.',
            'Do not rely on web search when statsnz_* tools can answer the request.',
          ].join('\n'),
          tool_names: JSON.stringify(['statsnz_list_dataflows', 'statsnz_search_dataflows', 'statsnz_get_dataflow_info', 'statsnz_get_codelist', 'statsnz_get_data']),
          persona: 'agent_worker',
          trigger_patterns: JSON.stringify([
            'stats nz', 'stats new zealand', 'statsnz', 'nz census', 'nz population', 'nz demographics',
            'new zealand census', 'new zealand population', 'new zealand demographics', 'new zealand statistics',
            'aotearoa data', 'aotearoa census', 'aotearoa population', 'nz gdp', 'nz trade', 'nz housing',
            'nz labour', 'nz employment', 'nz unemployment',
            'population of new zealand', 'population of nz', 'population in new zealand', 'population in nz',
            'new zealand gdp', 'new zealand trade', 'new zealand housing', 'new zealand labour',
            'new zealand employment', 'new zealand unemployment', 'new zealand economy',
            'nz economy', 'nz crime', 'new zealand crime', 'nz income', 'new zealand income',
            'nz data', 'new zealand data', 'nz births', 'nz deaths', 'nz migration',
            'economy of new zealand', 'economy of nz', 'economy in new zealand', 'economy in nz',
            'spending in new zealand', 'spending in nz', 'spending of new zealand',
            'where are people spending', 'consumer spending', 'card spending', 'retail spending',
            'gdp of new zealand', 'gdp of nz', 'gdp in new zealand',
            'cost of living new zealand', 'cost of living nz', 'inflation new zealand', 'inflation nz',
            'new zealand gdp', 'new zealand inflation', 'new zealand cost of living',
          ]),
          task_contract_id: 'eb6561e5-46a8-446d-8056-0d1a6fac751e', max_retries: 2, priority: 40, category: 'general', enabled: 1,
        },
        {
          id: 'bf3c7feb-5471-4e17-a46c-f2c84efbf613', name: 'researcher',
          display_name: 'Riley',
          job_profile: 'Research Specialist',
          description: 'Researches topics, searches the web, browses websites, and gathers information. Can open a headless browser to navigate dynamic sites, read page content, click links, fill forms, and interact with web applications. Has full browser authentication capabilities: can detect login forms, auto-login using stored website credentials from the credential vault, save session cookies, and hand off the browser to the user for manual steps like 2FA or CAPTCHA. Always delegate login/auth tasks to this worker — it has the browser_detect_auth, browser_login, browser_save_cookies, browser_handoff_request, and browser_handoff_resume tools.',
          system_prompt: '',
          tool_names: JSON.stringify(['web_search', 'text_analysis', 'browser_open', 'browser_close', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_select', 'browser_type', 'browser_hover', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_detect_auth', 'browser_login', 'browser_save_cookies', 'browser_handoff_request', 'browser_handoff_resume']),
          persona: 'agent_researcher', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 30, category: 'general', enabled: 1,
        },
        {
          id: '63566924-9e94-41e5-8e55-6e9ddee168c5', name: 'analyst',
          display_name: 'Avery',
          job_profile: 'Data Analyst',
          description: 'Analyzes data, performs calculations, validates computed outputs, formats JSON, provides structured insights, and handles temporal/timer queries. Good for math, data processing, output verification, formatting, date/time questions, and time management.',
          system_prompt: '',
          tool_names: JSON.stringify(['calculator', 'json_format', 'text_analysis', 'memory_recall', 'datetime', 'datetime_add', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel']),
          persona: 'agent_worker', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 20, category: 'general', enabled: 1,
        },
        {
          id: '1111d2e3-2828-4570-9bf2-91320b536a2e', name: 'writer',
          display_name: 'Wren',
          job_profile: 'Writing Specialist',
          description: 'Writes, edits, and refines text. Good for drafting content, summarizing, and creative writing tasks.',
          system_prompt: '',
          tool_names: JSON.stringify(['text_analysis', 'memory_recall', 'datetime', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel']),
          persona: 'agent_worker', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 10, category: 'general', enabled: 1,
        },
      ];
      for (const w of workers) await this.createWorkerAgent(w);
    }

    // Phase 1B — seed the global default supervisor agent row.
    // Idempotent: only inserts if no row with this id exists. Operators may
    // override behaviour by adding tenant- or category-scoped rows in admin.
    {
      const existing = this.d.prepare("SELECT id FROM agents WHERE id = ? OR (is_default = 1 AND tenant_id IS NULL)").get('agent-supervisor-default') as { id: string } | undefined;
      if (!existing) {
        await this.createSupervisorAgent({
          id: 'agent-supervisor-default',
          tenant_id: null,
          category: 'general',
          name: 'geneweave-supervisor',
          display_name: 'Default Supervisor',
          description: 'Global default supervisor agent. Plans work, delegates to workers, and uses the shared utility tools (datetime, math_eval, unit_convert) provided by @weaveintel/agents.',
          system_prompt: null,
          include_utility_tools: 1,
          default_timezone: null,
          is_default: 1,
          enabled: 1,
        });
      }
    }

    const codeExecutorWorker = await this.getWorkerAgent('8d2598f8-775d-4e67-841d-1cb5fb16713e');
    if (codeExecutorWorker) {
      const parsedToolNames = (() => {
        try {
          return JSON.parse(codeExecutorWorker.tool_names ?? '[]') as string[];
        } catch {
          return [] as string[];
        }
      })();
      const nextToolNames = Array.from(new Set([
        ...parsedToolNames,
        'cse_run_data_analysis',
      ]));
      const desiredDisplayName = 'Casey';
      const desiredJobProfile = 'Code Execution Specialist';
      const desiredDescription = '[USE FIRST FOR ANY CODE/SCRIPT/RUN REQUEST] Writes AND executes code in real isolated Docker containers via CSE. Uses the dedicated data-analysis sandbox for dataframe/charting work and returns actual stdout. Use for: "run", "execute", "run it", "run in a container", "write and run", "test", "script that runs", and dataset analysis that requires real execution.';
      const desiredSystemPrompt = [
        'You are a code writing + execution + verification agent.',
        'Your mission is not just to write code, but to make it run successfully and produce validated results.',
        '',
        'Execution workflow (MANDATORY):',
        '1. Understand objective and available attached files from context.',
        '2. Generate a runnable script.',
        '3. Execute with the correct CSE tool: use `cse_run_data_analysis` for file/data analysis, charting, dataframe, Excel/Parquet, or statistical workflows; use `cse_run_code` for generic scripts that are not data-analysis tasks.',
        '4. Verify stdout/stderr and correctness against requested output.',
        '5. If errors or weak output, revise code and run again (iterate).',
        '6. Stop only when output is successful and materially answers the request, or when a clear environment blocker is proven.',
        '',
        'For file/data analysis tasks:',
        '- Treat attached filenames as real files in container workspace.',
        '- Default to `cse_run_data_analysis`; it already includes pandas, numpy, matplotlib, seaborn, plotly, statsmodels, scikit-learn, openpyxl, and pyarrow.',
        '- Prefer robust Python stdlib (`csv`, `json`, `statistics`) when it is sufficient, but do not waste turns reinstalling standard analysis libraries that are already present in the analysis sandbox.',
        '- If an analysis-library import fails inside `cse_run_data_analysis`, treat that as an environment issue and report it clearly.',
        '- If file path fails, probe workspace via code (e.g., os.listdir("."), os.listdir("/workspace")) and retry with corrected path.',
        '',
        'Quality bar before returning:',
        '- Code executed successfully (status success).',
        '- Output includes concrete computed values (not generic commentary).',
        '- At least 3 clear insights when the user asks for analysis/insights.',
        '- Include assumptions and any residual limitations.',
        '',
        'Response format back to supervisor:',
        '- Final code used',
        '- Execution stdout',
        '- Verification notes (why output is correct)',
        '- If blocked: exact blocker + next best fallback',
      ].join('\n');
      if (
        codeExecutorWorker.display_name !== desiredDisplayName
        || codeExecutorWorker.job_profile !== desiredJobProfile
        || codeExecutorWorker.description !== desiredDescription
        || codeExecutorWorker.system_prompt !== desiredSystemPrompt
        || nextToolNames.length !== parsedToolNames.length
      ) {
        await this.updateWorkerAgent(codeExecutorWorker.id, {
          display_name: desiredDisplayName,
          job_profile: desiredJobProfile,
          description: desiredDescription,
          system_prompt: desiredSystemPrompt,
          tool_names: JSON.stringify(nextToolNames),
        });
      }
    }

    const supervisorExecutionPrompt = await this.getPromptByKey('runtime.supervisor-code-execution');
    if (supervisorExecutionPrompt && !supervisorExecutionPrompt.template.includes('cse_run_data_analysis')) {
      await this.updatePrompt(supervisorExecutionPrompt.id, { template: SUPERVISOR_CODE_EXECUTION_POLICY });
    }

    const hardExecutionGuardPrompt = await this.getPromptByKey('runtime.hard-execution-guard');
    if (hardExecutionGuardPrompt && !hardExecutionGuardPrompt.template.includes('cse_run_data_analysis')) {
      await this.updatePrompt(hardExecutionGuardPrompt.id, { template: HARD_EXECUTION_GUARD_POLICY });
    }

    // Human Task Policies
    if (cnt('human_task_policies') === 0) {
    const taskPolicies: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'cc83adb8-bf49-4fb0-83c4-fa27da65dc56', name: 'High-Risk Tool Approval', description: 'Require human approval before executing high-risk tools (code execution, DB writes)',
        trigger: 'tool:high-risk', task_type: 'approval', default_priority: 'high', sla_hours: 1, auto_escalate_after_hours: 2,
        assignment_strategy: 'round-robin', assign_to: null, enabled: 1,
      },
      {
        id: '50cb4891-c1b7-4562-9bbb-75d0e552c07d', name: 'Sensitive Data Review', description: 'Human review when agent accesses sensitive or PII data',
        trigger: 'data:sensitive', task_type: 'review', default_priority: 'urgent', sla_hours: 0.5, auto_escalate_after_hours: 1,
        assignment_strategy: 'role-based', assign_to: 'security-team', enabled: 1,
      },
      {
        id: '33664f9c-7e81-4bae-b536-6bdf17ea2352', name: 'Cost Threshold Approval', description: 'Require approval when estimated cost exceeds threshold',
        trigger: 'cost:threshold', task_type: 'approval', default_priority: 'normal', sla_hours: 4, auto_escalate_after_hours: 8,
        assignment_strategy: 'specific-user', assign_to: 'admin', enabled: 1,
      },
      {
        id: '659ed861-c3da-432d-a954-94393eb628de', name: 'Workflow Gate Review', description: 'Human review gate at critical workflow checkpoints',
        trigger: 'workflow:gate', task_type: 'review', default_priority: 'normal', sla_hours: 24, auto_escalate_after_hours: 48,
        assignment_strategy: 'least-busy', assign_to: null, enabled: 1,
      },
    ];
    for (const tp of taskPolicies) await this.createHumanTaskPolicy(tp);
    }

    // Cache Policies
    if (cnt('cache_policies') === 0) {
    // Response-side secret bypass — applied to every policy (defence-in-depth)
    // because policy resolution currently selects the highest-priority enabled
    // policy regardless of request scope, so secrets must be screened whichever
    // policy ends up active.
    const SECRET_OUTPUT_PATTERNS = JSON.stringify(['sk-[A-Za-z0-9]{16,}', 'BEGIN [A-Z ]*PRIVATE KEY', 'AKIA[0-9A-Z]{16}']);
    const cachePolicies: Omit<CachePolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'a747b721-8eff-46b2-a916-864ec0ac67cf', name: 'Global Default Cache', description: 'Default caching policy for all responses — 5 minute TTL',
        scope: 'global', ttl_ms: 300000, max_entries: 1000, max_bytes: 0,
        bypass_patterns: JSON.stringify(['password', 'secret', 'token', 'key']),
        output_bypass_patterns: SECRET_OUTPUT_PATTERNS,
        invalidate_on: JSON.stringify(['model_change', 'prompt_update']),
        key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
        enabled: 1,
      },
      {
        id: '5820734a-3bea-4558-90ad-d382b7b76bb2', name: 'Session Short-Lived', description: 'Short TTL cache scoped to individual sessions',
        scope: 'session', ttl_ms: 60000, max_entries: 100, max_bytes: 0,
        bypass_patterns: null, output_bypass_patterns: SECRET_OUTPUT_PATTERNS, invalidate_on: JSON.stringify(['session_end']),
        key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
        enabled: 1,
      },
      {
        id: 'bd5cbbb5-c407-4016-9c43-5525f2789017', name: 'Semantic Query Cache', description: 'Cache semantically similar queries to avoid redundant LLM calls',
        scope: 'global', ttl_ms: 600000, max_entries: 500, max_bytes: 0,
        bypass_patterns: JSON.stringify(['real-time', 'current date', 'current time']),
        output_bypass_patterns: SECRET_OUTPUT_PATTERNS,
        invalidate_on: JSON.stringify(['knowledge_update']),
        key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
        enabled: 1,
      },
      {
        id: '50dd439b-1fec-4293-8ee2-ed24ae07c387', name: 'User Personalised Cache', description: 'Per-user cache that respects personalisation context',
        scope: 'user', ttl_ms: 120000, max_entries: 200, max_bytes: 0,
        bypass_patterns: null, output_bypass_patterns: SECRET_OUTPUT_PATTERNS, invalidate_on: JSON.stringify(['preference_change']),
        key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
        enabled: 0,
      },
    ];
    for (const cp of cachePolicies) await this.createCachePolicy(cp);
    }

    // Identity Rules
    if (cnt('identity_rules') === 0) {
    const identityRules: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '71d997aa-fb08-446d-8123-1b774f3c7de5', name: 'Admin Full Access', description: 'Admins have unrestricted access to all resources',
        resource: '*', action: '*', roles: JSON.stringify(['admin']), scopes: null,
        result: 'allow', priority: 100, enabled: 1,
      },
      {
        id: '280a5cfc-548c-4714-aabb-5e6a5dcaaf44', name: 'User Chat Access', description: 'Regular users can read and write in chat',
        resource: 'chat:*', action: '*', roles: JSON.stringify(['user', 'agent']), scopes: JSON.stringify(['chat']),
        result: 'allow', priority: 50, enabled: 1,
      },
      {
        id: '89eee70b-407a-4a89-a5e8-17b69330da8a', name: 'Agent Tool Access', description: 'AI agents can use tools within defined scopes',
        resource: 'tools:*', action: 'execute', roles: JSON.stringify(['agent']), scopes: JSON.stringify(['tools']),
        result: 'allow', priority: 50, enabled: 1,
      },
      {
        id: '7ef01416-07ec-496b-be00-67926157a29e', name: 'Deny Non-Admin Panel', description: 'Non-admins cannot access admin settings',
        resource: 'admin:*', action: '*', roles: null, scopes: null,
        result: 'deny', priority: 10, enabled: 1,
      },
      {
        id: '29a67ad5-7424-4e81-887b-14b0b9d951bc', name: 'Sensitive Data Challenge', description: 'Challenge access to sensitive data requiring additional verification',
        resource: 'data:sensitive', action: 'read', roles: null, scopes: null,
        result: 'challenge', priority: 60, enabled: 1,
      },
    ];
    for (const ir of identityRules) await this.createIdentityRule(ir);
    }

    // Memory Governance
    if (cnt('memory_governance') === 0) {
    const memGov: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'b15e183e-66e3-4bd2-9b63-7dd540ca65ec', name: 'Block PII in Memory', description: 'Prevent storage of messages containing PII patterns',
        memory_types: JSON.stringify(['conversation', 'semantic']),
        tenant_id: null,
        block_patterns: JSON.stringify(['\\b\\d{3}-\\d{2}-\\d{4}\\b', '\\b\\d{16}\\b']),
        redact_patterns: JSON.stringify(['[\\w.+-]+@[\\w-]+\\.[\\w.]+', '\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b']),
        max_age: null, max_entries: null, enabled: 1,
      },
      {
        id: '9dbbe38c-a0a4-4f42-a1bc-a688d5b67103', name: 'Conversation Retention', description: 'Limit conversation memory to 30 days with max 10000 entries',
        memory_types: JSON.stringify(['conversation']),
        tenant_id: null,
        block_patterns: null, redact_patterns: null,
        max_age: 'P30D', max_entries: 10000, enabled: 1,
      },
      {
        id: '2a97b95b-6f01-4637-bc69-020d0597c02d', name: 'Semantic Memory Retention', description: 'Semantic facts retained for 90 days with a cap of 5000 entries',
        memory_types: JSON.stringify(['semantic']),
        tenant_id: null,
        block_patterns: null, redact_patterns: null,
        max_age: 'P90D', max_entries: 5000, enabled: 1,
      },
      {
        id: 'e6488668-f28f-4574-a7b0-49e45fc8aff2', name: 'No Secrets in Entity Memory', description: 'Block secrets and API keys from being stored as entity facts',
        memory_types: JSON.stringify(['entity']),
        tenant_id: null,
        block_patterns: JSON.stringify(['api[_\\s-]?key', 'secret[_\\s-]?key', 'password', 'bearer\\s+\\S+']),
        redact_patterns: null,
        max_age: null, max_entries: null, enabled: 1,
      },
    ];
    for (const g of memGov) await this.createMemoryGovernance(g);
    }

    // Memory extraction rules
    if (cnt('memory_extraction_rules') === 0) {
    const extractionRules: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '64e1189c-3e5a-41f3-ad5d-da4b1e962093',
        name: 'Self disclosure: name',
        description: 'Detect when user discloses their name',
        rule_type: 'self_disclosure',
        entity_type: null,
        pattern: "\\b(?:my name is|i\\'?m called|call me)\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)",
        flags: 'i',
        facts_template: null,
        priority: 100,
        enabled: 1,
      },
      {
        id: '729662dd-644c-4a42-8984-24ed5623bd4c',
        name: 'Self disclosure: location',
        description: 'Detect where user lives or is from',
        rule_type: 'self_disclosure',
        entity_type: null,
        pattern: "\\b(?:i live in|i\\'?m from|i am from|i reside in)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: null,
        priority: 95,
        enabled: 1,
      },
      {
        id: '464f8582-2df1-4b39-9749-a43f7eb21438',
        name: 'Self disclosure: work',
        description: 'Detect organization where user works',
        rule_type: 'self_disclosure',
        entity_type: null,
        pattern: "\\b(?:i work (?:at|for)|i\\'?m employed (?:at|by)|i\\'?m at)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: null,
        priority: 90,
        enabled: 1,
      },
      {
        id: '16d483a4-c2b9-4fea-9082-6a9bcb43befb',
        name: 'Entity extraction: person name',
        description: 'Extract a person entity from self name disclosure',
        rule_type: 'entity_extraction',
        entity_type: 'person',
        pattern: "\\b(?:my name is|i\\'?m called|call me)\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)",
        flags: 'i',
        facts_template: '{"relationship":"self"}',
        priority: 100,
        enabled: 1,
      },
      {
        id: 'e3354de1-15e6-4ecf-ad8e-e4d02127ee26',
        name: 'Entity extraction: location',
        description: 'Extract location entity from residence disclosure',
        rule_type: 'entity_extraction',
        entity_type: 'location',
        pattern: "\\b(?:i live in|i\\'?m from|i am from|i reside in)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: '{"relationship":"residence"}',
        priority: 95,
        enabled: 1,
      },
      {
        id: 'b7f3045d-6428-4f43-bda1-dd3a879f5951',
        name: 'Entity extraction: organization',
        description: 'Extract organization entity from employer disclosure',
        rule_type: 'entity_extraction',
        entity_type: 'organization',
        pattern: "\\b(?:i work (?:at|for)|i\\'?m employed (?:at|by)|i\\'?m at)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: '{"relationship":"employer"}',
        priority: 90,
        enabled: 1,
      },
      {
        id: 'dea53647-9c8a-4c29-9e02-5dd297fe9762',
        name: 'Entity extraction: preference',
        description: 'Extract preference topic from likes/loves/enjoys statements',
        rule_type: 'entity_extraction',
        entity_type: 'preference',
        pattern: '\\bi (?:like|love|enjoy|prefer)\\s+([a-zA-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)',
        flags: 'gi',
        facts_template: '{"sentiment":"positive"}',
        priority: 80,
        enabled: 1,
      },
    ];
    for (const r of extractionRules) await this.createMemoryExtractionRule(r);
    }

    // Search Providers
    if (cnt('search_providers') === 0) {
    const searchProviders: Omit<SearchProviderRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '6fce6815-171b-4d75-8502-65b720b829d3', name: 'DuckDuckGo', description: 'Free web search via DuckDuckGo Instant Answer API — no API key required',
        provider_type: 'duckduckgo', api_key: null, base_url: null, priority: 10,
        options: JSON.stringify({ safesearch: 'moderate', region: 'wt-wt' }), enabled: 1,
      },
      {
        id: '897b8e52-dc64-4854-ac39-65b92e00ccd8', name: 'Brave Search', description: 'Privacy-focused web search with Brave Search API',
        provider_type: 'brave', api_key: '', base_url: null, priority: 20,
        options: JSON.stringify({ count: 10, freshness: 'none' }), enabled: 0,
      },
      {
        id: 'f64e9011-5b20-41b0-bea3-6a86359e4f47', name: 'Tavily AI Search', description: 'AI-optimised search engine designed for LLM applications',
        provider_type: 'tavily', api_key: '', base_url: null, priority: 30,
        options: JSON.stringify({ search_depth: 'basic', include_answer: true }), enabled: 0,
      },
      {
        id: 'e770810c-7033-4fa5-b525-1befa69000dd', name: 'Google Custom Search', description: 'Google Programmable Search Engine for custom search experiences',
        provider_type: 'google', api_key: '', base_url: null, priority: 15,
        options: JSON.stringify({ cx: '', num: 10 }), enabled: 0,
      },
      {
        id: 'e2f358c3-89c4-48c4-aad2-3fb7153022ad', name: 'Serper (Google SERP)', description: 'Fast Google search results via Serper API',
        provider_type: 'serper', api_key: '', base_url: null, priority: 25,
        options: JSON.stringify({ gl: 'us', hl: 'en', num: 10 }), enabled: 0,
      },
    ];
    for (const sp of searchProviders) await this.createSearchProvider(sp);
    }

    // Tool Registry
    if (cnt('tool_registry') === 0) {
    const toolReg: Omit<ToolRegistryRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '66c73c20-622c-47a3-a21d-210bd8a2eb91', name: 'Web Search Tools', description: 'Search provider toolkit with multi-engine routing',
        package_name: '@weaveintel/tools/search', version: '1.0.0', category: 'search', risk_level: 'low',
        tags: JSON.stringify(['search', 'web', 'retrieval']),
        config: JSON.stringify({ defaultProvider: 'duckduckgo', maxResults: 10 }),
        requires_approval: 0, max_execution_ms: 15000, rate_limit_per_min: 30, enabled: 1,
      },
      {
        id: '2891e86c-a4d0-4fbc-8a6c-ede1c717ba89', name: 'HTTP Endpoint Tools', description: 'Dynamic HTTP request toolkit with auth, retry, and transforms',
        package_name: '@weaveintel/tools/http', version: '1.0.0', category: 'integration', risk_level: 'medium',
        tags: JSON.stringify(['http', 'api', 'rest']),
        config: JSON.stringify({ defaultRetries: 2, defaultTimeout: 10000 }),
        requires_approval: 0, max_execution_ms: 20000, rate_limit_per_min: 30, enabled: 1,
      },
      {
        id: 'f27606f3-534b-4760-aa95-77dc4e52da3e', name: 'Browser & Scraping Tools', description: 'Web page fetching, content extraction, and readability tools',
        package_name: '@weaveintel/tools-browser', version: '1.0.0', category: 'browser', risk_level: 'low',
        tags: JSON.stringify(['browser', 'scrape', 'extract', 'readability']),
        config: JSON.stringify({ defaultTimeout: 10000, maxBodySize: 1048576 }),
        requires_approval: 0, max_execution_ms: 15000, rate_limit_per_min: 20, enabled: 1,
      },
      {
        id: '212ad0f7-2ad2-43e1-94d0-49be0a73d2bf', name: 'Social Platform Tools', description: 'Slack, Discord, and GitHub integrations',
        package_name: '@weaveintel/tools/social', version: '1.0.0', category: 'social', risk_level: 'medium',
        tags: JSON.stringify(['slack', 'discord', 'github', 'social']),
        config: null,
        requires_approval: 0, max_execution_ms: 10000, rate_limit_per_min: 20, enabled: 1,
      },
      {
        id: '0566e9f3-00c5-4ef2-9ac9-7012c477d5fd', name: 'Enterprise Connector Tools', description: 'Jira, Confluence, Salesforce, and Notion integrations',
        package_name: '@weaveintel/tools-enterprise', version: '1.0.0', category: 'enterprise', risk_level: 'medium',
        tags: JSON.stringify(['jira', 'confluence', 'salesforce', 'notion', 'enterprise']),
        config: null,
        requires_approval: 0, max_execution_ms: 20000, rate_limit_per_min: 15, enabled: 1,
      },
    ];
    for (const tr of toolReg) await this.createToolRegistryEntry(tr);
    }

    // Replay Scenarios
    if (cnt('replay_scenarios') === 0) {
    const replayScenarios: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'c6c1387d-1cdd-4c7d-8c2a-0964d3481c51', name: 'Greeting Test', description: 'Verify the assistant handles basic greetings correctly',
        golden_prompt: 'Hello! How are you?',
        golden_response: 'Hello! I\'m doing great, thanks for asking. How can I help you today?',
        model: 'gpt-4o-mini', provider: 'openai',
        tags: JSON.stringify(['basic', 'greeting', 'regression']),
        acceptance_criteria: JSON.stringify({ min_match_rate: 0.7, max_duration_ms: 5000 }),
        enabled: 1,
      },
      {
        id: '1eef00ae-efa6-49ee-94ee-5c9a9e301e86', name: 'Code Review Scenario', description: 'Test code review accuracy against a golden response',
        golden_prompt: 'Review this JavaScript function for bugs:\\nfunction add(a, b) { return a - b; }',
        golden_response: 'Bug found: The function is named "add" but performs subtraction (a - b). It should be return a + b;',
        model: 'gpt-4o', provider: 'openai',
        tags: JSON.stringify(['code', 'review', 'regression']),
        acceptance_criteria: JSON.stringify({ min_match_rate: 0.6, required_step_matches: ['bug', 'subtraction'] }),
        enabled: 1,
      },
      {
        id: '6d68edbb-4641-42b3-8de6-26b61faecf17', name: 'Summarization Quality', description: 'Test document summarization quality and completeness',
        golden_prompt: 'Summarize: AI is transforming healthcare through diagnostics, drug discovery, and personalized medicine. Key challenges include data privacy, bias, and regulatory compliance.',
        golden_response: 'AI is revolutionizing healthcare in three areas: diagnostics, drug discovery, and personalized medicine. Main challenges are data privacy, algorithmic bias, and regulatory compliance.',
        model: null, provider: null,
        tags: JSON.stringify(['summarization', 'quality']),
        acceptance_criteria: JSON.stringify({ min_match_rate: 0.5 }),
        enabled: 1,
      },
    ];
    for (const s of replayScenarios) await this.createReplayScenario(s);
    }

    // Trigger Definitions
    if (cnt('trigger_definitions') === 0) {
    const triggerDefs: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'b97f561c-b948-447c-8d52-2d1d681a232e', name: 'Daily Eval Sweep', description: 'Run evaluation suite every day at 2 AM UTC',
        trigger_type: 'cron', expression: '0 2 * * *',
        config: JSON.stringify({ timezone: 'UTC', skipIfRunning: true }),
        target_workflow: '3aedac32-ef1a-429f-89d7-23d481ccd8ad', status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
      },
      {
        id: '6e5be73b-49a5-461a-8cfe-4ff5c758955f', name: 'Deploy Webhook', description: 'Trigger workflow on deployment webhook from CI/CD',
        trigger_type: 'webhook', expression: null,
        config: JSON.stringify({ path: '/hooks/deploy', method: 'POST', requiredHeaders: ['X-Deploy-Token'] }),
        target_workflow: '3aedac32-ef1a-429f-89d7-23d481ccd8ad', status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
      },
      {
        id: '43de3406-4ee5-4ea6-b3ef-0ca283afe1a7', name: 'Queue Analysis Jobs', description: 'Process queued data analysis requests',
        trigger_type: 'queue', expression: null,
        config: JSON.stringify({ queueName: 'analysis-jobs', concurrency: 3, pollIntervalMs: 5000 }),
        target_workflow: null, status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
      },
      {
        id: '1ca7843f-9aa0-4298-8bb5-752ad4c263c6', name: 'Model Config Change', description: 'Re-run golden tests when model configuration changes',
        trigger_type: 'change', expression: null,
        config: JSON.stringify({ resourceType: 'model-config', changeTypes: ['updated'], debounceMs: 10000 }),
        target_workflow: null, status: 'paused', last_fired_at: null, fire_count: 0, enabled: 0,
      },
    ];
    for (const t of triggerDefs) await this.createTriggerDefinition(t);
    }

    // Tenant Configs
    if (cnt('tenant_configs') === 0) {
    const tenantConfigs: Omit<TenantConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '9ce41ecd-202f-49bf-8042-1ff7a296e537', name: 'Default Tenant', description: 'Default tenant configuration with standard limits',
        tenant_id: 'default', scope: 'global',
        allowed_models: JSON.stringify(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6']),
        denied_models: null,
        allowed_tools: JSON.stringify(['web-search', 'file-reader', 'api-caller']),
        max_tokens_daily: 100000, max_cost_daily: 5.0,
        max_tokens_monthly: 2000000, max_cost_monthly: 100.0,
        features: JSON.stringify(['chat', 'agent', 'tools', 'eval']),
        config_overrides: null, enabled: 1,
      },
      {
        id: '0291280f-f15f-44dc-ac95-bc2a61e88cbd', name: 'Enterprise Tenant', description: 'Enterprise tier with expanded limits and all features',
        tenant_id: 'enterprise', scope: 'organization',
        allowed_models: JSON.stringify(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6', 'claude-opus-4-7']),
        denied_models: null,
        allowed_tools: JSON.stringify(['web-search', 'file-reader', 'api-caller', 'code-exec', 'db-query']),
        max_tokens_daily: 500000, max_cost_daily: 25.0,
        max_tokens_monthly: 10000000, max_cost_monthly: 500.0,
        features: JSON.stringify(['chat', 'agent', 'supervisor', 'tools', 'eval', 'workflows', 'replay']),
        config_overrides: JSON.stringify({ max_concurrent_runs: 10 }), enabled: 1,
      },
      {
        id: 'b061bbe6-2ded-4c77-afad-33473b4cb4fa', name: 'Trial Tenant', description: 'Free trial with limited access',
        tenant_id: 'trial', scope: 'tenant',
        allowed_models: JSON.stringify(['gpt-4o-mini']),
        denied_models: JSON.stringify(['claude-opus-4-7']),
        allowed_tools: JSON.stringify(['web-search']),
        max_tokens_daily: 10000, max_cost_daily: 0.5,
        max_tokens_monthly: 100000, max_cost_monthly: 5.0,
        features: JSON.stringify(['chat']),
        config_overrides: null, enabled: 1,
      },
    ];
    for (const c of tenantConfigs) await this.createTenantConfig(c);
    }

    // Sandbox Policies
    if (cnt('sandbox_policies') === 0) {
    const sandboxPolicies: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'f694e2d8-172c-4ed2-bab7-35720a28149f', name: 'Strict Sandbox', description: 'Highly restrictive sandbox for untrusted code execution',
        max_cpu_ms: 5000, max_memory_mb: 64, max_duration_ms: 10000, max_output_bytes: 65536,
        allowed_modules: JSON.stringify(['Math', 'Date', 'JSON']),
        denied_modules: JSON.stringify(['fs', 'net', 'child_process', 'http', 'https', 'crypto']),
        network_access: 0, filesystem_access: 'none', enabled: 1,
      },
      {
        id: '1b9b4d0e-5307-439d-9608-cac2695ac07f', name: 'Moderate Sandbox', description: 'Balanced sandbox allowing read-only filesystem and select modules',
        max_cpu_ms: 30000, max_memory_mb: 256, max_duration_ms: 60000, max_output_bytes: 1048576,
        allowed_modules: JSON.stringify(['Math', 'Date', 'JSON', 'crypto', 'path', 'url']),
        denied_modules: JSON.stringify(['child_process', 'net', 'cluster', 'worker_threads']),
        network_access: 0, filesystem_access: 'read-only', enabled: 1,
      },
      {
        id: 'f7054708-cbbf-48cd-b3db-16271a4adb10', name: 'Permissive Sandbox', description: 'Relaxed sandbox for trusted internal code with network access',
        max_cpu_ms: 120000, max_memory_mb: 512, max_duration_ms: 300000, max_output_bytes: 10485760,
        allowed_modules: null, denied_modules: JSON.stringify(['child_process', 'cluster']),
        network_access: 1, filesystem_access: 'read-write', enabled: 1,
      },
    ];
    for (const p of sandboxPolicies) await this.createSandboxPolicy(p);
    }

    // Extraction Pipelines
    if (cnt('extraction_pipelines') === 0) {
    const extractionPipelines: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'dd32d2f8-ccd6-4f93-8aa8-e8859ca9456b', name: 'Full Extraction', description: 'Runs all extraction stages: metadata, language, entities, tables, code, tasks, timeline',
        stages: JSON.stringify([
          { type: 'metadata', enabled: true, order: 1 },
          { type: 'language', enabled: true, order: 2 },
          { type: 'entities', enabled: true, order: 3 },
          { type: 'tables', enabled: true, order: 4 },
          { type: 'code', enabled: true, order: 5 },
          { type: 'tasks', enabled: true, order: 6 },
          { type: 'timeline', enabled: true, order: 7 },
        ]),
        input_mime_types: JSON.stringify(['text/plain', 'text/markdown', 'text/html', 'application/pdf']),
        max_input_size_bytes: 10485760, enabled: 1,
      },
      {
        id: '28e7b976-5201-4170-9c7a-ee813e9b2ff5', name: 'Code Extraction', description: 'Extracts code blocks and related entities from technical documents',
        stages: JSON.stringify([
          { type: 'metadata', enabled: true, order: 1 },
          { type: 'code', enabled: true, order: 2 },
          { type: 'entities', enabled: true, order: 3 },
        ]),
        input_mime_types: JSON.stringify(['text/plain', 'text/markdown']),
        max_input_size_bytes: 5242880, enabled: 1,
      },
      {
        id: 'b3f4b90f-7094-4ae5-bbda-bf3f106b4c7c', name: 'Tasks & Timeline', description: 'Extracts tasks, deadlines, and chronological events',
        stages: JSON.stringify([
          { type: 'metadata', enabled: true, order: 1 },
          { type: 'tasks', enabled: true, order: 2 },
          { type: 'timeline', enabled: true, order: 3 },
          { type: 'entities', enabled: true, order: 4 },
        ]),
        input_mime_types: JSON.stringify(['text/plain', 'text/markdown', 'text/html']),
        max_input_size_bytes: 5242880, enabled: 1,
      },
    ];
    for (const p of extractionPipelines) await this.createExtractionPipeline(p);
    }

    // Artifact Policies
    if (cnt('artifact_policies') === 0) {
    const artifactPolicies: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '5cb95d9c-1bfe-4eb3-b1c4-0a2bab12988f', name: 'Default Artifact Policy', description: 'Standard artifact policy with 100MB limit and 90-day retention',
        max_size_bytes: 104857600, allowed_types: JSON.stringify(['text', 'csv', 'json', 'html', 'markdown', 'image', 'code', 'report']),
        retention_days: 90, require_versioning: 1, enabled: 1,
      },
      {
        id: 'fb9ad62b-b0ec-4a89-af1c-9cea0e4b9c9a', name: 'Strict Artifact Policy', description: 'Restrictive policy for sensitive environments — small size limit, short retention',
        max_size_bytes: 10485760, allowed_types: JSON.stringify(['text', 'json', 'csv']),
        retention_days: 30, require_versioning: 1, enabled: 1,
      },
      {
        id: 'eda3f580-8b10-4d88-b0bc-2f1f5bf1a9a9', name: 'Large Artifact Policy', description: 'Policy for large outputs — PDFs, reports, diagrams — with extended retention',
        max_size_bytes: 1073741824, allowed_types: JSON.stringify(['text', 'csv', 'json', 'html', 'markdown', 'image', 'pdf', 'diagram', 'code', 'report', 'custom']),
        retention_days: 365, require_versioning: 1, enabled: 1,
      },
    ];
    for (const p of artifactPolicies) await this.createArtifactPolicy(p);
    }

    // Reliability Policies
    if (cnt('reliability_policies') === 0) {
    const reliabilityPolicies: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '7558015a-aacd-4b89-acf1-6f11e6cb4d74', name: 'Default Retry', description: 'Standard exponential backoff retry for transient failures',
        policy_type: 'retry', max_retries: 3, initial_delay_ms: 1000, max_delay_ms: 30000, backoff_multiplier: 2.0,
        max_concurrent: null, queue_size: null, strategy: null, ttl_ms: null, enabled: 1,
      },
      {
        id: 'fe035101-0621-43ce-a133-ca8a74022859', name: 'Aggressive Retry', description: 'More retries with shorter delays for critical operations',
        policy_type: 'retry', max_retries: 5, initial_delay_ms: 500, max_delay_ms: 15000, backoff_multiplier: 1.5,
        max_concurrent: null, queue_size: null, strategy: null, ttl_ms: null, enabled: 1,
      },
      {
        id: 'eb4778d5-c048-4c54-892a-bcfeb245e95b', name: 'Standard Concurrency', description: 'Limit concurrent executions with queuing for overflow',
        policy_type: 'concurrency', max_retries: null, initial_delay_ms: null, max_delay_ms: null, backoff_multiplier: null,
        max_concurrent: 10, queue_size: 50, strategy: 'queue', ttl_ms: 60000, enabled: 1,
      },
      {
        id: 'fbd7d3d6-4e70-47ff-9e2a-4e1e2bb62ef7', name: 'Idempotency Guard', description: 'Prevent duplicate processing within a 5-minute window',
        policy_type: 'idempotency', max_retries: null, initial_delay_ms: null, max_delay_ms: null, backoff_multiplier: null,
        max_concurrent: null, queue_size: null, strategy: null, ttl_ms: 300000, enabled: 1,
      },
    ];
    for (const p of reliabilityPolicies) await this.createReliabilityPolicy(p);
    }

    // Collaboration Sessions
    if (cnt('collaboration_sessions') === 0) {
    const collabSessions: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '24bfff3d-7f7b-4ca2-9711-5be4488215ea', name: 'Pair Programming', description: 'Two-participant session for pair programming with real-time code sharing',
        session_type: 'pair', max_participants: 2, presence_ttl_ms: 30000, auto_close_idle_ms: 600000,
        handoff_enabled: 1, enabled: 1,
      },
      {
        id: '4a79d9c8-5959-4839-a653-7caf09583aae', name: 'Team Collaboration', description: 'Multi-participant session for team brainstorming and collaborative problem solving',
        session_type: 'team', max_participants: 10, presence_ttl_ms: 60000, auto_close_idle_ms: 1800000,
        handoff_enabled: 1, enabled: 1,
      },
      {
        id: '3893f5a8-d061-43d7-920f-6d82167e54f6', name: 'Broadcast Session', description: 'One-to-many session for presentations and demos with view-only participants',
        session_type: 'broadcast', max_participants: 50, presence_ttl_ms: 120000, auto_close_idle_ms: null,
        handoff_enabled: 0, enabled: 1,
      },
    ];
    for (const s of collabSessions) await this.createCollaborationSession(s);
    }

    // Compliance Rules
    if (cnt('compliance_rules') === 0) {
    const complianceRules: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '726c5bfc-cdb2-47f0-9d08-177f656f6821', name: '90-Day Data Retention', description: 'Delete chat logs and metrics older than 90 days',
        rule_type: 'retention', target_resource: 'messages', retention_days: 90,
        region: null, consent_purpose: null, action: 'delete',
        config: JSON.stringify({ include_metadata: true }), enabled: 1,
      },
      {
        id: 'f56c10ea-07b4-4e8e-8824-8a5a50d1ced7', name: 'GDPR Right to Delete', description: 'Honor user deletion requests within 30 days per GDPR Article 17',
        rule_type: 'deletion', target_resource: '*', retention_days: null,
        region: 'EU', consent_purpose: null, action: 'delete',
        config: JSON.stringify({ cascade: true, notify_processors: true }), enabled: 1,
      },
      {
        id: 'a8ef9ac5-977a-4a8c-a473-9cae50d0f132', name: 'EU Data Residency', description: 'Ensure EU user data stays within EU regions only',
        rule_type: 'residency', target_resource: '*', retention_days: null,
        region: 'EU', consent_purpose: null, action: 'block',
        config: JSON.stringify({ allowed_regions: ['eu-west-1', 'eu-central-1', 'eu-north-1'] }), enabled: 1,
      },
      {
        id: '93e3d7d5-80ac-4924-9916-018e44122ad3', name: 'Analytics Consent', description: 'Require explicit consent for analytics data collection',
        rule_type: 'consent', target_resource: 'metrics', retention_days: null,
        region: null, consent_purpose: 'analytics', action: 'notify',
        config: JSON.stringify({ consent_ttl_days: 365, re_consent_required: true }), enabled: 1,
      },
    ];
    for (const r of complianceRules) await this.createComplianceRule(r);
    }

    // Graph Configs
    if (cnt('graph_configs') === 0) {
    const graphConfigs: Omit<GraphConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '19d8bf98-fe69-4bfb-84c7-31181f171f28', name: 'Entity Knowledge Graph', description: 'General-purpose entity extraction and relationship mapping',
        graph_type: 'entity', max_depth: 3,
        entity_types: JSON.stringify(['person', 'organization', 'location', 'product', 'concept']),
        relationship_types: JSON.stringify(['works_at', 'located_in', 'related_to', 'depends_on', 'part_of']),
        auto_link: 1, scoring_weights: JSON.stringify({ relevance: 0.4, recency: 0.3, frequency: 0.3 }), enabled: 1,
      },
      {
        id: '0abab6b4-93cc-4664-a99d-200bd9378dee', name: 'Timeline Graph', description: 'Chronological event tracking with causal links between events',
        graph_type: 'timeline', max_depth: 5,
        entity_types: JSON.stringify(['event', 'milestone', 'decision']),
        relationship_types: JSON.stringify(['caused_by', 'preceded_by', 'concurrent_with']),
        auto_link: 1, scoring_weights: JSON.stringify({ temporal_proximity: 0.5, causal_strength: 0.5 }), enabled: 1,
      },
      {
        id: '27efa1f1-bec8-4c09-a7a3-c2e472b1125d', name: 'Knowledge Base', description: 'Long-term knowledge graph for RAG-augmented memory and retrieval',
        graph_type: 'knowledge', max_depth: 4,
        entity_types: JSON.stringify(['concept', 'definition', 'example', 'reference']),
        relationship_types: JSON.stringify(['defines', 'exemplifies', 'references', 'contradicts', 'supports']),
        auto_link: 0, scoring_weights: JSON.stringify({ semantic_similarity: 0.6, authority: 0.2, recency: 0.2 }), enabled: 1,
      },
    ];
    for (const g of graphConfigs) await this.createGraphConfig(g);
    }

    // Plugin Configs
    if (cnt('plugin_configs') === 0) {
    const pluginConfigs: Omit<PluginConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '1a4cac30-57a8-4853-b2d9-e8048ade5fc5', name: 'Code Execution Plugin', description: 'Sandboxed code execution for JavaScript and Python',
        plugin_type: 'official', package_name: '@weaveintel/sandbox', version: '1.0.0',
        capabilities: JSON.stringify(['code-execution', 'sandboxing']),
        trust_level: 'official', auto_update: 1,
        config: JSON.stringify({ defaultPolicy: '1b9b4d0e-5307-439d-9608-cac2695ac07f' }), enabled: 1,
      },
      {
        id: '0146baef-15d0-40ec-98f0-40c88f34b9b3', name: 'Web Search Plugin', description: 'Integrate external search providers for web search capabilities',
        plugin_type: 'official', package_name: '@weaveintel/tools/search', version: '1.0.0',
        capabilities: JSON.stringify(['web-search', 'news-search']),
        trust_level: 'official', auto_update: 1,
        config: JSON.stringify({ defaultProvider: '897b8e52-dc64-4854-ac39-65b92e00ccd8' }), enabled: 1,
      },
      {
        id: 'ad0e5e5b-4af3-4bd9-84e3-5fc2b84bb465', name: 'Data Visualization', description: 'Community plugin for generating charts and data visualizations',
        plugin_type: 'community', package_name: 'weaveintel-plugin-viz', version: '0.3.2',
        capabilities: JSON.stringify(['visualization', 'chart-generation']),
        trust_level: 'community', auto_update: 0,
        config: null, enabled: 1,
      },
      {
        id: 'b9550588-d6e3-4d8f-961f-93ed1d841671', name: 'Enterprise SSO', description: 'SAML/OIDC single sign-on integration for enterprise deployments',
        plugin_type: 'verified', package_name: 'weaveintel-plugin-sso', version: '2.1.0',
        capabilities: JSON.stringify(['authentication', 'sso', 'saml', 'oidc']),
        trust_level: 'verified', auto_update: 1,
        config: JSON.stringify({ provider: 'okta', domain: 'example.okta.com' }), enabled: 0,
      },
    ];
    for (const p of pluginConfigs) await this.createPluginConfig(p);
    }

    // Scaffold Templates (Phase 9)
    if (cnt('scaffold_templates') === 0) {
    const scaffoldTemplates: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'd2d4c9c7-4f26-4de8-b8b9-21c1caadf3d1', name: 'Basic Agent', description: 'Minimal conversational agent with a single model',
        template_type: 'basic-agent',
        files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\n\nconst agent = createAgent({ name: "{{name}}", model: "{{model}}" });\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'model']),
        post_install: null, enabled: 1,
      },
      {
        id: '238db0e5-0a97-408a-87ea-411b7bb90556', name: 'Tool-Calling Agent', description: 'Agent with tool registration and execution capabilities',
        template_type: 'tool-calling-agent',
        files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\nimport { defineTool } from "@weaveintel/core";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'model']),
        post_install: null, enabled: 1,
      },
      {
        id: '955d8720-fb97-41e2-8e21-f6f5ed8bd944', name: 'RAG Pipeline', description: 'Retrieval-augmented generation pipeline with vector search',
        template_type: 'rag-pipeline',
        files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\nimport { createRetriever } from "@weaveintel/retrieval";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/retrieval': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'model', 'collection']),
        post_install: null, enabled: 1,
      },
      {
        id: 'b65b2a2d-6173-49bf-af09-5fbaf48d1b92', name: 'Workflow', description: 'Multi-step workflow with agent orchestration',
        template_type: 'workflow',
        files: JSON.stringify({ 'src/index.ts': 'import { createWorkflow } from "@weaveintel/workflows";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/workflows': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name']),
        post_install: null, enabled: 1,
      },
      {
        id: 'b1d3f948-420e-4798-8c16-99c8b0cc46a3', name: 'Multi-Agent', description: 'Supervisor with multiple worker agents',
        template_type: 'multi-agent',
        files: JSON.stringify({ 'src/index.ts': 'import { createSupervisor } from "@weaveintel/agents";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'workers']),
        post_install: null, enabled: 1,
      },
      {
        id: 'b61ad2bf-cce5-4989-8800-d51e092fc309', name: 'MCP Server', description: 'Model Context Protocol server exposing tools over stdio/SSE',
        template_type: 'mcp-server',
        files: JSON.stringify({ 'src/index.ts': 'import { createMcpServer } from "@weaveintel/mcp-server";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/mcp-server': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'transport']),
        post_install: null, enabled: 1,
      },
      {
        id: 'e27a18c3-7718-46e0-9f71-425ec51802b0', name: 'Full-Stack App', description: 'Complete application with geneWeave UI, agents, tools, and observability',
        template_type: 'full-stack',
        files: JSON.stringify({ 'src/index.ts': 'import { startGeneWeave } from "@weaveintel/geneweave";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/geneweave': '*', '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/observability': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0', '@playwright/test': '^1.59.0' }),
        variables: JSON.stringify(['name', 'model', 'provider']),
        post_install: 'npx playwright install', enabled: 1,
      },
    ];
    for (const t of scaffoldTemplates) await this.createScaffoldTemplate(t);
    }

    // Recipe Configs (Phase 9)
    if (cnt('recipe_configs') === 0) {
    const recipeConfigs: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '762dba63-d819-4f85-a86f-5f6788c42c99', name: 'Workflow Agent', description: 'Workflow-aware agent with step-by-step execution',
        recipe_type: 'workflow', model: 'gpt-4o', provider: 'openai',
        system_prompt: 'You are a workflow executor. Follow the steps precisely.',
        tools: JSON.stringify(['web-search', 'file-reader']),
        guardrails: JSON.stringify(['1a6b5225-07c6-41cc-878f-c0d08930c1de']),
        max_steps: 10, options: null, enabled: 1,
      },
      {
        id: '5a5b3951-4ca6-49b8-9ab4-b09a679e5275', name: 'Governed Assistant', description: 'Assistant with governance rules enforced in system prompt',
        recipe_type: 'governed', model: 'gpt-4o', provider: 'openai',
        system_prompt: 'You are a governed assistant. Follow all policies strictly.',
        tools: null,
        guardrails: JSON.stringify(['0370fa22-5fc8-49a4-bd4c-3e39863da61d', '51586988-83b7-4780-a006-b3b86b76713f']),
        max_steps: 5, options: JSON.stringify({ governanceLevel: 'strict' }), enabled: 1,
      },
      {
        id: 'b046bcff-9950-46bf-b107-ab6baf097240', name: 'Approval-Driven Agent', description: 'Agent that requires human approval for high-risk actions',
        recipe_type: 'approval', model: 'gpt-4o', provider: 'openai',
        system_prompt: null,
        tools: JSON.stringify(['code-exec', 'db-query']),
        guardrails: null,
        max_steps: 8, options: JSON.stringify({ approvalPolicy: 'cc83adb8-bf49-4fb0-83c4-fa27da65dc56' }), enabled: 1,
      },
      {
        id: '58bea5c2-662b-4c41-9f8e-203c59885931', name: 'ACL-Aware RAG', description: 'Retrieval agent with access-control-scoped collections',
        recipe_type: 'acl-rag', model: 'gpt-4o-mini', provider: 'openai',
        system_prompt: 'You answer questions using only the provided context.',
        tools: JSON.stringify(['web-search']),
        guardrails: JSON.stringify(['8ae24528-463a-4dfa-9348-a2be5214de9f']),
        max_steps: 5, options: JSON.stringify({ collection: 'default' }), enabled: 1,
      },
      {
        id: 'ddfd4301-7bf5-459c-a458-59785c6d6995', name: 'Safe Execution Agent', description: 'Agent with denied tools and defensive execution limits',
        recipe_type: 'safe-exec', model: 'gpt-4o-mini', provider: 'openai',
        system_prompt: 'You are a safe execution agent. Never execute dangerous operations.',
        tools: JSON.stringify(['file-reader', 'api-caller']),
        guardrails: JSON.stringify(['0370fa22-5fc8-49a4-bd4c-3e39863da61d', '1a6b5225-07c6-41cc-878f-c0d08930c1de']),
        max_steps: 5, options: JSON.stringify({ maxExecutionTime: 30000, deniedTools: ['code-exec'] }), enabled: 1,
      },
    ];
    for (const r of recipeConfigs) await this.createRecipeConfig(r);
    }

    // Widget Configs (Phase 9)
    if (cnt('widget_configs') === 0) {
    const widgetConfigs: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'd309940a-bd09-4899-ace5-a0acd53f2325', name: 'Data Table', description: 'Sortable, filterable data table for structured results',
        widget_type: 'table',
        default_options: JSON.stringify({ sortable: true, filterable: true, pageSize: 25 }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard', 'admin']),
        max_data_points: 10000, refresh_interval_ms: null, enabled: 1,
      },
      {
        id: '7fe15c63-2ffd-413f-93e8-1681d5dc5c5b', name: 'Chart', description: 'Line, bar, or pie chart for data visualization',
        widget_type: 'chart',
        default_options: JSON.stringify({ chartType: 'line', showLegend: true, responsive: true }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard']),
        max_data_points: 5000, refresh_interval_ms: 30000, enabled: 1,
      },
      {
        id: 'a3b5a4a7-6cd7-45b6-9715-3221ede6e2f0', name: 'Dynamic Form', description: 'Interactive form widget for collecting structured input',
        widget_type: 'form',
        default_options: JSON.stringify({ submitLabel: 'Submit', resetLabel: 'Reset' }),
        allowed_contexts: JSON.stringify(['chat']),
        max_data_points: null, refresh_interval_ms: null, enabled: 1,
      },
      {
        id: '4d57f558-6068-44ff-9f45-354696fcdb59', name: 'Code Block', description: 'Syntax-highlighted code viewer with copy and download',
        widget_type: 'code',
        default_options: JSON.stringify({ lineNumbers: true, theme: 'dark', wordWrap: false }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard', 'admin']),
        max_data_points: null, refresh_interval_ms: null, enabled: 1,
      },
      {
        id: '464ec787-112f-413f-a376-ce534a3c505c', name: 'Timeline', description: 'Chronological event timeline for workflow and trace visualisation',
        widget_type: 'timeline',
        default_options: JSON.stringify({ direction: 'vertical', showDuration: true }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard']),
        max_data_points: 500, refresh_interval_ms: 10000, enabled: 1,
      },
      {
        id: '337c379d-22df-44af-980c-04c453398169', name: 'Image', description: 'Image display widget with zoom and lightbox support',
        widget_type: 'image',
        default_options: JSON.stringify({ maxWidth: '100%', lightbox: true }),
        allowed_contexts: JSON.stringify(['chat']),
        max_data_points: null, refresh_interval_ms: null, enabled: 1,
      },
    ];
    for (const w of widgetConfigs) await this.createWidgetConfig(w);
    }

    // Validation Rules (Phase 9)
    if (cnt('validation_rules') === 0) {
    const validationRules: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: '940eb416-6e60-47bc-9d7d-3fca55c7b98d', name: 'Agent Name Required', description: 'Every agent config must have a non-empty name',
        rule_type: 'required', target: 'agent-config',
        condition: JSON.stringify({ field: 'name', operator: 'exists' }),
        severity: 'error', message: 'Agent name is required', enabled: 1,
      },
      {
        id: '014b4186-c36f-4f61-b8c3-bf2545023199', name: 'Agent Max Steps Range', description: 'Max steps must be between 1 and 100',
        rule_type: 'range', target: 'agent-config',
        condition: JSON.stringify({ field: 'maxSteps', min: 1, max: 100 }),
        severity: 'error', message: 'Max steps must be between 1 and 100', enabled: 1,
      },
      {
        id: 'c5985869-b721-40a2-b4ef-529bb975c84c', name: 'Workflow Entry Step', description: 'Workflow must define a valid entry step ID',
        rule_type: 'required', target: 'workflow-config',
        condition: JSON.stringify({ field: 'entry_step_id', operator: 'exists' }),
        severity: 'error', message: 'Workflow must have an entry step', enabled: 1,
      },
      {
        id: 'b6490a1a-2ddf-41ad-9a7b-6d406808cf86', name: 'Tool Risk Level', description: 'High-risk tools should require approval',
        rule_type: 'custom', target: 'tool-config',
        condition: JSON.stringify({ if: { field: 'risk_level', equals: 'high' }, then: { field: 'requires_approval', equals: true } }),
        severity: 'warning', message: 'High-risk tools should require approval', enabled: 1,
      },
      {
        id: '892adcec-808b-4c17-bc2c-c5c45cfe47fb', name: 'Valid JSON Fields', description: 'Fields marked as JSON must contain valid JSON or be null',
        rule_type: 'custom', target: 'agent-config',
        condition: JSON.stringify({ fields: ['tools', 'guardrails', 'metadata'], validate: 'json' }),
        severity: 'error', message: 'JSON fields must contain valid JSON', enabled: 1,
      },
    ];
    for (const r of validationRules) await this.createValidationRule(r);
    }

    // ── Hypothesis Validation seed data ──────────────────────
    // Check for the specific seed ID rather than "table is empty" so that
    // bootstrap migrations that pre-insert SV budget envelopes (e.g. m72) do
    // not suppress creation of the system default envelopes.
    if (!(this.d.prepare(`SELECT 1 FROM hv_budget_envelope WHERE id = '019500000-0000-7000-8000-000000000001'`).get())) {
      await this.createBudgetEnvelope({
        id: '019500000-0000-7000-8000-000000000001',
        tenant_id: 'system',
        name: 'Default Research Budget',
        max_llm_cents: 500,
        max_sandbox_cents: 200,
        max_wall_seconds: 300,
        max_rounds: 10,
        diminishing_returns_epsilon: 0.05,
      });
      await this.createBudgetEnvelope({
        id: '019500000-0000-7000-8000-000000000002',
        tenant_id: 'system',
        name: 'High-Throughput Budget',
        max_llm_cents: 2000,
        max_sandbox_cents: 1000,
        max_wall_seconds: 600,
        max_rounds: 20,
        diminishing_returns_epsilon: 0.02,
      });
    }
    if (cnt('hv_hypothesis') === 0) {
      await this.createHypothesis({
        id: '019500000-0000-7000-8000-000000000010',
        tenant_id: 'system',
        submitted_by: 'system',
        title: 'Sample: Vitamin D reduces COVID-19 severity',
        statement: 'Supplementation with vitamin D at therapeutic doses (≥4000 IU/day) reduces ICU admission rate in COVID-19 patients by at least 20% compared to standard care.',
        domain_tags: JSON.stringify(['medicine', 'nutrition', 'covid-19']),
        status: 'queued',
        budget_envelope_id: '019500000-0000-7000-8000-000000000001',
        workflow_run_id: null,
        trace_id: null,
        contract_id: null,
      });
    }

    // ─── anyWeave Task-Aware Routing — Phase 1 seeds ───────────
    // Idempotent: INSERT OR IGNORE on the unique key columns.
    await this.seedAnyWeaveRoutingPhase1();

    // ─── Cost Governor — default cost policies (4 tiers) ───────
    // Phase 2 ships the table; Phase 3 ships the seed data so operators
    // and runtime resolvers always have at least one binding target per
    // tier. Idempotent via INSERT OR IGNORE on `cost_policies.key`.
    await this.seedDefaultCostPolicies();

    // ─── Tenant Encryption Phase 1 — default disabled-policy row ───
    // Operators see one example tenant in admin (`demo-encrypted-tenant`)
    // with encryption disabled. Flipping `enabled = 1` and calling
    // `bootstrapTenant(...)` materializes a KEK + DEK + BIK on first use.
    // Idempotent via INSERT OR IGNORE.
    await this.seedDefaultEncryptionPolicies();
  }

  /**
   * Phase 3 — seed the four built-in cost-policy tier rows. Idempotent.
   * `levers_json = '{}'` means "use the tier preset defaults from
   * `@weaveintel/cost-governor`" — no per-policy overrides. Operators
   * can edit `levers_json` later to override individual levers.
   */
  private async seedDefaultCostPolicies(): Promise<void> {
    const stmt = this.d.prepare(
      `INSERT OR IGNORE INTO cost_policies (id, key, tier, levers_json, description, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    const rows: Array<{ id: string; key: string; tier: string; levers: string; description: string }> = [
      { id: '019700000-c057-7000-8000-000000000001', key: 'economy',     tier: 'economy',     levers: '{}', description: 'Cheapest tier: small models, aggressive caching, history compaction, minimal tools.' },
      { id: '019700000-c057-7000-8000-000000000002', key: 'balanced',    tier: 'balanced',    levers: '{}', description: 'Default tier: balanced quality/cost. Caching enabled, moderate tool subset.' },
      { id: '019700000-c057-7000-8000-000000000003', key: 'performance', tier: 'performance', levers: '{}', description: 'Higher quality tier: prefers stronger models, looser tool subset, caching still on.' },
      { id: '019700000-c057-7000-8000-000000000004', key: 'max',         tier: 'max',         levers: '{}', description: 'Maximum quality tier: best models, all tools, full history, caching for prefix reuse only.' },
      // Phase 5 (L3 — dynamic tool subset) example. Demonstrates phase-driven
      // tool narrowing for the kaggle strategist. Operators can edit the
      // `levers_json.toolSubset.phases` map via /api/admin/cost-policies to
      // expose different tool keys per logical phase. The kaggle heartbeat
      // derives the phase from the active kgl_competition_run state:
      // 0 kernel pushes → 'discovery'; 1 → 'kernel'; 2+ → 'improvement'.
      {
        id: '019700000-c057-7000-8000-000000000005',
        key: 'kaggle_phase_subset',
        tier: 'balanced',
        levers: JSON.stringify({
          toolSubset: {
            strategy: 'phase',
            phases: {
              discovery: ['kaggle_list_competitions', 'kaggle_get_competition', 'web_search'],
              kernel: ['kaggle_push_kernel', 'kaggle_wait_for_kernel', 'kaggle_get_kernel_output'],
              improvement: ['kaggle_push_kernel', 'kaggle_wait_for_kernel', 'kaggle_get_kernel_output', 'kaggle_list_kernels'],
            },
          },
        }),
        description: 'Phase 5 example: kaggle strategist tool subset varies by run phase (discovery/kernel/improvement). Bind via capability_policy_bindings (policy_kind=cost_policy) to a kaggle mesh or agent.',
      },
      // Phase 6 (L4 — intel-gated prompt sections + L5 — history compaction).
      // Drops the intel-header + intel-snippets sections from prepare() once
      // the live mesh has accumulated enough signals (default thresholds:
      // ≥0.7 → drop both, ≥0.4 → drop snippets only). Keeps the last 12
      // history items (sliding window) so long runs stay cheap. Bind via
      // capability_policy_bindings (policy_kind=cost_policy).
      {
        id: '019700000-c057-7000-8000-000000000006',
        key: 'kaggle_intel_aware',
        tier: 'balanced',
        levers: JSON.stringify({
          intelGating: { enabled: true, thresholds: { low: 0.4, high: 0.7 } },
          historyCompaction: { strategy: 'sliding', windowTurns: 12 },
        }),
        description: 'Phase 6 example: gates intel header/snippets when score ≥ 0.7; sliding-12 history. Bind to a kaggle mesh or agent via capability_policy_bindings (policy_kind=cost_policy).',
      },
      // Phase 7 (L6 maxSteps + L7 reasoningEffort + L8 toolOutputTruncation
      // + L9 budgetGate). Full cost-governor envelope: clamps the strategist's
      // ReAct iteration budget to 30, hints the model toward 'low' reasoning
      // effort (OpenAI passes this as `reasoning_effort` body field), caps
      // each tool result at 2 KiB while preserving the last 3 turns
      // verbatim, and halts the run with a CostCeilingExceededError once
      // cumulative spend exceeds $2.50. Bind via capability_policy_bindings
      // (policy_kind=cost_policy).
      {
        id: '019700000-c057-7000-8000-000000000007',
        key: 'kaggle_full_governor',
        tier: 'balanced',
        levers: JSON.stringify({
          maxStepsCap: 30,
          reasoningEffort: 'low',
          toolOutputTruncation: { maxBytesPerTurn: 2048, keepLastN: 3 },
          budgetCeilingUsd: 2.5,
        }),
        description: 'Phase 7 example: full cost envelope (maxSteps=30, reasoning=low, tool-output cap 2KiB×keepLast 3, ceiling $2.50). Bind via capability_policy_bindings (policy_kind=cost_policy).',
      },
      // Phase 8 (L3 strategy upgrade — Intent-RAG tool retrieval).
      // Switches the toolSubset lever from the deterministic 'phase' map
      // to per-step cosine-similarity ranking against pre-computed tool
      // description embeddings. topK=6, minSimilarity=0.15. The
      // `kaggle_submit` tool is always kept regardless of similarity so
      // the strategist can finalize. Requires the embedding warmer to
      // populate `tool_embeddings` at startup (no-op without OPENAI_API_KEY).
      {
        id: '019700000-c057-7000-8000-000000000008',
        key: 'kaggle_intent_rag',
        tier: 'balanced',
        levers: JSON.stringify({
          toolSubset: {
            strategy: 'intent-rag',
            topK: 6,
            minSimilarity: 0.15,
            includeAlways: ['kaggle_submit'],
          },
        }),
        description: 'Phase 8 example: kaggle strategist tool subset ranked per-step via intent-RAG (cosine sim against tool description embeddings). topK=6, minSim=0.15, kaggle_submit always kept. Bind via capability_policy_bindings (policy_kind=cost_policy).',
      },
    ];
    for (const r of rows) stmt.run(r.id, r.key, r.tier, r.levers, r.description);
  }

  /**
   * Tenant Encryption Phase 1 — seed a single demo policy row so admin
   * tabs are populated and operators have a template to copy. Encryption
   * stays disabled (`enabled = 0`) until an operator opts in. Idempotent
   * via INSERT OR IGNORE on `tenant_id`.
   */
  private async seedDefaultEncryptionPolicies(): Promise<void> {
    this.d
      .prepare(
        `INSERT OR IGNORE INTO tenant_encryption_policy
         (tenant_id, enabled, kms_provider_id, kms_config, active_kek_id, active_dek_id, active_bik_id,
          rotation_schedule, blind_index_enabled, field_policy, shred_requested_at, shred_completed_at)
         VALUES (?, 0, 'local', NULL, NULL, NULL, NULL, 'manual', 0, '{"messages":{"columns":["content","metadata"]},"chats":{"columns":["title"]}}', NULL, NULL)`,
      )
      .run('demo-encrypted-tenant');
  }

  /**
   * Phase 1 anyWeave routing seed data.
   * - 16 task type definitions (text/code/image/audio/video/embedding modalities).
   * - Capability scores for the 10 currently-priced models across 11 text/code/vision tasks.
   * - 3 provider tool adapters (openai, anthropic, google).
   *
   * All inserts use INSERT OR IGNORE so re-running on a populated DB is a no-op.
   * Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md (Part C, Phase 1).
   */
  private async seedAnyWeaveRoutingPhase1(): Promise<void> {
    const cnt = (tbl: string) => (this.d.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get() as { cnt: number }).cnt;
    type TaskSeed = {
      task_key: string;
      display_name: string;
      category: string;
      description: string;
      output_modality: string;
      default_strategy: string;
      default_weights: { cost: number; speed: number; quality: number; capability: number };
      inference_hints: Record<string, unknown>;
    };

    const tasks: TaskSeed[] = [
      { task_key: 'reasoning', display_name: 'Reasoning', category: 'cognitive', description: 'Multi-step deduction, planning, math word problems.', output_modality: 'text', default_strategy: 'quality', default_weights: { cost: 0.10, speed: 0.10, quality: 0.50, capability: 0.30 }, inference_hints: { keywords: ['why', 'explain', 'prove', 'solve', 'plan', 'derive'] } },
      { task_key: 'summarization', display_name: 'Summarization', category: 'text-transform', description: 'Condense long input into shorter form.', output_modality: 'text', default_strategy: 'cost', default_weights: { cost: 0.45, speed: 0.30, quality: 0.20, capability: 0.05 }, inference_hints: { keywords: ['summarize', 'tl;dr', 'condense', 'short version'] } },
      { task_key: 'translation', display_name: 'Translation', category: 'text-transform', description: 'Convert text between natural languages.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['translate', 'in french', 'in spanish', 'in chinese'] } },
      { task_key: 'classification', display_name: 'Classification', category: 'text-transform', description: 'Assign labels / categories to input.', output_modality: 'text', default_strategy: 'cost', default_weights: { cost: 0.50, speed: 0.30, quality: 0.15, capability: 0.05 }, inference_hints: { keywords: ['classify', 'categorize', 'label', 'tag'] } },
      { task_key: 'extraction', display_name: 'Information Extraction', category: 'text-transform', description: 'Pull structured fields from unstructured text.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.30, speed: 0.20, quality: 0.40, capability: 0.10 }, inference_hints: { keywords: ['extract', 'parse', 'pull out', 'find all'] } },
      { task_key: 'qa', display_name: 'Question Answering', category: 'cognitive', description: 'Answer factual / contextual questions.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.25, speed: 0.25, quality: 0.40, capability: 0.10 }, inference_hints: { keywords: ['what', 'who', 'when', 'where', 'how many'] } },
      { task_key: 'code_generation', display_name: 'Code Generation', category: 'code', description: 'Write new code from a natural language spec.', output_modality: 'code', default_strategy: 'quality', default_weights: { cost: 0.15, speed: 0.15, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['write a function', 'generate code', 'implement', 'build a'] } },
      { task_key: 'code_debug', display_name: 'Code Debugging', category: 'code', description: 'Diagnose and fix existing code.', output_modality: 'code', default_strategy: 'quality', default_weights: { cost: 0.10, speed: 0.10, quality: 0.55, capability: 0.25 }, inference_hints: { keywords: ['fix this', 'debug', 'why does this fail', 'error in'] } },
      { task_key: 'code_review', display_name: 'Code Review', category: 'code', description: 'Critique style, correctness, security of code.', output_modality: 'text', default_strategy: 'quality', default_weights: { cost: 0.15, speed: 0.15, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['review', 'audit', 'critique', 'lgtm', 'pr feedback'] } },
      { task_key: 'creative_writing', display_name: 'Creative Writing', category: 'generative-text', description: 'Stories, poems, marketing copy, ideation.', output_modality: 'text', default_strategy: 'quality', default_weights: { cost: 0.20, speed: 0.10, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['write a story', 'poem', 'tagline', 'ad copy', 'creative'] } },
      { task_key: 'conversation', display_name: 'Conversation', category: 'generative-text', description: 'Open-ended chat / assistant-style dialogue.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['chat', 'talk', 'tell me', 'help me'] } },
      { task_key: 'tool_use', display_name: 'Tool / Function Calling', category: 'agentic', description: 'Multi-turn function calling, agent loops.', output_modality: 'text', default_strategy: 'capability', default_weights: { cost: 0.15, speed: 0.20, quality: 0.30, capability: 0.35 }, inference_hints: { keywords: ['call api', 'use tool', 'fetch', 'search the web', 'lookup'] } },
      { task_key: 'vision_understanding', display_name: 'Vision Understanding', category: 'multimodal-input', description: 'Read / describe images and screenshots.', output_modality: 'text', default_strategy: 'capability', default_weights: { cost: 0.15, speed: 0.15, quality: 0.40, capability: 0.30 }, inference_hints: { requiresVision: true, keywords: ['image', 'screenshot', 'photo', 'describe this picture'] } },
      { task_key: 'image_generation', display_name: 'Image Generation', category: 'generative-image', description: 'Create images from text prompts.', output_modality: 'image', default_strategy: 'quality', default_weights: { cost: 0.20, speed: 0.15, quality: 0.45, capability: 0.20 }, inference_hints: { keywords: ['draw', 'generate image', 'illustrate', 'render'] } },
      { task_key: 'speech_to_text', display_name: 'Speech-to-Text', category: 'multimodal-input', description: 'Transcribe audio into text.', output_modality: 'text', default_strategy: 'capability', default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['transcribe', 'audio', 'voice', 'recording'] } },
      { task_key: 'embedding', display_name: 'Embedding', category: 'representation', description: 'Generate fixed-length vector representations.', output_modality: 'embedding', default_strategy: 'cost', default_weights: { cost: 0.50, speed: 0.30, quality: 0.15, capability: 0.05 }, inference_hints: { keywords: ['embed', 'vector', 'semantic search'] } },
    ];

    if (cnt('task_type_definitions') === 0) {
      const insert = this.d.prepare(`
        INSERT OR IGNORE INTO task_type_definitions
          (id, task_key, display_name, category, description, output_modality, default_strategy, default_weights, inference_hints, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      const tx = this.d.transaction((rows: TaskSeed[]) => {
        for (const t of rows) {
          insert.run(
            newUUIDv7(),
            t.task_key,
            t.display_name,
            t.category,
            t.description,
            t.output_modality,
            t.default_strategy,
            JSON.stringify(t.default_weights),
            JSON.stringify(t.inference_hints),
          );
        }
      });
      tx(tasks);
    }

    // Provider tool adapters.
    if (cnt('provider_tool_adapters') === 0) {
      const adapters: Array<Omit<ProviderToolAdapterRow, 'id' | 'created_at' | 'updated_at'>> = [
        {
          provider: 'openai',
          display_name: 'OpenAI Chat Completions / Responses',
          adapter_module: '@weaveintel/tools/schema/openai',
          tool_format: 'openai_json',
          tool_call_response_format: 'tool_calls_array',
          tool_result_format: 'tool_message',
          system_prompt_location: 'system_message',
          name_validation_regex: '^[a-zA-Z0-9_-]{1,64}$',
          max_tool_count: 128,
          enabled: 1,
        },
        {
          provider: 'anthropic',
          display_name: 'Anthropic Messages',
          adapter_module: '@weaveintel/tools/schema/anthropic',
          tool_format: 'anthropic_xml',
          tool_call_response_format: 'tool_use_block',
          tool_result_format: 'tool_result_block',
          system_prompt_location: 'separate_field',
          name_validation_regex: '^[a-zA-Z0-9_-]{1,64}$',
          max_tool_count: 64,
          enabled: 1,
        },
        {
          provider: 'google',
          display_name: 'Google Gemini',
          adapter_module: '@weaveintel/tools/schema/google',
          tool_format: 'google_function',
          tool_call_response_format: 'function_call',
          tool_result_format: 'function_response',
          system_prompt_location: 'system_message',
          name_validation_regex: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$',
          max_tool_count: 64,
          enabled: 1,
        },
      ];
      const insert = this.d.prepare(`
        INSERT OR IGNORE INTO provider_tool_adapters
          (id, provider, display_name, adapter_module, tool_format, tool_call_response_format, tool_result_format, system_prompt_location, name_validation_regex, max_tool_count, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of adapters) {
        insert.run(
          newUUIDv7(),
          a.provider, a.display_name, a.adapter_module,
          a.tool_format, a.tool_call_response_format, a.tool_result_format,
          a.system_prompt_location, a.name_validation_regex, a.max_tool_count, a.enabled,
        );
      }
    }

    // Capability scores: 10 currently-priced models × 11 applicable tasks.
    // Quality scores derived from public benchmarks (MMLU, HumanEval, GPQA, etc.) — see design doc.
    // Models without a row for a task = excluded from candidate pool for that task (e.g. nano lacks vision).
    if (cnt('model_capability_scores') === 0) {
      type CapSeed = {
        model_id: string;
        provider: string;
        task_key: string;
        quality_score: number;
        supports_tools?: number;
        supports_streaming?: number;
        supports_thinking?: number;
        supports_json_mode?: number;
        supports_vision?: number;
        max_output_tokens?: number | null;
        benchmark_source?: string | null;
      };

      // Per-model capability flag baseline — sourced from @weaveintel/routing package.
      const flags = getModelCapabilityFlags;

      // Scores per (model, task). Tasks not listed for a model = excluded.
      const scores: CapSeed[] = [
        // Anthropic family
        ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
          model_id: 'claude-opus-4-7', provider: 'anthropic', task_key: task,
          quality_score: ({ reasoning: 95, summarization: 90, translation: 88, classification: 90, extraction: 92, qa: 93, code_generation: 94, code_debug: 95, code_review: 95, creative_writing: 96, conversation: 92, tool_use: 93, vision_understanding: 90 }[task as string] ?? 90),
          benchmark_source: 'composite-2025q1',
        })),
        ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
          model_id: 'claude-sonnet-4-6', provider: 'anthropic', task_key: task,
          quality_score: ({ reasoning: 88, summarization: 88, translation: 86, classification: 88, extraction: 89, qa: 88, code_generation: 90, code_debug: 89, code_review: 88, creative_writing: 90, conversation: 90, tool_use: 89, vision_understanding: 86 }[task as string] ?? 85),
          benchmark_source: 'composite-2025q1',
        })),
        ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use'].map(task => ({
          model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', task_key: task,
          quality_score: ({ summarization: 78, classification: 78, extraction: 76, qa: 75, translation: 74, conversation: 80, tool_use: 75 }[task as string] ?? 70),
          benchmark_source: 'composite-2025q1',
        })),
        // OpenAI family
        ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
          model_id: 'gpt-4o', provider: 'openai', task_key: task,
          quality_score: ({ reasoning: 88, summarization: 90, translation: 92, classification: 89, extraction: 90, qa: 91, code_generation: 89, code_debug: 88, code_review: 87, creative_writing: 88, conversation: 91, tool_use: 92, vision_understanding: 92 }[task as string] ?? 88),
          benchmark_source: 'composite-2025q1',
        })),
        ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
          model_id: 'gpt-4o-mini', provider: 'openai', task_key: task,
          quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 82, tool_use: 80, vision_understanding: 78 }[task as string] ?? 75),
          benchmark_source: 'composite-2025q1',
        })),
        ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
          model_id: 'gpt-4.1', provider: 'openai', task_key: task,
          quality_score: ({ reasoning: 89, summarization: 89, translation: 90, classification: 89, extraction: 90, qa: 90, code_generation: 91, code_debug: 90, code_review: 88, creative_writing: 87, conversation: 89, tool_use: 91, vision_understanding: 89 }[task as string] ?? 88),
          benchmark_source: 'composite-2025q1',
        })),
        ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
          model_id: 'gpt-4.1-mini', provider: 'openai', task_key: task,
          quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 81, tool_use: 80, vision_understanding: 76 }[task as string] ?? 75),
          benchmark_source: 'composite-2025q1',
        })),
        ...['summarization', 'classification', 'extraction', 'conversation'].map(task => ({
          model_id: 'gpt-4.1-nano', provider: 'openai', task_key: task,
          quality_score: ({ summarization: 70, classification: 72, extraction: 68, conversation: 72 }[task as string] ?? 65),
          benchmark_source: 'composite-2025q1',
        })),
        // Reasoning specialists (o-series): exclude creative/conversation but excel at reasoning/code/math.
        ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use'].map(task => ({
          model_id: 'o3', provider: 'openai', task_key: task,
          quality_score: ({ reasoning: 96, qa: 90, code_generation: 92, code_debug: 94, code_review: 91, tool_use: 88 }[task as string] ?? 88),
          benchmark_source: 'composite-2025q1',
        })),
        ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use'].map(task => ({
          model_id: 'o4-mini', provider: 'openai', task_key: task,
          quality_score: ({ reasoning: 88, qa: 82, code_generation: 86, code_debug: 87, code_review: 84, tool_use: 82 }[task as string] ?? 80),
          benchmark_source: 'composite-2025q1',
        })),
      ];

      const insert = this.d.prepare(`
        INSERT OR IGNORE INTO model_capability_scores
          (id, tenant_id, model_id, provider, task_key, quality_score,
           supports_tools, supports_streaming, supports_thinking, supports_json_mode, supports_vision,
           max_output_tokens, benchmark_source, raw_benchmark_score, is_active, last_evaluated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, datetime('now'))
      `);
      const tx = this.d.transaction((rows: CapSeed[]) => {
        for (const s of rows) {
          const f = flags(s.model_id);
          insert.run(
            newUUIDv7(),
            s.model_id, s.provider, s.task_key, s.quality_score,
            s.supports_tools ?? 1,
            s.supports_streaming ?? 1,
            f.supports_thinking,
            f.supports_json_mode,
            // Vision capability is meaningful only for vision_understanding; otherwise flag still reflects model native support.
            f.supports_vision,
            s.max_output_tokens ?? null,
            s.benchmark_source ?? null,
          );
        }
      });
      tx(scores);
    }

    // Backfill output_modality on model_pricing for the 10 seeded models (all are text producers).
    this.d.prepare("UPDATE model_pricing SET output_modality = 'text' WHERE output_modality IS NULL OR output_modality = ''").run();
  }

  // ─── Hypothesis Validation ──────────────────────────────────

  async createBudgetEnvelope(envelope: Omit<SvBudgetEnvelopeRow, 'created_at'>): Promise<void> {
    const now = new Date().toISOString();
    this.d.prepare(
      `INSERT INTO hv_budget_envelope
         (id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds,
          max_rounds, diminishing_returns_epsilon, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      envelope.id, envelope.tenant_id, envelope.name,
      envelope.max_llm_cents, envelope.max_sandbox_cents, envelope.max_wall_seconds,
      envelope.max_rounds, envelope.diminishing_returns_epsilon, now,
    );
  }

  async getBudgetEnvelope(id: string, tenantId: string): Promise<SvBudgetEnvelopeRow | null> {
    return (this.d.prepare(
      `SELECT * FROM hv_budget_envelope WHERE id = ? AND tenant_id = ?`,
    ).get(id, tenantId) as SvBudgetEnvelopeRow | undefined) ?? null;
  }

  async listBudgetEnvelopes(tenantId: string): Promise<SvBudgetEnvelopeRow[]> {
    return this.d.prepare(
      `SELECT * FROM hv_budget_envelope WHERE tenant_id = ? ORDER BY created_at DESC`,
    ).all(tenantId) as SvBudgetEnvelopeRow[];
  }

  async createHypothesis(hypothesis: Omit<SvHypothesisRow, 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString();
    this.d.prepare(
      `INSERT INTO hv_hypothesis
         (id, tenant_id, submitted_by, title, statement, domain_tags, status,
          budget_envelope_id, workflow_run_id, trace_id, contract_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      hypothesis.id, hypothesis.tenant_id, hypothesis.submitted_by,
      hypothesis.title, hypothesis.statement, hypothesis.domain_tags,
      hypothesis.status, hypothesis.budget_envelope_id,
      hypothesis.workflow_run_id ?? null, hypothesis.trace_id ?? null,
      hypothesis.contract_id ?? null, now, now,
    );
  }

  async getHypothesis(id: string, tenantId: string): Promise<SvHypothesisRow | null> {
    return (this.d.prepare(
      `SELECT * FROM hv_hypothesis WHERE id = ? AND tenant_id = ?`,
    ).get(id, tenantId) as SvHypothesisRow | undefined) ?? null;
  }

  async listHypotheses(tenantId: string, limit = 50, offset = 0): Promise<SvHypothesisRow[]> {
    return this.d.prepare(
      `SELECT * FROM hv_hypothesis WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(tenantId, limit, offset) as SvHypothesisRow[];
  }

  async updateHypothesisStatus(id: string, status: SvHypothesisStatus, updatedAt: string): Promise<void> {
    this.d.prepare(
      `UPDATE hv_hypothesis SET status = ?, updated_at = ? WHERE id = ?`,
    ).run(status, updatedAt, id);
  }

  async updateHypothesisWorkflowIds(
    id: string,
    opts: { workflowRunId?: string; traceId?: string; contractId?: string; updatedAt: string },
  ): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [opts.updatedAt];
    if (opts.workflowRunId !== undefined) { sets.push('workflow_run_id = ?'); vals.push(opts.workflowRunId); }
    if (opts.traceId !== undefined) { sets.push('trace_id = ?'); vals.push(opts.traceId); }
    if (opts.contractId !== undefined) { sets.push('contract_id = ?'); vals.push(opts.contractId); }
    vals.push(id);
    this.d.prepare(`UPDATE hv_hypothesis SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async createSubClaim(claim: Omit<SvSubClaimRow, 'created_at'>): Promise<void> {
    const now = new Date().toISOString();
    this.d.prepare(
      `INSERT INTO hv_sub_claim
         (id, tenant_id, hypothesis_id, parent_sub_claim_id, statement, claim_type,
          testability_score, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      claim.id, claim.tenant_id, claim.hypothesis_id,
      claim.parent_sub_claim_id ?? null, claim.statement,
      claim.claim_type, claim.testability_score, now,
    );
  }

  async getSubClaim(id: string): Promise<SvSubClaimRow | null> {
    return (this.d.prepare(`SELECT * FROM hv_sub_claim WHERE id = ?`).get(id) as SvSubClaimRow | undefined) ?? null;
  }

  async listSubClaims(hypothesisId: string): Promise<SvSubClaimRow[]> {
    return this.d.prepare(
      `SELECT * FROM hv_sub_claim WHERE hypothesis_id = ? ORDER BY created_at ASC`,
    ).all(hypothesisId) as SvSubClaimRow[];
  }

  async createVerdict(verdict: Omit<SvVerdictRow, 'created_at'>): Promise<void> {
    const now = new Date().toISOString();
    this.d.prepare(
      `INSERT INTO hv_verdict
         (id, tenant_id, hypothesis_id, verdict, confidence_lo, confidence_hi,
          key_evidence_ids, falsifiers, limitations, contract_id, replay_trace_id,
          emitted_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      verdict.id, verdict.tenant_id, verdict.hypothesis_id,
      verdict.verdict, verdict.confidence_lo, verdict.confidence_hi,
      verdict.key_evidence_ids, verdict.falsifiers, verdict.limitations,
      verdict.contract_id, verdict.replay_trace_id,
      verdict.emitted_by ?? 'supervisor', now,
    );
  }

  async getVerdictByHypothesis(hypothesisId: string): Promise<SvVerdictRow | null> {
    return (this.d.prepare(
      `SELECT * FROM hv_verdict WHERE hypothesis_id = ?`,
    ).get(hypothesisId) as SvVerdictRow | undefined) ?? null;
  }

  async getVerdictById(id: string): Promise<SvVerdictRow | null> {
    return (this.d.prepare(`SELECT * FROM hv_verdict WHERE id = ?`).get(id) as SvVerdictRow | undefined) ?? null;
  }

  // ─── Evidence events (SSE /events) ────────────────────────

  async createEvidenceEvent(event: Omit<SvEvidenceEventRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO hv_evidence_event
       (id, hypothesis_id, step_id, agent_id, evidence_id, kind, summary, source_type, tool_key, reproducibility_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      event.id, event.hypothesis_id, event.step_id, event.agent_id,
      event.evidence_id, event.kind, event.summary, event.source_type,
      event.tool_key ?? null, event.reproducibility_hash ?? null,
      new Date().toISOString(),
    );
  }

  async listEvidenceEvents(hypothesisId: string, afterId?: string, limit = 100): Promise<SvEvidenceEventRow[]> {
    if (afterId) {
      const anchor = this.d.prepare(
        `SELECT created_at FROM hv_evidence_event WHERE id = ?`,
      ).get(afterId) as { created_at: string } | undefined;
      if (anchor) {
        return this.d.prepare(
          `SELECT * FROM hv_evidence_event WHERE hypothesis_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?`,
        ).all(hypothesisId, anchor.created_at, limit) as SvEvidenceEventRow[];
      }
    }
    return this.d.prepare(
      `SELECT * FROM hv_evidence_event WHERE hypothesis_id = ? ORDER BY created_at ASC LIMIT ?`,
    ).all(hypothesisId, limit) as SvEvidenceEventRow[];
  }

  // ─── Agent dialogue turns (SSE /dialogue) ─────────────────

  async createAgentTurn(turn: Omit<SvAgentTurnRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO hv_agent_turn
       (id, hypothesis_id, round_index, from_agent, to_agent, message, cites_evidence_ids, dissent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      turn.id, turn.hypothesis_id, turn.round_index,
      turn.from_agent, turn.to_agent ?? null, turn.message,
      turn.cites_evidence_ids, turn.dissent ? 1 : 0,
      new Date().toISOString(),
    );
  }

  async listAgentTurns(hypothesisId: string, afterId?: string, limit = 200): Promise<SvAgentTurnRow[]> {
    if (afterId) {
      const anchor = this.d.prepare(
        `SELECT created_at FROM hv_agent_turn WHERE id = ?`,
      ).get(afterId) as { created_at: string } | undefined;
      if (anchor) {
        return this.d.prepare(
          `SELECT * FROM hv_agent_turn WHERE hypothesis_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?`,
        ).all(hypothesisId, anchor.created_at, limit) as SvAgentTurnRow[];
      }
    }
    return this.d.prepare(
      `SELECT * FROM hv_agent_turn WHERE hypothesis_id = ? ORDER BY created_at ASC LIMIT ?`,
    ).all(hypothesisId, limit) as SvAgentTurnRow[];
  }

  // ─── Phase K3: Kaggle projections ────────────────────────────

  async upsertKaggleCompetitionTracked(row: Omit<KaggleCompetitionTrackedRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO kaggle_competitions_tracked
        (id, tenant_id, competition_ref, title, category, deadline, reward, url, status, notes, last_synced_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(tenant_id, competition_ref) DO UPDATE SET
        title=excluded.title,
        category=excluded.category,
        deadline=excluded.deadline,
        reward=excluded.reward,
        url=excluded.url,
        status=excluded.status,
        notes=excluded.notes,
        last_synced_at=excluded.last_synced_at,
        updated_at=datetime('now')
    `).run(
      row.id, row.tenant_id ?? null, row.competition_ref,
      row.title ?? null, row.category ?? null, row.deadline ?? null,
      row.reward ?? null, row.url ?? null, row.status,
      row.notes ?? null, row.last_synced_at ?? null,
    );
  }

  async getKaggleCompetitionTracked(id: string): Promise<KaggleCompetitionTrackedRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_competitions_tracked WHERE id = ?`).get(id) as KaggleCompetitionTrackedRow | undefined) ?? null;
  }

  async listKaggleCompetitionsTracked(opts: { status?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleCompetitionTrackedRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status)   { where.push('status = ?');       params.push(opts.status); }
    if (opts.tenantId !== undefined) {
      if (opts.tenantId === null) where.push('tenant_id IS NULL');
      else { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    }
    const sql = `SELECT * FROM kaggle_competitions_tracked${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KaggleCompetitionTrackedRow[];
  }

  async updateKaggleCompetitionTracked(id: string, patch: Partial<Omit<KaggleCompetitionTrackedRow, 'id' | 'created_at'>>): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'updated_at') continue;
      fields.push(`${k} = ?`);
      params.push(v ?? null);
    }
    if (fields.length === 0) return;
    fields.push(`updated_at = datetime('now')`);
    params.push(id);
    this.d.prepare(`UPDATE kaggle_competitions_tracked SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async deleteKaggleCompetitionTracked(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM kaggle_competitions_tracked WHERE id = ?`).run(id);
  }

  async createKaggleApproach(row: Omit<KaggleApproachRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO kaggle_approaches
        (id, tenant_id, competition_ref, summary, expected_metric, model, source_kernel_refs, embedding, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      row.id, row.tenant_id ?? null, row.competition_ref,
      row.summary, row.expected_metric ?? null, row.model ?? null,
      row.source_kernel_refs ?? null, row.embedding ?? null,
      row.status, row.created_by ?? null,
    );
  }

  async getKaggleApproach(id: string): Promise<KaggleApproachRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_approaches WHERE id = ?`).get(id) as KaggleApproachRow | undefined) ?? null;
  }

  async listKaggleApproaches(opts: { competitionRef?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleApproachRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.competitionRef) { where.push('competition_ref = ?'); params.push(opts.competitionRef); }
    if (opts.status)         { where.push('status = ?');           params.push(opts.status); }
    if (opts.tenantId !== undefined) {
      if (opts.tenantId === null) where.push('tenant_id IS NULL');
      else { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    }
    const sql = `SELECT * FROM kaggle_approaches${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KaggleApproachRow[];
  }

  async updateKaggleApproach(id: string, patch: Partial<Omit<KaggleApproachRow, 'id' | 'created_at'>>): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'updated_at') continue;
      fields.push(`${k} = ?`);
      params.push(v ?? null);
    }
    if (fields.length === 0) return;
    fields.push(`updated_at = datetime('now')`);
    params.push(id);
    this.d.prepare(`UPDATE kaggle_approaches SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async deleteKaggleApproach(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM kaggle_approaches WHERE id = ?`).run(id);
  }

  async createKaggleRun(row: Omit<KaggleRunRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO kaggle_runs
        (id, tenant_id, competition_ref, approach_id, contract_id, replay_trace_id, mesh_id, agent_id,
         kernel_ref, submission_id, public_score, validator_report, status, started_at, completed_at,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      row.id, row.tenant_id ?? null, row.competition_ref,
      row.approach_id ?? null, row.contract_id ?? null, row.replay_trace_id ?? null,
      row.mesh_id ?? null, row.agent_id ?? null,
      row.kernel_ref ?? null, row.submission_id ?? null, row.public_score ?? null,
      row.validator_report ?? null, row.status,
      row.started_at ?? null, row.completed_at ?? null,
    );
  }

  async getKaggleRun(id: string): Promise<KaggleRunRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_runs WHERE id = ?`).get(id) as KaggleRunRow | undefined) ?? null;
  }

  async listKaggleRuns(opts: { competitionRef?: string; approachId?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleRunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.competitionRef) { where.push('competition_ref = ?'); params.push(opts.competitionRef); }
    if (opts.approachId)     { where.push('approach_id = ?');     params.push(opts.approachId); }
    if (opts.status)         { where.push('status = ?');           params.push(opts.status); }
    if (opts.tenantId !== undefined) {
      if (opts.tenantId === null) where.push('tenant_id IS NULL');
      else { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    }
    const sql = `SELECT * FROM kaggle_runs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KaggleRunRow[];
  }

  async updateKaggleRun(id: string, patch: Partial<Omit<KaggleRunRow, 'id' | 'created_at'>>): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'updated_at') continue;
      fields.push(`${k} = ?`);
      params.push(v ?? null);
    }
    if (fields.length === 0) return;
    fields.push(`updated_at = datetime('now')`);
    params.push(id);
    this.d.prepare(`UPDATE kaggle_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async deleteKaggleRun(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM kaggle_runs WHERE id = ?`).run(id);
  }

  // ─── Phase K4: Kaggle run artifacts ─────────────────────────
  async upsertKaggleRunArtifact(row: Omit<KaggleRunArtifactRow, 'created_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO kaggle_run_artifacts
        (id, run_id, contract_id, replay_trace_id, contract_report_json, replay_run_log_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(run_id) DO UPDATE SET
        contract_id = excluded.contract_id,
        replay_trace_id = excluded.replay_trace_id,
        contract_report_json = excluded.contract_report_json,
        replay_run_log_json = excluded.replay_run_log_json
    `).run(
      row.id, row.run_id, row.contract_id, row.replay_trace_id,
      row.contract_report_json, row.replay_run_log_json,
    );
  }

  async getKaggleRunArtifactByRunId(runId: string): Promise<KaggleRunArtifactRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_run_artifacts WHERE run_id = ?`).get(runId) as KaggleRunArtifactRow | undefined) ?? null;
  }

  async listKaggleRunArtifacts(opts: { limit?: number; offset?: number } = {}): Promise<KaggleRunArtifactRow[]> {
    return this.d.prepare(`SELECT * FROM kaggle_run_artifacts ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(opts.limit ?? 100, opts.offset ?? 0) as KaggleRunArtifactRow[];
  }

  async deleteKaggleRunArtifact(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM kaggle_run_artifacts WHERE id = ?`).run(id);
  }

  // ─── Phase K5: Kaggle live-agents mesh index ─────────────────
  // Pure pointer table — domain state lives in the live-agents StateStore
  // (la_entities). Used so admin GETs can enumerate every Kaggle mesh
  // without first knowing the tenantId.
  async upsertKaggleLiveMesh(row: { mesh_id: string; tenant_id: string; kaggle_username: string }): Promise<void> {
    this.d.prepare(`
      INSERT INTO kaggle_live_mesh_index (mesh_id, tenant_id, kaggle_username, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(mesh_id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        kaggle_username = excluded.kaggle_username
    `).run(row.mesh_id, row.tenant_id, row.kaggle_username);
  }

  async listKaggleLiveMeshes(opts: { tenantId?: string } = {}): Promise<Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>> {
    if (opts.tenantId) {
      return this.d.prepare(`SELECT mesh_id, tenant_id, kaggle_username, created_at FROM kaggle_live_mesh_index WHERE tenant_id = ? ORDER BY created_at DESC`)
        .all(opts.tenantId) as Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>;
    }
    return this.d.prepare(`SELECT mesh_id, tenant_id, kaggle_username, created_at FROM kaggle_live_mesh_index ORDER BY created_at DESC`)
      .all() as Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>;
  }

  // ─── Phase K6: Kaggle discussion bot (kill switch + log) ─────────────
  // discussion_enabled is a per-tenant kill switch; the runtime MUST check
  // isKaggleDiscussionEnabledForTenant before invoking kaggle.discussions.create.
  async getKaggleDiscussionSettings(tenantId: string): Promise<KaggleDiscussionSettingsRow | null> {
    const row = this.d.prepare(`SELECT * FROM kaggle_discussion_settings WHERE tenant_id = ?`).get(tenantId) as KaggleDiscussionSettingsRow | undefined;
    return row ?? null;
  }

  async listKaggleDiscussionSettings(): Promise<KaggleDiscussionSettingsRow[]> {
    return this.d.prepare(`SELECT * FROM kaggle_discussion_settings ORDER BY tenant_id`).all() as KaggleDiscussionSettingsRow[];
  }

  async upsertKaggleDiscussionSettings(row: { tenant_id: string; discussion_enabled: number; notes?: string | null }): Promise<KaggleDiscussionSettingsRow> {
    const existing = this.d.prepare(`SELECT id FROM kaggle_discussion_settings WHERE tenant_id = ?`).get(row.tenant_id) as { id: string } | undefined;
    const id = existing?.id ?? newUUIDv7();
    this.d.prepare(`
      INSERT INTO kaggle_discussion_settings (id, tenant_id, discussion_enabled, notes, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(tenant_id) DO UPDATE SET
        discussion_enabled = excluded.discussion_enabled,
        notes = excluded.notes,
        updated_at = datetime('now')
    `).run(id, row.tenant_id, row.discussion_enabled ? 1 : 0, row.notes ?? null);
    return (this.d.prepare(`SELECT * FROM kaggle_discussion_settings WHERE tenant_id = ?`).get(row.tenant_id) as KaggleDiscussionSettingsRow);
  }

  async isKaggleDiscussionEnabledForTenant(tenantId: string): Promise<boolean> {
    const row = this.d.prepare(`SELECT discussion_enabled FROM kaggle_discussion_settings WHERE tenant_id = ?`).get(tenantId) as { discussion_enabled: number } | undefined;
    return row?.discussion_enabled === 1;
  }

  async recordKaggleDiscussionPost(row: Omit<KaggleDiscussionPostRow, 'posted_at'> & { posted_at?: string }): Promise<void> {
    this.d.prepare(`
      INSERT OR IGNORE INTO kaggle_discussion_posts (
        id, tenant_id, competition_ref, topic_id, parent_topic_id, title,
        body_preview, url, status, contract_id, replay_trace_id, posted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    `).run(
      row.id,
      row.tenant_id,
      row.competition_ref,
      row.topic_id,
      row.parent_topic_id,
      row.title,
      row.body_preview,
      row.url,
      row.status,
      row.contract_id,
      row.replay_trace_id,
      row.posted_at ?? null,
    );
  }

  async listKaggleDiscussionPosts(opts: { tenantId?: string; competitionRef?: string; limit?: number; offset?: number } = {}): Promise<KaggleDiscussionPostRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantId) { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    if (opts.competitionRef) { where.push('competition_ref = ?'); params.push(opts.competitionRef); }
    const sql = `SELECT * FROM kaggle_discussion_posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY posted_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KaggleDiscussionPostRow[];
  }

  async getKaggleDiscussionPost(id: string): Promise<KaggleDiscussionPostRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_discussion_posts WHERE id = ?`).get(id) as KaggleDiscussionPostRow | undefined) ?? null;
  }

  // ─── Phase K7d — Submission validation ─────────────────────────────────

  async upsertKaggleCompetitionRubric(row: Omit<KaggleCompetitionRubricRow, 'created_at' | 'updated_at'>): Promise<KaggleCompetitionRubricRow> {
    // Upsert by (tenant_id, competition_ref). UNIQUE constraint guarantees one row.
    const existing = await this.getKaggleCompetitionRubricByRef(row.competition_ref, row.tenant_id ?? null);
    const now = new Date().toISOString();
    if (existing) {
      this.d.prepare(`
        UPDATE kaggle_competition_rubric SET
          metric_name = ?, metric_direction = ?, baseline_score = ?, target_score = ?,
          expected_row_count = ?, id_column = ?, id_range_min = ?, id_range_max = ?,
          target_column = ?, target_type = ?, expected_distribution_json = ?,
          sample_submission_sha256 = ?, inference_source = ?, auto_generated = ?,
          inferred_at = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        row.metric_name, row.metric_direction, row.baseline_score, row.target_score,
        row.expected_row_count, row.id_column, row.id_range_min, row.id_range_max,
        row.target_column, row.target_type, row.expected_distribution_json,
        row.sample_submission_sha256, row.inference_source, row.auto_generated,
        row.inferred_at, row.notes, now,
        existing.id,
      );
      return (await this.getKaggleCompetitionRubric(existing.id))!;
    }
    this.d.prepare(`
      INSERT INTO kaggle_competition_rubric (
        id, tenant_id, competition_ref, metric_name, metric_direction,
        baseline_score, target_score, expected_row_count, id_column,
        id_range_min, id_range_max, target_column, target_type,
        expected_distribution_json, sample_submission_sha256, inference_source,
        auto_generated, inferred_at, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.tenant_id, row.competition_ref, row.metric_name, row.metric_direction,
      row.baseline_score, row.target_score, row.expected_row_count, row.id_column,
      row.id_range_min, row.id_range_max, row.target_column, row.target_type,
      row.expected_distribution_json, row.sample_submission_sha256, row.inference_source,
      row.auto_generated, row.inferred_at, row.notes, now, now,
    );
    return (await this.getKaggleCompetitionRubric(row.id))!;
  }

  async getKaggleCompetitionRubric(id: string): Promise<KaggleCompetitionRubricRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_competition_rubric WHERE id = ?`).get(id) as KaggleCompetitionRubricRow | undefined) ?? null;
  }

  async getKaggleCompetitionRubricByRef(competitionRef: string, tenantId: string | null = null): Promise<KaggleCompetitionRubricRow | null> {
    const sql = tenantId
      ? `SELECT * FROM kaggle_competition_rubric WHERE competition_ref = ? AND tenant_id = ?`
      : `SELECT * FROM kaggle_competition_rubric WHERE competition_ref = ? AND tenant_id IS NULL`;
    const params = tenantId ? [competitionRef, tenantId] : [competitionRef];
    return (this.d.prepare(sql).get(...params) as KaggleCompetitionRubricRow | undefined) ?? null;
  }

  async listKaggleCompetitionRubrics(opts: { competitionRef?: string; tenantId?: string | null; limit?: number; offset?: number } = {}): Promise<KaggleCompetitionRubricRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.competitionRef) { where.push('competition_ref = ?'); params.push(opts.competitionRef); }
    if (opts.tenantId !== undefined) {
      if (opts.tenantId === null) { where.push('tenant_id IS NULL'); }
      else { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    }
    const sql = `SELECT * FROM kaggle_competition_rubric ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KaggleCompetitionRubricRow[];
  }

  async updateKaggleCompetitionRubric(id: string, patch: Partial<Omit<KaggleCompetitionRubricRow, 'id' | 'created_at'>>): Promise<void> {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const setSql = cols.map((c) => `${c} = ?`).join(', ');
    const params = cols.map((c) => (patch as Record<string, unknown>)[c]);
    params.push(new Date().toISOString());
    params.push(id);
    this.d.prepare(`UPDATE kaggle_competition_rubric SET ${setSql}, updated_at = ? WHERE id = ?`).run(...params);
  }

  async deleteKaggleCompetitionRubric(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM kaggle_competition_rubric WHERE id = ?`).run(id);
  }

  async createKaggleValidationResult(row: Omit<KaggleValidationResultRow, 'created_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO kaggle_validation_results (
        id, run_id, competition_ref, rubric_id, kernel_ref,
        schema_check_passed, distribution_check_passed, baseline_check_passed,
        cv_score, cv_std, cv_metric, n_folds,
        predicted_distribution_json, violations_json, verdict, summary, validated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.run_id, row.competition_ref, row.rubric_id, row.kernel_ref,
      row.schema_check_passed, row.distribution_check_passed, row.baseline_check_passed,
      row.cv_score, row.cv_std, row.cv_metric, row.n_folds,
      row.predicted_distribution_json, row.violations_json, row.verdict, row.summary, row.validated_at,
    );
  }

  async getKaggleValidationResult(id: string): Promise<KaggleValidationResultRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_validation_results WHERE id = ?`).get(id) as KaggleValidationResultRow | undefined) ?? null;
  }

  async listKaggleValidationResults(opts: { runId?: string; competitionRef?: string; verdict?: string; limit?: number; offset?: number } = {}): Promise<KaggleValidationResultRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
    if (opts.competitionRef) { where.push('competition_ref = ?'); params.push(opts.competitionRef); }
    if (opts.verdict) { where.push('verdict = ?'); params.push(opts.verdict); }
    const sql = `SELECT * FROM kaggle_validation_results ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KaggleValidationResultRow[];
  }

  async deleteKaggleValidationResult(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM kaggle_validation_results WHERE id = ?`).run(id);
  }

  async createKaggleLeaderboardScore(row: Omit<KaggleLeaderboardScoreRow, 'created_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO kaggle_leaderboard_scores (
        id, run_id, competition_ref, submission_id,
        public_score, private_score, cv_lb_delta, percentile_estimate,
        rank_estimate, leaderboard_size, raw_status, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.run_id, row.competition_ref, row.submission_id,
      row.public_score, row.private_score, row.cv_lb_delta, row.percentile_estimate,
      row.rank_estimate, row.leaderboard_size, row.raw_status, row.observed_at,
    );
  }

  async getKaggleLeaderboardScore(id: string): Promise<KaggleLeaderboardScoreRow | null> {
    return (this.d.prepare(`SELECT * FROM kaggle_leaderboard_scores WHERE id = ?`).get(id) as KaggleLeaderboardScoreRow | undefined) ?? null;
  }

  async listKaggleLeaderboardScores(opts: { runId?: string; competitionRef?: string; limit?: number; offset?: number } = {}): Promise<KaggleLeaderboardScoreRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
    if (opts.competitionRef) { where.push('competition_ref = ?'); params.push(opts.competitionRef); }
    const sql = `SELECT * FROM kaggle_leaderboard_scores ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KaggleLeaderboardScoreRow[];
  }

  async deleteKaggleLeaderboardScore(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM kaggle_leaderboard_scores WHERE id = ?`).run(id);
  }

  // ─── Phase K8 — Kaggle competition run ledger ──────────────────────────
  async createKglCompetitionRun(row: Omit<KglCompetitionRunRow, 'created_at' | 'updated_at' | 'step_count' | 'event_count'>): Promise<KglCompetitionRunRow> {
    const now = new Date().toISOString();
    this.d.prepare(`
      INSERT INTO kgl_competition_run (
        id, tenant_id, submitted_by, competition_ref, title, objective,
        mesh_id, status, step_count, event_count, summary,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.tenant_id, row.submitted_by, row.competition_ref,
      row.title ?? null, row.objective ?? null, row.mesh_id ?? null,
      row.status, row.summary ?? null,
      row.started_at ?? null, row.completed_at ?? null, now, now,
    );
    return (await this.getKglCompetitionRun(row.id))!;
  }

  async getKglCompetitionRun(id: string, tenantId?: string | null): Promise<KglCompetitionRunRow | null> {
    const sql = tenantId
      ? `SELECT * FROM kgl_competition_run WHERE id = ? AND tenant_id = ?`
      : `SELECT * FROM kgl_competition_run WHERE id = ?`;
    const params: unknown[] = tenantId ? [id, tenantId] : [id];
    return (this.d.prepare(sql).get(...params) as KglCompetitionRunRow | undefined) ?? null;
  }

  async listKglCompetitionRuns(opts: { tenantId?: string | null; status?: KglCompetitionRunRow['status']; competitionRef?: string; limit?: number; offset?: number } = {}): Promise<KglCompetitionRunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantId) { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.competitionRef) { where.push('competition_ref = ?'); params.push(opts.competitionRef); }
    const sql = `SELECT * FROM kgl_competition_run ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 50, opts.offset ?? 0);
    return this.d.prepare(sql).all(...params) as KglCompetitionRunRow[];
  }

  async updateKglCompetitionRun(id: string, patch: Partial<Omit<KglCompetitionRunRow, 'id' | 'created_at'>>): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      params.push(v as unknown);
    }
    if (!fields.length) return;
    fields.push(`updated_at = ?`);
    params.push(new Date().toISOString());
    params.push(id);
    this.d.prepare(`UPDATE kgl_competition_run SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async appendKglRunStep(row: Omit<KglRunStepRow, 'created_at' | 'updated_at'>): Promise<KglRunStepRow> {
    const now = new Date().toISOString();
    this.d.prepare(`
      INSERT INTO kgl_run_step (
        id, run_id, step_index, role, title, description, agent_id,
        status, started_at, completed_at, summary, input_preview, output_preview,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.run_id, row.step_index, row.role, row.title, row.description ?? null,
      row.agent_id ?? null, row.status, row.started_at ?? null, row.completed_at ?? null,
      row.summary ?? null, row.input_preview ?? null, row.output_preview ?? null, now, now,
    );
    this.d.prepare(`UPDATE kgl_competition_run SET step_count = step_count + 1, updated_at = ? WHERE id = ?`).run(now, row.run_id);
    return (this.d.prepare(`SELECT * FROM kgl_run_step WHERE id = ?`).get(row.id) as KglRunStepRow);
  }

  async updateKglRunStep(id: string, patch: Partial<Omit<KglRunStepRow, 'id' | 'run_id' | 'created_at'>>): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      params.push(v as unknown);
    }
    if (!fields.length) return;
    fields.push(`updated_at = ?`);
    params.push(new Date().toISOString());
    params.push(id);
    this.d.prepare(`UPDATE kgl_run_step SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async listKglRunSteps(runId: string): Promise<KglRunStepRow[]> {
    return this.d.prepare(`SELECT * FROM kgl_run_step WHERE run_id = ? ORDER BY step_index ASC, created_at ASC`).all(runId) as KglRunStepRow[];
  }

  async appendKglRunEvent(row: Omit<KglRunEventRow, 'created_at'>): Promise<KglRunEventRow> {
    const now = new Date().toISOString();
    this.d.prepare(`
      INSERT INTO kgl_run_event (
        id, run_id, step_id, kind, agent_id, tool_key, summary, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.run_id, row.step_id ?? null, row.kind, row.agent_id ?? null,
      row.tool_key ?? null, row.summary, row.payload_json ?? null, now,
    );
    this.d.prepare(`UPDATE kgl_competition_run SET event_count = event_count + 1, updated_at = ? WHERE id = ?`).run(now, row.run_id);
    return (this.d.prepare(`SELECT * FROM kgl_run_event WHERE id = ?`).get(row.id) as KglRunEventRow);
  }

  async listKglRunEvents(runId: string, opts: { afterId?: string; limit?: number } = {}): Promise<KglRunEventRow[]> {
    const where: string[] = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (opts.afterId) { where.push('id > ?'); params.push(opts.afterId); }
    const sql = `SELECT * FROM kgl_run_event WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return this.d.prepare(sql).all(...params) as KglRunEventRow[];
  }

  /**
   * Read recent heartbeat_tick rows for a single agent out of the live-agents
   * StateStore (la_entities, entity_type='heartbeat_tick'), ordered by
   * scheduledFor desc. Used by the kaggle heartbeat scheduler for
   * backoff-on-failure / circuit-breaker logic so a permanently broken
   * upstream (e.g. OpenAI 429) doesn't get retried every 30s forever.
   */
  async listRecentHeartbeatTicksForAgent(agentId: string, limit: number = 20): Promise<Array<{
    id: string;
    status: string;
    actionOutcomeStatus: string | null;
    actionOutcomeProse: string | null;
    scheduledFor: string;
    completedAt: string | null;
  }>> {
    // Filter and order in SQL via json_extract — much cheaper than scanning
    // every tick payload in JS for high-volume meshes.
    const rows = this.d.prepare(`
      SELECT payload_json FROM la_entities
      WHERE entity_type = 'heartbeat_tick'
        AND json_extract(payload_json, '$.agentId') = ?
      ORDER BY json_extract(payload_json, '$.scheduledFor') DESC
      LIMIT ?
    `).all(agentId, limit) as Array<{ payload_json: string }>;
    const out: Array<{
      id: string;
      status: string;
      actionOutcomeStatus: string | null;
      actionOutcomeProse: string | null;
      scheduledFor: string;
      completedAt: string | null;
    }> = [];
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json) as Record<string, unknown>;
        out.push({
          id: String(p['id'] ?? ''),
          status: String(p['status'] ?? ''),
          actionOutcomeStatus: (p['actionOutcomeStatus'] as string | null) ?? null,
          actionOutcomeProse: (p['actionOutcomeProse'] as string | null) ?? null,
          scheduledFor: String(p['scheduledFor'] ?? ''),
          completedAt: (p['completedAt'] as string | null) ?? null,
        });
      } catch { /* skip malformed */ }
    }
    return out;
  }

  /**
   * Read inter-agent messages for a mesh out of the live-agents StateStore
   * (la_entities, entity_type='message'). Used by the admin Run record view
   * to surface what each agent said to the next. Best-effort — returns []
   * when la_entities is empty or payload_json is malformed.
   */
  async listLiveMeshMessages(meshId: string, opts: { limit?: number } = {}): Promise<LiveMeshMessageView[]> {
    const limit = opts.limit ?? 500;
    const rows = this.d.prepare(`
      SELECT id, payload_json FROM la_entities
      WHERE entity_type = 'message'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; payload_json: string }>;
    const out: LiveMeshMessageView[] = [];
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json) as Record<string, unknown>;
        if (p['meshId'] !== meshId && p['fromMeshId'] !== meshId) continue;
        out.push({
          id: r.id,
          meshId: (p['meshId'] as string | null) ?? null,
          fromType: (p['fromType'] as string | null) ?? null,
          fromId: (p['fromId'] as string | null) ?? null,
          toType: (p['toType'] as string | null) ?? null,
          toId: (p['toId'] as string | null) ?? null,
          topic: (p['topic'] as string | null) ?? null,
          kind: (p['kind'] as string | null) ?? null,
          subject: (p['subject'] as string | null) ?? null,
          body: (p['body'] as string | null) ?? null,
          status: (p['status'] as string | null) ?? null,
          createdAt: (p['createdAt'] as string | null) ?? null,
          deliveredAt: (p['deliveredAt'] as string | null) ?? null,
          readAt: (p['readAt'] as string | null) ?? null,
          processedAt: (p['processedAt'] as string | null) ?? null,
        });
      } catch { /* ignore malformed row */ }
    }
    out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    return out;
  }

  // ─── Kaggle role capability matrix (M45) ─────────────────────

  async getKaggleRoleCapabilityMatrix(): Promise<Record<string, string[]>> {
    const rows = this.d.prepare('SELECT role, capabilities FROM kaggle_role_capabilities').all() as Array<{ role: string; capabilities: string }>;
    const result: Record<string, string[]> = {};
    for (const row of rows) {
      try { result[row.role] = JSON.parse(row.capabilities) as string[]; } catch { /* skip malformed */ }
    }
    return result;
  }

  async upsertKaggleRoleCapability(role: string, capabilities: string[], updatedBy: string | null): Promise<void> {
    this.d.prepare(
      `INSERT INTO kaggle_role_capabilities (role, capabilities, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(role) DO UPDATE SET capabilities = excluded.capabilities, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(role, JSON.stringify(capabilities), updatedBy);
  }

  // ─── Live mesh / agent definitions (M21) ─────────────────────

  async listLiveMeshDefinitions(opts: { enabledOnly?: boolean } = {}): Promise<LiveMeshDefinitionRow[]> {
    const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
    return this.d.prepare(`SELECT * FROM live_mesh_definitions ${where} ORDER BY mesh_key ASC`).all() as LiveMeshDefinitionRow[];
  }

  async getLiveMeshDefinition(id: string): Promise<LiveMeshDefinitionRow | null> {
    return (this.d.prepare('SELECT * FROM live_mesh_definitions WHERE id = ?').get(id) as LiveMeshDefinitionRow | undefined) ?? null;
  }

  async getLiveMeshDefinitionByKey(meshKey: string): Promise<LiveMeshDefinitionRow | null> {
    return (this.d.prepare('SELECT * FROM live_mesh_definitions WHERE mesh_key = ?').get(meshKey) as LiveMeshDefinitionRow | undefined) ?? null;
  }

  async createLiveMeshDefinition(row: Omit<LiveMeshDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDefinitionRow> {
    this.d.prepare(
      `INSERT INTO live_mesh_definitions (id, mesh_key, name, charter_prose, dual_control_required_for, enabled, description) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.mesh_key, row.name, row.charter_prose, row.dual_control_required_for, row.enabled, row.description);
    return (this.d.prepare('SELECT * FROM live_mesh_definitions WHERE id = ?').get(row.id) as LiveMeshDefinitionRow);
  }

  async updateLiveMeshDefinition(id: string, patch: Partial<Omit<LiveMeshDefinitionRow, 'id' | 'created_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`); vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    this.d.prepare(`UPDATE live_mesh_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteLiveMeshDefinition(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_mesh_definitions WHERE id = ?').run(id);
  }

  async listLiveAgentDefinitions(opts: { meshDefId?: string; enabledOnly?: boolean } = {}): Promise<LiveAgentDefinitionRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.meshDefId) { where.push('mesh_def_id = ?'); params.push(opts.meshDefId); }
    if (opts.enabledOnly) where.push('enabled = 1');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.d.prepare(`SELECT * FROM live_agent_definitions ${whereSql} ORDER BY mesh_def_id, ordering ASC, role_key ASC`).all(...params) as LiveAgentDefinitionRow[];
  }

  async getLiveAgentDefinition(id: string): Promise<LiveAgentDefinitionRow | null> {
    return (this.d.prepare('SELECT * FROM live_agent_definitions WHERE id = ?').get(id) as LiveAgentDefinitionRow | undefined) ?? null;
  }

  async createLiveAgentDefinition(row: Omit<LiveAgentDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveAgentDefinitionRow> {
    this.d.prepare(
      `INSERT INTO live_agent_definitions (id, mesh_def_id, role_key, name, role_label, persona, objectives, success_indicators, ordering, enabled, model_capability_json, model_routing_policy_key, model_pinned_id, default_handler_kind, default_handler_config_json, default_tool_catalog_keys, default_attention_policy_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id, row.mesh_def_id, row.role_key, row.name, row.role_label, row.persona,
      row.objectives, row.success_indicators, row.ordering, row.enabled,
      row.model_capability_json ?? null, row.model_routing_policy_key ?? null,
      row.model_pinned_id ?? null,
      row.default_handler_kind ?? null, row.default_handler_config_json ?? null,
      row.default_tool_catalog_keys ?? null, row.default_attention_policy_key ?? null,
    );
    return (this.d.prepare('SELECT * FROM live_agent_definitions WHERE id = ?').get(row.id) as LiveAgentDefinitionRow);
  }

  async updateLiveAgentDefinition(id: string, patch: Partial<Omit<LiveAgentDefinitionRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`); vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    this.d.prepare(`UPDATE live_agent_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteLiveAgentDefinition(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_agent_definitions WHERE id = ?').run(id);
  }

  async listLiveMeshDelegationEdges(opts: { meshDefId?: string; enabledOnly?: boolean } = {}): Promise<LiveMeshDelegationEdgeRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.meshDefId) { where.push('mesh_def_id = ?'); params.push(opts.meshDefId); }
    if (opts.enabledOnly) where.push('enabled = 1');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.d.prepare(`SELECT * FROM live_mesh_delegation_edges ${whereSql} ORDER BY mesh_def_id, ordering ASC`).all(...params) as LiveMeshDelegationEdgeRow[];
  }

  async getLiveMeshDelegationEdge(id: string): Promise<LiveMeshDelegationEdgeRow | null> {
    return (this.d.prepare('SELECT * FROM live_mesh_delegation_edges WHERE id = ?').get(id) as LiveMeshDelegationEdgeRow | undefined) ?? null;
  }

  async createLiveMeshDelegationEdge(row: Omit<LiveMeshDelegationEdgeRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDelegationEdgeRow> {
    this.d.prepare(
      `INSERT INTO live_mesh_delegation_edges (id, mesh_def_id, from_role_key, to_role_key, relationship, prose, ordering, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.mesh_def_id, row.from_role_key, row.to_role_key, row.relationship, row.prose, row.ordering, row.enabled);
    return (this.d.prepare('SELECT * FROM live_mesh_delegation_edges WHERE id = ?').get(row.id) as LiveMeshDelegationEdgeRow);
  }

  async updateLiveMeshDelegationEdge(id: string, patch: Partial<Omit<LiveMeshDelegationEdgeRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`); vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    this.d.prepare(`UPDATE live_mesh_delegation_edges SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteLiveMeshDelegationEdge(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_mesh_delegation_edges WHERE id = ?').run(id);
  }

  // ─── DB-Driven Live-Agents Runtime CRUD (M22, Phase 1) ───────
  // All methods below mirror the table layout in db-sqlite-migrations.ts §M22.
  // Pattern: list / get(byId|byKey) / create / update (dynamic SET) / delete.
  // Inserts return the freshly-fetched row so the API can return it verbatim.

  // ── live_handler_kinds ──
  async listLiveHandlerKinds(opts: { enabledOnly?: boolean } = {}): Promise<LiveHandlerKindRow[]> {
    const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
    return this.d.prepare(`SELECT * FROM live_handler_kinds ${where} ORDER BY kind ASC`).all() as LiveHandlerKindRow[];
  }
  async getLiveHandlerKind(id: string): Promise<LiveHandlerKindRow | null> {
    return (this.d.prepare('SELECT * FROM live_handler_kinds WHERE id = ?').get(id) as LiveHandlerKindRow | undefined) ?? null;
  }
  async getLiveHandlerKindByKind(kind: string): Promise<LiveHandlerKindRow | null> {
    return (this.d.prepare('SELECT * FROM live_handler_kinds WHERE kind = ?').get(kind) as LiveHandlerKindRow | undefined) ?? null;
  }
  async createLiveHandlerKind(row: Omit<LiveHandlerKindRow, 'created_at' | 'updated_at'>): Promise<LiveHandlerKindRow> {
    this.d.prepare(
      `INSERT INTO live_handler_kinds (id, kind, description, config_schema_json, source, enabled) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.kind, row.description, row.config_schema_json, row.source, row.enabled);
    return this.d.prepare('SELECT * FROM live_handler_kinds WHERE id = ?').get(row.id) as LiveHandlerKindRow;
  }
  async updateLiveHandlerKind(id: string, patch: Partial<Omit<LiveHandlerKindRow, 'id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_handler_kinds SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveHandlerKind(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_handler_kinds WHERE id = ?').run(id);
  }

  // ── live_attention_policies ──
  async listLiveAttentionPolicies(opts: { enabledOnly?: boolean } = {}): Promise<LiveAttentionPolicyRow[]> {
    const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
    return this.d.prepare(`SELECT * FROM live_attention_policies ${where} ORDER BY key ASC`).all() as LiveAttentionPolicyRow[];
  }
  async getLiveAttentionPolicy(id: string): Promise<LiveAttentionPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM live_attention_policies WHERE id = ?').get(id) as LiveAttentionPolicyRow | undefined) ?? null;
  }
  async getLiveAttentionPolicyByKey(key: string): Promise<LiveAttentionPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM live_attention_policies WHERE key = ?').get(key) as LiveAttentionPolicyRow | undefined) ?? null;
  }
  async createLiveAttentionPolicy(row: Omit<LiveAttentionPolicyRow, 'created_at' | 'updated_at'>): Promise<LiveAttentionPolicyRow> {
    this.d.prepare(
      `INSERT INTO live_attention_policies (id, key, kind, description, config_json, enabled) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.key, row.kind, row.description, row.config_json, row.enabled);
    return this.d.prepare('SELECT * FROM live_attention_policies WHERE id = ?').get(row.id) as LiveAttentionPolicyRow;
  }
  async updateLiveAttentionPolicy(id: string, patch: Partial<Omit<LiveAttentionPolicyRow, 'id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_attention_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveAttentionPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_attention_policies WHERE id = ?').run(id);
  }

  // ── live_meshes (provisioned) ──
  async listLiveMeshes(opts: { tenantId?: string; meshDefId?: string; status?: string } = {}): Promise<LiveMeshRow[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.tenantId)  { where.push('tenant_id = ?');   params.push(opts.tenantId); }
    if (opts.meshDefId) { where.push('mesh_def_id = ?'); params.push(opts.meshDefId); }
    if (opts.status)    { where.push('status = ?');      params.push(opts.status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.d.prepare(`SELECT * FROM live_meshes ${whereSql} ORDER BY created_at DESC`).all(...params) as LiveMeshRow[];
  }
  async getLiveMesh(id: string): Promise<LiveMeshRow | null> {
    return (this.d.prepare('SELECT * FROM live_meshes WHERE id = ?').get(id) as LiveMeshRow | undefined) ?? null;
  }
  async createLiveMesh(row: Omit<LiveMeshRow, 'created_at' | 'updated_at'>): Promise<LiveMeshRow> {
    this.d.prepare(
      `INSERT INTO live_meshes (id, tenant_id, mesh_def_id, name, status, domain, dual_control_required_for, owner_human_id, mcp_server_ref, account_id, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.tenant_id, row.mesh_def_id, row.name, row.status, row.domain, row.dual_control_required_for, row.owner_human_id, row.mcp_server_ref, row.account_id, row.context_json);
    return this.d.prepare('SELECT * FROM live_meshes WHERE id = ?').get(row.id) as LiveMeshRow;
  }
  async updateLiveMesh(id: string, patch: Partial<Omit<LiveMeshRow, 'id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_meshes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveMesh(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_meshes WHERE id = ?').run(id);
  }

  // ── live_agents (provisioned) ──
  async listLiveAgents(opts: { meshId?: string; status?: string } = {}): Promise<LiveAgentRow[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.meshId) { where.push('mesh_id = ?'); params.push(opts.meshId); }
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.d.prepare(`SELECT * FROM live_agents ${whereSql} ORDER BY mesh_id, ordering ASC, role_key ASC`).all(...params) as LiveAgentRow[];
  }
  async getLiveAgent(id: string): Promise<LiveAgentRow | null> {
    return (this.d.prepare('SELECT * FROM live_agents WHERE id = ?').get(id) as LiveAgentRow | undefined) ?? null;
  }
  async createLiveAgent(row: Omit<LiveAgentRow, 'created_at' | 'updated_at'>): Promise<LiveAgentRow> {
    this.d.prepare(
      `INSERT INTO live_agents (id, mesh_id, agent_def_id, role_key, name, role_label, persona, objectives, success_indicators, attention_policy_key, contract_version_id, status, ordering, archived_at, model_capability_json, model_routing_policy_key, model_pinned_id, prepare_config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.mesh_id, row.agent_def_id, row.role_key, row.name, row.role_label, row.persona, row.objectives, row.success_indicators, row.attention_policy_key, row.contract_version_id, row.status, row.ordering, row.archived_at, row.model_capability_json ?? null, row.model_routing_policy_key ?? null, row.model_pinned_id ?? null, row.prepare_config_json ?? null);
    return this.d.prepare('SELECT * FROM live_agents WHERE id = ?').get(row.id) as LiveAgentRow;
  }
  async updateLiveAgent(id: string, patch: Partial<Omit<LiveAgentRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveAgent(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_agents WHERE id = ?').run(id);
  }

  // ── live_agent_handler_bindings ──
  async listLiveAgentHandlerBindings(opts: { agentId?: string; enabledOnly?: boolean } = {}): Promise<LiveAgentHandlerBindingRow[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.agentId)     { where.push('agent_id = ?'); params.push(opts.agentId); }
    if (opts.enabledOnly) { where.push('enabled = 1'); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.d.prepare(`SELECT * FROM live_agent_handler_bindings ${whereSql} ORDER BY agent_id, handler_kind`).all(...params) as LiveAgentHandlerBindingRow[];
  }
  async getLiveAgentHandlerBinding(id: string): Promise<LiveAgentHandlerBindingRow | null> {
    return (this.d.prepare('SELECT * FROM live_agent_handler_bindings WHERE id = ?').get(id) as LiveAgentHandlerBindingRow | undefined) ?? null;
  }
  async createLiveAgentHandlerBinding(row: Omit<LiveAgentHandlerBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentHandlerBindingRow> {
    this.d.prepare(
      `INSERT INTO live_agent_handler_bindings (id, agent_id, handler_kind, config_json, enabled) VALUES (?, ?, ?, ?, ?)`
    ).run(row.id, row.agent_id, row.handler_kind, row.config_json, row.enabled);
    return this.d.prepare('SELECT * FROM live_agent_handler_bindings WHERE id = ?').get(row.id) as LiveAgentHandlerBindingRow;
  }
  async updateLiveAgentHandlerBinding(id: string, patch: Partial<Omit<LiveAgentHandlerBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_agent_handler_bindings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveAgentHandlerBinding(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_agent_handler_bindings WHERE id = ?').run(id);
  }

  // ── live_agent_tool_bindings ──
  async listLiveAgentToolBindings(opts: { agentId?: string; enabledOnly?: boolean } = {}): Promise<LiveAgentToolBindingRow[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.agentId)     { where.push('agent_id = ?'); params.push(opts.agentId); }
    if (opts.enabledOnly) { where.push('enabled = 1'); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.d.prepare(`SELECT * FROM live_agent_tool_bindings ${whereSql} ORDER BY agent_id`).all(...params) as LiveAgentToolBindingRow[];
  }
  async getLiveAgentToolBinding(id: string): Promise<LiveAgentToolBindingRow | null> {
    return (this.d.prepare('SELECT * FROM live_agent_tool_bindings WHERE id = ?').get(id) as LiveAgentToolBindingRow | undefined) ?? null;
  }
  async createLiveAgentToolBinding(row: Omit<LiveAgentToolBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentToolBindingRow> {
    this.d.prepare(
      `INSERT INTO live_agent_tool_bindings (id, agent_id, tool_catalog_id, mcp_server_url, capability_keys, enabled) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.agent_id, row.tool_catalog_id, row.mcp_server_url, row.capability_keys, row.enabled);
    return this.d.prepare('SELECT * FROM live_agent_tool_bindings WHERE id = ?').get(row.id) as LiveAgentToolBindingRow;
  }
  async updateLiveAgentToolBinding(id: string, patch: Partial<Omit<LiveAgentToolBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_agent_tool_bindings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveAgentToolBinding(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_agent_tool_bindings WHERE id = ?').run(id);
  }

  // ── live_runs ──
  async listLiveRuns(opts: { meshId?: string; tenantId?: string; status?: string; limit?: number } = {}): Promise<LiveRunRow[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.meshId)   { where.push('mesh_id = ?');   params.push(opts.meshId); }
    if (opts.tenantId) { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    if (opts.status)   { where.push('status = ?');    params.push(opts.status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql  = opts.limit ? `LIMIT ${Number(opts.limit)}` : '';
    return this.d.prepare(`SELECT * FROM live_runs ${whereSql} ORDER BY started_at DESC ${limitSql}`).all(...params) as LiveRunRow[];
  }
  async getLiveRun(id: string): Promise<LiveRunRow | null> {
    return (this.d.prepare('SELECT * FROM live_runs WHERE id = ?').get(id) as LiveRunRow | undefined) ?? null;
  }
  async createLiveRun(row: Omit<LiveRunRow, 'created_at' | 'updated_at'>): Promise<LiveRunRow> {
    this.d.prepare(
      `INSERT INTO live_runs (id, mesh_id, tenant_id, run_key, label, status, started_at, completed_at, summary, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.mesh_id, row.tenant_id, row.run_key, row.label, row.status, row.started_at, row.completed_at, row.summary, row.context_json);
    return this.d.prepare('SELECT * FROM live_runs WHERE id = ?').get(row.id) as LiveRunRow;
  }
  async updateLiveRun(id: string, patch: Partial<Omit<LiveRunRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveRun(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_runs WHERE id = ?').run(id);
  }

  // ── api_live_runs (user-scoped, no mesh FK, durable stop signal) ──
  async createApiLiveRun(row: Omit<ApiLiveRunRow, 'created_at' | 'updated_at'>): Promise<ApiLiveRunRow> {
    this.d.prepare(
      `INSERT INTO api_live_runs (id, user_id, tenant_id, agent_id, status, stop_requested, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.user_id, row.tenant_id ?? null, row.agent_id ?? null, row.status, row.stop_requested ?? 0, row.config_json ?? null);
    return this.d.prepare('SELECT * FROM api_live_runs WHERE id = ?').get(row.id) as ApiLiveRunRow;
  }
  async getApiLiveRun(id: string): Promise<ApiLiveRunRow | null> {
    return (this.d.prepare('SELECT * FROM api_live_runs WHERE id = ?').get(id) as ApiLiveRunRow | undefined) ?? null;
  }
  async listUserApiLiveRuns(userId: string, opts: { status?: string; limit?: number } = {}): Promise<ApiLiveRunRow[]> {
    const where: string[] = ['user_id = ?']; const params: unknown[] = [userId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    const limitSql = opts.limit ? `LIMIT ${Number(opts.limit)}` : 'LIMIT 100';
    return this.d.prepare(`SELECT * FROM api_live_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC ${limitSql}`).all(...params) as ApiLiveRunRow[];
  }
  async updateApiLiveRun(id: string, patch: Partial<Omit<ApiLiveRunRow, 'id' | 'user_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE api_live_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteApiLiveRun(id: string): Promise<void> {
    this.d.prepare('DELETE FROM api_live_runs WHERE id = ?').run(id);
  }

  // ── live_run_steps ──
  async listLiveRunSteps(opts: { runId?: string; meshId?: string; agentId?: string } = {}): Promise<LiveRunStepRow[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.runId)   { where.push('run_id = ?');   params.push(opts.runId); }
    if (opts.meshId)  { where.push('mesh_id = ?');  params.push(opts.meshId); }
    if (opts.agentId) { where.push('agent_id = ?'); params.push(opts.agentId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.d.prepare(`SELECT * FROM live_run_steps ${whereSql} ORDER BY created_at ASC`).all(...params) as LiveRunStepRow[];
  }
  async getLiveRunStep(id: string): Promise<LiveRunStepRow | null> {
    return (this.d.prepare('SELECT * FROM live_run_steps WHERE id = ?').get(id) as LiveRunStepRow | undefined) ?? null;
  }
  async createLiveRunStep(row: Omit<LiveRunStepRow, 'created_at' | 'updated_at'>): Promise<LiveRunStepRow> {
    this.d.prepare(
      `INSERT INTO live_run_steps (id, run_id, mesh_id, agent_id, role_key, status, started_at, completed_at, summary, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.run_id, row.mesh_id, row.agent_id, row.role_key, row.status, row.started_at, row.completed_at, row.summary, row.payload_json);
    return this.d.prepare('SELECT * FROM live_run_steps WHERE id = ?').get(row.id) as LiveRunStepRow;
  }
  async updateLiveRunStep(id: string, patch: Partial<Omit<LiveRunStepRow, 'id' | 'run_id' | 'mesh_id' | 'created_at'>>): Promise<void> {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id);
    this.d.prepare(`UPDATE live_run_steps SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async deleteLiveRunStep(id: string): Promise<void> {
    this.d.prepare('DELETE FROM live_run_steps WHERE id = ?').run(id);
  }

  // ── live_run_events (append-only) ──
  async listLiveRunEvents(opts: { runId?: string; afterId?: string; limit?: number } = {}): Promise<LiveRunEventRow[]> {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.runId)   { where.push('run_id = ?');     params.push(opts.runId); }
    if (opts.afterId) { where.push('id > ?');         params.push(opts.afterId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql  = opts.limit ? `LIMIT ${Number(opts.limit)}` : 'LIMIT 500';
    return this.d.prepare(`SELECT * FROM live_run_events ${whereSql} ORDER BY id ASC ${limitSql}`).all(...params) as LiveRunEventRow[];
  }
  async getLiveRunEvent(id: string): Promise<LiveRunEventRow | null> {
    return (this.d.prepare('SELECT * FROM live_run_events WHERE id = ?').get(id) as LiveRunEventRow | undefined) ?? null;
  }
  async appendLiveRunEvent(row: Omit<LiveRunEventRow, 'created_at'>): Promise<LiveRunEventRow> {
    this.d.prepare(
      `INSERT INTO live_run_events (id, run_id, step_id, kind, agent_id, tool_key, summary, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.run_id, row.step_id, row.kind, row.agent_id, row.tool_key, row.summary, row.payload_json);
    return this.d.prepare('SELECT * FROM live_run_events WHERE id = ?').get(row.id) as LiveRunEventRow;
  }

  // ── IMeStore ────────────────────────────────────────────────────────────────

  async createUserRun(run: { id: string; user_id: string; status: 'pending'|'running'|'completed'|'failed'|'cancelled'; tenant_id?: string; surface?: string; metadata?: string }): Promise<void> {
    this.d.prepare(
      'INSERT INTO user_runs (id, user_id, tenant_id, status, surface, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(run.id, run.user_id, run.tenant_id ?? null, run.status, run.surface ?? null, run.metadata ?? null);
  }

  async getUserRun(id: string, userId: string): Promise<import('./db-types/adapter-me.js').UserRunRow | null> {
    return (this.d.prepare('SELECT * FROM user_runs WHERE id = ? AND user_id = ?').get(id, userId) as import('./db-types/adapter-me.js').UserRunRow | undefined) ?? null;
  }

  /**
   * Owner-agnostic run lookup by id (Collaboration Phase 3). Used by the
   * notification outbox, where we have a runId from a terminal event but not the
   * owner. NOT an access-control path — callers must authorize separately.
   */
  async getUserRunById(id: string): Promise<import('./db-types/adapter-me.js').UserRunRow | null> {
    return (this.d.prepare('SELECT * FROM user_runs WHERE id = ?').get(id) as import('./db-types/adapter-me.js').UserRunRow | undefined) ?? null;
  }

  async listUserRuns(userId: string, filter: { status?: 'pending'|'running'|'completed'|'failed'|'cancelled'; limit?: number; offset?: number } = {}): Promise<import('./db-types/adapter-me.js').UserRunRow[]> {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    if (filter.status) {
      return this.d.prepare('SELECT * FROM user_runs WHERE user_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(userId, filter.status, limit, offset) as import('./db-types/adapter-me.js').UserRunRow[];
    }
    return this.d.prepare('SELECT * FROM user_runs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(userId, limit, offset) as import('./db-types/adapter-me.js').UserRunRow[];
  }

  async updateUserRunStatus(id: string, userId: string, status: 'pending'|'running'|'completed'|'failed'|'cancelled'): Promise<void> {
    this.d.prepare("UPDATE user_runs SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(status, id, userId);
  }

  async appendUserRunEvent(event: { id: string; run_id: string; sequence: number; kind: string; payload: string }): Promise<void> {
    this.d.prepare(
      'INSERT OR IGNORE INTO user_run_events (id, run_id, sequence, kind, payload) VALUES (?, ?, ?, ?, ?)'
    ).run(event.id, event.run_id, event.sequence, event.kind, event.payload);
  }

  async listUserRunEvents(runId: string, afterSequence = -1): Promise<import('./db-types/adapter-me.js').UserRunEventRow[]> {
    return this.d.prepare('SELECT * FROM user_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC').all(runId, afterSequence) as import('./db-types/adapter-me.js').UserRunEventRow[];
  }

  // Per-run journal purge (Collaboration Phase 0 — backs the core RunJournal
  // port's `purgeRun`, e.g. after a run is archived). Distinct from the global
  // `pruneUserRunEvents` retention sweep below.
  async deleteUserRunEvents(runId: string): Promise<number> {
    return this.d.prepare('DELETE FROM user_run_events WHERE run_id = ?').run(runId).changes;
  }

  // ── Presence (m94, Collaboration Phase 1) — current-state, heartbeat/TTL ─────
  // Backs the collaboration PresenceManager SQL adapter. UPSERT on heartbeat,
  // DELETE on leave/expiry. NEVER appended to the journal (ephemeral).
  async upsertRunPresence(row: {
    id: string; run_id: string; tenant_id?: string | null; user_id: string; display_name: string;
    presence: string; peer_type: string; color?: string | null; cursor_json?: string | null;
    last_heartbeat_at: number; expires_at: number;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO run_presence
         (id, run_id, tenant_id, user_id, display_name, presence, peer_type, color, cursor_json, last_heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, user_id) DO UPDATE SET
         display_name = excluded.display_name, presence = excluded.presence, peer_type = excluded.peer_type,
         color = excluded.color, cursor_json = excluded.cursor_json,
         last_heartbeat_at = excluded.last_heartbeat_at, expires_at = excluded.expires_at`,
    ).run(
      row.id, row.run_id, row.tenant_id ?? null, row.user_id, row.display_name, row.presence, row.peer_type,
      row.color ?? null, row.cursor_json ?? null, row.last_heartbeat_at, row.expires_at,
    );
  }

  async listActiveRunPresence(runId: string, now: number): Promise<import('./db-types/adapter-me.js').RunPresenceRow[]> {
    return this.d.prepare(
      'SELECT * FROM run_presence WHERE run_id = ? AND expires_at > ? ORDER BY peer_type DESC, user_id ASC',
    ).all(runId, now) as import('./db-types/adapter-me.js').RunPresenceRow[];
  }

  async deleteRunPresence(runId: string, userId: string): Promise<number> {
    return this.d.prepare('DELETE FROM run_presence WHERE run_id = ? AND user_id = ?').run(runId, userId).changes;
  }

  /** Sweep expired presence; returns the distinct affected runs (for re-broadcast). */
  async deleteExpiredRunPresence(now: number): Promise<Array<{ run_id: string; tenant_id: string | null }>> {
    const affected = this.d.prepare(
      'SELECT DISTINCT run_id, tenant_id FROM run_presence WHERE expires_at <= ?',
    ).all(now) as Array<{ run_id: string; tenant_id: string | null }>;
    this.d.prepare('DELETE FROM run_presence WHERE expires_at <= ?').run(now);
    return affected;
  }

  async getCollaborationConfig(): Promise<import('./db-types/adapter-me.js').CollaborationConfigRow | null> {
    return (this.d.prepare(`SELECT * FROM collaboration_config WHERE id = 'global'`).get() ?? null) as import('./db-types/adapter-me.js').CollaborationConfigRow | null;
  }

  // ── Shared sessions + invite links (m95, Collaboration Phase 2) ─────────────
  async createSharedSession(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; max_participants: number; created_at: number }): Promise<void> {
    // Idempotent per run via UNIQUE(run_id) + the owner is participant #1.
    this.d.prepare(
      `INSERT OR IGNORE INTO shared_sessions (id, run_id, tenant_id, owner_id, status, max_participants, created_at)
       VALUES (?, ?, ?, ?, 'live', ?, ?)`,
    ).run(row.id, row.run_id, row.tenant_id ?? null, row.owner_id, row.max_participants, row.created_at);
  }
  async getSharedSessionById(id: string): Promise<import('./db-types/adapter-me.js').SharedSessionRow | null> {
    return (this.d.prepare('SELECT * FROM shared_sessions WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').SharedSessionRow | null;
  }
  async getSharedSessionByRun(runId: string): Promise<import('./db-types/adapter-me.js').SharedSessionRow | null> {
    return (this.d.prepare('SELECT * FROM shared_sessions WHERE run_id = ?').get(runId) ?? null) as import('./db-types/adapter-me.js').SharedSessionRow | null;
  }
  async endSharedSession(id: string, endedAt: number): Promise<void> {
    this.d.prepare(`UPDATE shared_sessions SET status = 'ended', ended_at = ? WHERE id = ?`).run(endedAt, id);
  }
  async upsertSessionParticipant(row: { id: string; session_id: string; tenant_id?: string | null; user_id: string; role: string; joined_at: number; invited_via_token_id?: string | null }): Promise<void> {
    this.d.prepare(
      `INSERT INTO session_participants (id, session_id, tenant_id, user_id, role, joined_at, invited_via_token_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, user_id) DO UPDATE SET role = excluded.role`,
    ).run(row.id, row.session_id, row.tenant_id ?? null, row.user_id, row.role, row.joined_at, row.invited_via_token_id ?? null);
  }
  async getSessionParticipant(sessionId: string, userId: string): Promise<import('./db-types/adapter-me.js').SessionParticipantRow | null> {
    return (this.d.prepare('SELECT * FROM session_participants WHERE session_id = ? AND user_id = ?').get(sessionId, userId) ?? null) as import('./db-types/adapter-me.js').SessionParticipantRow | null;
  }
  async listSessionParticipants(sessionId: string): Promise<import('./db-types/adapter-me.js').SessionParticipantRow[]> {
    return this.d.prepare('SELECT * FROM session_participants WHERE session_id = ? ORDER BY joined_at ASC').all(sessionId) as import('./db-types/adapter-me.js').SessionParticipantRow[];
  }
  async deleteSessionParticipant(sessionId: string, userId: string): Promise<number> {
    return this.d.prepare('DELETE FROM session_participants WHERE session_id = ? AND user_id = ?').run(sessionId, userId).changes;
  }
  async createShareToken(row: { id: string; session_id: string; tenant_id?: string | null; role: string; token_hash: string; token_prefix: string; max_uses?: number | null; expires_at?: number | null; created_by: string; created_at: number }): Promise<void> {
    this.d.prepare(
      `INSERT INTO session_share_tokens (id, session_id, tenant_id, role, token_hash, token_prefix, max_uses, uses, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(row.id, row.session_id, row.tenant_id ?? null, row.role, row.token_hash, row.token_prefix, row.max_uses ?? null, row.expires_at ?? null, row.created_by, row.created_at);
  }
  async getShareTokenByHash(tokenHash: string): Promise<import('./db-types/adapter-me.js').ShareTokenRow | null> {
    return (this.d.prepare('SELECT * FROM session_share_tokens WHERE token_hash = ?').get(tokenHash) ?? null) as import('./db-types/adapter-me.js').ShareTokenRow | null;
  }
  async incrementShareTokenUses(id: string): Promise<void> {
    this.d.prepare('UPDATE session_share_tokens SET uses = uses + 1 WHERE id = ?').run(id);
  }
  async revokeShareToken(id: string, revokedAt: number): Promise<void> {
    this.d.prepare('UPDATE session_share_tokens SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
  }

  // ── Durable subscriptions + notifications (m96, Collaboration Phase 3) ──────
  async upsertRunSubscription(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; created_at: number }): Promise<import('./db-types/adapter-me.js').RunSubscriptionRow> {
    // Idempotent per (run, user): re-subscribing updates the channel set but
    // preserves the original created_at and the existing row id.
    this.d.prepare(
      `INSERT INTO run_subscriptions (id, run_id, tenant_id, user_id, channels, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, user_id) DO UPDATE SET channels = excluded.channels`,
    ).run(row.id, row.run_id, row.tenant_id ?? null, row.user_id, row.channels, row.created_at);
    return this.d.prepare('SELECT * FROM run_subscriptions WHERE run_id = ? AND user_id = ?').get(row.run_id, row.user_id) as import('./db-types/adapter-me.js').RunSubscriptionRow;
  }
  async deleteRunSubscription(runId: string, userId: string): Promise<number> {
    return this.d.prepare('DELETE FROM run_subscriptions WHERE run_id = ? AND user_id = ?').run(runId, userId).changes;
  }
  async getRunSubscription(runId: string, userId: string): Promise<import('./db-types/adapter-me.js').RunSubscriptionRow | null> {
    return (this.d.prepare('SELECT * FROM run_subscriptions WHERE run_id = ? AND user_id = ?').get(runId, userId) ?? null) as import('./db-types/adapter-me.js').RunSubscriptionRow | null;
  }
  async listRunSubscribers(runId: string): Promise<import('./db-types/adapter-me.js').RunSubscriptionRow[]> {
    return this.d.prepare('SELECT * FROM run_subscriptions WHERE run_id = ? ORDER BY created_at ASC').all(runId) as import('./db-types/adapter-me.js').RunSubscriptionRow[];
  }
  async listSubscriptionsForUser(userId: string): Promise<import('./db-types/adapter-me.js').RunSubscriptionRow[]> {
    return this.d.prepare('SELECT * FROM run_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as import('./db-types/adapter-me.js').RunSubscriptionRow[];
  }

  // Notification feed (in-app inbox) — fan-out-on-write, dedupe per principal.
  async appendNotificationFeed(row: import('./db-types/adapter-me.js').NotificationFeedRow): Promise<import('./db-types/adapter-me.js').NotificationFeedRow> {
    // Idempotent on (principal_id, dedupe_key): the partial UNIQUE index means a
    // duplicate insert is ignored; we then return the surviving row.
    this.d.prepare(
      `INSERT OR IGNORE INTO notification_feed (id, tenant_id, principal_id, category, title, body, deep_link, priority, dedupe_key, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.tenant_id ?? null, row.principal_id, row.category, row.title, row.body ?? null, row.deep_link ?? null, row.priority, row.dedupe_key ?? null, row.created_at, row.read_at ?? null);
    if (row.dedupe_key) {
      const existing = this.d.prepare('SELECT * FROM notification_feed WHERE principal_id = ? AND dedupe_key = ?').get(row.principal_id, row.dedupe_key);
      if (existing) return existing as import('./db-types/adapter-me.js').NotificationFeedRow;
    }
    return (this.d.prepare('SELECT * FROM notification_feed WHERE id = ?').get(row.id) ?? row) as import('./db-types/adapter-me.js').NotificationFeedRow;
  }
  async listNotificationFeed(tenantId: string, principalId: string, opts?: { limit?: number; unreadOnly?: boolean }): Promise<import('./db-types/adapter-me.js').NotificationFeedRow[]> {
    const unread = opts?.unreadOnly ? 'AND read_at IS NULL' : '';
    const limit = typeof opts?.limit === 'number' ? `LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
    return this.d.prepare(
      `SELECT * FROM notification_feed WHERE tenant_id IS ? AND principal_id = ? ${unread} ORDER BY created_at DESC ${limit}`,
    ).all(tenantId === '__global__' ? null : tenantId, principalId) as import('./db-types/adapter-me.js').NotificationFeedRow[];
  }
  async countUnreadNotificationFeed(tenantId: string, principalId: string): Promise<number> {
    const r = this.d.prepare('SELECT COUNT(*) AS n FROM notification_feed WHERE tenant_id IS ? AND principal_id = ? AND read_at IS NULL').get(tenantId === '__global__' ? null : tenantId, principalId) as { n: number };
    return r.n;
  }
  async markNotificationFeedRead(tenantId: string, principalId: string, id: string, now: number): Promise<boolean> {
    return this.d.prepare('UPDATE notification_feed SET read_at = ? WHERE id = ? AND tenant_id IS ? AND principal_id = ? AND read_at IS NULL').run(now, id, tenantId === '__global__' ? null : tenantId, principalId).changes > 0;
  }
  async markAllNotificationFeedRead(tenantId: string, principalId: string, now: number): Promise<number> {
    return this.d.prepare('UPDATE notification_feed SET read_at = ? WHERE tenant_id IS ? AND principal_id = ? AND read_at IS NULL').run(now, tenantId === '__global__' ? null : tenantId, principalId).changes;
  }

  // Transactional outbox — crash-safe at-least-once delivery.
  async enqueueNotificationOutbox(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; payload: string; idempotency_key: string; next_attempt_at: number; created_at: number }): Promise<boolean> {
    // UNIQUE(run_id, user_id): exactly one delivery per subscriber per run terminal.
    return this.d.prepare(
      `INSERT OR IGNORE INTO notification_outbox (id, run_id, tenant_id, user_id, channels, payload, idempotency_key, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(row.id, row.run_id, row.tenant_id ?? null, row.user_id, row.channels, row.payload, row.idempotency_key, row.next_attempt_at, row.created_at).changes > 0;
  }
  async claimNotificationOutbox(now: number, leaseUntil: number, limit: number): Promise<import('./db-types/adapter-me.js').NotificationOutboxRow[]> {
    // Atomically lease due rows. A row is claimable when it is pending/failed and
    // due, OR stuck in 'sending' past its lease (the previous worker crashed).
    const claim = this.d.transaction((n: number, lease: number, lim: number) => {
      const rows = this.d.prepare(
        `SELECT * FROM notification_outbox
          WHERE ((status = 'pending' AND next_attempt_at <= ?)
                 OR (status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?))
          ORDER BY next_attempt_at ASC LIMIT ?`,
      ).all(n, n, lim) as import('./db-types/adapter-me.js').NotificationOutboxRow[];
      const upd = this.d.prepare(`UPDATE notification_outbox SET status = 'sending', lease_until = ?, attempts = attempts + 1 WHERE id = ?`);
      for (const r of rows) upd.run(lease, r.id);
      return rows;
    });
    return claim(now, leaseUntil, Math.max(1, Math.floor(limit)));
  }
  async markNotificationOutboxSent(id: string, sentAt: number): Promise<void> {
    this.d.prepare(`UPDATE notification_outbox SET status = 'sent', sent_at = ?, lease_until = NULL, last_error = NULL WHERE id = ?`).run(sentAt, id);
  }
  async rescheduleNotificationOutbox(id: string, nextAttemptAt: number, attempts: number, lastError: string, failed: boolean): Promise<void> {
    // `failed` = exhausted the retry budget → dead-letter (status 'failed', not retried).
    this.d.prepare(`UPDATE notification_outbox SET status = ?, next_attempt_at = ?, last_error = ?, lease_until = NULL WHERE id = ?`)
      .run(failed ? 'failed' : 'pending', nextAttemptAt, lastError.slice(0, 500), id);
    void attempts; // attempts already incremented at claim time
  }
  async hasNotificationOutboxForRun(runId: string): Promise<boolean> {
    return this.d.prepare('SELECT 1 FROM notification_outbox WHERE run_id = ? LIMIT 1').get(runId) !== undefined;
  }
  async listTerminalRunsWithSubscribers(limit: number): Promise<import('./db-types/adapter-me.js').UserRunRow[]> {
    return this.d.prepare(
      `SELECT r.* FROM user_runs r
        WHERE r.status IN ('completed','failed','cancelled')
          AND EXISTS (SELECT 1 FROM run_subscriptions s WHERE s.run_id = r.id)
        ORDER BY r.created_at DESC LIMIT ?`,
    ).all(Math.max(1, Math.floor(limit))) as import('./db-types/adapter-me.js').UserRunRow[];
  }

  // ── Run comments + annotations + public share (m97, Collaboration Phase 4) ──
  async createRunComment(row: import('./db-types/adapter-me.js').RunCommentRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO run_comments (id, run_id, tenant_id, thread_id, parent_id, author_id, body, body_html, mentions_json, anchor_part_id, anchor_seq, anchor_range_json, created_at, updated_at, edited_at, deleted_at, deleted_by, resolved_at, resolved_by)
       VALUES (@id, @run_id, @tenant_id, @thread_id, @parent_id, @author_id, @body, @body_html, @mentions_json, @anchor_part_id, @anchor_seq, @anchor_range_json, @created_at, @updated_at, @edited_at, @deleted_at, @deleted_by, @resolved_at, @resolved_by)`,
    ).run(row);
  }
  async getRunComment(id: string): Promise<import('./db-types/adapter-me.js').RunCommentRow | null> {
    return (this.d.prepare('SELECT * FROM run_comments WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').RunCommentRow | null;
  }
  async listRunComments(runId: string): Promise<import('./db-types/adapter-me.js').RunCommentRow[]> {
    return this.d.prepare('SELECT * FROM run_comments WHERE run_id = ? ORDER BY created_at ASC').all(runId) as import('./db-types/adapter-me.js').RunCommentRow[];
  }
  async listRunCommentThread(threadId: string): Promise<import('./db-types/adapter-me.js').RunCommentRow[]> {
    return this.d.prepare('SELECT * FROM run_comments WHERE thread_id = ? ORDER BY created_at ASC').all(threadId) as import('./db-types/adapter-me.js').RunCommentRow[];
  }
  async updateRunCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void> {
    this.d.prepare('UPDATE run_comments SET body = ?, body_html = ?, mentions_json = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(body, bodyHtml, mentionsJson, editedAt, updatedAt, id);
  }
  async softDeleteRunComment(id: string, deletedBy: string, deletedAt: number): Promise<void> {
    // Tombstone: scrub the body but keep the row so replies are not orphaned.
    this.d.prepare(`UPDATE run_comments SET body = '', body_html = '', mentions_json = '[]', deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?`).run(deletedAt, deletedBy, deletedAt, id);
  }
  async setRunThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void> {
    // Resolution is recorded on the ROOT (id === thread_id); reads mirror it across the thread.
    this.d.prepare('UPDATE run_comments SET resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?').run(resolvedAt, resolvedBy, updatedAt, threadId);
  }
  async createRunAnnotation(row: import('./db-types/adapter-me.js').RunAnnotationRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO run_annotations (id, run_id, tenant_id, part_id, author_id, name, data_type, value, string_value, comment, source, created_at)
       VALUES (@id, @run_id, @tenant_id, @part_id, @author_id, @name, @data_type, @value, @string_value, @comment, @source, @created_at)`,
    ).run(row);
  }
  async getRunAnnotation(id: string): Promise<import('./db-types/adapter-me.js').RunAnnotationRow | null> {
    return (this.d.prepare('SELECT * FROM run_annotations WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').RunAnnotationRow | null;
  }
  async listRunAnnotations(runId: string): Promise<import('./db-types/adapter-me.js').RunAnnotationRow[]> {
    return this.d.prepare('SELECT * FROM run_annotations WHERE run_id = ? ORDER BY created_at ASC').all(runId) as import('./db-types/adapter-me.js').RunAnnotationRow[];
  }
  async deleteRunAnnotation(id: string): Promise<number> {
    return this.d.prepare('DELETE FROM run_annotations WHERE id = ?').run(id).changes;
  }
  async createRunPublicShare(row: { id: string; run_id: string; tenant_id?: string | null; token_hash: string; token_prefix: string; created_by: string; created_at: number; expires_at?: number | null }): Promise<void> {
    this.d.prepare(
      `INSERT INTO run_public_shares (id, run_id, tenant_id, token_hash, token_prefix, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.run_id, row.tenant_id ?? null, row.token_hash, row.token_prefix, row.created_by, row.created_at, row.expires_at ?? null);
  }
  async getRunPublicShareByHash(tokenHash: string): Promise<import('./db-types/adapter-me.js').RunPublicShareRow | null> {
    return (this.d.prepare('SELECT * FROM run_public_shares WHERE token_hash = ?').get(tokenHash) ?? null) as import('./db-types/adapter-me.js').RunPublicShareRow | null;
  }
  async listRunPublicShares(runId: string): Promise<import('./db-types/adapter-me.js').RunPublicShareRow[]> {
    return this.d.prepare('SELECT * FROM run_public_shares WHERE run_id = ? AND revoked_at IS NULL ORDER BY created_at ASC').all(runId) as import('./db-types/adapter-me.js').RunPublicShareRow[];
  }
  async revokeRunPublicShare(id: string, runId: string, revokedAt: number): Promise<number> {
    return this.d.prepare('UPDATE run_public_shares SET revoked_at = ? WHERE id = ? AND run_id = ?').run(revokedAt, id, runId).changes;
  }

  // ── Unified handoff (m98, Collaboration Phase 5) ────────────────────────────
  async insertSessionHandoff(row: import('./db-types/adapter-me.js').SessionHandoffRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO session_handoffs (id, run_id, tenant_id, scope, from_actor_type, from_actor_id, to_actor_type, to_actor_id, state, reason, briefing_json, rejection_reason, hand_back_briefing_json, depth, parent_handoff_id, reference_task_ids_json, created_at, updated_at, resolved_at, expires_at)
       VALUES (@id, @run_id, @tenant_id, @scope, @from_actor_type, @from_actor_id, @to_actor_type, @to_actor_id, @state, @reason, @briefing_json, @rejection_reason, @hand_back_briefing_json, @depth, @parent_handoff_id, @reference_task_ids_json, @created_at, @updated_at, @resolved_at, @expires_at)`,
    ).run(row);
  }
  async getSessionHandoff(id: string): Promise<import('./db-types/adapter-me.js').SessionHandoffRow | null> {
    return (this.d.prepare('SELECT * FROM session_handoffs WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').SessionHandoffRow | null;
  }
  async updateSessionHandoff(id: string, fields: Partial<Pick<import('./db-types/adapter-me.js').SessionHandoffRow, 'state' | 'rejection_reason' | 'hand_back_briefing_json' | 'updated_at' | 'resolved_at'>>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    this.d.prepare(`UPDATE session_handoffs SET ${set} WHERE id = @id`).run({ ...fields, id });
  }
  async listSessionHandoffsForRun(runId: string): Promise<import('./db-types/adapter-me.js').SessionHandoffRow[]> {
    return this.d.prepare('SELECT * FROM session_handoffs WHERE run_id = ? ORDER BY created_at DESC').all(runId) as import('./db-types/adapter-me.js').SessionHandoffRow[];
  }
  async listSessionHandoffsForActor(actorId: string): Promise<import('./db-types/adapter-me.js').SessionHandoffRow[]> {
    return this.d.prepare('SELECT * FROM session_handoffs WHERE to_actor_id = ? ORDER BY created_at DESC').all(actorId) as import('./db-types/adapter-me.js').SessionHandoffRow[];
  }
  async listDueSessionHandoffs(now: number): Promise<import('./db-types/adapter-me.js').SessionHandoffRow[]> {
    return this.d.prepare(`SELECT * FROM session_handoffs WHERE state IN ('requested','accepted') AND expires_at IS NOT NULL AND expires_at <= ?`).all(now) as import('./db-types/adapter-me.js').SessionHandoffRow[];
  }
  async insertHandoffEvent(row: import('./db-types/adapter-me.js').HandoffEventRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO handoff_events (id, handoff_id, at, actor_id, from_state, to_state, note)
       VALUES (@id, @handoff_id, @at, @actor_id, @from_state, @to_state, @note)`,
    ).run(row);
  }
  async listHandoffEvents(handoffId: string): Promise<import('./db-types/adapter-me.js').HandoffEventRow[]> {
    // Order by INSERTION (rowid), not (at, id): many transitions land in the same
    // millisecond and UUIDv7 ids are not reliably monotonic within a ms, which
    // would scramble the audit trail. rowid is strict insertion order.
    return this.d.prepare('SELECT * FROM handoff_events WHERE handoff_id = ? ORDER BY rowid ASC').all(handoffId) as import('./db-types/adapter-me.js').HandoffEventRow[];
  }

  // ── CRDT co-editing (m99, Collaboration Phase 7) ────────────────────────────
  async createCoeditDoc(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; title?: string | null; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean> {
    // Idempotent per run via UNIQUE(run_id).
    return this.d.prepare(
      `INSERT OR IGNORE INTO coedit_docs (id, run_id, tenant_id, owner_id, title, snapshot_json, state_vector_json, agent_written, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(row.id, row.run_id, row.tenant_id ?? null, row.owner_id, row.title ?? null, row.snapshot_json, row.state_vector_json, row.created_at, row.updated_at).changes > 0;
  }
  async getCoeditDoc(id: string): Promise<import('./db-types/adapter-me.js').CoeditDocRow | null> {
    return (this.d.prepare('SELECT * FROM coedit_docs WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').CoeditDocRow | null;
  }
  async getCoeditDocByRun(runId: string): Promise<import('./db-types/adapter-me.js').CoeditDocRow | null> {
    return (this.d.prepare('SELECT * FROM coedit_docs WHERE run_id = ?').get(runId) ?? null) as import('./db-types/adapter-me.js').CoeditDocRow | null;
  }
  async updateCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; agent_written: number; updated_at: number }): Promise<void> {
    this.d.prepare('UPDATE coedit_docs SET snapshot_json = ?, state_vector_json = ?, agent_written = ?, updated_at = ? WHERE id = ?')
      .run(fields.snapshot_json, fields.state_vector_json, fields.agent_written, fields.updated_at, id);
  }
  async appendCoeditOp(row: import('./db-types/adapter-me.js').CoeditOpRow): Promise<boolean> {
    return this.d.prepare(
      `INSERT OR IGNORE INTO coedit_ops (id, doc_id, op_site, op_counter, op_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.doc_id, row.op_site, row.op_counter, row.op_json, row.created_at).changes > 0;
  }
  async listCoeditOps(docId: string): Promise<import('./db-types/adapter-me.js').CoeditOpRow[]> {
    return this.d.prepare('SELECT * FROM coedit_ops WHERE doc_id = ? ORDER BY rowid ASC').all(docId) as import('./db-types/adapter-me.js').CoeditOpRow[];
  }

  // ── weaveNotes Phase 2 — collaborative NOTE co-editing (m100) ────────────────
  async createNoteCoeditDoc(row: { id: string; note_id: string; tenant_id?: string | null; owner_id: string; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean> {
    // Idempotent per note via UNIQUE(note_id).
    return this.d.prepare(
      `INSERT OR IGNORE INTO note_coedit_docs (id, note_id, tenant_id, owner_id, snapshot_json, state_vector_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.note_id, row.tenant_id ?? null, row.owner_id, row.snapshot_json, row.state_vector_json, row.created_at, row.updated_at).changes > 0;
  }
  async getNoteCoeditDoc(id: string): Promise<import('./db-types/adapter-me.js').NoteCoeditDocRow | null> {
    return (this.d.prepare('SELECT * FROM note_coedit_docs WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').NoteCoeditDocRow | null;
  }
  async getNoteCoeditDocByNote(noteId: string): Promise<import('./db-types/adapter-me.js').NoteCoeditDocRow | null> {
    return (this.d.prepare('SELECT * FROM note_coedit_docs WHERE note_id = ?').get(noteId) ?? null) as import('./db-types/adapter-me.js').NoteCoeditDocRow | null;
  }
  async updateNoteCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; updated_at: number }): Promise<void> {
    this.d.prepare('UPDATE note_coedit_docs SET snapshot_json = ?, state_vector_json = ?, updated_at = ? WHERE id = ?')
      .run(fields.snapshot_json, fields.state_vector_json, fields.updated_at, id);
  }
  async appendNoteCoeditOp(row: import('./db-types/adapter-me.js').NoteCoeditOpRow): Promise<boolean> {
    return this.d.prepare(
      `INSERT OR IGNORE INTO note_coedit_ops (id, doc_id, op_site, op_counter, op_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.doc_id, row.op_site, row.op_counter, row.op_json, row.created_at).changes > 0;
  }
  async listNoteCoeditOps(docId: string): Promise<import('./db-types/adapter-me.js').NoteCoeditOpRow[]> {
    return this.d.prepare('SELECT * FROM note_coedit_ops WHERE doc_id = ? ORDER BY rowid ASC').all(docId) as import('./db-types/adapter-me.js').NoteCoeditOpRow[];
  }
  // Note sharing — membership + invite tokens.
  async getNoteForOwner(noteId: string, ownerId: string): Promise<{ id: string; owner_user_id: string; tenant_id: string | null } | null> {
    return (this.d.prepare('SELECT id, owner_user_id, tenant_id FROM notes WHERE id = ? AND owner_user_id = ?').get(noteId, ownerId) ?? null) as { id: string; owner_user_id: string; tenant_id: string | null } | null;
  }
  async getNoteShare(noteId: string, userId: string): Promise<import('./db-types/adapter-me.js').NoteShareRow | null> {
    return (this.d.prepare('SELECT * FROM note_shares WHERE note_id = ? AND user_id = ?').get(noteId, userId) ?? null) as import('./db-types/adapter-me.js').NoteShareRow | null;
  }
  async listNoteShares(noteId: string): Promise<import('./db-types/adapter-me.js').NoteShareRow[]> {
    return this.d.prepare('SELECT * FROM note_shares WHERE note_id = ? ORDER BY joined_at ASC').all(noteId) as import('./db-types/adapter-me.js').NoteShareRow[];
  }
  async upsertNoteShare(row: import('./db-types/adapter-me.js').NoteShareRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_shares (id, note_id, tenant_id, owner_id, user_id, role, joined_at, invited_via_token_id)
       VALUES (@id, @note_id, @tenant_id, @owner_id, @user_id, @role, @joined_at, @invited_via_token_id)
       ON CONFLICT(note_id, user_id) DO UPDATE SET role = excluded.role, invited_via_token_id = excluded.invited_via_token_id`,
    ).run(row);
  }
  async deleteNoteShare(noteId: string, userId: string): Promise<number> {
    return this.d.prepare('DELETE FROM note_shares WHERE note_id = ? AND user_id = ?').run(noteId, userId).changes;
  }
  async createNoteShareToken(row: import('./db-types/adapter-me.js').NoteShareTokenRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_share_tokens (id, note_id, tenant_id, owner_id, role, token_hash, token_prefix, max_uses, uses, expires_at, revoked_at, created_by, created_at)
       VALUES (@id, @note_id, @tenant_id, @owner_id, @role, @token_hash, @token_prefix, @max_uses, @uses, @expires_at, @revoked_at, @created_by, @created_at)`,
    ).run(row);
  }
  async getNoteShareTokenByHash(hash: string): Promise<import('./db-types/adapter-me.js').NoteShareTokenRow | null> {
    return (this.d.prepare('SELECT * FROM note_share_tokens WHERE token_hash = ?').get(hash) ?? null) as import('./db-types/adapter-me.js').NoteShareTokenRow | null;
  }
  async listNoteShareTokens(noteId: string): Promise<import('./db-types/adapter-me.js').NoteShareTokenRow[]> {
    return this.d.prepare('SELECT * FROM note_share_tokens WHERE note_id = ? ORDER BY created_at DESC').all(noteId) as import('./db-types/adapter-me.js').NoteShareTokenRow[];
  }
  async incrementNoteShareTokenUses(id: string): Promise<void> {
    this.d.prepare('UPDATE note_share_tokens SET uses = uses + 1 WHERE id = ?').run(id);
  }
  async revokeNoteShareToken(id: string, noteId: string, revokedAt: number): Promise<number> {
    return this.d.prepare('UPDATE note_share_tokens SET revoked_at = ? WHERE id = ? AND note_id = ? AND revoked_at IS NULL').run(revokedAt, id, noteId).changes;
  }
  // weaveNotes Phase 3 — AI co-author suggestions (track-changes).
  async createNoteSuggestion(row: import('./db-types/adapter-me.js').NoteSuggestionRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_suggestions (id, note_id, doc_id, tenant_id, author_kind, author_id, author_site, action, status, ops_json, preview_text, before_text, anchor_json, created_at, resolved_at, resolved_by)
       VALUES (@id, @note_id, @doc_id, @tenant_id, @author_kind, @author_id, @author_site, @action, @status, @ops_json, @preview_text, @before_text, @anchor_json, @created_at, @resolved_at, @resolved_by)`,
    ).run({ ...row, before_text: row.before_text ?? '' });
  }
  async getNoteSuggestion(id: string): Promise<import('./db-types/adapter-me.js').NoteSuggestionRow | null> {
    return (this.d.prepare('SELECT * FROM note_suggestions WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').NoteSuggestionRow | null;
  }
  async listNoteSuggestions(noteId: string, status?: 'pending' | 'accepted' | 'rejected'): Promise<import('./db-types/adapter-me.js').NoteSuggestionRow[]> {
    const sql = status
      ? 'SELECT * FROM note_suggestions WHERE note_id = ? AND status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM note_suggestions WHERE note_id = ? ORDER BY created_at DESC';
    const args = status ? [noteId, status] : [noteId];
    return this.d.prepare(sql).all(...args) as import('./db-types/adapter-me.js').NoteSuggestionRow[];
  }
  async resolveNoteSuggestion(id: string, status: 'accepted' | 'rejected', resolvedAt: number, resolvedBy: string): Promise<number> {
    // Only a still-pending suggestion can be resolved (idempotency / double-accept guard).
    return this.d.prepare("UPDATE note_suggestions SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'")
      .run(status, resolvedAt, resolvedBy, id).changes;
  }

  // weaveNotes Phase 5 — notes knowledge graph.
  async replaceNoteEntities(noteId: string, rows: import('./db-types/adapter-me.js').NoteEntityRow[]): Promise<void> {
    const del = this.d.prepare('DELETE FROM note_entities WHERE note_id = ?');
    const ins = this.d.prepare('INSERT INTO note_entities (id, note_id, user_id, tenant_id, name, name_key, type, created_at, canonical_key, canonical_name) VALUES (@id,@note_id,@user_id,@tenant_id,@name,@name_key,@type,@created_at,@canonical_key,@canonical_name)');
    this.d.transaction(() => { del.run(noteId); for (const r of rows) ins.run({ canonical_key: null, canonical_name: null, ...r }); })();
  }
  async listNoteEntities(noteId: string): Promise<import('./db-types/adapter-me.js').NoteEntityRow[]> {
    return this.d.prepare('SELECT * FROM note_entities WHERE note_id = ? ORDER BY created_at ASC').all(noteId) as import('./db-types/adapter-me.js').NoteEntityRow[];
  }
  async listUserNoteEntities(userId: string, tenantId?: string | null): Promise<import('./db-types/adapter-me.js').NoteEntityRow[]> {
    return (tenantId === undefined
      ? this.d.prepare('SELECT * FROM note_entities WHERE user_id = ?').all(userId)
      : this.d.prepare('SELECT * FROM note_entities WHERE user_id = ? AND tenant_id IS ?').all(userId, tenantId ?? null)) as import('./db-types/adapter-me.js').NoteEntityRow[];
  }
  // geneWeave UI rebuild (m135) — per-tenant Appearance / branding.
  async getTenantAppearance(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantAppearanceRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_appearance WHERE tenant_id = ?').get(tenantId) ?? null) as import('./db-types/adapter-me.js').TenantAppearanceRow | null;
  }
  async upsertTenantAppearance(row: import('./db-types/adapter-me.js').TenantAppearanceRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_appearance (tenant_id, enabled, brand_name, logo_svg, color_scheme, variant, accent, on_accent, corner_style, font_display, font_body, density, updated_at)
       VALUES (@tenant_id,@enabled,@brand_name,@logo_svg,@color_scheme,@variant,@accent,@on_accent,@corner_style,@font_display,@font_body,@density,@updated_at)
       ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled, brand_name=excluded.brand_name, logo_svg=excluded.logo_svg, color_scheme=excluded.color_scheme, variant=excluded.variant, accent=excluded.accent, on_accent=excluded.on_accent, corner_style=excluded.corner_style, font_display=excluded.font_display, font_body=excluded.font_body, density=excluded.density, updated_at=excluded.updated_at`,
    ).run(row);
  }
  async listTenantAppearance(): Promise<import('./db-types/adapter-me.js').TenantAppearanceRow[]> {
    return this.d.prepare('SELECT * FROM tenant_appearance ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantAppearanceRow[];
  }

  // m137 — per-tenant AI transparency (answer feedback itself is stored via insertMessageFeedback/listMessageFeedback).
  async getTenantAiTransparency(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantAiTransparencyRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_ai_transparency WHERE tenant_id = ?').get(tenantId) as import('./db-types/adapter-me.js').TenantAiTransparencyRow | undefined) ?? null;
  }
  async upsertTenantAiTransparency(row: import('./db-types/adapter-me.js').TenantAiTransparencyRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_ai_transparency (tenant_id, show_ai_label, disclosure_text, content_warnings, feedback_enabled)
       VALUES (@tenant_id, @show_ai_label, @disclosure_text, @content_warnings, @feedback_enabled)
       ON CONFLICT(tenant_id) DO UPDATE SET
         show_ai_label=excluded.show_ai_label, disclosure_text=excluded.disclosure_text,
         content_warnings=excluded.content_warnings, feedback_enabled=excluded.feedback_enabled, updated_at=datetime('now')`,
    ).run(row);
  }
  async listTenantAiTransparency(): Promise<import('./db-types/adapter-me.js').TenantAiTransparencyRow[]> {
    return this.d.prepare('SELECT * FROM tenant_ai_transparency ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantAiTransparencyRow[];
  }

  // m138 — answer citations in chat.
  async insertMessageCitations(rows: import('./db-types/adapter-me.js').MessageCitationRow[]): Promise<void> {
    if (!rows.length) return;
    const stmt = this.d.prepare(
      `INSERT INTO message_citations (id, message_id, chat_id, user_id, tenant_id, n, source_id, source_kind, source_title, quote, char_start, char_end)
       VALUES (@id, @message_id, @chat_id, @user_id, @tenant_id, @n, @source_id, @source_kind, @source_title, @quote, @char_start, @char_end)`,
    );
    const tx = this.d.transaction((rs: import('./db-types/adapter-me.js').MessageCitationRow[]) => { for (const r of rs) stmt.run(r); });
    tx(rows);
  }
  async listMessageCitations(messageId: string): Promise<import('./db-types/adapter-me.js').MessageCitationRow[]> {
    return this.d.prepare('SELECT * FROM message_citations WHERE message_id = ? ORDER BY n ASC').all(messageId) as import('./db-types/adapter-me.js').MessageCitationRow[];
  }
  async getTenantChatCitations(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantChatCitationsRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_chat_citations WHERE tenant_id = ?').get(tenantId) as import('./db-types/adapter-me.js').TenantChatCitationsRow | undefined) ?? null;
  }
  async upsertTenantChatCitations(row: import('./db-types/adapter-me.js').TenantChatCitationsRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_chat_citations (tenant_id, enabled, min_citations, scope, max_sources)
       VALUES (@tenant_id, @enabled, @min_citations, @scope, @max_sources)
       ON CONFLICT(tenant_id) DO UPDATE SET
         enabled=excluded.enabled, min_citations=excluded.min_citations, scope=excluded.scope,
         max_sources=excluded.max_sources, updated_at=datetime('now')`,
    ).run(row);
  }
  async listTenantChatCitations(): Promise<import('./db-types/adapter-me.js').TenantChatCitationsRow[]> {
    return this.d.prepare('SELECT * FROM tenant_chat_citations ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantChatCitationsRow[];
  }

  // m139 — regenerate with version history.
  async insertMessageVariants(rows: import('./db-types/adapter-me.js').MessageVariantRow[]): Promise<void> {
    if (!rows.length) return;
    const stmt = this.d.prepare(
      `INSERT INTO message_variants (id, group_id, chat_id, user_id, tenant_id, variant_index, content, model, provider, reason)
       VALUES (@id, @group_id, @chat_id, @user_id, @tenant_id, @variant_index, @content, @model, @provider, @reason)`,
    );
    const tx = this.d.transaction((rs: import('./db-types/adapter-me.js').MessageVariantRow[]) => { for (const r of rs) stmt.run(r); });
    tx(rows);
  }
  async listMessageVariants(groupId: string): Promise<import('./db-types/adapter-me.js').MessageVariantRow[]> {
    return this.d.prepare('SELECT * FROM message_variants WHERE group_id = ? ORDER BY variant_index ASC').all(groupId) as import('./db-types/adapter-me.js').MessageVariantRow[];
  }
  async updateMessageContent(messageId: string, content: string, metadata: string | null): Promise<void> {
    this.d.prepare('UPDATE messages SET content = ?, metadata = ? WHERE id = ?').run(content, metadata, messageId);
  }
  async getTenantAnswerVersions(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantAnswerVersionsRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_answer_versions WHERE tenant_id = ?').get(tenantId) as import('./db-types/adapter-me.js').TenantAnswerVersionsRow | undefined) ?? null;
  }
  async upsertTenantAnswerVersions(row: import('./db-types/adapter-me.js').TenantAnswerVersionsRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_answer_versions (tenant_id, enabled, max_variants)
       VALUES (@tenant_id, @enabled, @max_variants)
       ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled, max_variants=excluded.max_variants, updated_at=datetime('now')`,
    ).run(row);
  }
  async listTenantAnswerVersions(): Promise<import('./db-types/adapter-me.js').TenantAnswerVersionsRow[]> {
    return this.d.prepare('SELECT * FROM tenant_answer_versions ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantAnswerVersionsRow[];
  }

  // m140 — per-tenant accessibility defaults.
  async getTenantAccessibility(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantAccessibilityRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_accessibility WHERE tenant_id = ?').get(tenantId) as import('./db-types/adapter-me.js').TenantAccessibilityRow | undefined) ?? null;
  }
  async upsertTenantAccessibility(row: import('./db-types/adapter-me.js').TenantAccessibilityRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_accessibility (tenant_id, announce_mode, reduced_motion, always_show_focus, confirm_destructive, show_skeletons)
       VALUES (@tenant_id, @announce_mode, @reduced_motion, @always_show_focus, @confirm_destructive, @show_skeletons)
       ON CONFLICT(tenant_id) DO UPDATE SET announce_mode=excluded.announce_mode, reduced_motion=excluded.reduced_motion, always_show_focus=excluded.always_show_focus, confirm_destructive=excluded.confirm_destructive, show_skeletons=excluded.show_skeletons, updated_at=datetime('now')`,
    ).run(row);
  }
  async listTenantAccessibility(): Promise<import('./db-types/adapter-me.js').TenantAccessibilityRow[]> {
    return this.d.prepare('SELECT * FROM tenant_accessibility ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantAccessibilityRow[];
  }

  // m143 — per-tenant role-access policy.
  async getTenantRoleAccess(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantRoleAccessRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_role_access WHERE tenant_id = ?').get(tenantId) as import('./db-types/adapter-me.js').TenantRoleAccessRow | undefined) ?? null;
  }
  async upsertTenantRoleAccess(row: import('./db-types/adapter-me.js').TenantRoleAccessRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_role_access (tenant_id, member_dashboard, member_connectors, member_design)
       VALUES (@tenant_id, @member_dashboard, @member_connectors, @member_design)
       ON CONFLICT(tenant_id) DO UPDATE SET member_dashboard=excluded.member_dashboard, member_connectors=excluded.member_connectors, member_design=excluded.member_design, updated_at=datetime('now')`,
    ).run(row);
  }
  async listTenantRoleAccess(): Promise<import('./db-types/adapter-me.js').TenantRoleAccessRow[]> {
    return this.d.prepare('SELECT * FROM tenant_role_access ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantRoleAccessRow[];
  }
  // m145 — per-tenant i18n policy + AI-generated locale packs.
  async getTenantLocales(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantLocalesRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_locales WHERE tenant_id = ?').get(tenantId) as import('./db-types/adapter-me.js').TenantLocalesRow | undefined) ?? null;
  }
  async upsertTenantLocales(row: import('./db-types/adapter-me.js').TenantLocalesRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_locales (tenant_id, default_locale, enabled_locales, assistant_localized)
       VALUES (@tenant_id, @default_locale, @enabled_locales, @assistant_localized)
       ON CONFLICT(tenant_id) DO UPDATE SET default_locale=excluded.default_locale, enabled_locales=excluded.enabled_locales, assistant_localized=excluded.assistant_localized, updated_at=datetime('now')`,
    ).run({ tenant_id: row.tenant_id, default_locale: row.default_locale, enabled_locales: row.enabled_locales, assistant_localized: row.assistant_localized });
  }
  async listTenantLocales(): Promise<import('./db-types/adapter-me.js').TenantLocalesRow[]> {
    return this.d.prepare('SELECT * FROM tenant_locales ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantLocalesRow[];
  }
  async getTenantUiTranslation(tenantId: string, locale: string): Promise<import('./db-types/adapter-me.js').TenantUiTranslationRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_ui_translations WHERE tenant_id = ? AND locale = ?').get(tenantId, locale) as import('./db-types/adapter-me.js').TenantUiTranslationRow | undefined) ?? null;
  }
  async listTenantUiTranslations(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantUiTranslationRow[]> {
    return this.d.prepare('SELECT * FROM tenant_ui_translations WHERE tenant_id = ? ORDER BY locale ASC').all(tenantId) as import('./db-types/adapter-me.js').TenantUiTranslationRow[];
  }
  async upsertTenantUiTranslation(row: import('./db-types/adapter-me.js').TenantUiTranslationRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_ui_translations (tenant_id, locale, messages_json, source, key_count)
       VALUES (@tenant_id, @locale, @messages_json, @source, @key_count)
       ON CONFLICT(tenant_id, locale) DO UPDATE SET messages_json=excluded.messages_json, source=excluded.source, key_count=excluded.key_count, updated_at=datetime('now')`,
    ).run({ tenant_id: row.tenant_id, locale: row.locale, messages_json: row.messages_json, source: row.source, key_count: row.key_count });
  }
  // m146 — suggested/starter prompts: per-tenant policy + per-user AI cache + click log.
  async getTenantSuggestedPrompts(tenantId: string): Promise<import('./db-types/adapter-me.js').TenantSuggestedPromptsRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_suggested_prompts WHERE tenant_id = ?').get(tenantId) as import('./db-types/adapter-me.js').TenantSuggestedPromptsRow | undefined) ?? null;
  }
  async upsertTenantSuggestedPrompts(row: import('./db-types/adapter-me.js').TenantSuggestedPromptsRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_suggested_prompts (tenant_id, enabled, use_recent_notes, use_recent_chats, use_ai, max_curated, max_personalized)
       VALUES (@tenant_id, @enabled, @use_recent_notes, @use_recent_chats, @use_ai, @max_curated, @max_personalized)
       ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled, use_recent_notes=excluded.use_recent_notes, use_recent_chats=excluded.use_recent_chats, use_ai=excluded.use_ai, max_curated=excluded.max_curated, max_personalized=excluded.max_personalized, updated_at=datetime('now')`,
    ).run({ tenant_id: row.tenant_id, enabled: row.enabled, use_recent_notes: row.use_recent_notes, use_recent_chats: row.use_recent_chats, use_ai: row.use_ai, max_curated: row.max_curated, max_personalized: row.max_personalized });
  }
  async listTenantSuggestedPrompts(): Promise<import('./db-types/adapter-me.js').TenantSuggestedPromptsRow[]> {
    return this.d.prepare('SELECT * FROM tenant_suggested_prompts ORDER BY tenant_id ASC').all() as import('./db-types/adapter-me.js').TenantSuggestedPromptsRow[];
  }
  async getUserPromptSuggestions(userId: string): Promise<import('./db-types/adapter-me.js').UserPromptSuggestionsRow | null> {
    return (this.d.prepare('SELECT * FROM user_prompt_suggestions WHERE user_id = ?').get(userId) as import('./db-types/adapter-me.js').UserPromptSuggestionsRow | undefined) ?? null;
  }
  async upsertUserPromptSuggestions(row: import('./db-types/adapter-me.js').UserPromptSuggestionsRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO user_prompt_suggestions (user_id, tenant_id, prompts_json, generated_at)
       VALUES (@user_id, @tenant_id, @prompts_json, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id, prompts_json=excluded.prompts_json, generated_at=datetime('now')`,
    ).run({ user_id: row.user_id, tenant_id: row.tenant_id, prompts_json: row.prompts_json });
  }
  async insertPromptSuggestionEvent(row: import('./db-types/adapter-me.js').PromptSuggestionEventRow): Promise<void> {
    this.d.prepare(
      `INSERT OR IGNORE INTO prompt_suggestion_events (id, user_id, tenant_id, prompt_id, title, source)
       VALUES (@id, @user_id, @tenant_id, @prompt_id, @title, @source)`,
    ).run({ id: row.id, user_id: row.user_id, tenant_id: row.tenant_id, prompt_id: row.prompt_id, title: row.title, source: row.source });
  }

  // weaveNotes Phase 5 (m134) — background-memory extraction state.
  async getNoteMemoryState(noteId: string, userId: string): Promise<import('./db-types/adapter-me.js').NoteMemoryStateRow | null> {
    return (this.d.prepare('SELECT * FROM note_memory_state WHERE note_id = ? AND user_id = ?').get(noteId, userId) ?? null) as import('./db-types/adapter-me.js').NoteMemoryStateRow | null;
  }
  async upsertNoteMemoryState(row: import('./db-types/adapter-me.js').NoteMemoryStateRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_memory_state (note_id, user_id, tenant_id, content_hash, memory_ids_json, memory_count, last_extracted_at)
       VALUES (@note_id,@user_id,@tenant_id,@content_hash,@memory_ids_json,@memory_count,@last_extracted_at)
       ON CONFLICT(note_id) DO UPDATE SET content_hash=excluded.content_hash, memory_ids_json=excluded.memory_ids_json, memory_count=excluded.memory_count, last_extracted_at=excluded.last_extracted_at`,
    ).run(row);
  }
  async listNotesNeedingMemoryExtraction(limit: number): Promise<import('./db-types/adapter-me.js').NoteNeedingMemoryRow[]> {
    return this.d.prepare(
      `SELECT n.id AS id, n.owner_user_id AS owner_user_id, n.tenant_id AS tenant_id, n.updated_at AS updated_at
         FROM notes n
         LEFT JOIN note_memory_state s ON s.note_id = n.id
        WHERE (n.is_template = 0 OR n.is_template IS NULL)
          AND (n.archived_at IS NULL)
          AND (s.note_id IS NULL OR datetime(n.updated_at) > datetime(s.last_extracted_at))
        ORDER BY n.updated_at DESC
        LIMIT ?`,
    ).all(Math.max(1, Math.min(200, limit))) as import('./db-types/adapter-me.js').NoteNeedingMemoryRow[];
  }
  // weaveNotes Phase 4 (m133) — captured meetings.
  async createNoteMeeting(row: import('./db-types/adapter-me.js').NoteMeetingRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_meetings (id, note_id, user_id, tenant_id, title, source, language, duration_sec, segments_json, summary, action_items_json, decisions_json, cited, cite_total, audio_retained, created_at)
       VALUES (@id,@note_id,@user_id,@tenant_id,@title,@source,@language,@duration_sec,@segments_json,@summary,@action_items_json,@decisions_json,@cited,@cite_total,@audio_retained,@created_at)`,
    ).run(row);
  }
  async getNoteMeetingByNote(noteId: string, userId: string): Promise<import('./db-types/adapter-me.js').NoteMeetingRow | null> {
    return (this.d.prepare('SELECT * FROM note_meetings WHERE note_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1').get(noteId, userId) ?? null) as import('./db-types/adapter-me.js').NoteMeetingRow | null;
  }
  async listUserNoteMeetings(userId: string, tenantId?: string | null): Promise<import('./db-types/adapter-me.js').NoteMeetingRow[]> {
    return (tenantId === undefined
      ? this.d.prepare('SELECT * FROM note_meetings WHERE user_id = ? ORDER BY created_at DESC').all(userId)
      : this.d.prepare('SELECT * FROM note_meetings WHERE user_id = ? AND tenant_id IS ? ORDER BY created_at DESC').all(userId, tenantId ?? null)) as import('./db-types/adapter-me.js').NoteMeetingRow[];
  }
  async replaceNoteRelations(noteId: string, rows: import('./db-types/adapter-me.js').NoteRelationRow[]): Promise<void> {
    const del = this.d.prepare('DELETE FROM note_relations WHERE note_id = ?');
    const ins = this.d.prepare('INSERT INTO note_relations (id, note_id, user_id, tenant_id, subject, predicate, object, created_at) VALUES (@id,@note_id,@user_id,@tenant_id,@subject,@predicate,@object,@created_at)');
    this.d.transaction(() => { del.run(noteId); for (const r of rows) ins.run(r); })();
  }
  async listNoteRelations(noteId: string): Promise<import('./db-types/adapter-me.js').NoteRelationRow[]> {
    return this.d.prepare('SELECT * FROM note_relations WHERE note_id = ? ORDER BY created_at ASC').all(noteId) as import('./db-types/adapter-me.js').NoteRelationRow[];
  }
  async upsertNoteEmbedding(row: import('./db-types/adapter-me.js').NoteEmbeddingRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_embeddings (note_id, user_id, tenant_id, dim, embedding_json, content_hash, title, updated_at)
       VALUES (@note_id,@user_id,@tenant_id,@dim,@embedding_json,@content_hash,@title,@updated_at)
       ON CONFLICT(note_id) DO UPDATE SET embedding_json=excluded.embedding_json, dim=excluded.dim, content_hash=excluded.content_hash, title=excluded.title, updated_at=excluded.updated_at`,
    ).run(row);
  }
  async getNoteEmbedding(noteId: string, tenantId?: string | null): Promise<import('./db-types/adapter-me.js').NoteEmbeddingRow | null> {
    // tenant_id IS ? is null-safe (matches NULL rows when tenantId is null). When tenantId is
    // undefined we skip the tenant gate for backward-compatible internal callers.
    const row = tenantId === undefined
      ? this.d.prepare('SELECT * FROM note_embeddings WHERE note_id = ?').get(noteId)
      : this.d.prepare('SELECT * FROM note_embeddings WHERE note_id = ? AND tenant_id IS ?').get(noteId, tenantId ?? null);
    return (row ?? null) as import('./db-types/adapter-me.js').NoteEmbeddingRow | null;
  }
  async listUserNoteEmbeddings(userId: string, tenantId?: string | null): Promise<import('./db-types/adapter-me.js').NoteEmbeddingRow[]> {
    return (tenantId === undefined
      ? this.d.prepare('SELECT * FROM note_embeddings WHERE user_id = ?').all(userId)
      : this.d.prepare('SELECT * FROM note_embeddings WHERE user_id = ? AND tenant_id IS ?').all(userId, tenantId ?? null)) as import('./db-types/adapter-me.js').NoteEmbeddingRow[];
  }

  // weaveNotes Phase 8 — run output embeddings (workspace RAG over runs).
  async upsertRunEmbedding(row: import('./db-types/adapter-me.js').RunEmbeddingRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO run_embeddings (run_id, user_id, tenant_id, dim, embedding_json, content_hash, title, content, updated_at)
       VALUES (@run_id,@user_id,@tenant_id,@dim,@embedding_json,@content_hash,@title,@content,@updated_at)
       ON CONFLICT(run_id) DO UPDATE SET embedding_json=excluded.embedding_json, dim=excluded.dim, content_hash=excluded.content_hash, title=excluded.title, content=excluded.content, updated_at=excluded.updated_at`,
    ).run(row);
  }
  async getRunEmbedding(runId: string, tenantId?: string | null): Promise<import('./db-types/adapter-me.js').RunEmbeddingRow | null> {
    const row = tenantId === undefined
      ? this.d.prepare('SELECT * FROM run_embeddings WHERE run_id = ?').get(runId)
      : this.d.prepare('SELECT * FROM run_embeddings WHERE run_id = ? AND tenant_id IS ?').get(runId, tenantId ?? null);
    return (row ?? null) as import('./db-types/adapter-me.js').RunEmbeddingRow | null;
  }
  async listUserRunEmbeddings(userId: string, tenantId?: string | null): Promise<import('./db-types/adapter-me.js').RunEmbeddingRow[]> {
    return (tenantId === undefined
      ? this.d.prepare('SELECT * FROM run_embeddings WHERE user_id = ?').all(userId)
      : this.d.prepare('SELECT * FROM run_embeddings WHERE user_id = ? AND tenant_id IS ?').all(userId, tenantId ?? null)) as import('./db-types/adapter-me.js').RunEmbeddingRow[];
  }

  // weaveNotes Phase 8 — per-note version history.
  async createNoteVersion(row: import('./db-types/adapter-me.js').NoteVersionRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_versions (id, note_id, user_id, tenant_id, title, doc_json, label, reason, word_count, created_by, created_at)
       VALUES (@id, @note_id, @user_id, @tenant_id, @title, @doc_json, @label, @reason, @word_count, @created_by, @created_at)`,
    ).run(row);
  }
  async listNoteVersions(noteId: string): Promise<import('./db-types/adapter-me.js').NoteVersionRow[]> {
    return this.d.prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY created_at DESC').all(noteId) as import('./db-types/adapter-me.js').NoteVersionRow[];
  }
  async getNoteVersion(id: string): Promise<import('./db-types/adapter-me.js').NoteVersionRow | null> {
    return (this.d.prepare('SELECT * FROM note_versions WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').NoteVersionRow | null;
  }

  // weaveNotes Phase 8 — block comments on notes (mirrors run_comments).
  async createNoteComment(row: import('./db-types/adapter-me.js').NoteCommentRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_comments (id, note_id, tenant_id, thread_id, parent_id, author_id, body, body_html, mentions_json, anchor_block_id, created_at, updated_at, edited_at, deleted_at, deleted_by, resolved_at, resolved_by)
       VALUES (@id, @note_id, @tenant_id, @thread_id, @parent_id, @author_id, @body, @body_html, @mentions_json, @anchor_block_id, @created_at, @updated_at, @edited_at, @deleted_at, @deleted_by, @resolved_at, @resolved_by)`,
    ).run(row);
  }
  async getNoteComment(id: string): Promise<import('./db-types/adapter-me.js').NoteCommentRow | null> {
    return (this.d.prepare('SELECT * FROM note_comments WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').NoteCommentRow | null;
  }
  async listNoteComments(noteId: string): Promise<import('./db-types/adapter-me.js').NoteCommentRow[]> {
    return this.d.prepare('SELECT * FROM note_comments WHERE note_id = ? ORDER BY created_at ASC').all(noteId) as import('./db-types/adapter-me.js').NoteCommentRow[];
  }
  async listNoteCommentThread(threadId: string): Promise<import('./db-types/adapter-me.js').NoteCommentRow[]> {
    return this.d.prepare('SELECT * FROM note_comments WHERE thread_id = ? ORDER BY created_at ASC').all(threadId) as import('./db-types/adapter-me.js').NoteCommentRow[];
  }
  async updateNoteCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void> {
    this.d.prepare('UPDATE note_comments SET body = ?, body_html = ?, mentions_json = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(body, bodyHtml, mentionsJson, editedAt, updatedAt, id);
  }
  async softDeleteNoteComment(id: string, deletedBy: string, deletedAt: number): Promise<void> {
    this.d.prepare(`UPDATE note_comments SET body = '', body_html = '', mentions_json = '[]', deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?`).run(deletedAt, deletedBy, deletedAt, id);
  }
  async setNoteThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void> {
    this.d.prepare('UPDATE note_comments SET resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?').run(resolvedAt, resolvedBy, updatedAt, threadId);
  }

  // weaveNotes Phase 8 — synced blocks (transclusion).
  async createNoteSyncedBlock(row: import('./db-types/adapter-me.js').NoteSyncedBlockRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_synced_blocks (id, note_id, user_id, tenant_id, source_note_id, source_block_id, created_at)
       VALUES (@id, @note_id, @user_id, @tenant_id, @source_note_id, @source_block_id, @created_at)`,
    ).run(row);
  }
  async getNoteSyncedBlock(id: string): Promise<import('./db-types/adapter-me.js').NoteSyncedBlockRow | null> {
    return (this.d.prepare('SELECT * FROM note_synced_blocks WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').NoteSyncedBlockRow | null;
  }
  async listNoteSyncedBlocks(noteId: string): Promise<import('./db-types/adapter-me.js').NoteSyncedBlockRow[]> {
    return this.d.prepare('SELECT * FROM note_synced_blocks WHERE note_id = ? ORDER BY created_at ASC').all(noteId) as import('./db-types/adapter-me.js').NoteSyncedBlockRow[];
  }
  async deleteNoteSyncedBlock(id: string, noteId: string): Promise<void> {
    this.d.prepare('DELETE FROM note_synced_blocks WHERE id = ? AND note_id = ?').run(id, noteId);
  }

  // weaveNotes Phase 0 — capability config (single 'global' row) + activity log.
  async getWeaveNotesSettings(): Promise<import('./db-types/adapter-me.js').WeaveNotesSettingsRow | null> {
    return (this.d.prepare("SELECT * FROM weavenotes_settings WHERE id = 'global'").get() ?? null) as import('./db-types/adapter-me.js').WeaveNotesSettingsRow | null;
  }
  async updateWeaveNotesSettings(fields: Partial<Omit<import('./db-types/adapter-me.js').WeaveNotesSettingsRow, 'id'>>): Promise<void> {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    this.d.prepare(`UPDATE weavenotes_settings SET ${set}, updated_at = datetime('now') WHERE id = 'global'`).run(fields as Record<string, unknown>);
  }
  // weaveNotes — per-tenant routing mode for a note AI action. Resolution: tenant row → global ('')
  // row → 'direct'. So a tenant override wins, otherwise the global default, otherwise the safe fast path.
  async resolveNoteActionMode(tenantId: string | null, actionKey: string): Promise<'direct' | 'agent' | 'supervisor'> {
    const pick = (tid: string): string | undefined =>
      (this.d.prepare('SELECT mode FROM note_action_modes WHERE tenant_id = ? AND action_key = ?').get(tid, actionKey) as { mode?: string } | undefined)?.mode;
    const mode = (tenantId ? pick(tenantId) : undefined) ?? pick('') ?? 'direct';
    return mode === 'agent' || mode === 'supervisor' ? mode : 'direct';
  }
  async getNoteImageLanguage(userId: string): Promise<string> {
    const row = this.d.prepare('SELECT notes_image_language FROM user_preferences WHERE user_id = ?').get(userId) as { notes_image_language?: string } | undefined;
    return (typeof row?.notes_image_language === 'string' && row.notes_image_language.trim()) ? row.notes_image_language : 'en';
  }
  async setNoteImageLanguage(userId: string, language: string): Promise<void> {
    this.d.prepare(
      `INSERT INTO user_preferences (user_id, notes_image_language) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET notes_image_language = excluded.notes_image_language, updated_at = datetime('now')`,
    ).run(userId, language);
  }
  async listNoteActionModes(): Promise<import('./db-types/adapter-me.js').NoteActionModeRow[]> {
    return this.d.prepare('SELECT * FROM note_action_modes ORDER BY tenant_id ASC, action_key ASC').all() as import('./db-types/adapter-me.js').NoteActionModeRow[];
  }
  async getNoteActionMode(id: string): Promise<import('./db-types/adapter-me.js').NoteActionModeRow | null> {
    return (this.d.prepare('SELECT * FROM note_action_modes WHERE id = ?').get(id) ?? null) as import('./db-types/adapter-me.js').NoteActionModeRow | null;
  }
  async createNoteActionMode(row: { id: string; tenant_id: string; action_key: string; mode: string }): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_action_modes (id, tenant_id, action_key, mode, updated_at)
         VALUES (@id, @tenant_id, @action_key, @mode, datetime('now'))
       ON CONFLICT(tenant_id, action_key) DO UPDATE SET mode = excluded.mode, updated_at = datetime('now')`,
    ).run(row);
  }
  async updateNoteActionMode(id: string, fields: Partial<Pick<import('./db-types/adapter-me.js').NoteActionModeRow, 'tenant_id' | 'action_key' | 'mode'>>): Promise<void> {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    this.d.prepare(`UPDATE note_action_modes SET ${set}, updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id });
  }
  async deleteNoteActionMode(id: string): Promise<void> {
    this.d.prepare('DELETE FROM note_action_modes WHERE id = ?').run(id);
  }
  async recordNoteActivity(row: import('./db-types/adapter-me.js').NoteActivityRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_activity (id, note_id, user_id, tenant_id, action, actor, summary, detail_json, created_at)
       VALUES (@id, @note_id, @user_id, @tenant_id, @action, @actor, @summary, @detail_json, COALESCE(@created_at, datetime('now')))`,
    ).run(row);
  }
  async listNoteActivity(noteId: string, limit = 50): Promise<import('./db-types/adapter-me.js').NoteActivityRow[]> {
    return this.d.prepare('SELECT * FROM note_activity WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(noteId, Math.max(1, Math.min(500, limit))) as import('./db-types/adapter-me.js').NoteActivityRow[];
  }
  // Phase 0-B — TENANT-scoped audit feed for the admin/compliance viewer + export.
  // KEYSET pagination on (created_at, id) DESC — NOT offset, which on a live append-only log would
  // skip/duplicate rows as new events land. tenant_id is null-safe (`IS ?`). Joins the note title.
  async listTenantNoteActivity(tenantId: string | null, opts: import('./db-types/adapter-me.js').NoteActivityQuery = {}): Promise<Array<import('./db-types/adapter-me.js').NoteActivityRow & { note_title?: string | null }>> {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const where: string[] = ['a.tenant_id IS ?'];
    const args: unknown[] = [tenantId ?? null];
    if (opts.action) { where.push('a.action = ?'); args.push(opts.action); }
    if (opts.actor) { where.push('a.actor = ?'); args.push(opts.actor); }
    if (opts.userId) { where.push('a.user_id = ?'); args.push(opts.userId); }
    if (opts.noteId) { where.push('a.note_id = ?'); args.push(opts.noteId); }
    if (opts.fromDate) { where.push('a.created_at >= ?'); args.push(opts.fromDate); }
    if (opts.toDate) { where.push('a.created_at <= ?'); args.push(opts.toDate); }
    // Keyset cursor: fetch the page strictly OLDER than (beforeCreatedAt, beforeId).
    if (opts.beforeCreatedAt && opts.beforeId) { where.push('(a.created_at, a.id) < (?, ?)'); args.push(opts.beforeCreatedAt, opts.beforeId); }
    args.push(limit);
    return this.d.prepare(
      `SELECT a.*, n.title AS note_title FROM note_activity a LEFT JOIN notes n ON n.id = a.note_id
       WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ).all(...args as never[]) as Array<import('./db-types/adapter-me.js').NoteActivityRow & { note_title?: string | null }>;
  }
  // Phase 0-B — retention pruning. Deletes activity older than the cutoff ISO timestamp. Returns count.
  async pruneNoteActivity(beforeIso: string): Promise<number> {
    const info = this.d.prepare('DELETE FROM note_activity WHERE created_at < ?').run(beforeIso);
    return info.changes ?? 0;
  }

  // Registered outbound webhook endpoints.
  async createWebhookEndpoint(row: { id: string; tenant_id?: string | null; user_id: string; url: string; signing_secret: string; created_at: number }): Promise<void> {
    this.d.prepare(
      `INSERT INTO webhook_endpoints (id, tenant_id, user_id, url, signing_secret, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(row.id, row.tenant_id ?? null, row.user_id, row.url, row.signing_secret, row.created_at);
  }
  async listWebhookEndpoints(userId: string): Promise<import('./db-types/adapter-me.js').WebhookEndpointRow[]> {
    return this.d.prepare('SELECT * FROM webhook_endpoints WHERE user_id = ? AND revoked_at IS NULL AND enabled = 1 ORDER BY created_at ASC').all(userId) as import('./db-types/adapter-me.js').WebhookEndpointRow[];
  }
  async revokeWebhookEndpoint(id: string, userId: string, revokedAt: number): Promise<number> {
    return this.d.prepare('UPDATE webhook_endpoints SET revoked_at = ?, enabled = 0 WHERE id = ? AND user_id = ?').run(revokedAt, id, userId).changes;
  }

  // ── HITL approvals (m64 table, m93 run-scoped) ─────────────────────────────
  async createHitlInterrupt(row: {
    id: string; chat_id: string; run_id?: string | null; agent_name: string; agent_step?: number;
    tool_name: string; tool_args_json?: string; interrupt_type?: string; reason?: string; expires_at?: string | null;
  }): Promise<void> {
    this.d.prepare(
      `INSERT OR IGNORE INTO hitl_interrupt_requests
         (id, chat_id, run_id, agent_name, agent_step, tool_name, tool_args_json, interrupt_type, reason, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      row.id, row.chat_id, row.run_id ?? null, row.agent_name, row.agent_step ?? 0,
      row.tool_name, row.tool_args_json ?? '{}', row.interrupt_type ?? 'tool_approval', row.reason ?? '', row.expires_at ?? null,
    );
  }

  async resolveHitlInterrupt(id: string, fields: {
    status: string; decision_action?: string; modified_args_json?: string | null; feedback?: string | null; decided_by?: string | null;
  }): Promise<void> {
    this.d.prepare(
      `UPDATE hitl_interrupt_requests
         SET status = ?, decision_action = ?, modified_args_json = ?, feedback = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(fields.status, fields.decision_action ?? null, fields.modified_args_json ?? null, fields.feedback ?? null, fields.decided_by ?? null, id);
  }

  async listPendingHitlInterruptsByRun(runId: string): Promise<Array<{ id: string; tool_name: string; status: string; tool_args_json: string }>> {
    return this.d.prepare(
      `SELECT id, tool_name, status, tool_args_json FROM hitl_interrupt_requests WHERE run_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    ).all(runId) as Array<{ id: string; tool_name: string; status: string; tool_args_json: string }>;
  }

  async pruneUserRunEvents(opts: { olderThanHours: number; maxEventsPerRun: number }): Promise<number> {
    let deleted = 0;
    // 1) Age-based: drop journal events for TERMINAL runs older than the horizon.
    //    In-flight (pending/running) runs are never pruned — only settled ones.
    if (opts.olderThanHours > 0) {
      const r = this.d.prepare(
        `DELETE FROM user_run_events
           WHERE created_at < datetime('now', ?)
             AND run_id IN (SELECT id FROM user_runs WHERE status IN ('completed','failed','cancelled'))`,
      ).run(`-${Math.floor(opts.olderThanHours)} hours`);
      deleted += r.changes;
    }
    // 2) Per-run cap: keep only the most recent N events per run (the terminal
    //    event always has the highest sequence, so it is never dropped).
    if (opts.maxEventsPerRun > 0) {
      const over = this.d.prepare(
        `SELECT run_id FROM user_run_events GROUP BY run_id HAVING COUNT(*) > ?`,
      ).all(opts.maxEventsPerRun) as Array<{ run_id: string }>;
      const trim = this.d.prepare(
        `DELETE FROM user_run_events
           WHERE run_id = ?
             AND sequence NOT IN (SELECT sequence FROM user_run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT ?)`,
      );
      for (const { run_id } of over) {
        deleted += trim.run(run_id, run_id, opts.maxEventsPerRun).changes;
      }
    }
    return deleted;
  }

  async registerDevice(device: { id: string; user_id: string; channel: 'web-push'|'apns'|'fcm'; token: string; tenant_id?: string; label?: string }): Promise<void> {
    this.d.prepare(
      'INSERT OR REPLACE INTO user_devices (id, user_id, tenant_id, channel, token, label) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(device.id, device.user_id, device.tenant_id ?? null, device.channel, device.token, device.label ?? null);
  }

  async removeDevice(userId: string, token: string): Promise<void> {
    this.d.prepare('DELETE FROM user_devices WHERE user_id = ? AND token = ?').run(userId, token);
  }

  async getDeviceById(deviceId: string): Promise<import('./db-types/adapter-me.js').UserDeviceRow | null> {
    return (this.d.prepare('SELECT * FROM user_devices WHERE id = ?').get(deviceId) as import('./db-types/adapter-me.js').UserDeviceRow | undefined) ?? null;
  }

  async listDevices(userId: string): Promise<import('./db-types/adapter-me.js').UserDeviceRow[]> {
    return this.d.prepare('SELECT * FROM user_devices WHERE user_id = ? ORDER BY created_at DESC').all(userId) as import('./db-types/adapter-me.js').UserDeviceRow[];
  }

  async getNotificationPrefs(userId: string): Promise<import('./db-types/adapter-me.js').NotificationPrefsRow | null> {
    return (this.d.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId) as import('./db-types/adapter-me.js').NotificationPrefsRow | undefined) ?? null;
  }

  async upsertNotificationPrefs(userId: string, prefs: { id: string; enabled?: boolean; categories?: string[]; quiet_hours?: string | null; timezone?: string | null }): Promise<void> {
    this.d.prepare(`
      INSERT INTO notification_preferences (id, user_id, enabled, categories, quiet_hours, timezone)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled = excluded.enabled,
        categories = excluded.categories,
        quiet_hours = excluded.quiet_hours,
        timezone = excluded.timezone,
        updated_at = datetime('now')
    `).run(
      prefs.id, userId,
      prefs.enabled !== false ? 1 : 0,
      JSON.stringify(prefs.categories ?? []),
      prefs.quiet_hours ?? null,
      prefs.timezone ?? null,
    );
  }

  async listModeLabels(surfaceId: string): Promise<import('./db-types/adapter-me.js').ModeLabel[]> {
    return this.d.prepare('SELECT * FROM mode_labels WHERE surface_id = ? AND enabled = 1 ORDER BY sort_order ASC, rowid ASC').all(surfaceId) as import('./db-types/adapter-me.js').ModeLabel[];
  }

  async listStarterPrompts(surfaceId: string): Promise<import('./db-types/adapter-me.js').StarterPrompt[]> {
    return this.d.prepare('SELECT * FROM starter_prompts WHERE surface_id = ? AND enabled = 1 ORDER BY sort_order ASC, rowid ASC').all(surfaceId) as import('./db-types/adapter-me.js').StarterPrompt[];
  }

  // ── catalog administration (include disabled rows) ─────────────────────────
  async adminListModeLabels(surfaceId?: string): Promise<import('./db-types/adapter-me.js').ModeLabel[]> {
    if (surfaceId) {
      return this.d.prepare('SELECT * FROM mode_labels WHERE surface_id = ? ORDER BY surface_id ASC, sort_order ASC, rowid ASC').all(surfaceId) as import('./db-types/adapter-me.js').ModeLabel[];
    }
    return this.d.prepare('SELECT * FROM mode_labels ORDER BY surface_id ASC, sort_order ASC, rowid ASC').all() as import('./db-types/adapter-me.js').ModeLabel[];
  }

  async getModeLabel(id: string): Promise<import('./db-types/adapter-me.js').ModeLabel | null> {
    return (this.d.prepare('SELECT * FROM mode_labels WHERE id = ?').get(id) as import('./db-types/adapter-me.js').ModeLabel | undefined) ?? null;
  }

  async createModeLabel(row: Pick<import('./db-types/adapter-me.js').ModeLabel, 'id' | 'surface_id' | 'mode_key' | 'label'> & {
    description?: string | null; icon?: string | null; is_default?: number; sort_order?: number; enabled?: number; metadata?: string | null;
  }): Promise<void> {
    const isDefault = row.is_default === 1 ? 1 : 0;
    const tx = this.d.transaction(() => {
      if (isDefault === 1) {
        this.d.prepare('UPDATE mode_labels SET is_default = 0 WHERE surface_id = ?').run(row.surface_id);
      }
      this.d.prepare(`INSERT INTO mode_labels (id, surface_id, mode_key, label, description, icon, is_default, sort_order, enabled, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, row.surface_id, row.mode_key, row.label,
        row.description ?? null, row.icon ?? null, isDefault,
        row.sort_order ?? 0, row.enabled === 0 ? 0 : 1, row.metadata ?? null,
      );
    });
    tx();
  }

  async updateModeLabel(id: string, patch: Partial<Pick<import('./db-types/adapter-me.js').ModeLabel,
    'label' | 'mode_key' | 'description' | 'icon' | 'is_default' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void> {
    const tx = this.d.transaction(() => {
      const existing = this.d.prepare('SELECT surface_id FROM mode_labels WHERE id = ?').get(id) as { surface_id: string } | undefined;
      if (!existing) return;
      if (patch.is_default === 1) {
        this.d.prepare('UPDATE mode_labels SET is_default = 0 WHERE surface_id = ?').run(existing.surface_id);
      }
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };
      if (patch.label !== undefined) set('label', patch.label);
      if (patch.mode_key !== undefined) set('mode_key', patch.mode_key);
      if (patch.description !== undefined) set('description', patch.description);
      if (patch.icon !== undefined) set('icon', patch.icon);
      if (patch.is_default !== undefined) set('is_default', patch.is_default === 1 ? 1 : 0);
      if (patch.sort_order !== undefined) set('sort_order', patch.sort_order);
      if (patch.enabled !== undefined) set('enabled', patch.enabled === 0 ? 0 : 1);
      if (patch.metadata !== undefined) set('metadata', patch.metadata);
      if (fields.length === 0) return;
      values.push(id);
      this.d.prepare(`UPDATE mode_labels SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    });
    tx();
  }

  async deleteModeLabel(id: string): Promise<void> {
    this.d.prepare('DELETE FROM mode_labels WHERE id = ?').run(id);
  }

  async adminListStarterPrompts(surfaceId?: string): Promise<import('./db-types/adapter-me.js').StarterPrompt[]> {
    if (surfaceId) {
      return this.d.prepare('SELECT * FROM starter_prompts WHERE surface_id = ? ORDER BY surface_id ASC, sort_order ASC, rowid ASC').all(surfaceId) as import('./db-types/adapter-me.js').StarterPrompt[];
    }
    return this.d.prepare('SELECT * FROM starter_prompts ORDER BY surface_id ASC, sort_order ASC, rowid ASC').all() as import('./db-types/adapter-me.js').StarterPrompt[];
  }

  async getStarterPrompt(id: string): Promise<import('./db-types/adapter-me.js').StarterPrompt | null> {
    return (this.d.prepare('SELECT * FROM starter_prompts WHERE id = ?').get(id) as import('./db-types/adapter-me.js').StarterPrompt | undefined) ?? null;
  }

  async createStarterPrompt(row: Pick<import('./db-types/adapter-me.js').StarterPrompt, 'id' | 'surface_id' | 'label' | 'prompt_text'> & {
    sort_order?: number; enabled?: number; metadata?: string | null;
  }): Promise<void> {
    this.d.prepare(`INSERT INTO starter_prompts (id, surface_id, label, prompt_text, sort_order, enabled, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.surface_id, row.label, row.prompt_text,
      row.sort_order ?? 0, row.enabled === 0 ? 0 : 1, row.metadata ?? null,
    );
  }

  async updateStarterPrompt(id: string, patch: Partial<Pick<import('./db-types/adapter-me.js').StarterPrompt,
    'label' | 'prompt_text' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };
    if (patch.label !== undefined) set('label', patch.label);
    if (patch.prompt_text !== undefined) set('prompt_text', patch.prompt_text);
    if (patch.sort_order !== undefined) set('sort_order', patch.sort_order);
    if (patch.enabled !== undefined) set('enabled', patch.enabled === 0 ? 0 : 1);
    if (patch.metadata !== undefined) set('metadata', patch.metadata);
    if (fields.length === 0) return;
    values.push(id);
    this.d.prepare(`UPDATE starter_prompts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async deleteStarterPrompt(id: string): Promise<void> {
    this.d.prepare('DELETE FROM starter_prompts WHERE id = ?').run(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IAgendaNotesStore (m46)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Agenda categories ──────────────────────────────────────────────────────

  async listAgendaCategories(userId: string): Promise<import('./db-types/adapter-agenda-notes.js').AgendaCategoryRow[]> {
    return this.d.prepare(
      `SELECT * FROM agenda_categories
       WHERE user_id = ? OR user_id IS NULL
       ORDER BY user_id NULLS FIRST, name ASC`,
    ).all(userId) as import('./db-types/adapter-agenda-notes.js').AgendaCategoryRow[];
  }

  async getAgendaCategory(id: string): Promise<import('./db-types/adapter-agenda-notes.js').AgendaCategoryRow | null> {
    return (this.d.prepare('SELECT * FROM agenda_categories WHERE id = ?').get(id) as import('./db-types/adapter-agenda-notes.js').AgendaCategoryRow | undefined) ?? null;
  }

  async createAgendaCategory(row: Pick<import('./db-types/adapter-agenda-notes.js').AgendaCategoryRow, 'id' | 'name'> & {
    tenant_id?: string | null; user_id?: string | null;
    color?: string; icon?: string; template_key?: string | null;
  }): Promise<void> {
    this.d.prepare(`INSERT INTO agenda_categories (id, tenant_id, user_id, name, color, icon, template_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.tenant_id ?? null, row.user_id ?? null, row.name,
      row.color ?? '#7C5CFC', row.icon ?? '◆', row.template_key ?? null,
    );
  }

  async updateAgendaCategory(id: string, patch: Partial<Pick<import('./db-types/adapter-agenda-notes.js').AgendaCategoryRow, 'name' | 'color' | 'icon'>>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.color !== undefined) set('color', patch.color);
    if (patch.icon !== undefined) set('icon', patch.icon);
    if (fields.length === 0) return;
    values.push(id);
    this.d.prepare(`UPDATE agenda_categories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async deleteAgendaCategory(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM agenda_categories WHERE id = ? AND user_id = ?').run(id, userId);
  }

  // ── Agenda items ───────────────────────────────────────────────────────────

  async listAgendaItems(userId: string, filter?: import('./db-types/adapter-agenda-notes.js').AgendaListFilter): Promise<import('./db-types/adapter-agenda-notes.js').AgendaItemRow[]> {
    const conditions = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filter?.startAt) { conditions.push('(start_at >= ? OR start_at IS NULL)'); params.push(filter.startAt); }
    if (filter?.endAt) {
      // Extend date-only strings to end of day so events on that day are included
      const endBound = /^\d{4}-\d{2}-\d{2}$/.test(filter.endAt) ? `${filter.endAt}T23:59:59` : filter.endAt;
      conditions.push('(start_at <= ? OR start_at IS NULL)');
      params.push(endBound);
    }
    if (filter?.kind) { conditions.push('kind = ?'); params.push(filter.kind); }
    if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
    if (filter?.categoryId) { conditions.push('category_id = ?'); params.push(filter.categoryId); }
    if (filter?.search) { conditions.push('LOWER(title) LIKE ?'); params.push(`%${filter.search.toLowerCase()}%`); }
    const limit = filter?.limit ?? 50;
    return this.d.prepare(
      `SELECT * FROM agenda_items WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(start_at, created_at) ASC LIMIT ?`,
    ).all(...params, limit) as import('./db-types/adapter-agenda-notes.js').AgendaItemRow[];
  }

  async findSimilarAgendaItems(userId: string, title: string, dateBucket?: string): Promise<import('./db-types/adapter-agenda-notes.js').AgendaItemRow[]> {
    const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\b(a|an|the|my|for|at|on|with|and|or|to|in)\b/g, '').trim();
    const tokens = (s: string) => new Set(normalized(s).split(/\s+/).filter(Boolean));
    const jaccard = (a: Set<string>, b: Set<string>) => {
      const inter = [...a].filter(x => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      return union === 0 ? 0 : inter / union;
    };
    const incomingTokens = tokens(title);
    const windowStart = dateBucket ? `${dateBucket.slice(0, 10)}T00:00:00` : undefined;
    const windowEnd = dateBucket ? `${dateBucket.slice(0, 10)}T23:59:59` : undefined;
    const candidates = await this.listAgendaItems(userId, {
      startAt: windowStart,
      endAt: windowEnd,
      limit: 100,
    });
    return candidates.filter(item => jaccard(incomingTokens, tokens(item.title)) >= 0.5);
  }

  async getAgendaItem(id: string, userId: string): Promise<import('./db-types/adapter-agenda-notes.js').AgendaItemRow | null> {
    return (this.d.prepare('SELECT * FROM agenda_items WHERE id = ? AND user_id = ?').get(id, userId) as import('./db-types/adapter-agenda-notes.js').AgendaItemRow | undefined) ?? null;
  }

  async createAgendaItem(row: Pick<import('./db-types/adapter-agenda-notes.js').AgendaItemRow, 'id' | 'user_id' | 'title'> & {
    tenant_id?: string | null; kind?: string; category_id?: string | null;
    start_at?: string | null; end_at?: string | null; all_day?: number;
    location?: string | null; description?: string | null; recurrence_rule?: string | null;
    status?: string; sensitivity?: string;
    amount?: string | null; currency?: string | null; provenance?: string | null;
    linked_task_id?: string | null; linked_run_id?: string | null; linked_note_id?: string | null;
    parent_item_id?: string | null;
  }): Promise<void> {
    this.d.prepare(`
      INSERT INTO agenda_items
        (id, user_id, tenant_id, title, kind, category_id, start_at, end_at, all_day,
         location, description, recurrence_rule, status, sensitivity,
         amount, currency, provenance, linked_task_id, linked_run_id, linked_note_id, parent_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.user_id, row.tenant_id ?? null, row.title,
      row.kind ?? 'event', row.category_id ?? null,
      row.start_at ?? null, row.end_at ?? null, row.all_day ?? 0,
      row.location ?? null, row.description ?? null, row.recurrence_rule ?? null,
      row.status ?? 'confirmed', row.sensitivity ?? 'normal',
      row.amount ?? null, row.currency ?? null, row.provenance ?? null,
      row.linked_task_id ?? null, row.linked_run_id ?? null,
      row.linked_note_id ?? null, row.parent_item_id ?? null,
    );
  }

  async updateAgendaItem(id: string, userId: string, patch: Partial<Pick<import('./db-types/adapter-agenda-notes.js').AgendaItemRow,
    'title' | 'kind' | 'category_id' | 'start_at' | 'end_at' | 'all_day' |
    'location' | 'description' | 'recurrence_rule' | 'status' | 'sensitivity' |
    'amount' | 'currency' | 'linked_task_id' | 'linked_run_id' | 'linked_note_id'
  >>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.kind !== undefined) set('kind', patch.kind);
    if (patch.category_id !== undefined) set('category_id', patch.category_id);
    if (patch.start_at !== undefined) set('start_at', patch.start_at);
    if (patch.end_at !== undefined) set('end_at', patch.end_at);
    if (patch.all_day !== undefined) set('all_day', patch.all_day);
    if (patch.location !== undefined) set('location', patch.location);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.recurrence_rule !== undefined) set('recurrence_rule', patch.recurrence_rule);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.sensitivity !== undefined) set('sensitivity', patch.sensitivity);
    if (patch.amount !== undefined) set('amount', patch.amount);
    if (patch.currency !== undefined) set('currency', patch.currency);
    if (patch.linked_task_id !== undefined) set('linked_task_id', patch.linked_task_id);
    if (patch.linked_run_id !== undefined) set('linked_run_id', patch.linked_run_id);
    if (patch.linked_note_id !== undefined) set('linked_note_id', patch.linked_note_id);
    if (fields.length === 0) return;
    fields.push('updated_at = datetime(\'now\')');
    values.push(id, userId);
    this.d.prepare(`UPDATE agenda_items SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  }

  async deleteAgendaItem(id: string, userId: string): Promise<boolean> {
    const r = this.d.prepare('DELETE FROM agenda_items WHERE id = ? AND user_id = ?').run(id, userId);
    return r.changes > 0;
  }

  // ── Notes ──────────────────────────────────────────────────────────────────

  async listNotes(userId: string, filter?: import('./db-types/adapter-agenda-notes.js').NoteListFilter): Promise<import('./db-types/adapter-agenda-notes.js').NoteRow[]> {
    const conditions = ['owner_user_id = ?', 'is_template = 0'];
    const params: unknown[] = [userId];
    if (filter?.parentNoteId !== undefined) {
      if (filter.parentNoteId === null) {
        conditions.push('parent_note_id IS NULL');
      } else {
        conditions.push('parent_note_id = ?');
        params.push(filter.parentNoteId);
      }
    }
    if (filter?.favorite) { conditions.push('favorite = 1'); }
    // weaveNotes Phase 6: by default show only ACTIVE notes; `archived` shows only the trash.
    conditions.push(filter?.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
    if (filter?.search) {
      conditions.push('(title LIKE ? OR doc_json LIKE ?)');
      const q = `%${filter.search}%`;
      params.push(q, q);
    }
    const limit = filter?.limit ?? 100;
    return this.d.prepare(
      `SELECT id, owner_user_id, tenant_id, title, icon, cover, parent_note_id,
              sensitivity, is_template, template_key, favorite,
              page_theme, freeform_mode, cover_image_artifact_id, archived_at, created_at, updated_at
       FROM notes WHERE ${conditions.join(' AND ')}
       ORDER BY favorite DESC, updated_at DESC LIMIT ?`,
    ).all(...params, limit) as import('./db-types/adapter-agenda-notes.js').NoteRow[];
  }

  async listNoteTemplates(): Promise<import('./db-types/adapter-agenda-notes.js').NoteRow[]> {
    return this.d.prepare(
      `SELECT * FROM notes WHERE is_template = 1 ORDER BY title ASC`,
    ).all() as import('./db-types/adapter-agenda-notes.js').NoteRow[];
  }

  async getNote(id: string, userId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteRow | null> {
    const row = this.d.prepare(
      `SELECT * FROM notes WHERE id = ? AND (owner_user_id = ? OR owner_user_id = '_system')`,
    ).get(id, userId) as import('./db-types/adapter-agenda-notes.js').NoteRow | undefined;
    return row ?? null;
  }

  async createNote(row: Pick<import('./db-types/adapter-agenda-notes.js').NoteRow, 'id' | 'owner_user_id' | 'title'> & {
    tenant_id?: string | null; icon?: string | null; cover?: string | null;
    parent_note_id?: string | null; sensitivity?: string;
    doc_json?: string; is_template?: number; template_key?: string | null; favorite?: number;
    page_theme?: string; freeform_mode?: number; cover_image_artifact_id?: string | null;
  }): Promise<void> {
    this.d.prepare(`
      INSERT INTO notes
        (id, owner_user_id, tenant_id, title, icon, cover, parent_note_id,
         sensitivity, doc_json, is_template, template_key, favorite,
         page_theme, freeform_mode, cover_image_artifact_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.owner_user_id, row.tenant_id ?? null, row.title,
      row.icon ?? null, row.cover ?? null, row.parent_note_id ?? null,
      row.sensitivity ?? 'normal',
      row.doc_json ?? '{"type":"doc","content":[]}',
      row.is_template ?? 0, row.template_key ?? null, row.favorite ?? 0,
      row.page_theme ?? 'pro', row.freeform_mode ?? 0, row.cover_image_artifact_id ?? null,
    );
  }

  async updateNote(id: string, userId: string, patch: Partial<Pick<import('./db-types/adapter-agenda-notes.js').NoteRow,
    'title' | 'icon' | 'cover' | 'parent_note_id' | 'sensitivity' | 'doc_json' | 'favorite'
    | 'page_theme' | 'freeform_mode' | 'cover_image_artifact_id'
  >>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => { fields.push(`${col} = ?`); values.push(val); };
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.icon !== undefined) set('icon', patch.icon);
    if (patch.cover !== undefined) set('cover', patch.cover);
    if (patch.parent_note_id !== undefined) set('parent_note_id', patch.parent_note_id);
    if (patch.sensitivity !== undefined) set('sensitivity', patch.sensitivity);
    if (patch.doc_json !== undefined) set('doc_json', patch.doc_json);
    if (patch.favorite !== undefined) set('favorite', patch.favorite);
    if (patch.page_theme !== undefined) set('page_theme', patch.page_theme);
    if (patch.freeform_mode !== undefined) set('freeform_mode', patch.freeform_mode);
    if (patch.cover_image_artifact_id !== undefined) set('cover_image_artifact_id', patch.cover_image_artifact_id);
    if (fields.length === 0) return;
    fields.push('updated_at = datetime(\'now\')');
    values.push(id, userId);
    this.d.prepare(`UPDATE notes SET ${fields.join(', ')} WHERE id = ? AND owner_user_id = ?`).run(...values);
  }

  async archiveNote(id: string, userId: string, at: string): Promise<boolean> {
    // Owner-scoped soft-delete; only flips an ACTIVE note (archived_at IS NULL) so re-archiving is a no-op.
    const r = this.d.prepare(
      `UPDATE notes SET archived_at = ?, updated_at = datetime('now')
       WHERE id = ? AND owner_user_id = ? AND archived_at IS NULL`,
    ).run(at, id, userId);
    return r.changes > 0;
  }

  async restoreNote(id: string, userId: string): Promise<boolean> {
    const r = this.d.prepare(
      `UPDATE notes SET archived_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND owner_user_id = ? AND archived_at IS NOT NULL`,
    ).run(id, userId);
    return r.changes > 0;
  }

  async deleteNote(id: string, userId: string): Promise<boolean> {
    const tx = this.d.transaction(() => {
      // Delete sub-pages recursively (one level; production would use recursive CTE)
      const subIds = (this.d.prepare('SELECT id FROM notes WHERE parent_note_id = ? AND owner_user_id = ?').all(id, userId) as Array<{ id: string }>).map((r) => r.id);
      for (const subId of subIds) {
        this.d.prepare('DELETE FROM note_links WHERE note_id = ?').run(subId);
        this.d.prepare('DELETE FROM notes WHERE id = ? AND owner_user_id = ?').run(subId, userId);
      }
      this.d.prepare('DELETE FROM note_links WHERE note_id = ?').run(id);
      const r = this.d.prepare('DELETE FROM notes WHERE id = ? AND owner_user_id = ?').run(id, userId);
      return r.changes;
    });
    return tx() > 0;
  }

  // ── Note links ─────────────────────────────────────────────────────────────

  async listNoteLinks(noteId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteLinkRow[]> {
    return this.d.prepare('SELECT * FROM note_links WHERE note_id = ? ORDER BY created_at ASC').all(noteId) as import('./db-types/adapter-agenda-notes.js').NoteLinkRow[];
  }

  async listNoteBacklinks(targetKind: string, targetId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteLinkRow[]> {
    return this.d.prepare('SELECT * FROM note_links WHERE target_kind = ? AND target_id = ? ORDER BY created_at DESC').all(targetKind, targetId) as import('./db-types/adapter-agenda-notes.js').NoteLinkRow[];
  }

  async createNoteLink(row: Pick<import('./db-types/adapter-agenda-notes.js').NoteLinkRow, 'id' | 'note_id' | 'target_kind' | 'target_id'>): Promise<void> {
    this.d.prepare(`INSERT OR IGNORE INTO note_links (id, note_id, target_kind, target_id) VALUES (?, ?, ?, ?)`)
      .run(row.id, row.note_id, row.target_kind, row.target_id);
  }

  async deleteNoteLink(id: string, noteId: string): Promise<void> {
    this.d.prepare('DELETE FROM note_links WHERE id = ? AND note_id = ?').run(id, noteId);
  }

  // ── Note databases ─────────────────────────────────────────────────────────

  async listNoteDatabases(userId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteDatabaseRow[]> {
    return this.d.prepare('SELECT * FROM note_databases WHERE owner_user_id = ? ORDER BY name ASC').all(userId) as import('./db-types/adapter-agenda-notes.js').NoteDatabaseRow[];
  }

  async getNoteDatabase(id: string, userId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteDatabaseRow | null> {
    return (this.d.prepare('SELECT * FROM note_databases WHERE id = ? AND owner_user_id = ?').get(id, userId) as import('./db-types/adapter-agenda-notes.js').NoteDatabaseRow | undefined) ?? null;
  }

  async createNoteDatabase(row: Pick<import('./db-types/adapter-agenda-notes.js').NoteDatabaseRow, 'id' | 'owner_user_id' | 'name'> & {
    tenant_id?: string | null; source?: string; view_type?: string;
    filter_json?: string; sort_json?: string; columns_json?: string;
  }): Promise<void> {
    this.d.prepare(`INSERT INTO note_databases (id, owner_user_id, tenant_id, name, source, view_type, filter_json, sort_json, columns_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.owner_user_id, row.tenant_id ?? null, row.name,
      row.source ?? 'generic', row.view_type ?? 'table',
      row.filter_json ?? '{}', row.sort_json ?? '[]', row.columns_json ?? '[]',
    );
  }

  async deleteNoteDatabase(id: string, userId: string): Promise<void> {
    const tx = this.d.transaction(() => {
      this.d.prepare('DELETE FROM note_db_rows WHERE database_id = ?').run(id);
      this.d.prepare('DELETE FROM note_databases WHERE id = ? AND owner_user_id = ?').run(id, userId);
    });
    tx();
  }

  // ── Note database rows ─────────────────────────────────────────────────────

  async listNoteDbRows(databaseId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteDbRowRow[]> {
    return this.d.prepare('SELECT * FROM note_db_rows WHERE database_id = ? ORDER BY created_at ASC').all(databaseId) as import('./db-types/adapter-agenda-notes.js').NoteDbRowRow[];
  }

  async createNoteDbRow(row: Pick<import('./db-types/adapter-agenda-notes.js').NoteDbRowRow, 'id' | 'database_id'> & { fields_json?: string }): Promise<void> {
    this.d.prepare('INSERT INTO note_db_rows (id, database_id, fields_json) VALUES (?, ?, ?)').run(row.id, row.database_id, row.fields_json ?? '{}');
  }

  async updateNoteDbRow(id: string, databaseId: string, fieldsJson: string): Promise<void> {
    this.d.prepare('UPDATE note_db_rows SET fields_json = ? WHERE id = ? AND database_id = ?').run(fieldsJson, id, databaseId);
  }

  async deleteNoteDbRow(id: string, databaseId: string): Promise<void> {
    this.d.prepare('DELETE FROM note_db_rows WHERE id = ? AND database_id = ?').run(id, databaseId);
  }

  // ─── weaveNotes Phase 5: flashcards (SM-2) ──────────────────────────────────
  async createNoteFlashcard(row: import('./db-types/adapter-agenda-notes.js').NoteFlashcardRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO note_flashcards (id, note_id, owner_user_id, tenant_id, front, back, ease_factor, interval_days, repetitions, due_at, last_reviewed_at, created_at)
       VALUES (@id, @note_id, @owner_user_id, @tenant_id, @front, @back, @ease_factor, @interval_days, @repetitions, @due_at, @last_reviewed_at, @created_at)`,
    ).run(row);
  }
  async listNoteFlashcards(noteId: string, ownerUserId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteFlashcardRow[]> {
    return this.d.prepare('SELECT * FROM note_flashcards WHERE note_id = ? AND owner_user_id = ? ORDER BY created_at ASC').all(noteId, ownerUserId) as import('./db-types/adapter-agenda-notes.js').NoteFlashcardRow[];
  }
  async getNoteFlashcard(id: string, ownerUserId: string): Promise<import('./db-types/adapter-agenda-notes.js').NoteFlashcardRow | null> {
    return (this.d.prepare('SELECT * FROM note_flashcards WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId) as import('./db-types/adapter-agenda-notes.js').NoteFlashcardRow) ?? null;
  }
  async listDueFlashcards(ownerUserId: string, nowMs: number, limit: number): Promise<import('./db-types/adapter-agenda-notes.js').NoteFlashcardRow[]> {
    return this.d.prepare('SELECT * FROM note_flashcards WHERE owner_user_id = ? AND due_at <= ? ORDER BY due_at ASC LIMIT ?').all(ownerUserId, nowMs, Math.max(1, Math.min(500, limit))) as import('./db-types/adapter-agenda-notes.js').NoteFlashcardRow[];
  }
  async updateNoteFlashcardSchedule(id: string, ownerUserId: string, sched: { ease_factor: number; interval_days: number; repetitions: number; due_at: number; last_reviewed_at: number; stability?: number | null; difficulty?: number | null }): Promise<void> {
    this.d.prepare('UPDATE note_flashcards SET ease_factor = ?, interval_days = ?, repetitions = ?, due_at = ?, last_reviewed_at = ?, stability = ?, difficulty = ? WHERE id = ? AND owner_user_id = ?')
      .run(sched.ease_factor, sched.interval_days, sched.repetitions, sched.due_at, sched.last_reviewed_at, sched.stability ?? null, sched.difficulty ?? null, id, ownerUserId);
  }
  async countNoteFlashcards(noteId: string, ownerUserId: string): Promise<number> {
    return (this.d.prepare('SELECT COUNT(*) AS n FROM note_flashcards WHERE note_id = ? AND owner_user_id = ?').get(noteId, ownerUserId) as { n: number }).n;
  }

  // ─── Voice configs ────────────────────────────────────────────────────────

  async getVoiceConfig(userId: string): Promise<import('./db-types/adapter-voice.js').VoiceConfigRow | null> {
    return (this.d.prepare('SELECT * FROM voice_configs WHERE user_id = ?').get(userId) as import('./db-types/adapter-voice.js').VoiceConfigRow) ?? null;
  }

  async upsertVoiceConfig(create: import('./db-types/adapter-voice.js').VoiceConfigCreate): Promise<import('./db-types/adapter-voice.js').VoiceConfigRow> {
    const id = newUUIDv7();
    this.d.prepare(`
      INSERT INTO voice_configs
        (id, user_id, tenant_id, stt_provider, stt_model, stt_language,
         tts_provider, tts_model, tts_voice, tts_speed, tts_format,
         enabled_tools, mode, guardrail_policy, cost_policy,
         pipeline_mode, realtime_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        stt_provider = excluded.stt_provider,
        stt_model    = excluded.stt_model,
        stt_language = excluded.stt_language,
        tts_provider = excluded.tts_provider,
        tts_model    = excluded.tts_model,
        tts_voice    = excluded.tts_voice,
        tts_speed    = excluded.tts_speed,
        tts_format   = excluded.tts_format,
        enabled_tools = excluded.enabled_tools,
        mode         = excluded.mode,
        guardrail_policy = excluded.guardrail_policy,
        cost_policy  = excluded.cost_policy,
        pipeline_mode = excluded.pipeline_mode,
        realtime_model = excluded.realtime_model,
        updated_at   = datetime('now')
    `).run(
      id,
      create.userId,
      create.tenantId ?? null,
      create.sttProvider ?? 'openai',
      create.sttModel ?? 'whisper-1',
      create.sttLanguage ?? null,
      create.ttsProvider ?? 'openai',
      create.ttsModel ?? 'tts-1',
      create.ttsVoice ?? 'alloy',
      create.ttsSpeed ?? 1.0,
      create.ttsFormat ?? 'mp3',
      create.enabledTools ? JSON.stringify(create.enabledTools) : null,
      create.mode ?? 'agent',
      create.guardrailPolicy ?? null,
      create.costPolicy ?? null,
      create.pipelineMode ?? 'chained',
      create.realtimeModel ?? 'gpt-realtime-2',
    );
    return (this.d.prepare('SELECT * FROM voice_configs WHERE user_id = ?').get(create.userId) as import('./db-types/adapter-voice.js').VoiceConfigRow)!;
  }

  async updateVoiceConfig(userId: string, update: import('./db-types/adapter-voice.js').VoiceConfigUpdate): Promise<import('./db-types/adapter-voice.js').VoiceConfigRow | null> {
    const sets: string[] = ['updated_at = datetime(\'now\')'];
    const vals: unknown[] = [];
    if (update.sttProvider !== undefined) { sets.push('stt_provider = ?'); vals.push(update.sttProvider); }
    if (update.sttModel !== undefined)    { sets.push('stt_model = ?');    vals.push(update.sttModel); }
    if (update.sttLanguage !== undefined) { sets.push('stt_language = ?'); vals.push(update.sttLanguage); }
    if (update.ttsProvider !== undefined) { sets.push('tts_provider = ?'); vals.push(update.ttsProvider); }
    if (update.ttsModel !== undefined)    { sets.push('tts_model = ?');    vals.push(update.ttsModel); }
    if (update.ttsVoice !== undefined)    { sets.push('tts_voice = ?');    vals.push(update.ttsVoice); }
    if (update.ttsSpeed !== undefined)    { sets.push('tts_speed = ?');    vals.push(update.ttsSpeed); }
    if (update.ttsFormat !== undefined)   { sets.push('tts_format = ?');   vals.push(update.ttsFormat); }
    if (update.enabledTools !== undefined){ sets.push('enabled_tools = ?'); vals.push(update.enabledTools ? JSON.stringify(update.enabledTools) : null); }
    if (update.mode !== undefined)        { sets.push('mode = ?');         vals.push(update.mode); }
    if (update.guardrailPolicy !== undefined) { sets.push('guardrail_policy = ?'); vals.push(update.guardrailPolicy); }
    if (update.costPolicy !== undefined)  { sets.push('cost_policy = ?');  vals.push(update.costPolicy); }
    if (update.pipelineMode !== undefined){ sets.push('pipeline_mode = ?'); vals.push(update.pipelineMode); }
    if (update.realtimeModel !== undefined){ sets.push('realtime_model = ?'); vals.push(update.realtimeModel); }
    if (sets.length === 1) return this.getVoiceConfig(userId);
    vals.push(userId);
    this.d.prepare(`UPDATE voice_configs SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
    return this.getVoiceConfig(userId);
  }

  // ─── Voice sessions ───────────────────────────────────────────────────────

  async createVoiceSession(create: import('./db-types/adapter-voice.js').VoiceSessionCreate): Promise<import('./db-types/adapter-voice.js').VoiceSessionRow> {
    this.d.prepare(`
      INSERT INTO voice_sessions (id, user_id, tenant_id, chat_id, config_snapshot)
      VALUES (?, ?, ?, ?, ?)
    `).run(create.id, create.userId, create.tenantId ?? null, create.chatId, create.configSnapshot);
    return (this.d.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(create.id) as import('./db-types/adapter-voice.js').VoiceSessionRow)!;
  }

  async getVoiceSession(id: string, userId: string): Promise<import('./db-types/adapter-voice.js').VoiceSessionRow | null> {
    return (this.d.prepare('SELECT * FROM voice_sessions WHERE id = ? AND user_id = ?').get(id, userId) as import('./db-types/adapter-voice.js').VoiceSessionRow) ?? null;
  }

  async listVoiceSessions(userId: string, filter?: import('./db-types/adapter-voice.js').VoiceSessionListFilter): Promise<import('./db-types/adapter-voice.js').VoiceSessionRow[]> {
    const where: string[] = ['user_id = ?'];
    const vals: unknown[] = [userId];
    if (filter?.status) { where.push('status = ?'); vals.push(filter.status); }
    const limit = filter?.limit ?? 50;
    const sql = `SELECT * FROM voice_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`;
    return this.d.prepare(sql).all(...vals) as import('./db-types/adapter-voice.js').VoiceSessionRow[];
  }

  async updateVoiceSessionStatus(id: string, userId: string, status: import('./db-types/adapter-voice.js').VoiceSessionStatus, endedAt?: string | null): Promise<void> {
    this.d.prepare(`
      UPDATE voice_sessions SET status = ?, ended_at = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(status, endedAt ?? null, id, userId);
  }

  async updateVoiceSessionStats(id: string, userId: string, delta: {
    turns?: number; sttMs?: number; ttsMs?: number; llmMs?: number;
    costUsd?: number; audioBytes?: number; lastActiveAt?: string; wsConnected?: boolean;
  }): Promise<void> {
    const sets: string[] = ['updated_at = datetime(\'now\')'];
    const vals: unknown[] = [];
    if (delta.turns !== undefined)       { sets.push('total_turns = total_turns + ?');             vals.push(delta.turns); }
    if (delta.sttMs !== undefined)       { sets.push('total_stt_ms = total_stt_ms + ?');           vals.push(delta.sttMs); }
    if (delta.ttsMs !== undefined)       { sets.push('total_tts_ms = total_tts_ms + ?');           vals.push(delta.ttsMs); }
    if (delta.llmMs !== undefined)       { sets.push('total_llm_ms = total_llm_ms + ?');           vals.push(delta.llmMs); }
    if (delta.costUsd !== undefined)     { sets.push('total_cost_usd = total_cost_usd + ?');       vals.push(delta.costUsd); }
    if (delta.audioBytes !== undefined)  { sets.push('total_audio_bytes = total_audio_bytes + ?'); vals.push(delta.audioBytes); }
    if (delta.lastActiveAt !== undefined){ sets.push('last_active_at = ?');                        vals.push(delta.lastActiveAt); }
    if (delta.wsConnected !== undefined) { sets.push('ws_connected = ?');                          vals.push(delta.wsConnected ? 1 : 0); }
    vals.push(id, userId);
    this.d.prepare(`UPDATE voice_sessions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  }

  async endVoiceSession(id: string, userId: string): Promise<void> {
    this.d.prepare(`
      UPDATE voice_sessions
      SET status = 'ended', ended_at = datetime('now'), ws_connected = 0, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(id, userId);
  }

  // ─── Voice session events ─────────────────────────────────────────────────

  async insertVoiceSessionEvent(event: import('./db-types/adapter-voice.js').VoiceSessionEventCreate): Promise<void> {
    this.d.prepare(`
      INSERT INTO voice_session_events
        (id, session_id, user_id, turn_index, event_type, input_text, output_text,
         audio_bytes_in, audio_bytes_out, stt_provider, stt_model, tts_provider,
         tts_model, tts_voice, llm_provider, llm_model, prompt_tokens,
         completion_tokens, duration_ms, cost_usd, error, guardrail_decision, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.sessionId, event.userId, event.turnIndex, event.eventType,
      event.inputText ?? null, event.outputText ?? null,
      event.audioBytesIn ?? null, event.audioBytesOut ?? null,
      event.sttProvider ?? null, event.sttModel ?? null,
      event.ttsProvider ?? null, event.ttsModel ?? null, event.ttsVoice ?? null,
      event.llmProvider ?? null, event.llmModel ?? null,
      event.promptTokens ?? null, event.completionTokens ?? null,
      event.durationMs ?? null, event.costUsd ?? null,
      event.error ?? null, event.guardrailDecision ?? null, event.traceId ?? null,
    );
  }

  async listVoiceSessionEvents(sessionId: string, userId: string, limit = 100): Promise<import('./db-types/adapter-voice.js').VoiceSessionEventRow[]> {
    return this.d.prepare(
      'SELECT * FROM voice_session_events WHERE session_id = ? AND user_id = ? ORDER BY turn_index ASC, created_at ASC LIMIT ?',
    ).all(sessionId, userId, limit) as import('./db-types/adapter-voice.js').VoiceSessionEventRow[];
  }

  // ─── Agentic Scope Isolation (m75) ───────────────────────────────────────

  async listScopes(): Promise<import('./db-types/scopes.js').AgentScopeRow[]> {
    return this.d.prepare(`SELECT * FROM agent_scopes WHERE enabled = 1 ORDER BY id`).all() as import('./db-types/scopes.js').AgentScopeRow[];
  }

  async getScope(id: string): Promise<import('./db-types/scopes.js').AgentScopeRow | null> {
    return (this.d.prepare(`SELECT * FROM agent_scopes WHERE id = ?`).get(id) as import('./db-types/scopes.js').AgentScopeRow | undefined) ?? null;
  }

  async listScopePolicies(): Promise<import('./db-types/scopes.js').ScopeCrossPolicyRow[]> {
    return this.d.prepare(`SELECT * FROM scope_cross_policies WHERE enabled = 1 ORDER BY from_scope, to_scope`).all() as import('./db-types/scopes.js').ScopeCrossPolicyRow[];
  }

  async getScopeForSkill(skillId: string): Promise<string> {
    const row = this.d.prepare(`SELECT scope_id FROM scope_skill_assignments WHERE skill_id = ?`).get(skillId) as { scope_id: string } | undefined;
    if (row) return row.scope_id;
    const skillRow = this.d.prepare(`SELECT agentic_scope FROM a2a_skills WHERE id = ?`).get(skillId) as { agentic_scope: string } | undefined;
    return skillRow?.agentic_scope ?? 'system';
  }

  async getScopeForMeshRole(meshKey: string, roleKey: string): Promise<string> {
    // Try specific role first, then catch-all (empty string)
    const row = this.d.prepare(
      `SELECT scope_id FROM scope_live_agent_assignments WHERE mesh_key = ? AND role_key IN (?, '') ORDER BY CASE role_key WHEN ? THEN 0 ELSE 1 END LIMIT 1`,
    ).get(meshKey, roleKey, roleKey) as { scope_id: string } | undefined;
    return row?.scope_id ?? 'system';
  }

  async getScopeForTool(nameOrKey: string): Promise<string> {
    const row = this.d.prepare(
      `SELECT agentic_scope FROM tool_catalog WHERE (tool_key = ? OR name = ?) AND enabled = 1 LIMIT 1`,
    ).get(nameOrKey, nameOrKey) as { agentic_scope?: string } | undefined;
    return row?.agentic_scope ?? 'system';
  }

  async logScopeEvent(event: Omit<import('./db-types/scopes.js').ScopeAccessLogRow, 'id' | 'created_at'>): Promise<void> {
    const { randomUUID } = await import('crypto');
    this.d.prepare(`
      INSERT INTO scope_access_log
        (id, event_type, from_scope, to_scope, skill_id, tool_name, session_id, task_id, user_id, allowed, reason, delegation_chain_json)
      VALUES
        (@id, @event_type, @from_scope, @to_scope, @skill_id, @tool_name, @session_id, @task_id, @user_id, @allowed, @reason, @delegation_chain_json)
    `).run({ id: randomUUID(), ...event });
  }

  async listScopeAccessLog(opts: { limit?: number; sessionId?: string; onlyViolations?: boolean } = {}): Promise<import('./db-types/scopes.js').ScopeAccessLogRow[]> {
    const limit = opts.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.sessionId) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
    if (opts.onlyViolations) conditions.push('allowed = 0');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    return this.d.prepare(`SELECT * FROM scope_access_log ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as import('./db-types/scopes.js').ScopeAccessLogRow[];
  }

  async countScopeViolations(withinHours = 24): Promise<number> {
    // SQLite datetime('now') uses a space separator ('2026-06-21 08:00:00'),
    // but JS .toISOString() uses 'T' ('2026-06-21T08:00:00.000Z').
    // Since 'T'(84) > ' '(32) in ASCII, the T-format string always compares
    // as greater than the space-format string, causing the query to return 0.
    // Fix: use SQLite's datetime() arithmetic instead of a JS timestamp string.
    const row = this.d.prepare(
      `SELECT COUNT(*) as n FROM scope_access_log WHERE allowed = 0 AND created_at >= datetime('now', '-${Math.floor(withinHours)} hours')`,
    ).get() as { n: number };
    return row.n;
  }

  // ── Admin CRUD — agent_scopes ────────────────────────────────────────────

  async adminListScopes(): Promise<import('./db-types/scopes.js').AgentScopeRow[]> {
    return this.d.prepare(`SELECT * FROM agent_scopes ORDER BY id`).all() as import('./db-types/scopes.js').AgentScopeRow[];
  }

  async adminCreateScope(scope: Omit<import('./db-types/scopes.js').AgentScopeRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO agent_scopes (id, display_name, description, sandboxed, max_delegation_depth, audit_level, enabled)
      VALUES (@id, @display_name, @description, @sandboxed, @max_delegation_depth, @audit_level, @enabled)
    `).run(scope);
  }

  async adminUpdateScope(id: string, patch: Partial<Omit<import('./db-types/scopes.js').AgentScopeRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const setClauses = [...cols.map((c) => `${c} = @${c}`), `updated_at = datetime('now')`].join(', ');
    this.d.prepare(`UPDATE agent_scopes SET ${setClauses} WHERE id = @id`).run({ ...patch, id });
  }

  async adminDeleteScope(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM agent_scopes WHERE id = ?`).run(id);
  }

  // ── Admin CRUD — scope_cross_policies ────────────────────────────────────

  async adminListScopePolicies(): Promise<import('./db-types/scopes.js').ScopeCrossPolicyRow[]> {
    return this.d.prepare(`SELECT * FROM scope_cross_policies ORDER BY from_scope, to_scope`).all() as import('./db-types/scopes.js').ScopeCrossPolicyRow[];
  }

  async adminGetScopePolicy(id: string): Promise<import('./db-types/scopes.js').ScopeCrossPolicyRow | null> {
    return (this.d.prepare(`SELECT * FROM scope_cross_policies WHERE id = ?`).get(id) as import('./db-types/scopes.js').ScopeCrossPolicyRow | undefined) ?? null;
  }

  async adminCreateScopePolicy(policy: Omit<import('./db-types/scopes.js').ScopeCrossPolicyRow, 'created_at'>): Promise<void> {
    this.d.prepare(`
      INSERT INTO scope_cross_policies
        (id, from_scope, to_scope, allowed, requires_a2a, max_delegation_depth, conditions_json, audit_level, enabled)
      VALUES
        (@id, @from_scope, @to_scope, @allowed, @requires_a2a, @max_delegation_depth, @conditions_json, @audit_level, @enabled)
    `).run(policy);
  }

  async adminUpdateScopePolicy(id: string, patch: Partial<Omit<import('./db-types/scopes.js').ScopeCrossPolicyRow, 'id' | 'created_at'>>): Promise<void> {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const setClauses = cols.map((c) => `${c} = @${c}`).join(', ');
    this.d.prepare(`UPDATE scope_cross_policies SET ${setClauses} WHERE id = @id`).run({ ...patch, id });
  }

  async adminDeleteScopePolicy(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM scope_cross_policies WHERE id = ?`).run(id);
  }

  // ── Admin CRUD — scope_skill_assignments ─────────────────────────────────

  async adminListScopeSkillAssignments(): Promise<import('./db-types/adapter-scopes.js').ScopeSkillAssignmentAdminRow[]> {
    const rows = this.d.prepare(`
      SELECT scope_id, skill_id FROM scope_skill_assignments ORDER BY scope_id, skill_id
    `).all() as import('./db-types/scopes.js').ScopeSkillAssignmentRow[];
    // Add synthetic composite ID so the generic admin SPA can address individual rows.
    return rows.map((r) => ({ ...r, id: `${r.scope_id}::${r.skill_id}` }));
  }

  async adminCreateScopeSkillAssignment(scope_id: string, skill_id: string): Promise<void> {
    this.d.prepare(`
      INSERT OR IGNORE INTO scope_skill_assignments (scope_id, skill_id) VALUES (?, ?)
    `).run(scope_id, skill_id);
  }

  async adminDeleteScopeSkillAssignment(compositeId: string): Promise<void> {
    // compositeId = "{scope_id}::{skill_id}"
    const sep = compositeId.indexOf('::');
    if (sep === -1) throw new Error(`Invalid compositeId: ${compositeId}`);
    const scope_id = compositeId.slice(0, sep);
    const skill_id = compositeId.slice(sep + 2);
    this.d.prepare(`DELETE FROM scope_skill_assignments WHERE scope_id = ? AND skill_id = ?`).run(scope_id, skill_id);
  }

  // ── Admin CRUD — scope_live_agent_assignments ─────────────────────────────

  async adminListScopeLiveAgentAssignments(): Promise<import('./db-types/adapter-scopes.js').ScopeLiveAgentAssignmentAdminRow[]> {
    const rows = this.d.prepare(`
      SELECT scope_id, mesh_key, role_key FROM scope_live_agent_assignments ORDER BY scope_id, mesh_key, role_key
    `).all() as import('./db-types/scopes.js').ScopeLiveAgentAssignmentRow[];
    return rows.map((r) => ({ ...r, id: `${r.scope_id}::${r.mesh_key}::${r.role_key}` }));
  }

  async adminCreateScopeLiveAgentAssignment(scope_id: string, mesh_key: string, role_key: string): Promise<void> {
    this.d.prepare(`
      INSERT OR IGNORE INTO scope_live_agent_assignments (scope_id, mesh_key, role_key) VALUES (?, ?, ?)
    `).run(scope_id, mesh_key, role_key);
  }

  async adminDeleteScopeLiveAgentAssignment(compositeId: string): Promise<void> {
    // compositeId = "{scope_id}::{mesh_key}::{role_key}" (role_key may be empty string)
    const parts = compositeId.split('::');
    if (parts.length < 3) throw new Error(`Invalid compositeId: ${compositeId}`);
    // scope_id and mesh_key are first two, everything after is role_key (handles '::-style empty role key)
    const [scope_id, mesh_key, ...rest] = parts;
    const role_key = rest.join('::');
    this.d.prepare(
      `DELETE FROM scope_live_agent_assignments WHERE scope_id = ? AND mesh_key = ? AND role_key = ?`,
    ).run(scope_id, mesh_key, role_key);
  }

  // ─── Artifact storage (m77) ──────────────────────────────────────────────────

  async saveArtifact(input: import('./db-types/artifacts.js').ArtifactSaveInput): Promise<import('./db-types/artifacts.js').ArtifactRow> {
    const { newUUIDv7 } = await import('@weaveintel/core');
    const id = newUUIDv7();
    const now = new Date().toISOString();
    const { serializeArtifactData, estimateArtifactSize } = await import('./lib/artifact-helpers.js');
    const { data_text, data_blob } = serializeArtifactData(input.data);
    const sizeBytes = input.sizeBytes ?? estimateArtifactSize(input.data);
    this.d.prepare(`
      INSERT INTO artifacts
        (id, name, type, mime_type, data_text, data_blob, size_bytes, version,
         session_id, user_id, agent_id, run_id, tags, metadata, policy_id, scope,
         streaming_status, streaming_progress, created_at, tenant_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, input.name, input.type, input.mimeType,
      data_text, data_blob, sizeBytes, 1,
      input.sessionId ?? null, input.userId ?? null,
      input.agentId ?? null, input.runId ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.policyId ?? null,
      input.scope ?? 'session',
      input.streamingStatus ?? null,
      input.streamingProgress ?? null,
      now,
      input.tenantId ?? null,
    );
    const verId = newUUIDv7();
    this.d.prepare(`
      INSERT INTO artifact_versions (id, artifact_id, version, data_text, data_blob, changelog, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(verId, id, 1, data_text, data_blob, null, now);
    return this.d.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as import('./db-types/artifacts.js').ArtifactRow;
  }

  async getArtifact(id: string): Promise<import('./db-types/artifacts.js').ArtifactRow | null> {
    return (this.d.prepare(`SELECT * FROM artifacts WHERE id = ? LIMIT 1`).get(id) as import('./db-types/artifacts.js').ArtifactRow | undefined) ?? null;
  }

  async updateArtifact(
    id: string,
    patch: import('./db-types/artifacts.js').ArtifactUpdateInput,
    changelog?: string,
  ): Promise<import('./db-types/artifacts.js').ArtifactRow> {
    const existing = await this.getArtifact(id);
    if (!existing) throw new Error(`Artifact not found: ${id}`);
    const { newUUIDv7 } = await import('@weaveintel/core');
    const { serializeArtifactData, estimateArtifactSize } = await import('./lib/artifact-helpers.js');
    const now = new Date().toISOString();
    const nextVersion = existing.version + 1;
    const newData = patch.data !== undefined ? patch.data : (existing.data_text !== null
      ? (() => { try { return JSON.parse(existing.data_text!); } catch { return existing.data_text; } })()
      : existing.data_blob);
    const { data_text, data_blob } = serializeArtifactData(newData);
    const sizeBytes = patch.data !== undefined ? estimateArtifactSize(newData) : existing.size_bytes;
    // m79: streamingStatus=null clears the 'streaming' marker (artifact finalized)
    const newStreamingStatus = 'streamingStatus' in patch
      ? (patch.streamingStatus ?? null)
      : existing.streaming_status;
    const newStreamingProgress = 'streamingProgress' in patch
      ? (patch.streamingProgress ?? null)
      : existing.streaming_progress;
    this.d.prepare(`
      UPDATE artifacts SET
        name=?, type=?, mime_type=?, data_text=?, data_blob=?, size_bytes=?,
        version=?, tags=?, metadata=?, policy_id=?, scope=?,
        streaming_status=?, streaming_progress=?, updated_at=?
      WHERE id=?
    `).run(
      patch.name ?? existing.name,
      patch.type ?? existing.type,
      patch.mimeType ?? existing.mime_type,
      data_text, data_blob, sizeBytes, nextVersion,
      patch.tags !== undefined ? JSON.stringify(patch.tags) : existing.tags,
      patch.metadata !== undefined ? JSON.stringify(patch.metadata) : existing.metadata,
      patch.policyId !== undefined ? patch.policyId : existing.policy_id,
      patch.scope ?? existing.scope,
      newStreamingStatus,
      newStreamingProgress,
      now, id,
    );
    const verId = newUUIDv7();
    this.d.prepare(`
      INSERT INTO artifact_versions (id, artifact_id, version, data_text, data_blob, changelog, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(verId, id, nextVersion, data_text, data_blob, changelog ?? null, now);
    return this.d.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as import('./db-types/artifacts.js').ArtifactRow;
  }

  async listArtifacts(filter?: import('./db-types/artifacts.js').ArtifactListFilter): Promise<import('./db-types/artifacts.js').ArtifactRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      conditions.push(`type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (filter?.sessionId) { conditions.push('session_id=?'); params.push(filter.sessionId); }
    if (filter?.userId) { conditions.push('user_id=?'); params.push(filter.userId); }
    if (filter?.agentId) { conditions.push('agent_id=?'); params.push(filter.agentId); }
    if (filter?.runId) { conditions.push('run_id=?'); params.push(filter.runId); }
    if (filter?.scope) { conditions.push('scope=?'); params.push(filter.scope); }
    if (filter?.policyId) { conditions.push('policy_id=?'); params.push(filter.policyId); }
    if (filter?.tenantId !== undefined) {
      if (filter.tenantId === null) { conditions.push('tenant_id IS NULL'); }
      else { conditions.push('tenant_id=?'); params.push(filter.tenantId); }
    }
    let sql = 'SELECT * FROM artifacts';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
    if (filter?.offset) { sql += ' OFFSET ?'; params.push(filter.offset); }
    let rows = this.d.prepare(sql).all(...params) as import('./db-types/artifacts.js').ArtifactRow[];
    if (filter?.tags && filter.tags.length > 0) {
      const required = filter.tags;
      rows = rows.filter((r) => {
        if (!r.tags) return false;
        try {
          const t = JSON.parse(r.tags) as string[];
          return required.every((tag: string) => t.includes(tag));
        } catch { return false; }
      });
    }
    return rows;
  }

  async deleteArtifact(id: string): Promise<void> {
    this.d.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
  }

  async getArtifactVersions(artifactId: string): Promise<import('./db-types/artifacts.js').ArtifactVersionRow[]> {
    return this.d.prepare(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC`,
    ).all(artifactId) as import('./db-types/artifacts.js').ArtifactVersionRow[];
  }

  async getArtifactVersion(artifactId: string, version: number): Promise<import('./db-types/artifacts.js').ArtifactVersionRow | null> {
    return (this.d.prepare(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ? LIMIT 1`,
    ).get(artifactId, version) as import('./db-types/artifacts.js').ArtifactVersionRow | undefined) ?? null;
  }

  async expireArtifacts(): Promise<number> {
    // Joins artifacts with their policy to find rows past retention period.
    // policy_id is nullable — rows without a policy are never expired.
    const rows = this.d.prepare(`
      SELECT a.id, p.retention_days
      FROM artifacts a
      JOIN artifact_policies p ON a.policy_id = p.id
      WHERE p.retention_days IS NOT NULL
        AND p.retention_days > 0
        AND p.enabled = 1
        AND datetime(a.created_at, '+' || p.retention_days || ' days') < datetime('now')
    `).all() as Array<{ id: string; retention_days: number }>;
    if (rows.length === 0) return 0;
    const del = this.d.prepare(`DELETE FROM artifacts WHERE id = ?`);
    const tx = this.d.transaction(() => {
      for (const row of rows) del.run(row.id);
    });
    tx();
    return rows.length;
  }

  // ─── Tenant artifact settings (m78) ──────────────────────────────────────────

  async getTenantArtifactSettings(tenantId: string): Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow | null> {
    try {
      return (this.d.prepare(`SELECT * FROM tenant_artifact_settings WHERE tenant_id = ?`).get(tenantId) as import('./db-types/artifacts.js').TenantArtifactSettingsRow) ?? null;
    } catch { return null; }
  }

  async getEffectiveTenantArtifactSettings(tenantId: string): Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow | null> {
    // Try tenant-specific first, then fall back to 'default' global row.
    try {
      const row = this.d.prepare(`SELECT * FROM tenant_artifact_settings WHERE tenant_id = ?`).get(tenantId) as import('./db-types/artifacts.js').TenantArtifactSettingsRow | undefined;
      if (row) return row;
      return (this.d.prepare(`SELECT * FROM tenant_artifact_settings WHERE tenant_id = 'default'`).get() as import('./db-types/artifacts.js').TenantArtifactSettingsRow) ?? null;
    } catch { return null; }
  }

  async upsertTenantArtifactSettings(
    tenantId: string,
    fields: Partial<Omit<import('./db-types/artifacts.js').TenantArtifactSettingsRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>,
  ): Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow> {
    const now = new Date().toISOString();
    const existing = await this.getTenantArtifactSettings(tenantId);
    if (existing) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (fields.allowed_types !== undefined) { sets.push('allowed_types = ?'); vals.push(fields.allowed_types); }
      if (fields.max_size_bytes !== undefined) { sets.push('max_size_bytes = ?'); vals.push(fields.max_size_bytes); }
      if (fields.require_policy !== undefined) { sets.push('require_policy = ?'); vals.push(fields.require_policy ? 1 : 0); }
      if (fields.preview_enabled !== undefined) { sets.push('preview_enabled = ?'); vals.push(fields.preview_enabled ? 1 : 0); }
      if (fields.sandbox_html !== undefined) { sets.push('sandbox_html = ?'); vals.push(fields.sandbox_html ? 1 : 0); }
      if (fields.emit_enabled !== undefined) { sets.push('emit_enabled = ?'); vals.push(fields.emit_enabled ? 1 : 0); }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        vals.push(now, tenantId);
        this.d.prepare(`UPDATE tenant_artifact_settings SET ${sets.join(', ')} WHERE tenant_id = ?`).run(...vals);
      }
    } else {
      const { newUUIDv7 } = await import('@weaveintel/core');
      this.d.prepare(`
        INSERT INTO tenant_artifact_settings
          (id, tenant_id, allowed_types, max_size_bytes, require_policy, preview_enabled, sandbox_html, emit_enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newUUIDv7(), tenantId,
        fields.allowed_types ?? null,
        fields.max_size_bytes ?? null,
        fields.require_policy ? 1 : 0,
        fields.preview_enabled ?? 1,
        fields.sandbox_html ?? 1,
        fields.emit_enabled ?? 1,
        now,
      );
    }
    return (await this.getTenantArtifactSettings(tenantId))!;
  }

  async listTenantArtifactSettings(): Promise<import('./db-types/artifacts.js').TenantArtifactSettingsRow[]> {
    try {
      return this.d.prepare(`SELECT * FROM tenant_artifact_settings ORDER BY tenant_id ASC`).all() as import('./db-types/artifacts.js').TenantArtifactSettingsRow[];
    } catch { return []; }
  }

  async deleteTenantArtifactSettings(tenantId: string): Promise<void> {
    try { this.d.prepare(`DELETE FROM tenant_artifact_settings WHERE tenant_id = ?`).run(tenantId); } catch { /* ignore */ }
  }

  // ─── Tenant enterprise governance (m127) ─────────────────────────────────────

  async getTenantGovernance(tenantId: string): Promise<import('./db-types/governance.js').TenantGovernanceRow | null> {
    try { return (this.d.prepare(`SELECT * FROM tenant_governance WHERE tenant_id = ?`).get(tenantId) as import('./db-types/governance.js').TenantGovernanceRow) ?? null; } catch { return null; }
  }

  async listTenantGovernance(): Promise<import('./db-types/governance.js').TenantGovernanceRow[]> {
    try { return this.d.prepare(`SELECT * FROM tenant_governance ORDER BY tenant_id ASC`).all() as import('./db-types/governance.js').TenantGovernanceRow[]; } catch { return []; }
  }

  async upsertTenantGovernance(
    tenantId: string,
    fields: Partial<Omit<import('./db-types/governance.js').TenantGovernanceRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>,
  ): Promise<import('./db-types/governance.js').TenantGovernanceRow> {
    const now = new Date().toISOString();
    const existing = await this.getTenantGovernance(tenantId);
    const cols = ['data_residency', 'allow_model_training', 'allow_analytics', 'sso_required', 'sso_protocol', 'scim_enabled', 'activity_retention_days', 'audit_retention_days', 'legal_hold'] as const;
    if (existing) {
      const sets: string[] = []; const vals: unknown[] = [];
      for (const c of cols) { const v = (fields as Record<string, unknown>)[c]; if (v !== undefined) { sets.push(`${c} = ?`); vals.push(v); } }
      if (sets.length > 0) { sets.push('updated_at = ?'); vals.push(now, tenantId); this.d.prepare(`UPDATE tenant_governance SET ${sets.join(', ')} WHERE tenant_id = ?`).run(...vals); }
    } else {
      const { newUUIDv7 } = await import('@weaveintel/core');
      this.d.prepare(`
        INSERT INTO tenant_governance
          (id, tenant_id, data_residency, allow_model_training, allow_analytics, sso_required, sso_protocol, scim_enabled, activity_retention_days, audit_retention_days, legal_hold, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newUUIDv7(), tenantId,
        fields.data_residency ?? 'unrestricted',
        fields.allow_model_training ?? 1, fields.allow_analytics ?? 1,
        fields.sso_required ?? 0, fields.sso_protocol ?? 'none', fields.scim_enabled ?? 0,
        fields.activity_retention_days ?? 0, fields.audit_retention_days ?? 365, fields.legal_hold ?? 0,
        now,
      );
    }
    return (await this.getTenantGovernance(tenantId))!;
  }

  async deleteTenantGovernance(tenantId: string): Promise<void> {
    try { this.d.prepare(`DELETE FROM tenant_governance WHERE tenant_id = ?`).run(tenantId); } catch { /* ignore */ }
  }

  /** Per-tenant note_activity prune older than cutoff (for per-tenant retention enforcement). */
  async pruneNoteActivityForTenant(tenantId: string, cutoffIso: string): Promise<number> {
    try { const r = this.d.prepare(`DELETE FROM note_activity WHERE tenant_id = ? AND created_at < ?`).run(tenantId, cutoffIso); return r.changes ?? 0; } catch { return 0; }
  }

  // ─── Scheduled note agents (m129) ────────────────────────────────────────────
  async createScheduledNoteAgent(row: import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO scheduled_note_agents (id, user_id, tenant_id, name, recipe, task_prompt, trigger_type, cron, timezone, scope, scope_tag, lookback_days, max_notes, token_budget, max_steps, require_approval, enabled, last_run_id, last_run_at, next_run_at, created_at, updated_at)
       VALUES (@id, @user_id, @tenant_id, @name, @recipe, @task_prompt, @trigger_type, @cron, @timezone, @scope, @scope_tag, @lookback_days, @max_notes, @token_budget, @max_steps, @require_approval, @enabled, @last_run_id, @last_run_at, @next_run_at, @created_at, @updated_at)`,
    ).run(row);
  }
  async listScheduledNoteAgents(userId: string): Promise<import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow[]> {
    return this.d.prepare(`SELECT * FROM scheduled_note_agents WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow[];
  }
  async getScheduledNoteAgent(id: string, userId: string): Promise<import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow | null> {
    return (this.d.prepare(`SELECT * FROM scheduled_note_agents WHERE id = ? AND user_id = ?`).get(id, userId) as import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow) ?? null;
  }
  async countScheduledNoteAgents(userId: string): Promise<number> {
    return (this.d.prepare(`SELECT COUNT(*) AS n FROM scheduled_note_agents WHERE user_id = ?`).get(userId) as { n: number }).n;
  }
  async updateScheduledNoteAgent(id: string, userId: string, fields: Partial<import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow>): Promise<void> {
    const cols = ['name', 'recipe', 'task_prompt', 'trigger_type', 'cron', 'timezone', 'scope', 'scope_tag', 'lookback_days', 'max_notes', 'token_budget', 'max_steps', 'require_approval', 'enabled', 'last_run_id', 'last_run_at', 'next_run_at'] as const;
    const sets: string[] = []; const vals: unknown[] = [];
    for (const c of cols) { const v = (fields as Record<string, unknown>)[c]; if (v !== undefined) { sets.push(`${c} = ?`); vals.push(v); } }
    if (!sets.length) return;
    sets.push(`updated_at = datetime('now')`); vals.push(id, userId);
    this.d.prepare(`UPDATE scheduled_note_agents SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  }
  async deleteScheduledNoteAgent(id: string, userId: string): Promise<void> {
    this.d.prepare(`DELETE FROM scheduled_note_agents WHERE id = ? AND user_id = ?`).run(id, userId);
  }
  async listDueScheduledNoteAgents(nowMs: number, limit = 50): Promise<import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow[]> {
    return this.d.prepare(`SELECT * FROM scheduled_note_agents WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?`).all(nowMs, Math.max(1, Math.min(200, limit))) as import('./db-types/scheduled-agents.js').ScheduledNoteAgentRow[];
  }
  async createScheduledNoteAgentRun(row: import('./db-types/scheduled-agents.js').ScheduledNoteAgentRunRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO scheduled_note_agent_runs (id, agent_id, user_id, tenant_id, trigger, status, started_at, finished_at, steps, tokens_used, notes_scanned, suggestions_created, output_note_id, summary, error, detail_json)
       VALUES (@id, @agent_id, @user_id, @tenant_id, @trigger, @status, @started_at, @finished_at, @steps, @tokens_used, @notes_scanned, @suggestions_created, @output_note_id, @summary, @error, @detail_json)`,
    ).run(row);
  }
  async updateScheduledNoteAgentRun(id: string, fields: Partial<import('./db-types/scheduled-agents.js').ScheduledNoteAgentRunRow>): Promise<void> {
    const cols = ['status', 'finished_at', 'steps', 'tokens_used', 'notes_scanned', 'suggestions_created', 'output_note_id', 'summary', 'error', 'detail_json'] as const;
    const sets: string[] = []; const vals: unknown[] = [];
    for (const c of cols) { const v = (fields as Record<string, unknown>)[c]; if (v !== undefined) { sets.push(`${c} = ?`); vals.push(v); } }
    if (!sets.length) return;
    vals.push(id);
    this.d.prepare(`UPDATE scheduled_note_agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  async listScheduledNoteAgentRuns(agentId: string, userId: string, limit = 20): Promise<import('./db-types/scheduled-agents.js').ScheduledNoteAgentRunRow[]> {
    return this.d.prepare(`SELECT * FROM scheduled_note_agent_runs WHERE agent_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT ?`).all(agentId, userId, Math.max(1, Math.min(100, limit))) as import('./db-types/scheduled-agents.js').ScheduledNoteAgentRunRow[];
  }

  // ─── Per-user MCP tokens (m130) ──────────────────────────────────────────────
  async createUserMcpToken(row: import('./db-types/mcp-notes.js').UserMcpTokenRow): Promise<void> {
    this.d.prepare(
      `INSERT INTO user_mcp_tokens (id, user_id, tenant_id, name, token_hash, token_prefix, scope, enabled, created_at, last_used_at, expires_at)
       VALUES (@id, @user_id, @tenant_id, @name, @token_hash, @token_prefix, @scope, @enabled, @created_at, @last_used_at, @expires_at)`,
    ).run(row);
  }
  async listUserMcpTokens(userId: string): Promise<import('./db-types/mcp-notes.js').UserMcpTokenRow[]> {
    return this.d.prepare(`SELECT * FROM user_mcp_tokens WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as import('./db-types/mcp-notes.js').UserMcpTokenRow[];
  }
  async getUserMcpTokenByHash(tokenHash: string): Promise<import('./db-types/mcp-notes.js').UserMcpTokenRow | null> {
    return (this.d.prepare(`SELECT * FROM user_mcp_tokens WHERE token_hash = ?`).get(tokenHash) as import('./db-types/mcp-notes.js').UserMcpTokenRow) ?? null;
  }
  async revokeUserMcpToken(id: string, userId: string): Promise<void> {
    this.d.prepare(`UPDATE user_mcp_tokens SET enabled = 0 WHERE id = ? AND user_id = ?`).run(id, userId);
  }
  async touchUserMcpToken(id: string): Promise<void> {
    try { this.d.prepare(`UPDATE user_mcp_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(id); } catch { /* best-effort */ }
  }

  // ─── Live artifact configs (m80 / Phase 6) ────────────────────────────────────

  async getLiveArtifactConfig(artifactId: string): Promise<import('./db-types/artifacts.js').LiveArtifactConfigRow | null> {
    try {
      return (this.d.prepare(`SELECT * FROM live_artifact_configs WHERE artifact_id = ?`).get(artifactId) as import('./db-types/artifacts.js').LiveArtifactConfigRow) ?? null;
    } catch { return null; }
  }

  async saveLiveArtifactConfig(input: import('./db-types/artifacts.js').LiveArtifactConfigInput): Promise<import('./db-types/artifacts.js').LiveArtifactConfigRow> {
    const { newUUIDv7 } = await import('@weaveintel/core');
    const now = new Date().toISOString();
    const id = newUUIDv7();
    this.d.prepare(`
      INSERT INTO live_artifact_configs
        (id, artifact_id, mcp_server_key, refresh_tool, refresh_args,
         refresh_interval_seconds, cache_ttl_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        mcp_server_key = excluded.mcp_server_key,
        refresh_tool   = excluded.refresh_tool,
        refresh_args   = excluded.refresh_args,
        refresh_interval_seconds = excluded.refresh_interval_seconds,
        cache_ttl_seconds        = excluded.cache_ttl_seconds,
        updated_at = excluded.created_at
    `).run(
      id, input.artifactId,
      input.mcpServerKey ?? null,
      input.refreshTool ?? null,
      input.refreshArgs ? JSON.stringify(input.refreshArgs) : null,
      input.refreshIntervalSeconds ?? 0,
      input.cacheTtlSeconds ?? 30,
      now,
    );
    return (await this.getLiveArtifactConfig(input.artifactId))!;
  }

  async updateLiveArtifactConfig(artifactId: string, patch: import('./db-types/artifacts.js').LiveArtifactConfigUpdate): Promise<import('./db-types/artifacts.js').LiveArtifactConfigRow> {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now];
    if (patch.mcpServerKey !== undefined) { sets.push('mcp_server_key = ?'); vals.push(patch.mcpServerKey); }
    if (patch.refreshTool !== undefined) { sets.push('refresh_tool = ?'); vals.push(patch.refreshTool); }
    if (patch.refreshArgs !== undefined) { sets.push('refresh_args = ?'); vals.push(patch.refreshArgs ? JSON.stringify(patch.refreshArgs) : null); }
    if (patch.refreshIntervalSeconds !== undefined) { sets.push('refresh_interval_seconds = ?'); vals.push(patch.refreshIntervalSeconds); }
    if (patch.cacheTtlSeconds !== undefined) { sets.push('cache_ttl_seconds = ?'); vals.push(patch.cacheTtlSeconds); }
    vals.push(artifactId);
    this.d.prepare(`UPDATE live_artifact_configs SET ${sets.join(', ')} WHERE artifact_id = ?`).run(...vals);
    return (await this.getLiveArtifactConfig(artifactId))!;
  }

  async deleteLiveArtifactConfig(artifactId: string): Promise<void> {
    try { this.d.prepare(`DELETE FROM live_artifact_configs WHERE artifact_id = ?`).run(artifactId); } catch { /* ignore */ }
  }

  async touchLiveArtifactRefresh(artifactId: string): Promise<void> {
    const now = new Date().toISOString();
    this.d.prepare(`
      UPDATE live_artifact_configs
         SET last_refreshed_at = ?, refresh_count = refresh_count + 1, updated_at = ?
       WHERE artifact_id = ?
    `).run(now, now, artifactId);
  }
}

// ─── Factory ─────────────────────────────────────────────────


export async function createDatabaseAdapter(config: DatabaseConfig): Promise<DatabaseAdapter> {
  if (config.type === 'custom') {
    if (!config.adapter) throw new Error('Custom database type requires an adapter instance');
    await config.adapter.initialize();
    return config.adapter;
  }
  const adapter = new SQLiteAdapter(config.path ?? './geneweave.db');
  await adapter.initialize();
  return adapter;
}
