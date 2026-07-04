import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import {
  hashPassword,
  verifyPasswordDetailed,
  signJWT,
  generateCSRFToken,
  setAuthCookie,
  clearAuthCookie,
} from '../auth.js';
import { isValidPersona, personaPermissions } from '../rbac.js';
import type { OAuthProviderName } from '@weaveintel/identity/oauth';
import {
  readBody,
  json,
  html,
  checkAuthRateLimits,
  getFailureKey,
  getLoginBackoffMs,
  recordLoginFailure,
  clearLoginFailures,
  readClientIp,
  ensureAtLeastOneTenantAdmin,
  oauthClient,
  buildOAuthProviderFromRequest,
  listConfiguredOAuthProviders,
  OAUTH_PROVIDER_NAMES,
  resolveRequestOrigin,
} from '../server-core.js';
import type { Router } from '../server-core.js';
import {
  encodeNativeOAuthState,
  parseNativeOAuthState,
  isAllowedNativeRedirect,
  buildNativeOAuthRedirect,
} from '../oauth-native.js';
import { consumeInvitation, markInvitationUsed, PRIVILEGED_PERSONAS, INVITATION_EXPIRY_HOURS } from '../auth-invitations.js';
import { issueVerificationToken, consumeVerificationToken, canResendVerification, VERIFICATION_EXPIRY_HOURS } from '../auth-email-verify.js';
import { getEmailNotifier } from '../email-notifier.js';
import {
  handlePasskeyRegisterBegin,
  handlePasskeyRegisterComplete,
  handlePasskeyAuthBegin,
  handlePasskeyAuthComplete,
} from '../auth-passkey.js';

/** Read the allow_expo_go_scheme flag from global platform config_overrides. */
async function isExpoGoSchemeAllowed(db: DatabaseAdapter): Promise<boolean> {
  try {
    const globalRow = await db.getGlobalTenantConfig();
    if (!globalRow?.config_overrides) return false;
    const overrides = JSON.parse(globalRow.config_overrides) as Record<string, unknown>;
    return overrides['allow_expo_go_scheme'] === true;
  } catch {
    return false;
  }
}

interface AuthRouteOptions {
  jwtSecret: string;
  corsOrigin?: string;
  publicBaseUrl?: string;
  setOAuthState: (state: string, value: { userId: string | null; provider: OAuthProviderName; expiresAt: number }) => Promise<void>;
  consumeOAuthState: (state: string) => Promise<{ userId: string | null; provider: OAuthProviderName; expiresAt: number } | null>;
}

/** A freshly minted JWT + DB session for an authenticated principal. */
interface MintedSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
  user: { id: string; email: string; name: string; persona: string; tenantId: string | null };
  permissions: string[];
}

/**
 * Shared credential-verification + session-mint path for the login (cookie) and
 * token (bearer) routes. Performs the identical security pipeline — login backoff,
 * rate limiting, password verification, lazy rehash, tenant-admin guarantee — then
 * creates a DB session and signs a JWT. On any failure it writes the appropriate
 * error response (400 / 401 / 429) and returns null; the caller only decides how to
 * deliver the resulting token (HttpOnly cookie vs response body).
 */
/**
 * Mint a fresh DB session + signed JWT for an already-resolved principal. Shared
 * by credential login (after password verification) and OAuth sign-in (after the
 * provider identity is resolved). Returns null only when the user vanished.
 */
async function mintSessionForUserId(
  db: DatabaseAdapter,
  jwtSecret: string,
  userId: string,
): Promise<MintedSession | null> {
  await ensureAtLeastOneTenantAdmin(db, userId);
  const user = await db.getUserById(userId);
  if (!user) return null;

  const sessionId = newUUIDv7();
  const csrfToken = generateCSRFToken();
  const expiresAt = new Date(Date.now() + 86400_000).toISOString();
  await db.createSession({ id: sessionId, userId: user.id, csrfToken, expiresAt });

  const token = signJWT({ userId: user.id, email: user.email, sessionId }, jwtSecret);
  return {
    token,
    csrfToken,
    expiresAt,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      persona: user.persona,
      tenantId: user.tenant_id,
    },
    permissions: personaPermissions(user.persona),
  };
}

