// SPDX-License-Identifier: MIT
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from './db.js';
import { canPersonaAccess, normalizePersona } from './rbac.js';
import { authenticateRequest, verifyCSRF, type AuthContext } from './auth.js';
import { OAuthClient, createOAuthProvider, type OAuthProviderName } from '@weaveintel/identity/oauth';
import type { HttpRateLimiter, LoginFailureStore } from './http-rate-limiter.js';

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: AuthContext | null,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  requireAuth: boolean;
  requireCSRF: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:(\w+)/g, (_, key: string) => { keys.push(key); return '([^/]+)'; }) + '$',
    );
    this.routes.push({
      method,
      pattern,
      keys,
      handler,
      requireAuth: opts?.auth ?? false,
      requireCSRF: opts?.csrf ?? false,
    });
  }

  get(path: string, handler: Handler, opts?: { auth?: boolean }): void {
    this.add('GET', path, handler, opts);
  }

  post(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    this.add('POST', path, handler, { auth: opts?.auth, csrf: opts?.csrf ?? true });
  }

  del(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    this.add('DELETE', path, handler, { auth: opts?.auth, csrf: opts?.csrf ?? true });
  }

  put(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    this.add('PUT', path, handler, { auth: opts?.auth, csrf: opts?.csrf ?? true });
  }

  patch(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    this.add('PATCH', path, handler, { auth: opts?.auth, csrf: opts?.csrf ?? true });
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => { params[key] = m[i + 1]!; });
      return { route, params };
    }
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────

export async function readBody(req: IncomingMessage, opts?: { maxBytes?: number }): Promise<string> {
  const release = await acquireBodyReadSlot();
  try {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxFromEnv = Number.parseInt(process.env['GENEWEAVE_MAX_REQUEST_BODY_BYTES'] ?? '', 10);
      const maxBytes = opts?.maxBytes;
      const MAX = Number.isFinite(maxBytes) && maxBytes && maxBytes > 0
        ? maxBytes
        : Number.isFinite(maxFromEnv) && maxFromEnv > 0
          ? maxFromEnv
          : DEFAULT_REQUEST_BODY_BYTES;
      let tooLarge = false;

      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX) {
          tooLarge = true;
          req.resume();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (tooLarge) {
          reject(new Error('Request body too large'));
          return;
        }
        resolve(Buffer.concat(chunks).toString());
      });
      req.on('error', reject);
    });
  } finally {
    release();
  }
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const IS_TEST_ENV = process.env['NODE_ENV'] === 'test';

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const AUTH_WINDOW_MS = envInt('GENEWEAVE_AUTH_RATE_WINDOW_MS', 10 * 60_000);
const REGISTER_IP_LIMIT = envInt('GENEWEAVE_REGISTER_IP_LIMIT', IS_TEST_ENV ? 1_000 : 10);
const REGISTER_EMAIL_LIMIT = envInt('GENEWEAVE_REGISTER_EMAIL_LIMIT', IS_TEST_ENV ? 500 : 5);
const LOGIN_IP_LIMIT = envInt('GENEWEAVE_LOGIN_IP_LIMIT', IS_TEST_ENV ? 2_000 : 10);
const LOGIN_EMAIL_LIMIT = envInt('GENEWEAVE_LOGIN_EMAIL_LIMIT', IS_TEST_ENV ? 1_000 : 10);
const LOGIN_MAX_BACKOFF_MS = envInt('GENEWEAVE_LOGIN_MAX_BACKOFF_MS', IS_TEST_ENV ? 0 : 5 * 60_000);
const EDGE_WINDOW_MS = envInt('GENEWEAVE_EDGE_RATE_WINDOW_MS', 60_000);
const EDGE_IP_LIMIT = envInt('GENEWEAVE_EDGE_IP_LIMIT', IS_TEST_ENV ? 100_000 : 600);
const DEFAULT_REQUEST_BODY_BYTES = envInt('GENEWEAVE_DEFAULT_REQUEST_BODY_BYTES', IS_TEST_ENV ? 20 * 1024 * 1024 : 2 * 1024 * 1024);
const MAX_CONCURRENT_BODY_READS = envInt('GENEWEAVE_MAX_CONCURRENT_BODY_READS', IS_TEST_ENV ? 200 : 24);
const MAX_QUEUED_BODY_READS = envInt('GENEWEAVE_MAX_QUEUED_BODY_READS', IS_TEST_ENV ? 5_000 : 512);
export const LARGE_REQUEST_BODY_BYTES = envInt('GENEWEAVE_LARGE_REQUEST_BODY_BYTES', 50 * 1024 * 1024);
// 60 s for non-streaming REST requests. SSE handlers call socket.setTimeout(0)
// and are protected by context deadlines + heartbeat instead of this timeout.
export const SERVER_REQUEST_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_REQUEST_TIMEOUT_MS', 60_000);
export const SERVER_HEADERS_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_HEADERS_TIMEOUT_MS', 10_000);
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_KEEPALIVE_TIMEOUT_MS', 5_000);
export const SERVER_MAX_HEADERS_COUNT = envInt('GENEWEAVE_SERVER_MAX_HEADERS_COUNT', 100);
export const SERVER_MAX_REQUESTS_PER_SOCKET = envInt('GENEWEAVE_SERVER_MAX_REQUESTS_PER_SOCKET', 100);

