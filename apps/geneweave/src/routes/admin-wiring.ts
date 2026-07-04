import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine } from '../chat.js';
import { getOrCreateModel } from '../chat.js';
import { isValidPersona, normalizePersona, canPersonaAccess, personaPermissions } from '../rbac.js';
import { registerAdminRoutes } from '../server-admin.js';
import { createSqliteRevisionStore } from '../guardrail-revision-store.js';
import { registerWorkflowPlatformRoutes } from '../admin/api/workflow-platform.js';
import { registerTriggerRoutes, type TriggerDispatcherHandle } from '../admin/api/triggers.js';
import { registerMeshContractRoutes } from '../admin/api/mesh-contracts.js';
import { registerCostLedgerRoutes } from '../admin/api/cost-ledger.js';
import { registerCostPolicyRoutes } from '../admin/api/cost-policies.js';
import { registerTenantEncryptionPolicyRoutes } from '../admin/api/tenant-encryption-policies.js';
import { registerEncryptionObservabilityRoutes } from '../admin/api/encryption-observability.js';
import { registerTenantByokRoutes } from '../admin/api/tenant-byok.js';
import * as indexModule from '../index.js';
import { registerSVRoutes } from '../features/scientific-validation/index.js';
import { registerKaggleCompetitionRoutes, KaggleCompetitionRunner } from '../features/kaggle-competition/index.js';
import { SVChatBridge } from '../features/scientific-validation/chat-bridge.js';
import { createSVToolMap } from '../features/scientific-validation/tools/index.js';
import { DbToolPolicyResolver, DbToolRateLimiter } from '../tool-policy-resolver.js';
import { DbToolAuditEmitter } from '../tool-audit-emitter.js';
import { createMCPGateway, DEFAULT_EXPOSED_ALLOCATION_CLASSES, type LoadedGatewayConfig } from '../mcp-gateway.js';
import { encryptCredential, decryptCredential } from '../vault.js';
import { setBrowserAuthProvider, type SSOPassThroughAuth } from '@weaveintel/tools-browser';
import { OAuthClient, createOAuthProvider, type OAuthProviderName } from '@weaveintel/identity/oauth';
import { getAllProviders, getProvider, checkAllProviders, type ExternalCredential } from '../password-providers.js';
import { getAvailableTools, BUILTIN_TOOLS } from '../tools.js';
import {
  json,
  html,
  readBody,
  ensurePermission,
  permissionForAdminRoute,
  oauthClient,
  buildOAuthProviderFromRequest,
  LARGE_REQUEST_BODY_BYTES,
} from '../server-core.js';
import type { Router, Handler } from '../server-core.js';
import {
  resolveLimits, invalidateLimitsCache, mergeLimitsIntoOverrides,
  CODE_DEFAULTS, type PlatformLimits,
} from '../platform-limits.js';
import {
  resolveTenantThemeTokens, invalidateThemeCache, setThemeInOverrides,
  parseThemeFromOverrides, sanitizeTheme, type TenantThemeTokens,
} from '../tenant-theme.js';
import { createInvitation, INVITATION_EXPIRY_HOURS } from '../auth-invitations.js';
import { getEmailNotifier } from '../email-notifier.js';
import {
  requireStepUpMfa,
  handleMfaSetup,
  handleMfaSetupConfirm,
  handleMfaVerify,
  handleMfaDisable,
} from '../auth-mfa.js';
import { safePageInt } from './index.js';