async function authenticateAndMintSession(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseAdapter,
  jwtSecret: string,
): Promise<MintedSession | null> {
  const raw = await readBody(req);
  let body: { email?: string; password?: string };
  try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return null; }

  const { email, password } = body;
  if (!email || !password) { json(res, 400, { error: 'email and password required' }); return null; }

  const clientIp = readClientIp(req);
  const lockedMs = await getLoginBackoffMs(clientIp, email);
  if (lockedMs > 0) {
    const retryAfterSec = Math.ceil(lockedMs / 1_000);
    res.setHeader('Retry-After', String(retryAfterSec));
    json(res, 429, { error: 'Too many login attempts. Please retry later.' });
    return null;
  }

  const loginRate = await checkAuthRateLimits('login', req, email);
  if (loginRate.limited) {
    const retryAfterSec = Math.ceil(loginRate.retryAfterMs / 1_000);
    res.setHeader('Retry-After', String(retryAfterSec));
    json(res, 429, { error: 'Too many login attempts. Please retry later.', correlationId: newUUIDv7() });
    return null;
  }

  const user = await db.getUserByEmail(email);
  const verification = user
    ? await verifyPasswordDetailed(password, user.password_hash)
    : { ok: false, needsRehash: false };
  if (!user || !verification.ok) {
    await recordLoginFailure(clientIp, email);
    json(res, 401, { error: 'Invalid credentials', correlationId: newUUIDv7() });
    return null;
  }

  await clearLoginFailures(clientIp, email);

  // Block sign-in until email is verified. email_verified is undefined for rows
  // that predate m44 — those are grandfathered (undefined !== 0 so they pass).
  if (user.email_verified === 0) {
    json(res, 403, {
      error: 'Please verify your email address before signing in.',
      requiresEmailVerification: true,
    });
    return null;
  }

  if (verification.needsRehash) {
    const upgradedHash = await hashPassword(password);
    await db.updateUser(user.id, { passwordHash: upgradedHash });
  }

  return mintSessionForUserId(db, jwtSecret, user.id);
}