// Auth rate limiter — replaced with an injectable HttpRateLimiter at startup.
// Defaults to in-process; swapped to Redis when REDIS_URL is set via
// initHttpRateLimiter() called from server.ts before the first request.
let _httpRateLimiter: HttpRateLimiter | null = null;
let _loginFailureStore: LoginFailureStore | null = null;

export function initHttpRateLimiter(limiter: HttpRateLimiter): void {
  _httpRateLimiter = limiter;
}

export function initLoginFailureStore(store: LoginFailureStore): void {
  _loginFailureStore = store;
}
let activeBodyReads = 0;
const bodyReadWaiters: Array<() => void> = [];

function releaseBodyReadSlot(): void {
  if (activeBodyReads > 0) activeBodyReads -= 1;
  const next = bodyReadWaiters.shift();
  if (next) next();
}

async function acquireBodyReadSlot(): Promise<() => void> {
  if (activeBodyReads < MAX_CONCURRENT_BODY_READS) {
    activeBodyReads += 1;
    return releaseBodyReadSlot;
  }
  if (bodyReadWaiters.length >= MAX_QUEUED_BODY_READS) {
    throw new Error('Too many concurrent request bodies');
  }
  await new Promise<void>((resolve) => {
    bodyReadWaiters.push(resolve);
  });
  activeBodyReads += 1;
  return releaseBodyReadSlot;
}

async function getLoginFailureStore(): Promise<LoginFailureStore> {
  if (_loginFailureStore) return _loginFailureStore;
  // Lazy fallback for tests and early startup requests (before server.ts fires).
  const { createLoginFailureStore } = await import('./http-rate-limiter.js');
  _loginFailureStore = await createLoginFailureStore();
  return _loginFailureStore;
}

function normalizeIpAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '::1') return '127.0.0.1';
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

const _trustedProxyCache: { set: Set<string> | null } = { set: null };

function loadTrustedProxySet(): Set<string> {
  if (_trustedProxyCache.set) return _trustedProxyCache.set;
  const raw = process.env['TRUSTED_PROXY_IPS'] ?? '';
  const values = raw
    .split(',')
    .map((part) => normalizeIpAddress(part))
    .filter(Boolean);
  _trustedProxyCache.set = new Set(values);
  return _trustedProxyCache.set;
}

function isTrustedProxy(ip: string, trusted: Set<string>): boolean {
  if (!ip) return false;
  if (trusted.has(ip)) return true;
  // Local proxy hops are trusted in development for local reverse-proxy setups.
  if (process.env['NODE_ENV'] !== 'production') {
    return ip === '127.0.0.1';
  }
  return false;
}

export function readClientIp(req: IncomingMessage): string {
  const trustedProxies = loadTrustedProxySet();
  const remote = normalizeIpAddress(req.socket.remoteAddress ?? '');
  if (!isTrustedProxy(remote, trustedProxies)) {
    return remote || 'unknown';
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const hops = forwardedFor
      .split(',')
      .map((part) => normalizeIpAddress(part))
      .filter(Boolean);
    // Walk from nearest -> furthest and choose first untrusted hop.
    for (let i = hops.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxy(hops[i]!, trustedProxies)) {
        return hops[i]!;
      }
    }
    return (hops[0] ?? remote) || 'unknown';
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return normalizeIpAddress(realIp) || remote || 'unknown';
  }

  return remote || 'unknown';
}

async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<{ limited: boolean; retryAfterMs: number }> {
  if (_httpRateLimiter) return _httpRateLimiter.check(key, limit, windowMs);
  // Lazy in-process fallback before limiter is initialised (e.g. in tests).
  const { createHttpRateLimiter } = await import('./http-rate-limiter.js');
  _httpRateLimiter = await createHttpRateLimiter();
  return _httpRateLimiter.check(key, limit, windowMs);
}

export async function checkEdgeRateLimit(req: IncomingMessage): Promise<{ limited: boolean; retryAfterMs: number }> {
  const ip = readClientIp(req);
  return checkRateLimit(`edge:ip:${ip}`, EDGE_IP_LIMIT, EDGE_WINDOW_MS);
}