export function registerAdminWiringRoutes(
  router: Router,
  db: DatabaseAdapter,
  config: {
    providers?: Record<string, { apiKey?: string }>;
    publicBaseUrl?: string;
    gatewayConfig?: LoadedGatewayConfig;
    workflowEngine?: import('../workflow-engine.js').WorkflowEngineHandle;
    triggerDispatcher?: TriggerDispatcherHandle;
    chatEngine: ChatEngine;
    runtime?: import('@weaveintel/core').WeaveRuntime;
  },
): void {
  const { providers, publicBaseUrl, gatewayConfig, workflowEngine, triggerDispatcher, chatEngine: _chatEngine, runtime } = config;
  void _chatEngine;

  // ── Admin routes (extracted to server-admin.ts) ─────────
  // Admin CRUD for guardrails, routing policies, prompts, tools,
  // workflows, HITL policies, and system settings. Each entity
  // maps to a database table via the DatabaseAdapter.
  const adminRouter = {
    get: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.get(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path, 'GET'));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
    post: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.post(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path, 'POST'));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        // 4.17: step-up MFA gate for admin mutations.
        const mfaGate = await requireStepUpMfa(auth!, db);
        if (!mfaGate.ok) { json(res, mfaGate.status, { error: mfaGate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
    put: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.put(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path, 'PUT'));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        // 4.17: step-up MFA gate for admin mutations.
        const mfaGate = await requireStepUpMfa(auth!, db);
        if (!mfaGate.ok) { json(res, mfaGate.status, { error: mfaGate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
    del: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.del(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path, 'DELETE'));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        // 4.17: step-up MFA gate for admin mutations.
        const mfaGate = await requireStepUpMfa(auth!, db);
        if (!mfaGate.ok) { json(res, mfaGate.status, { error: mfaGate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
    patch: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.patch(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path, 'PATCH'));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        const mfaGate = await requireStepUpMfa(auth!, db);
        if (!mfaGate.ok) { json(res, mfaGate.status, { error: mfaGate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
  };

  const guardrailRevisionStore = createSqliteRevisionStore(db);
  registerAdminRoutes(adminRouter, db, json, readBody, providers, html, { guardrailRevisionStore, runtime });

  // These modules expose `/api/admin/*` endpoints and must pass through
  // the same RBAC gate as other admin routes.
  registerWorkflowPlatformRoutes(adminRouter, db, { json, readBody }, workflowEngine);
  registerTriggerRoutes(adminRouter, db, { json, readBody }, triggerDispatcher);
  registerMeshContractRoutes(adminRouter, db, { json });
  registerCostLedgerRoutes(adminRouter, db, { json });
  registerCostPolicyRoutes(adminRouter, db, { json, readBody });
  // Tenant Encryption Phase 2 — admin CRUD + lifecycle (bootstrap, rotate-dek,
  // rotate-kek, shred). The route uses an ESM live-binding via a getter so it
  // always observes the current value of the process-wide
  // `geneweaveEncryptionManager` (filled in post-boot by `bootstrapEncryption`,
  // may stay null when WEAVE_ENCRYPTION_MASTER_KEY is unset).
  registerTenantEncryptionPolicyRoutes(
    adminRouter,
    db,
    { json, readBody },
    () => indexModule.geneweaveEncryptionManager,
    () => indexModule.geneweaveKmsRegistry,
    () => indexModule.geneweaveKmsResolver,
  );
  // Phase 9 — Encryption observability (health dashboard + alert rule CRUD).
  // Reads metrics from the in-memory emitter wired during bootstrapEncryption.
  registerEncryptionObservabilityRoutes(
    adminRouter,
    db,
    { json, readBody },
    () => indexModule.geneweaveEncryptionMetrics,
    () => indexModule.geneweaveKmsRegistry,
    () => indexModule.geneweaveKmsResolver,
  );
  // Phase 10 — BYOK / HYOK / break-glass / signed attestations.
  // All state DB-driven; no process-wide mutable wiring required.
  registerTenantByokRoutes(adminRouter, db, { json, readBody });

  // ── Hypothesis Validation feature routes ────────────────────
  // Build async model factories from the configured providers (models are cached by chat-runtime).
  // Prefer hosted/high-quality providers first, then fall back to local models so SV can
  // still operate against Ollama/llama.cpp when no cloud key is configured.
  const SV_PROVIDER_PREFERENCE = ['openai', 'anthropic', 'google', 'gemini', 'ollama', 'llamacpp', 'llama-cpp'] as const;
  const SV_REASONING_MODEL: Record<string, string> = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-6',
    google: 'gemini-2.5-pro',
    gemini: 'gemini-2.5-pro',
    ollama: process.env['OLLAMA_MODEL'] ?? 'llama3.1',
    llamacpp: 'local',
    'llama-cpp': 'local',
  };
  const SV_TOOL_MODEL: Record<string, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5-20251001',
    google: 'gemini-2.5-flash',
    gemini: 'gemini-2.5-flash',
    ollama: process.env['OLLAMA_MODEL'] ?? 'llama3.1',
    llamacpp: 'local',
    'llama-cpp': 'local',
  };
  const svProviderKey = SV_PROVIDER_PREFERENCE.find(p => providers?.[p]) ?? 'openai';
  const svProviderCfg = providers?.[svProviderKey] ?? { apiKey: '' };
  const svRunner = new SVChatBridge({
    db,
    makeReasoningModel: () => getOrCreateModel(
      svProviderKey,
      SV_REASONING_MODEL[svProviderKey] ?? 'gpt-4o',
      svProviderCfg,
    ),
    makeToolModel: () => getOrCreateModel(
      svProviderKey,
      SV_TOOL_MODEL[svProviderKey] ?? 'gpt-4o-mini',
      svProviderCfg,
    ),
    toolMap: { ...BUILTIN_TOOLS, ...createSVToolMap() },
    policyResolver: new DbToolPolicyResolver(db),
    auditEmitter: new DbToolAuditEmitter(db),
  });
  registerSVRoutes(adminRouter, db, json, readBody, svRunner);

  const kaggleRunner = new KaggleCompetitionRunner(db);
  registerKaggleCompetitionRoutes(adminRouter, db, json, readBody, kaggleRunner);

  adminRouter.get('/api/admin/rbac/personas', async (_req, res) => {
    json(res, 200, {
      personas: ['platform_admin', 'tenant_admin', 'tenant_user', 'agent_worker', 'agent_researcher', 'agent_supervisor'],
    });
  }, { auth: true });

  adminRouter.get('/api/admin/rbac/users', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const isPlatformAdmin = auth.persona === 'platform_admin';
    const filter = isPlatformAdmin ? undefined : { tenantId: auth.tenantId ?? null };
    const users = await db.listUsers(filter);
    json(res, 200, {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        persona: normalizePersona(user.persona),
        tenantId: user.tenant_id,
        createdAt: user.created_at,
      })),
    });
  }, { auth: true });

  adminRouter.post('/api/admin/rbac/users/:id/persona', async (req, res, params) => {
    const targetUser = await db.getUserById(params['id']!);
    if (!targetUser) { json(res, 404, { error: 'User not found' }); return; }

    const raw = await readBody(req);
    let body: { persona?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!isValidPersona(body.persona)) {
      json(res, 400, { error: 'Invalid persona value' });
      return;
    }
    const nextPersona = body.persona.trim().toLowerCase();

    await db.updateUserPersona(targetUser.id, nextPersona);
    json(res, 200, {
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        persona: nextPersona,
        tenantId: targetUser.tenant_id,
      },
    });
  }, { auth: true, csrf: true });

  // ── Admin invitations ────────────────────────────────────────────────────────
  // POST /api/admin/invitations — create an invitation and send it via email.
  // GET  /api/admin/invitations — list all invitations (admin visibility only).
  //
  // Privileged personas (tenant_admin, platform_admin) may only be registered
  // via an invitation issued here. The invitation token is SHA-256 stored;
  // the plaintext token travels exclusively in the email link.

  adminRouter.post('/api/admin/invitations', async (req, res, _params, auth) => {
    const raw = await readBody(req);
    let body: { email?: string; persona?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const persona = typeof body.persona === 'string' ? body.persona.trim().toLowerCase() : 'tenant_user';
    if (!email || !email.includes('@')) { json(res, 400, { error: 'A valid email is required' }); return; }
    if (!isValidPersona(persona)) { json(res, 400, { error: 'Invalid persona' }); return; }

    const inviter = await db.getUserById(auth!.userId);
    const inviterName = inviter?.name ?? 'Platform Admin';

    const { invitationId, rawToken } = await createInvitation(db, {
      email,
      persona,
      invitedBy: auth!.userId,
    });

    const inviteUrl = `${publicBaseUrl ?? ''}/auth/accept-invitation?token=${rawToken}`;
    await getEmailNotifier().sendInvitationEmail({
      to: email,
      inviterName,
      invitationUrl: inviteUrl,
      persona,
      expiresInHours: INVITATION_EXPIRY_HOURS,
    });

    json(res, 201, { invitationId, email, persona, expiresInHours: INVITATION_EXPIRY_HOURS });
  }, { auth: true, csrf: true });

  adminRouter.get('/api/admin/invitations', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://_');
    const limit = safePageInt(url.searchParams.get('limit'), 50, 1, 200);
    const invitations = await db.listInvitations({ limit });
    // Strip token_hash from the response (never expose the stored hash externally)
    const sanitized = invitations.map(({ token_hash: _th, ...rest }) => rest);
    json(res, 200, { invitations: sanitized });
  }, { auth: true });

  // ── Website Credentials (Browser Auth Vault) ───────────────

  router.get('/api/credentials', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listWebsiteCredentials(auth.userId);
    // Never expose encrypted creds to client — return metadata only
    const creds = rows.map(r => ({
      id: r.id,
      siteName: r.site_name,
      siteUrlPattern: r.site_url_pattern,
      authMethod: r.auth_method,
      lastUsedAt: r.last_used_at,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    json(res, 200, { credentials: creds });
  }, { auth: true });

  router.post('/api/credentials', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { siteName?: string; siteUrlPattern?: string; authMethod?: string; config?: Record<string, unknown> };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body.siteName || !body.siteUrlPattern || !body.authMethod || !body.config) {
      json(res, 400, { error: 'siteName, siteUrlPattern, authMethod, and config are required' }); return;
    }
    const id = `wc-${newUUIDv7().slice(-8)}`;
    const { encrypted, iv } = encryptCredential(body.config);
    await db.createWebsiteCredential({
      id,
      user_id: auth.userId,
      site_name: body.siteName,
      site_url_pattern: body.siteUrlPattern,
      auth_method: body.authMethod,
      credentials_encrypted: encrypted,
      encryption_iv: iv,
      last_used_at: null,
      status: 'active',
    });
    json(res, 201, { id, siteName: body.siteName, status: 'active' });
  }, { auth: true, csrf: true });

  router.put('/api/credentials/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWebsiteCredential(params['id']!, auth.userId);
    if (!existing) { json(res, 404, { error: 'Credential not found' }); return; }
    const raw = await readBody(req);
    let body: { siteName?: string; siteUrlPattern?: string; authMethod?: string; config?: Record<string, unknown>; status?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const updates: Record<string, unknown> = {};
    if (body.siteName) updates['site_name'] = body.siteName;
    if (body.siteUrlPattern) updates['site_url_pattern'] = body.siteUrlPattern;
    if (body.authMethod) updates['auth_method'] = body.authMethod;
    if (body.status) updates['status'] = body.status;
    if (body.config) {
      const { encrypted, iv } = encryptCredential(body.config);
      updates['credentials_encrypted'] = encrypted;
      updates['encryption_iv'] = iv;
    }
    await db.updateWebsiteCredential(params['id']!, auth.userId, updates);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  router.del('/api/credentials/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWebsiteCredential(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── External Password Manager Import ──────────────────────

  router.get('/api/password-providers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (process.env['NODE_ENV'] === 'production') { json(res, 404, { error: 'Not found' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:write')) {
      json(res, 403, { error: 'Missing permission: admin:platform:write' });
      return;
    }
    const statuses = await checkAllProviders();
    json(res, 200, statuses);
  }, { auth: true });

  router.post('/api/password-providers/import', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (process.env['NODE_ENV'] === 'production') { json(res, 404, { error: 'Not found' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:write')) {
      json(res, 403, { error: 'Missing permission: admin:platform:write' });
      return;
    }
    const raw = await readBody(req);
    let body: { provider: string; config?: Record<string, string>; search?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body.provider) { json(res, 400, { error: 'provider is required' }); return; }

    const provider = getProvider(body.provider);
    if (!provider) { json(res, 400, { error: `Unknown provider: ${body.provider}` }); return; }

    const status = await provider.checkAvailability();
    if (!status.available) { json(res, 400, { error: `Provider unavailable: ${status.reason}` }); return; }

    let credentials: ExternalCredential[];
    try {
      credentials = await provider.listCredentials(body.config ?? {}, body.search);
    } catch (e: unknown) {
      json(res, 500, { error: `Import failed: ${e instanceof Error ? e.message : String(e)}` }); return;
    }

    // Bulk-import into vault
    let imported = 0;
    for (const cred of credentials) {
      if (!cred.username && !cred.password) continue;
      const id = `wc-${newUUIDv7().slice(-8)}`;
      const config: Record<string, unknown> = {
        type: 'form_fill',
        username: cred.username,
        password: cred.password,
      };
      const { encrypted, iv } = encryptCredential(config);
      try {
        await db.createWebsiteCredential({
          id,
          user_id: auth.userId,
          site_name: cred.title || 'Imported',
          site_url_pattern: cred.url || '*',
          auth_method: 'form_fill',
          credentials_encrypted: encrypted,
          encryption_iv: iv,
          last_used_at: null,
          status: 'active',
        });
        imported++;
      } catch { /* skip duplicates */ }
    }

    json(res, 200, { imported, total: credentials.length, provider: body.provider });
  }, { auth: true, csrf: true });

  // ── SSO Pass-Through (Identity Provider Sessions) ──────────

  router.get('/api/sso/providers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const linked = await db.listSSOLinkedAccounts(auth.userId);
    json(res, 200, { providers: linked });
  }, { auth: true });

  router.post('/api/sso/capture', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { identityProvider: string; email?: string; cookies: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; expires?: number }> };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    
    if (!body.identityProvider || !body.cookies) {
      json(res, 400, { error: 'identityProvider and cookies are required' }); return;
    }

    const ssoSession: SSOPassThroughAuth = {
      method: 'sso_passthrough',
      identityProvider: body.identityProvider,
      email: body.email,
      cookies: body.cookies,
    };

    const { encrypted, iv } = encryptCredential(ssoSession);
    const id = `sso-${newUUIDv7().slice(-8)}`;
    
    try {
      await db.createSSOLinkedAccount({
        id,
        user_id: auth.userId,
        identity_provider: body.identityProvider,
        email: body.email,
        session_encrypted: encrypted,
        encryption_iv: iv,
      });
      json(res, 201, { id, provider: body.identityProvider, email: body.email, cookiesCaptured: body.cookies.length });
    } catch (e: unknown) {
      json(res, 500, { error: `Failed to save SSO session: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, { auth: true, csrf: true });

  router.del('/api/sso/providers/:provider', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const provider = params['provider']!;
    await db.deleteSSOLinkedAccount(auth.userId, provider);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Wire Browser Auth Provider ─────────────────────────────
  // Connects the credential vault to the browser auth tools so
  // browser_login can look up and decrypt stored credentials.

  setBrowserAuthProvider({
    async getCredential(url: string, userId?: string) {
      // Prefer credentials scoped to the current authenticated user.
      const rows = userId
        ? (await db.listWebsiteCredentials(userId)).filter(r => r.status === 'active')
        : await db.listAllActiveWebsiteCredentials();
      for (const row of rows) {
        try {
          const pattern = row.site_url_pattern;
          // Convert glob or literal URL to regex: *.example.com/* → .*\.example\.com\/.*
          const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          if (new RegExp(`^${escaped}$`, 'i').test(url) || url.includes(pattern.replace(/\*/g, ''))) {
            const config = decryptCredential(row.credentials_encrypted);
            return config as import('@weaveintel/tools-browser').BrowserAuthConfig;
          }
        } catch { /* skip broken entries */ }
      }
      return null;
    },
    async getSSOSession(identityProvider: string, userId?: string) {
      if (!userId) return null;
      const row = await db.getSSOLinkedAccount(userId, identityProvider);
      if (!row) return null;
      try {
        const session = decryptCredential<SSOPassThroughAuth>(row.session_encrypted);
        return session;
      } catch {
        return null;
      }
    },
    async saveSSOSession(session: import('@weaveintel/tools-browser').SSOPassThroughAuth, userId?: string) {
      if (!userId) return;
      const { encrypted, iv } = encryptCredential(session);
      await db.createSSOLinkedAccount({
        id: `sso-${newUUIDv7().slice(-8)}`,
        user_id: userId,
        identity_provider: session.identityProvider,
        email: session.email,
        session_encrypted: encrypted,
        encryption_iv: iv,
      });
    },
    async listSSOProviders(userId?: string) {
      if (!userId) return [];
      const linked = await db.listSSOLinkedAccounts(userId);
      return linked.map(p => ({
        provider: p.identity_provider,
        email: p.email ?? undefined,
        linkedAt: p.linked_at,
      }));
    },
  });

  // ── Health ─────────────────────────────────────────────────

  // ── Compute Sandbox Engine (CSE) ───────────────────────────

  router.get('/api/sandbox/status', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE, isCSEEnabled } = await import('../cse.js');
    if (!isCSEEnabled()) {
      json(res, 200, { enabled: false, message: 'CSE is not configured. Set CSE_PROVIDER or cloud credentials.' });
      return;
    }
    const cse = await getCSE(db);
    if (!cse) { json(res, 503, { error: 'CSE unavailable' }); return; }
    const health = await cse.healthCheck();
    json(res, health.healthy ? 200 : 503, { enabled: true, ...health });
  });

  router.post('/api/sandbox/execute', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE, isCSEEnabled } = await import('../cse.js');
    if (!isCSEEnabled()) { json(res, 503, { error: 'CSE is not configured' }); return; }

    const raw = await readBody(req, { maxBytes: LARGE_REQUEST_BODY_BYTES });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { code, language, chatId, sessionId, files, env: envVars, timeoutMs, networkAccess, withBrowser } = body;

    if (!code || typeof code !== 'string' || code.trim() === '') {
      json(res, 400, { error: 'code is required' });
      return;
    }

    // Restrict env vars to safe keys only (no overriding system vars)
    const safeEnv: Record<string, string> = {};
    if (envVars && typeof envVars === 'object') {
      for (const [k, v] of Object.entries(envVars as Record<string, unknown>)) {
        if (/^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string') safeEnv[k] = v;
      }
    }

    let cse: Awaited<ReturnType<typeof getCSE>>;
    try {
      cse = await getCSE(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 503, { status: 'error', error: 'Sandbox backend unavailable', stderr: msg });
      return;
    }
    if (!cse) { json(res, 503, { error: 'CSE unavailable' }); return; }

    const languageValue =
      language === 'python' ||
      language === 'javascript' ||
      language === 'typescript' ||
      language === 'bash' ||
      language === 'shell'
        ? language
        : undefined;

    let result: Awaited<ReturnType<typeof cse.run>>;
    try {
      result = await cse.run({
        code,
        language: languageValue,
        userId: auth.userId,
        chatId: typeof chatId === 'string' ? chatId : undefined,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        files: Array.isArray(files) ? files as Array<{ name: string; content: string; binary?: boolean }> : undefined,
        env: safeEnv,
        timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
        networkAccess: typeof networkAccess === 'boolean' ? networkAccess : undefined,
        withBrowser: typeof withBrowser === 'boolean' ? withBrowser : false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isUnavailable = msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('connect');
      json(res, isUnavailable ? 503 : 422, {
        status: 'error',
        error: isUnavailable ? 'Sandbox backend unavailable' : 'Sandbox execution failed',
        stderr: msg,
      });
      return;
    }

    json(res, result.status === 'success' ? 200 : 422, result);
  }, { auth: true, csrf: true });

  router.get('/api/sandbox/sessions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE, isCSEEnabled } = await import('../cse.js');
    if (!isCSEEnabled()) { json(res, 200, { sessions: [] }); return; }
    const cse = await getCSE(db);
    if (!cse) { json(res, 200, { sessions: [] }); return; }
    json(res, 200, { sessions: cse.listSessions() });
  });

  router.del('/api/sandbox/sessions/:sessionId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE } = await import('../cse.js');
    const cse = await getCSE(db);
    if (!cse) { json(res, 404, { error: 'No active CSE' }); return; }
    const sessionId = params['sessionId'];
    if (!sessionId) { json(res, 400, { error: 'sessionId required' }); return; }
    await cse.terminateSession(sessionId);
    json(res, 200, { terminated: true, sessionId });
  }, { auth: true, csrf: true });

  // ── Platform limits ──��─────────────────────────────────────
  // GET  /api/admin/platform-limits          — effective platform limits
  // PATCH /api/admin/platform-limits         — update platform overrides
  // GET  /api/admin/platform-limits/:tenantId — effective limits for tenant
  // PATCH /api/admin/platform-limits/:tenantId — update tenant overrides

  router.get('/api/admin/platform-limits', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:read')) {
      json(res, 403, { error: 'Missing permission: admin:platform:read' }); return;
    }
    const effective = await resolveLimits(db);
    const globalRow = await db.getGlobalTenantConfig();
    let overrides: Partial<PlatformLimits> = {};
    if (globalRow?.config_overrides) {
      try { overrides = (JSON.parse(globalRow.config_overrides) as Record<string, unknown>)['limits'] as Partial<PlatformLimits> ?? {}; } catch { /* ignore */ }
    }
    json(res, 200, { codeDefaults: CODE_DEFAULTS, platformOverrides: overrides, effective });
  }, { auth: true });

  router.put('/api/admin/platform-limits', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:write')) {
      json(res, 403, { error: 'Missing permission: admin:platform:write' }); return;
    }
    const raw = await readBody(req);
    let body: Partial<PlatformLimits>;
    try { body = JSON.parse(raw) as Partial<PlatformLimits>; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const globalRow = await db.getGlobalTenantConfig();
    if (!globalRow) { json(res, 404, { error: 'Platform config row not found — run migrations' }); return; }

    const updatedOverrides = mergeLimitsIntoOverrides(globalRow.config_overrides, body);
    await db.updateTenantConfig(globalRow.id, { config_overrides: updatedOverrides });
    invalidateLimitsCache();
    const effective = await resolveLimits(db);
    json(res, 200, { ok: true, effective });
  }, { auth: true, csrf: true });

  router.get('/api/admin/platform-limits/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:read')) {
      json(res, 403, { error: 'Missing permission: admin:platform:read' }); return;
    }
    const { tenantId } = params as { tenantId: string };
    const tenantRow = await db.getTenantConfigForTenant(tenantId);
    let overrides: Partial<PlatformLimits> = {};
    if (tenantRow?.config_overrides) {
      try { overrides = (JSON.parse(tenantRow.config_overrides) as Record<string, unknown>)['limits'] as Partial<PlatformLimits> ?? {}; } catch { /* ignore */ }
    }
    const effective = await resolveLimits(db, tenantId);
    json(res, 200, { tenantId, tenantOverrides: overrides, effective });
  }, { auth: true });

  router.put('/api/admin/platform-limits/:tenantId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:write')) {
      json(res, 403, { error: 'Missing permission: admin:platform:write' }); return;
    }
    const { tenantId } = params as { tenantId: string };
    const raw = await readBody(req);
    let body: Partial<PlatformLimits>;
    try { body = JSON.parse(raw) as Partial<PlatformLimits>; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const tenantRow = await db.getTenantConfigForTenant(tenantId);
    if (!tenantRow) { json(res, 404, { error: `No tenant config found for tenant '${tenantId}'` }); return; }

    const updatedOverrides = mergeLimitsIntoOverrides(tenantRow.config_overrides, body);
    await db.updateTenantConfig(tenantRow.id, { config_overrides: updatedOverrides });
    invalidateLimitsCache(tenantId);
    const effective = await resolveLimits(db, tenantId);
    json(res, 200, { ok: true, tenantId, effective });
  }, { auth: true, csrf: true });

  // ── Tenant theme (per-tenant design tokens) ────────────────
  // GET /api/admin/tenant-theme            — platform override + effective
  // PUT /api/admin/tenant-theme            — set/clear platform theme
  // GET /api/admin/tenant-theme/:tenantId  — tenant override + effective
  // PUT /api/admin/tenant-theme/:tenantId  — set/clear tenant theme
  // Body shape: a TenantThemeTokens object ({ colors?, typography?, radii? }).
  // An empty body / {} clears the override. The server validates + stores the
  // tokens; WCAG-AA enforcement happens client-side in @weaveintel/tokens.

  router.get('/api/admin/tenant-theme', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:read')) {
      json(res, 403, { error: 'Missing permission: admin:platform:read' }); return;
    }
    const globalRow = await db.getGlobalTenantConfig();
    const override = parseThemeFromOverrides(globalRow?.config_overrides);
    const effective = await resolveTenantThemeTokens(db);
    json(res, 200, { platformOverride: override, effective });
  }, { auth: true });

  router.put('/api/admin/tenant-theme', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:write')) {
      json(res, 403, { error: 'Missing permission: admin:platform:write' }); return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const globalRow = await db.getGlobalTenantConfig();
    if (!globalRow) { json(res, 404, { error: 'Platform config row not found — run migrations' }); return; }

    const theme: TenantThemeTokens | null = sanitizeTheme(body);
    const updatedOverrides = setThemeInOverrides(globalRow.config_overrides, theme);
    await db.updateTenantConfig(globalRow.id, { config_overrides: updatedOverrides });
    invalidateThemeCache();
    const effective = await resolveTenantThemeTokens(db);
    json(res, 200, { ok: true, platformOverride: theme, effective });
  }, { auth: true, csrf: true });

  router.get('/api/admin/tenant-theme/:tenantId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { tenantId } = params as { tenantId: string };
    // A platform admin reads any tenant; a tenant admin reads only their own.
    const allowed =
      canPersonaAccess(auth.persona, 'admin:platform:read') ||
      (canPersonaAccess(auth.persona, 'admin:tenant:read') && auth.tenantId === tenantId);
    if (!allowed) { json(res, 403, { error: 'Missing permission to read this tenant theme' }); return; }
    const tenantRow = await db.getTenantConfigForTenant(tenantId);
    const override = parseThemeFromOverrides(tenantRow?.config_overrides);
    const effective = await resolveTenantThemeTokens(db, tenantId);
    json(res, 200, { tenantId, tenantOverride: override, effective });
  }, { auth: true });

  router.put('/api/admin/tenant-theme/:tenantId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { tenantId } = params as { tenantId: string };
    // A platform admin writes any tenant; a tenant admin writes only their own.
    const allowed =
      canPersonaAccess(auth.persona, 'admin:platform:write') ||
      (canPersonaAccess(auth.persona, 'admin:tenant:write') && auth.tenantId === tenantId);
    if (!allowed) { json(res, 403, { error: 'Missing permission to write this tenant theme' }); return; }
    const raw = await readBody(req);
    let body: unknown;
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const tenantRow = await db.getTenantConfigForTenant(tenantId);
    if (!tenantRow) { json(res, 404, { error: `No tenant config found for tenant '${tenantId}'` }); return; }

    const theme: TenantThemeTokens | null = sanitizeTheme(body);
    const updatedOverrides = setThemeInOverrides(tenantRow.config_overrides, theme);
    await db.updateTenantConfig(tenantRow.id, { config_overrides: updatedOverrides });
    invalidateThemeCache(tenantId);
    const effective = await resolveTenantThemeTokens(db, tenantId);
    json(res, 200, { ok: true, tenantId, tenantOverride: theme, effective });
  }, { auth: true, csrf: true });

  router.get('/health', async (_req, res) => {
    json(res, 200, { status: 'ok', service: 'geneweave', timestamp: new Date().toISOString() });
  });

  // ── Step-up MFA routes (4.17) ─────────────────────────────────
  // MFA setup and challenge endpoints. These are NOT gated by the
  // adminRouter's step-up gate (they ARE the gate — the user can't
  // verify before they have a route to verify through).
  //
  //  GET  /api/admin/mfa/status  — returns { mfaEnabled, mfaVerifiedAt }
  //  POST /api/admin/mfa/setup   — generate TOTP secret (pending until confirm)
  //  POST /api/admin/mfa/setup/confirm — confirm first TOTP code and enable MFA
  //  POST /api/admin/mfa/verify  — complete step-up challenge; stamps session
  //  DELETE /api/admin/mfa       — disable MFA (requires TOTP confirmation)

  router.get('/api/admin/mfa/status', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    const mfaEnabled = await db.getUserMfaEnabled(auth.userId);
    json(res, 200, { mfaEnabled, mfaVerifiedAt: auth.mfaVerifiedAt ?? null });
  }, { auth: true });

  router.post('/api/admin/mfa/setup', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    await handleMfaSetup(req, res, auth, db, json);
  }, { auth: true, csrf: true });

  router.post('/api/admin/mfa/setup/confirm', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    await handleMfaSetupConfirm(req, res, auth, db, json, readBody);
  }, { auth: true, csrf: true });

  router.post('/api/admin/mfa/verify', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    await handleMfaVerify(req, res, auth, db, json, readBody);
  }, { auth: true, csrf: true });

  router.del('/api/admin/mfa', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    await handleMfaDisable(req, res, auth, db, json, readBody);
  }, { auth: true, csrf: true });

  // ── Internal MCP Gateway (Phase 1D) ────────────────────────
  // Exposes builtin tools whose allocation_class is in the operator-edited
  // tool_catalog `config.exposed_classes` (defaulting to web/social/search/
  // cse/http/enterprise/communication) over the MCP Streamable HTTP
  // protocol with bearer-token auth. Phase 4: exposure classes and the
  // enable toggle come from the DB so admin changes survive restart.
  const mcpGatewayToken = process.env['GENEWEAVE_MCP_GATEWAY_TOKEN'] ?? '';
  if (gatewayConfig?.enabled && !mcpGatewayToken) {
    console.warn('[mcp-gateway] GENEWEAVE_MCP_GATEWAY_TOKEN is not set — gateway will run without bearer-token authentication');
  }
  const gatewayEnabled = gatewayConfig?.enabled ?? true;
  const gatewayClasses = gatewayConfig?.exposedClasses ?? DEFAULT_EXPOSED_ALLOCATION_CLASSES;
  const gatewayEndpoint = gatewayConfig?.endpoint ?? '/api/mcp/gateway';
  const mcpGateway = createMCPGateway({
    token: gatewayEnabled && mcpGatewayToken ? mcpGatewayToken : undefined,
    exposedClasses: gatewayClasses,
    serverName: 'geneweave-gateway',
    serverVersion: '1.0.0',
    // Phase 3: every gateway invocation flows through the same policy +
    // audit + rate-limit pipeline as in-process chat tools, so external
    // MCP traffic is bound by operator-managed `tool_policies` and lands
    // in `tool_audit_events` with chatId='mcp-gateway' for filtering.
    policyResolver: new DbToolPolicyResolver(db),
    auditEmitter: new DbToolAuditEmitter(db),
    rateLimiter: new DbToolRateLimiter(db),
    // Phase 5: when the gateway is operator-enabled we wire a per-client
    // resolver so external callers can be individually attributed in the
    // audit log and scoped to a subset of allocation classes. Clients
    // that present a token whose hash is not in `mcp_gateway_clients`
    // are rejected with 401 — even if the legacy single-token env var
    // is also set. Both auth paths can coexist: the resolver first
    // attempts to match a registered client; if no client rows exist
    // (resolver returns null) the legacy single-token path is the
    // fallback for backward compatibility.
    ...(gatewayEnabled
      ? {
          clientResolver: async (hash: string) => {
            const row = await db.getMCPGatewayClientByTokenHash(hash);
            if (!row) return null;
            return row;
          },
          touchClient: (id: string) => db.touchMCPGatewayClient(id),
          // A-9: rate bucket keyed on (tenantId, clientId) tuple.
          gatewayRateLimiter: (tenantId: string | null, clientId: string, windowStartIso: string, limit: number) =>
            db.checkAndIncrementGatewayRateLimit(tenantId, clientId, windowStartIso, limit),
          requestLogger: async (entry) => {
            // Phase 8: persist every terminal outcome to mcp_gateway_request_log.
            // Best-effort: errors are swallowed by the gateway hook caller.
            await db.insertMCPGatewayRequestLog({
              id: newUUIDv7(),
              client_id: entry.clientId,
              client_name: entry.clientName,
              method: entry.method,
              tool_name: entry.toolName,
              outcome: entry.outcome,
              status_code: entry.statusCode,
              duration_ms: entry.durationMs,
              error_message: entry.errorMessage,
            });
          },
        }
      : {}),
  });

  // Expose the gateway handle on the router so server.ts HTTP handler can
  // bypass body-parsing and CSRF for the /api/mcp/gateway pass-through.
  (router as unknown as { _mcpGateway?: typeof mcpGateway })._mcpGateway = mcpGateway;

  // Diagnostic info endpoint — auth-required, no secret leakage. Operators
  // can use this to verify which tools the gateway is offering.
  router.get('/api/mcp/gateway/info', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    json(res, 200, {
      enabled: mcpGateway.enabled,
      operatorEnabled: gatewayEnabled,
      exposedClasses: [...gatewayClasses].sort(),
      exposedToolNames: mcpGateway.exposedToolNames,
      endpoint: gatewayEndpoint,
      authScheme: 'Bearer',
    });
  }, { auth: true });

  // ── Avatar static files ────────────────────────────────────

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const avatarDirs = [
    join(__dirname, '..', 'avatar'),
    join(__dirname, '..', 'avatars'),
    join(process.cwd(), 'packages', 'geneweave', 'avatar'),
    join(process.cwd(), 'packages', 'geneweave', 'avatars'),
    join(process.cwd(), 'avatar'),
    join(process.cwd(), 'avatars'),
  ];
}