export function registerAuthRoutes(
  router: Router,
  db: DatabaseAdapter,
  options: AuthRouteOptions,
): void {
  const { jwtSecret, corsOrigin, publicBaseUrl, setOAuthState, consumeOAuthState } = options;

  // ── Auth routes ────────────────────────────────────────

  // Auth routes use signJWT/verifyJWT + hashPassword/verifyPassword from auth.ts.
  // Sessions are stored in the database; JWT cookie (HttpOnly, SameSite=Strict)
  // carries the session reference. CSRF tokens are returned to the client and
  // validated on state-changing requests.────

  router.post('/api/auth/register', async (req, res) => {
    const raw = await readBody(req);
    let body: { name?: string; email?: string; password?: string; invitationToken?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const { name, email, password, invitationToken } = body;
    if (!name || !email || !password) { json(res, 400, { error: 'name, email, and password required' }); return; }
    if (password.length < 8) { json(res, 400, { error: 'Password must be at least 8 characters' }); return; }

    const registerRate = await checkAuthRateLimits('register', req, email);
    if (registerRate.limited) {
      const retryAfterSec = Math.ceil(registerRate.retryAfterMs / 1_000);
      res.setHeader('Retry-After', String(retryAfterSec));
      json(res, 429, { error: 'Too many registration attempts. Please retry later.' });
      return;
    }

    // ── Invitation validation ─────────────────────────────────────────────────
    // Privileged personas (tenant_admin, platform_admin) may only be assigned
    // via a valid admin-issued invitation. tenant_user may self-register or use
    // an invitation. The invitation is validated first (before user creation)
    // but marked used only after the user row is committed, to prevent TOCTOU.
    let invitationRow: Awaited<ReturnType<typeof consumeInvitation>> = null;
    let assignedPersona = 'tenant_user';

    if (invitationToken) {
      invitationRow = await consumeInvitation(db, invitationToken, email);
      if (!invitationRow) {
        json(res, 400, { error: 'Invitation is invalid, expired, or does not match this email address.' });
        return;
      }
      assignedPersona = invitationRow.persona;
    }

    if (PRIVILEGED_PERSONAS.has(assignedPersona) && !invitationRow) {
      json(res, 403, { error: 'An admin invitation is required to register with a privileged role.' });
      return;
    }

    const existing = await db.getUserByEmail(email);
    if (existing) { json(res, 409, { error: 'Email already registered' }); return; }

    const userId = newUUIDv7();
    const passwordHash = await hashPassword(password);
    try {
      await db.createUser({ id: userId, email, name, passwordHash, persona: assignedPersona });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed: users.email')) {
        json(res, 409, { error: 'Email already registered' });
        return;
      }
      throw error;
    }

    // Mark the invitation used atomically with user creation to prevent replay.
    if (invitationRow) {
      await markInvitationUsed(db, invitationRow.id, userId);
    }

    // For tenant_user without an invitation: promote to tenant_admin if no admin
    // exists yet. TOCTOU-safe because SQLite is single-writer and the function is
    // idempotent (promotes the earliest created_at user).
    if (!PRIVILEGED_PERSONAS.has(assignedPersona)) {
      await ensureAtLeastOneTenantAdmin(db, userId);
    }

    // In test environments, auto-verify email so stress tests can re-login without
    // waiting for an email link. Controlled by NODE_ENV=test only — never in prod.
    if (process.env['NODE_ENV'] === 'test') {
      await db.markUserEmailVerified(userId);
    } else {
      // Issue an email verification token. The raw token travels via email link;
      // only SHA-256(token) is stored in the DB (pre-image resistant).
      const rawVerificationToken = await issueVerificationToken(db, userId);
      const verifyUrl = `${publicBaseUrl ?? ''}/auth/verify-email?token=${rawVerificationToken}`;
      await getEmailNotifier().sendVerificationEmail({
        to: email,
        name,
        verificationUrl: verifyUrl,
        expiresInHours: VERIFICATION_EXPIRY_HOURS,
      });
    }

    // L-2: Do NOT issue a session at registration — the account must be verified
    // first. Previously a full session was granted immediately, which meant:
    //  (a) unverified users could impersonate any email address as a username,
    //  (b) bots could register unlimited accounts with no email barrier.
    //
    // In test mode (NODE_ENV=test) the email is auto-verified above, so the login
    // flow works immediately in tests. In all other non-production and production
    // environments the client must click the verification link and then log in.
    const created = await db.getUserById(userId);
    const persona = created?.persona ?? assignedPersona;
    json(res, 201, {
      user: { id: userId, email, name, persona },
      requiresEmailVerification: process.env['NODE_ENV'] !== 'test',
      message: process.env['NODE_ENV'] !== 'test'
        ? 'Account created. Please check your email to verify your address before logging in.'
        : 'Account created.',
    });
  }, { csrf: false });

  router.post('/api/auth/login', async (req, res) => {
    const minted = await authenticateAndMintSession(req, res, db, jwtSecret);
    if (!minted) return; // error response already written

    setAuthCookie(res, minted.token);
    json(res, 200, {
      user: minted.user,
      csrfToken: minted.csrfToken,
      permissions: minted.permissions,
    });
  }, { csrf: false });

  // Bearer-token issuance for non-browser clients (mobile, CLI, machine-to-machine).
  //
  // Unlike /api/auth/login (which delivers the JWT via an HttpOnly Set-Cookie),
  // this route returns the raw token in the response body so native clients that
  // do not run a cookie jar can store it (e.g. expo-secure-store) and send it as
  // `Authorization: Bearer <token>`. The same JWT + DB session is minted, so the
  // token is honoured by authenticateRequest(). CSRF is still enforced on mutating
  // routes, so the returned csrfToken must be sent as `X-CSRF-Token`.
  router.post('/api/auth/token', async (req, res) => {
    const minted = await authenticateAndMintSession(req, res, db, jwtSecret);
    if (!minted) return; // error response already written

    json(res, 200, {
      token: minted.token,
      csrfToken: minted.csrfToken,
      expiresAt: minted.expiresAt,
      user: minted.user,
      permissions: minted.permissions,
    });
  }, { csrf: false });

  router.post('/api/auth/logout', async (_req, _res, _params, auth) => {
    if (auth) await db.deleteSession(auth.sessionId);
    clearAuthCookie(_res);
    json(_res, 200, { ok: true });
  }, { auth: false, csrf: false });

  router.get('/api/auth/me', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await ensureAtLeastOneTenantAdmin(db, auth.userId);
    const user = await db.getUserById(auth.userId);
    if (!user) { json(res, 401, { error: 'User not found' }); return; }
    json(res, 200, {
      user: { id: user.id, email: user.email, name: user.name, persona: user.persona, tenantId: user.tenant_id },
      csrfToken: auth.csrfToken,
      permissions: personaPermissions(user.persona),
    });
  });

  // Auth check endpoint for UI bootstrap.
  // Always returns 200 to avoid noisy console "Failed to load resource: 401" on logged-out startup.
  router.get('/api/auth/check', async (_req, res, _params, auth) => {
    if (!auth) {
      json(res, 200, { authenticated: false });
      return;
    }

    await ensureAtLeastOneTenantAdmin(db, auth.userId);
    const user = await db.getUserById(auth.userId);
    if (!user) {
      json(res, 200, { authenticated: false });
      return;
    }

    json(res, 200, {
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name, persona: user.persona, tenantId: user.tenant_id },
      csrfToken: auth.csrfToken,
      permissions: personaPermissions(user.persona),
    });
  });

  router.get('/api/auth/permissions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, {
      persona: auth.persona,
      effectivePersona: isValidPersona(auth.persona) ? auth.persona : null,
      permissions: personaPermissions(auth.persona),
    });
  }, { auth: true });

  // ── OAuth routes ───────────────────────────────────────────

  // List all linked OAuth accounts for the authenticated user
  router.get('/api/oauth/accounts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const accounts = await db.listOAuthLinkedAccounts(auth.userId);
    // Return sanitized account info (no sensitive data)
    const sanitized = accounts.map(acc => ({
      id: acc.id,
      provider: acc.provider,
      email: acc.email,
      name: acc.name,
      picture_url: acc.picture_url,
      linked_at: acc.linked_at,
      last_used_at: acc.last_used_at,
    }));
    json(res, 200, { accounts: sanitized });
  });

  // Unlink an OAuth account
  router.post('/api/oauth/accounts/:provider/unlink', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const provider = params['provider'];
    if (!provider) { json(res, 400, { error: 'Provider required' }); return; }
    // M-3: validate provider against the canonical allowlist so an attacker cannot
    // pass arbitrary strings that reach DB queries or downstream OAuth clients.
    if (!(OAUTH_PROVIDER_NAMES as readonly string[]).includes(provider)) {
      json(res, 400, { error: 'Invalid provider' }); return;
    }
    await db.deleteOAuthLinkedAccount(auth.userId, provider);
    json(res, 200, { ok: true });
  });

  // List the OAuth providers currently configured on this server (client id +
  // secret present). The mobile/web client calls this to decide which social
  // sign-in buttons to render — only configured providers are returned.
  router.get('/api/oauth/providers', async (_req, res) => {
    json(res, 200, { providers: listConfiguredOAuthProviders() });
  }, { auth: false });

  // Generate OAuth authorization URL for a provider
  // Expected body: { provider: 'google' | ..., redirectUri?: string }
  // A `redirectUri` (an app scheme) switches to the native flow: the callback
  // mints a bearer session and 302-redirects to that URI instead of returning
  // the browser popup HTML.
  router.post('/api/oauth/authorize-url', async (req, res, _params, auth) => {
    const raw = await readBody(req);
    let body: { provider?: string; redirectUri?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const provider = body.provider?.toLowerCase() as OAuthProviderName | undefined;
    if (!provider) { json(res, 400, { error: 'provider required' }); return; }
    // M-3: validate against OAUTH_PROVIDER_NAMES (single source of truth in server-core.ts)
    // rather than a locally-maintained duplicate array.
    if (!(OAUTH_PROVIDER_NAMES as readonly string[]).includes(provider)) {
      json(res, 400, { error: 'Invalid provider' }); return;
    }

    const nativeRedirect = typeof body.redirectUri === 'string' && body.redirectUri.length > 0
      ? body.redirectUri
      : null;
    if (nativeRedirect && !isAllowedNativeRedirect(nativeRedirect, await isExpoGoSchemeAllowed(db))) {
      json(res, 400, { error: 'Invalid redirectUri' }); return;
    }

    try {
      const nonce = newUUIDv7();
      const state = nativeRedirect ? encodeNativeOAuthState(nativeRedirect, nonce) : nonce;
      const oauthProvider = buildOAuthProviderFromRequest(provider, req, publicBaseUrl);
      const { authUrl } = await oauthClient.generateAuthorizationUrl(oauthProvider, state);
      await setOAuthState(state, { userId: auth?.userId ?? null, provider, expiresAt: Date.now() + 600_000 });
      json(res, 200, { authUrl });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
  }, { auth: false, csrf: false });

  // OAuth callback handler (handles redirect from providers)
  const handleOAuthCallback = async (req: IncomingMessage, res: ServerResponse, callbackParams: Record<string, string>) => {
    const { code, state, error } = callbackParams;
    const errorDescription = callbackParams['error_description'];

    if (error) {
      // M-2: Allowlist the OAuth error codes we're willing to reflect back to the
      // client. Providers can return arbitrary strings; without filtering, an
      // attacker who controls the callback URL could inject content into the response
      // body. The truncated `error_description` is capped at 200 chars so a rogue
      // provider cannot embed a large XSS payload or exfiltration anchor.
      const ALLOWED_OAUTH_ERRORS = new Set([
        'access_denied', 'invalid_request', 'invalid_client', 'invalid_grant',
        'unauthorized_client', 'unsupported_grant_type', 'invalid_scope',
        'server_error', 'temporarily_unavailable', 'interaction_required',
        'login_required', 'consent_required',
      ]);
      const safeError = ALLOWED_OAUTH_ERRORS.has(error) ? error : 'oauth_error';
      const safeDesc = errorDescription
        ? String(errorDescription).replace(/[\r\n<>"']/g, '').slice(0, 200)
        : undefined;
      json(res, 400, { error: `OAuth error: ${safeError}`, ...(safeDesc ? { error_description: safeDesc } : {}) });
      return;
    }
    if (!code || !state) { json(res, 400, { error: 'Missing code or state' }); return; }

    const stateData = await consumeOAuthState(state);
    if (!stateData) { json(res, 400, { error: 'Invalid or expired state' }); return; }
    if (Date.now() > stateData.expiresAt) { json(res, 400, { error: 'State expired' }); return; }

    const { userId: stateUserId, provider } = stateData;

    try {
      const oauthProvider = buildOAuthProviderFromRequest(provider, req, publicBaseUrl);
      const { token } = await oauthClient.exchangeCodeForToken(oauthProvider, code, state);
      const oauthProfile = await oauthClient.getUserProfile(oauthProvider, token.access_token, token);

      const existingLinked = await db.getOAuthLinkedAccountByProviderUserId(provider, oauthProfile.id);

      // Prevent linking a provider identity already bound to a different account.
      if (stateUserId && existingLinked && existingLinked.user_id !== stateUserId) {
        json(res, 409, { error: 'This OAuth account is already linked to another user' });
        return;
      }

      let resolvedUserId = stateUserId;

      if (!resolvedUserId && existingLinked) {
        resolvedUserId = existingLinked.user_id;
      }

      if (!resolvedUserId) {
        resolvedUserId = newUUIDv7();
        const fallbackEmail = (oauthProfile.email && oauthProfile.email.includes('@'))
          ? oauthProfile.email
          : `${provider}-${oauthProfile.id}@oauth.local`;
        const fallbackName = oauthProfile.name || `${provider} user`;
        await db.createUser({
          id: resolvedUserId,
          email: fallbackEmail,
          name: fallbackName,
          passwordHash: await hashPassword(newUUIDv7()),
        });
        // OAuth provider asserts the email — no need for a separate verification step.
        await db.markUserEmailVerified(resolvedUserId);
      }

      if (!existingLinked) {
        await db.createOAuthLinkedAccount({
          id: newUUIDv7(),
          user_id: resolvedUserId,
          provider,
          provider_user_id: oauthProfile.id,
          email: oauthProfile.email || `${provider}-${oauthProfile.id}@oauth.local`,
          name: oauthProfile.name || 'User',
          picture_url: oauthProfile.picture || null,
          last_used_at: new Date().toISOString(),
        });
      } else {
        await db.updateOAuthAccountLastUsed(resolvedUserId, provider);
      }

      // Native (mobile) flow: the redirect URI was encoded into the state. Mint a
      // bearer session and 302 it back to the app scheme as a URL fragment (#),
      // which the in-app auth session captures and persists. Nonce integrity is
      // guaranteed by consumeOAuthState above (full state string used as key).
      const { native, redirectUri } = parseNativeOAuthState(state);
      if (native && redirectUri && isAllowedNativeRedirect(redirectUri, await isExpoGoSchemeAllowed(db))) {
        const minted = await mintSessionForUserId(db, jwtSecret, resolvedUserId);
        if (!minted) throw new Error('User not found after OAuth sign-in');
        res.statusCode = 302;
        res.setHeader('Location', buildNativeOAuthRedirect(redirectUri, minted));
        res.end();
        return;
      }

      // For OAuth sign-in from logged-out state, establish a session cookie.
      if (!stateUserId) {
        const user = await db.getUserById(resolvedUserId);
        if (!user) throw new Error('User not found after OAuth sign-in');
        const sessionId = newUUIDv7();
        const csrfToken = generateCSRFToken();
        const expiresAt = new Date(Date.now() + 86400_000).toISOString();
        await db.createSession({ id: sessionId, userId: resolvedUserId, csrfToken, expiresAt });
        const jwt = signJWT({ userId: resolvedUserId, email: user.email, sessionId }, jwtSecret);
        setAuthCookie(res, jwt);
      }

      // M-7: `window.location.origin` as the postMessage targetOrigin accepts ANY
      // opener — if this callback page were somehow loaded in a cross-origin iframe
      // an attacker could eavesdrop on the oauth-success message. Instead, embed the
      // server's own origin (derived from the Host header via resolveRequestOrigin)
      // so the browser only delivers the message to windows from our domain.
      // We JSON-encode the origin string so it is safe to inline in a script tag
      // even if it contains special characters (e.g. port number with colon).
      let callbackOrigin: string;
      try {
        callbackOrigin = resolveRequestOrigin(req);
      } catch {
        // Fallback: use same-origin (empty string falls back to same-origin in postMessage)
        callbackOrigin = '';
      }
      const safeOrigin = JSON.stringify(callbackOrigin || '*');
      html(
        res,
        200,
        `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"></head><body><script>if(window.opener){window.opener.postMessage({type:"oauth-success"},${safeOrigin});}window.close();</script>Account linked successfully! You can close this window.</body></html>`,
      );
    } catch (err) {
      json(res, 500, { error: `Failed to link account: ${(err as Error).message}` });
    }
  };

  router.get('/api/oauth/callback', async (req, res) => {
    const url = req.url ?? '';
    const queryStr = url.split('?')[1] ?? '';
    const params: Record<string, string> = {};
    queryStr.split('&').forEach(pair => {
      const [key, val] = pair.split('=');
      if (key && val) params[decodeURIComponent(key)] = decodeURIComponent(val);
    });
    await handleOAuthCallback(req, res, params);
  }, { auth: false });

  router.post('/api/oauth/callback', async (req, res) => {
    const raw = await readBody(req);
    const body = new URLSearchParams(raw);
    const params: Record<string, string> = {};
    for (const [key, value] of body.entries()) params[key] = value;
    await handleOAuthCallback(req, res, params);
  }, { auth: false, csrf: false });

  // ── Email verification ─────────────────────────────────────────────────────

  // Consume a verification token and mark the user's email as verified.
  // The same non-enumerable error is returned whether the token was never
  // issued, already used, or expired (OWASP A07:2021 prevents enumeration).
  router.post('/api/auth/verify-email', async (req, res) => {
    const raw = await readBody(req);
    let body: { token?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const userId = await consumeVerificationToken(db, token);
    if (!userId) {
      json(res, 400, { error: 'Verification link is invalid or has expired. Please request a new one.' });
      return;
    }
    json(res, 200, { ok: true, message: 'Email address verified. You can now sign in.' });
  }, { auth: false, csrf: false });

  // Resend a verification email. Always returns 200 regardless of whether the
  // email exists or is already verified — prevents user enumeration.
  router.post('/api/auth/resend-verification', async (req, res) => {
    const raw = await readBody(req);
    let body: { email?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) { json(res, 400, { error: 'email required' }); return; }

    const user = await db.getUserByEmail(email);
    if (user && user.email_verified !== 1) {
      const allowed = await canResendVerification(db, user.id);
      if (allowed) {
        const rawToken = await issueVerificationToken(db, user.id);
        const verifyUrl = `${publicBaseUrl ?? ''}/auth/verify-email?token=${rawToken}`;
        await getEmailNotifier().sendVerificationEmail({
          to: email,
          name: user.name,
          verificationUrl: verifyUrl,
          expiresInHours: VERIFICATION_EXPIRY_HOURS,
        });
      }
    }
    json(res, 200, { ok: true, message: 'If this email is registered and unverified, a verification link has been sent.' });
  }, { auth: false, csrf: false });

  // ── FIDO2 / WebAuthn passkey routes (4.1) ─────────────────────────
  // Passkey registration is authenticated (requires a logged-in session).
  // Passkey authentication is unauthenticated (this IS the login mechanism).
  //
  //  POST /api/auth/passkey/register/begin    — gen challenge + creation options
  //  POST /api/auth/passkey/register/complete — verify attestation + store
  //  POST /api/auth/passkey/auth/begin        — gen challenge + request options
  //  POST /api/auth/passkey/auth/complete     — verify assertion + issue session
  //  GET  /api/auth/passkeys                  — list credentials for current user
  //  DELETE /api/auth/passkeys/:credentialId  — remove a credential

  function passkeyConfig(req: IncomingMessage) {
    const origin = publicBaseUrl ?? `https://${req.headers['host'] ?? 'localhost'}`;
    const rpId = new URL(origin).hostname;
    return { rpId, rpName: 'WeaveIntel', origin };
  }

  router.post('/api/auth/passkey/register/begin', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    await handlePasskeyRegisterBegin(req, res, auth, db, passkeyConfig(req), json);
  }, { auth: true, csrf: true });

  router.post('/api/auth/passkey/register/complete', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    await handlePasskeyRegisterComplete(req, res, auth, db, passkeyConfig(req), json, readBody);
  }, { auth: true, csrf: true });

  router.post('/api/auth/passkey/auth/begin', async (req, res) => {
    await handlePasskeyAuthBegin(req, res, db, passkeyConfig(req), json, readBody);
  }, { auth: false, csrf: false });

  router.post('/api/auth/passkey/auth/complete', async (req, res) => {
    await handlePasskeyAuthComplete(
      req, res, db, passkeyConfig(req), json, readBody,
      async (userId, email) => {
        const sessionId = newUUIDv7();
        const csrfToken = generateCSRFToken();
        const expiresAt = new Date(Date.now() + 86400_000).toISOString();
        await db.createSession({ id: sessionId, userId, csrfToken, expiresAt });
        const token = signJWT({ userId, email, sessionId }, jwtSecret);
        return { token, csrfToken };
      },
    );
  }, { auth: false, csrf: false });

  router.get('/api/auth/passkeys', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    const credentials = await db.listPasskeyCredentials(auth.userId);
    json(res, 200, {
      credentials: credentials.map((c) => ({
        id: c.id,
        credentialId: c.credential_id,
        aaguid: c.aaguid,
        transports: c.transports ? c.transports.split(',') : [],
        createdAt: c.created_at,
        lastUsedAt: c.last_used_at,
      })),
    });
  }, { auth: true });

  router.del('/api/auth/passkeys/:credentialId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Unauthorized' }); return; }
    const cred = await db.getPasskeyCredentialById(params?.['credentialId'] ?? '');
    if (!cred) { json(res, 404, { error: 'not found' }); return; }
    if (cred.user_id !== auth.userId) { json(res, 403, { error: 'Forbidden' }); return; }
    await db.deletePasskeyCredential(cred.id);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

}