export async function checkAuthRateLimits(kind: 'login' | 'register', req: IncomingMessage, email?: string): Promise<{ limited: boolean; retryAfterMs: number }> {
  const ip = readClientIp(req);
  const ipLimit = kind === 'login' ? LOGIN_IP_LIMIT : REGISTER_IP_LIMIT;
  const emailLimit = kind === 'login' ? LOGIN_EMAIL_LIMIT : REGISTER_EMAIL_LIMIT;

  const ipCheck = await checkRateLimit(`${kind}:ip:${ip}`, ipLimit, AUTH_WINDOW_MS);
  if (ipCheck.limited) return ipCheck;

  if (email) {
    const emailCheck = await checkRateLimit(`${kind}:email:${email.toLowerCase()}`, emailLimit, AUTH_WINDOW_MS);
    if (emailCheck.limited) return emailCheck;
  }

  return { limited: false, retryAfterMs: 0 };
}

export function getFailureKey(ip: string, email: string): string {
  return `${ip}|${email.toLowerCase()}`;
}

export async function getLoginBackoffMs(ip: string, email: string): Promise<number> {
  const store = await getLoginFailureStore();
  const state = await store.get(getFailureKey(ip, email));
  if (!state) return 0;
  return Math.max(0, state.blockedUntil - Date.now());
}

export async function recordLoginFailure(ip: string, email: string): Promise<void> {
  const store = await getLoginFailureStore();
  const key = getFailureKey(ip, email);
  const existing = await store.get(key);
  const failures = (existing?.failures ?? 0) + 1;
  const backoffMs = Math.min(2 ** Math.min(failures, 8) * 1_000, LOGIN_MAX_BACKOFF_MS);
  await store.set(key, { failures, blockedUntil: Date.now() + backoffMs }, AUTH_WINDOW_MS);
}

export async function clearLoginFailures(ip: string, email: string): Promise<void> {
  const store = await getLoginFailureStore();
  await store.delete(getFailureKey(ip, email));
}

export function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function permissionForAdminRoute(path: string, method = 'POST'): string {
  if (path === '/api/admin/upgrade' || path.startsWith('/api/admin/tenants')) {
    return 'admin:platform:write';
  }
  if (path.startsWith('/api/admin/rbac')) {
    // Read-only RBAC operations (listing users/personas) are tenant-admin safe.
    // Mutations (assigning personas, managing roles) require platform-admin write.
    return (method === 'GET' || method === 'HEAD') ? 'admin:tenant:read' : 'admin:platform:write';
  }
  return 'admin:tenant:write';
}

export function ensurePermission(
  auth: AuthContext | null,
  permission: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!auth) {
    return { ok: false, status: 401, error: 'Not authenticated' };
  }
  if (!canPersonaAccess(auth.persona, permission)) {
    return { ok: false, status: 403, error: `Missing permission: ${permission}` };
  }
  return { ok: true };
}

export async function ensureAtLeastOneTenantAdmin(db: DatabaseAdapter, preferredUserId?: string): Promise<void> {
  const users = await db.listUsers();
  if (users.length === 0) return;

  const hasAdmin = users.some((u) => {
    const persona = normalizePersona(u.persona, 'user');
    return persona === 'tenant_admin' || persona === 'platform_admin';
  });
  if (hasAdmin) return;

  const preferred = preferredUserId ? users.find((u) => u.id === preferredUserId) : undefined;
  const fallback = preferred ?? users
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  if (!fallback) return;

  await db.updateUserPersona(fallback.id, 'tenant_admin');
}

/**
 * Default OAuth client (in-memory state store). Phase G: replaced at boot
 * by `setOAuthClient(...)` with a runtime-backed durable state store so
 * pending authorization-code exchanges survive a restart. ESM live
 * binding propagates the swap to all importers (e.g. `routes/auth.ts`).
 */
export let oauthClient = new OAuthClient();

/** Phase G — swap the module-level `oauthClient` in once the runtime is ready. */
export function setOAuthClient(client: OAuthClient): void {
  oauthClient = client;
}

export function normalizePublicOrigin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin;
}

/**
 * M-4: Resolve the request origin from the Host header. Before constructing a
 * redirect URI (used in OAuth callbacks), the Host value is validated against the
 * server's allowed-origins set so a request with a forged `Host: evil.com` header
 * cannot redirect tokens to an attacker-controlled domain.
 *
 * Validation is opt-in: when `allowedOrigins` is absent (the common internal
 * use case — e.g., `postMessage` target) the host is trusted as-is. When the
 * result will be used as an OAuth redirect URI, pass `resolveAllowedOAuthOrigins`
 * as `allowedOrigins` so the Host is checked before it reaches the OAuth provider.
 *
 * @param allowedOrigins - When provided, the resolved origin MUST be in this set.
 *                         Pass `resolveAllowedOAuthOrigins(publicBaseUrl)` here.
 * @throws {Error} When the Host header is missing or (with allowedOrigins) not
 *                 in the allowed set.
 */
