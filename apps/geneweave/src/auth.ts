// SPDX-License-Identifier: MIT
/**
 * @weaveintel/geneweave — Authentication module
 *
 * JWT (HMAC-SHA256 via node:crypto), scrypt password hashing, CSRF tokens,
 * cookie-based session management. Zero external dependencies.
 */

import { createHmac, scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter, SessionRow } from './db.js';

// ─── JWT ─────────────────────────────────────────────────────

// Hand-rolled JWT implementation using HMAC-SHA256 via node:crypto.
// Avoids external dependencies (no jsonwebtoken). The signJWT/verifyJWT
// pair produces/validates base64url-encoded tokens with iat/exp claims.

export interface JWTPayload {
  userId: string;
  email: string;
  sessionId: string;
  iat: number;
  exp: number;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

export function signJWT(payload: Omit<JWTPayload, 'iat' | 'exp'>, secret: string, expiresInSeconds = 86400): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const full: JWTPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(full));
  const signature = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}

export function verifyJWT(token: string, secret: string): JWTPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return null;

  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as { alg?: string; typ?: string };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  } catch {
    return null;
  }

  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (signatureB64.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(signatureB64), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as JWTPayload;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Password hashing (scrypt) ───────────────────────────────

// Uses async scrypt (memory-hard KDF) with random salt for password storage.
// Current format: scrypt$v2$N$r$p$salt$hash (hex).
// Legacy format: salt:hash (from earlier implementation).

const PASSWORD_KEY_LEN = 64;
const PASSWORD_HASH_PREFIX = 'scrypt$v2$';
const PASSWORD_HASH_R = 8;
const PASSWORD_HASH_P = 1;
const PASSWORD_HASH_MAXMEM = 256 * 1024 * 1024;
const DEFAULT_PASSWORD_HASH_N = process.env['NODE_ENV'] === 'test' ? 2 ** 14 : 2 ** 17;

function resolvePasswordHashN(): number {
  const fromEnv = Number.parseInt(process.env['GENEWEAVE_SCRYPT_N'] ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_PASSWORD_HASH_N;
}

interface ParsedPasswordHash {
  salt: string;
  hash: Buffer;
  n: number;
  r: number;
  p: number;
  isLegacy: boolean;
}

function parseStoredPasswordHash(stored: string): ParsedPasswordHash | null {
  if (stored.startsWith(PASSWORD_HASH_PREFIX)) {
    const [kdf, version, nRaw, rRaw, pRaw, salt, hashHex] = stored.split('$');
    if (kdf !== 'scrypt' || version !== 'v2' || !nRaw || !rRaw || !pRaw || !salt || !hashHex) return null;
    const n = Number.parseInt(nRaw, 10);
    const r = Number.parseInt(rRaw, 10);
    const p = Number.parseInt(pRaw, 10);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(r) || r <= 0 || !Number.isFinite(p) || p <= 0) return null;
    try {
      return {
        salt,
        hash: Buffer.from(hashHex, 'hex'),
        n,
        r,
        p,
        isLegacy: false,
      };
    } catch {
      return null;
    }
  }

  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return null;
  try {
    return {
      salt,
      hash: Buffer.from(hashHex, 'hex'),
      n: 16_384,
      r: 8,
      p: 1,
      isLegacy: true,
    };
  } catch {
    return null;
  }
}

async function derivePasswordKey(password: string, salt: string, n: number, r: number, p: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, PASSWORD_KEY_LEN, {
      N: n,
      r,
      p,
      maxmem: PASSWORD_HASH_MAXMEM,
    }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(Buffer.from(derivedKey));
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32).toString('hex');
  const n = resolvePasswordHashN();
  const hash = await derivePasswordKey(password, salt, n, PASSWORD_HASH_R, PASSWORD_HASH_P);
  return `scrypt$v2$${n}$${PASSWORD_HASH_R}$${PASSWORD_HASH_P}$${salt}$${hash.toString('hex')}`;
}

export interface PasswordVerificationResult {
  ok: boolean;
  needsRehash: boolean;
}