export function resolveRequestOrigin(
  req: IncomingMessage,
  allowedOrigins?: Set<string>,
): string {
  const hostHeader = req.headers['host'];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) throw new Error('Missing Host header');
  // Strip any trailing dot (normalisation) and null bytes (header injection guard).
  const cleanHost = host.replace(/\0/g, '').replace(/\.$/, '').trim();
  const protocol = cleanHost.startsWith('localhost') || cleanHost.startsWith('127.0.0.1') || cleanHost.startsWith('[::1]') ? 'http' : 'https';
  const origin = normalizePublicOrigin(`${protocol}://${cleanHost}`);

  if (allowedOrigins && !allowedOrigins.has(origin)) {
    throw new Error(
      `Host header "${cleanHost}" resolves to origin "${origin}" which is not in the allowed origins list. ` +
        `Allowed: ${[...allowedOrigins].join(', ')}`,
    );
  }

  return origin;
}

export function resolveAllowedOAuthOrigins(publicBaseUrl: string): Set<string> {
  const configured = normalizePublicOrigin(publicBaseUrl);
  const extras = (process.env['OAUTH_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalizePublicOrigin(raw));
  return new Set([configured, ...extras]);
}

/** Every OAuth provider the server knows how to talk to, in canonical display order. */
export const OAUTH_PROVIDER_NAMES: readonly OAuthProviderName[] = ['google', 'github', 'microsoft', 'apple', 'facebook'];

/**
 * The OAuth providers that are currently configured (both client id and secret
 * present in the environment). This is the single source of truth the mobile and
 * web clients use to decide which social sign-in buttons to render — only
 * configured providers are returned, in canonical order.
 *
 * Global (env-driven) today; structured so a future per-tenant override can
 * intersect this list with a tenant's enabled set without changing callers.
 */
export function listConfiguredOAuthProviders(env: NodeJS.ProcessEnv = process.env): OAuthProviderName[] {
  return OAUTH_PROVIDER_NAMES.filter((provider) => {
    const upper = provider.toUpperCase();
    return Boolean(env[`OAUTH_${upper}_CLIENT_ID`] && env[`OAUTH_${upper}_CLIENT_SECRET`]);
  });
}

/**
 * M-4: Build an OAuth provider config from the request.
 *
 * The Host header validation is now applied whenever a `publicBaseUrl` is
 * configured (previously only in production). This closes an SSRF / open-redirect
 * gap in staging/dev environments where an attacker with network access could
 * forge the Host header to redirect OAuth tokens to an arbitrary domain.
 *
 * Validation path:
 *  1. `publicBaseUrl` present → validate Host against resolveAllowedOAuthOrigins.
 *  2. `publicBaseUrl` absent  → derive origin from Host (dev convenience only;
 *     blocks if Host is missing, but no allowlist enforced).
 */
export function buildOAuthProviderFromRequest(provider: OAuthProviderName, req: IncomingMessage, publicBaseUrl?: string) {
  const isProduction = process.env['NODE_ENV'] === 'production';
  if (isProduction && !publicBaseUrl) {
    throw new Error('publicBaseUrl must be configured in production for OAuth routes');
  }

  let baseUrl: string;
  if (publicBaseUrl) {
    baseUrl = normalizePublicOrigin(publicBaseUrl);
    // M-4: Validate the Host header against allowed origins in ALL environments
    // (not just production) when publicBaseUrl is configured — a forged Host in
    // staging causes the same open-redirect risk as in production.
    const allowed = resolveAllowedOAuthOrigins(publicBaseUrl);
    const requestOrigin = resolveRequestOrigin(req, allowed);
    // resolveRequestOrigin throws if the Host is not in `allowed`; on success
    // we always use the canonical `baseUrl` (not the request origin) to build
    // the redirect URI so Host header manipulation cannot alter the callback URL.
    void requestOrigin; // validated; use publicBaseUrl-derived baseUrl
  } else {
    baseUrl = resolveRequestOrigin(req);
  }

  const redirectUri = `${baseUrl}/api/oauth/callback`;
  const clientId = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_ID`];
  const clientSecret = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new Error(`${provider} credentials not configured`);
  return createOAuthProvider(provider, clientId, clientSecret, redirectUri);
}