export async function verifyPasswordDetailed(password: string, stored: string): Promise<PasswordVerificationResult> {
  const parsed = parseStoredPasswordHash(stored);
  if (!parsed || parsed.hash.length === 0) {
    return { ok: false, needsRehash: false };
  }

  const derived = await derivePasswordKey(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  if (derived.length !== parsed.hash.length) {
    return { ok: false, needsRehash: false };
  }
  const ok = timingSafeEqual(parsed.hash, derived);
  if (!ok) return { ok: false, needsRehash: false };

  const currentN = resolvePasswordHashN();
  const needsRehash = parsed.isLegacy || parsed.n !== currentN || parsed.r !== PASSWORD_HASH_R || parsed.p !== PASSWORD_HASH_P;
  return { ok: true, needsRehash };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const result = await verifyPasswordDetailed(password, stored);
  return result.ok;
}

// ─── CSRF ────────────────────────────────────────────────────

export function generateCSRFToken(): string {
  return randomBytes(32).toString('hex');
}

// ─── Cookie helpers ──────────────────────────────────────────

/**
 * L-1: In production we use the `__Host-` prefix which browsers enforce at
 * the protocol level:
 *  - MUST be transmitted over HTTPS (Secure flag mandatory).
 *  - MUST have Path=/ (full-site binding — no path narrowing).
 *  - MUST NOT carry a Domain attribute (prevents subdomain forging).
 *
 * In non-production (localhost / HTTP dev server) the prefix is dropped and
 * Secure is omitted so the cookie travels over plain HTTP without breaking
 * local development. parseCookies / getAuthCookieValue reads both names
 * transparently, so dev ↔ prod deployments work without client changes.
 */
const AUTH_COOKIE_PROD = '__Host-gw_token';
const AUTH_COOKIE_DEV = 'gw_token';

/** Return the canonical cookie name for the current runtime environment. */
export function authCookieName(): string {
  return process.env['NODE_ENV'] === 'production' ? AUTH_COOKIE_PROD : AUTH_COOKIE_DEV;
}

export function setAuthCookie(res: ServerResponse, token: string, maxAge = 86400): void {
  const isProduction = process.env['NODE_ENV'] === 'production';
  // __Host- prefix requires Secure; never emit Domain (the prefix forbids it).
  const name = isProduction ? AUTH_COOKIE_PROD : AUTH_COOKIE_DEV;
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

export function clearAuthCookie(res: ServerResponse): void {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const name = isProduction ? AUTH_COOKIE_PROD : AUTH_COOKIE_DEV;
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

// ─── Auth context ───────────────────────────────────────────

// authenticateRequest() is the auth middleware used by the Router.
// It reads the gw_token HttpOnly cookie, verifies the JWT signature,
// checks expiry, and validates the session ID against the database.
// Returns an AuthContext (userId, email, sessionId, csrfToken) or null.─

export interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
  csrfToken: string;
  persona: string;
  tenantId: string | null;
  /** 4.17: ISO timestamp of the last step-up MFA challenge. Null = not yet verified.
   *  Optional for backwards compatibility with existing code that constructs AuthContext directly. */
  mfaVerifiedAt?: string | null;
}

export interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthContext;
}

/**
 * Authenticate an incoming request by verifying the JWT cookie and
 * looking up the session in the database.
 * Returns the AuthContext on success, null on failure.
 */
export async function authenticateRequest(
  req: IncomingMessage,
  db: DatabaseAdapter,
  jwtSecret: string,
): Promise<AuthContext | null> {
  const cookies = parseCookies(req);
  // Accept cookie-based JWT (browser) or Bearer token (A2A / machine-to-machine).
  const bearerHeader = req.headers['authorization'] ?? '';
  const bearerToken = bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7).trim() : undefined;
  // L-1: Read both the __Host-prefixed name (production HTTPS) and the plain
  // name (development HTTP) so that the same code works in all environments.
  const token = cookies[AUTH_COOKIE_PROD] ?? cookies[AUTH_COOKIE_DEV] ?? bearerToken;
  if (!token) return null;

  const payload = verifyJWT(token, jwtSecret);
  if (!payload) return null;

  const session = await db.getSession(payload.sessionId);
  if (!session) return null;
  if (session.user_id !== payload.userId) return null;
  const user = await db.getUserById(payload.userId);
  if (!user) return null;

  return {
    userId: payload.userId,
    email: payload.email,
    sessionId: payload.sessionId,
    csrfToken: session.csrf_token,
    persona: user.persona,
    tenantId: user.tenant_id,
    mfaVerifiedAt: session.mfa_verified_at ?? null,
  };
}

/**
 * CSRF check for mutating requests (POST, PUT, DELETE, PATCH).
 * Compares the X-CSRF-Token header against the session's stored token.
 */
export function verifyCSRF(req: IncomingMessage, auth: AuthContext): boolean {
  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken || typeof headerToken !== 'string') return false;
  if (headerToken.length !== auth.csrfToken.length) return false;
  return timingSafeEqual(Buffer.from(headerToken), Buffer.from(auth.csrfToken));
}
