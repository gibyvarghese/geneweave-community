/**
 * Step-up MFA for admin routes (4.17)
 *
 * Provides TOTP-based step-up MFA for users with elevated personas. Admin
 * POST/PUT/DELETE operations require an MFA challenge completed within the
 * last STEP_UP_MFA_TTL_MS (15 minutes) to be stamped on the current session.
 *
 * Architecture:
 *  - TOTP secrets are stored per-user in `users.mfa_totp_secret` (base32).
 *    When VAULT_KEY is set, the secret is vault-encrypted at rest.
 *  - `sessions.mfa_verified_at` records the ISO timestamp of the last
 *    successful MFA challenge for a session. It expires after
 *    STEP_UP_MFA_TTL_MS — the user must re-verify to continue.
 *  - The gate (`requireStepUpMfa`) is applied to POST/PUT/DELETE in the
 *    admin router. Read-only GET routes are not gated.
 *
 * TOTP complies with RFC 6238 (HMAC-SHA1, 30-second intervals, 6 digits).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseAdapter } from './db.js';
import type { AuthContext } from './auth.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { encryptCredential, decryptCredential } from './vault.js';

// Step-up MFA challenge window: 15 minutes. After this, the user must
// complete another TOTP challenge before writing to admin routes.
export const STEP_UP_MFA_TTL_MS = 15 * 60 * 1_000;

// TOTP window: accept ±1 step (±30s) to tolerate clock skew.
const TOTP_WINDOW = 1;

/* ─── Base32 helpers (RFC 4648) ─────────────────────────────────────── */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode raw bytes as an unpadded base32 string. */
export function base32Encode(buf: Buffer): string {
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

/** Decode a base32 string → raw bytes. Ignores padding and whitespace. */
export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[=\s]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ─── TOTP (RFC 6238 / RFC 4226 HOTP) ──────────────────────────────── */

function computeHotp(key: Buffer, counter: bigint): string {
  const counterBuf = Buffer.allocUnsafe(8);
  // Write as 64-bit big-endian.
  counterBuf.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Verify a 6-digit TOTP code against a base32 secret.
 * Accepts codes within ±windowSteps time steps to handle clock skew.
 */
export function verifyTotp(secret: string, code: string, windowSteps = TOTP_WINDOW): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (let i = -windowSteps; i <= windowSteps; i++) {
    const expected = computeHotp(key, counter + BigInt(i));
    // Constant-time compare prevents timing-oracle on TOTP digits.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

/* ─── TOTP secret management ────────────────────────────────────────── */

/**
 * Generate a 20-byte (160-bit) TOTP secret and return it as base32.
 * 160 bits satisfies RFC 4226 §4 which recommends ≥128 bits.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Store a TOTP secret for a user. If vault encryption is available (VAULT_KEY
 * set), the secret is encrypted before storage. Returns the plaintext secret
 * for delivery to the user (QR code / manual entry — not re-readable later).
 */
export async function saveMfaSecret(userId: string, secret: string, db: DatabaseAdapter): Promise<void> {
  let stored: string;
  try {
    // Attempt vault encryption. If VAULT_KEY is unset this throws — fall back to plaintext.
    const { encrypted } = encryptCredential({ secret });
    stored = encrypted;
  } catch {
    // VAULT_KEY not configured — store as plaintext base32.
    stored = secret;
  }
  await db.setUserMfaSecret(userId, stored);
}

/** Read and (if needed) decrypt the TOTP secret for a user. Returns null if not set. */
async function loadMfaSecret(userId: string, db: DatabaseAdapter): Promise<string | null> {
  const raw = await db.getUserMfaSecret(userId);
  if (!raw) return null;
  if (raw.startsWith('v1:')) {
    try {
      const obj = decryptCredential<{ secret: string }>(raw);
      return obj.secret ?? null;
    } catch {
      return null;
    }
  }
  return raw;
}

/* ─── Session MFA stamp ─────────────────────────────────────────────── */

/** Stamp the current session with the MFA verification time. */
export async function stampSessionMfa(sessionId: string, db: DatabaseAdapter): Promise<void> {
  await db.setSessionMfaVerifiedAt(sessionId, new Date().toISOString());
}

/**
 * Return true if the session's MFA stamp is present and within
 * STEP_UP_MFA_TTL_MS. This is the gate used by admin mutation routes.
 */
export function isMfaFresh(mfaVerifiedAt: string | null | undefined): boolean {
  if (!mfaVerifiedAt) return false;
  const verifiedMs = new Date(mfaVerifiedAt).getTime();
  if (Number.isNaN(verifiedMs)) return false;
  return Date.now() - verifiedMs < STEP_UP_MFA_TTL_MS;
}

/* ─── Step-up gate ──────────────────────────────────────────────────── */

/**
 * Gate for admin mutation routes. Returns `{ ok: true }` when:
 *  1. The user has no MFA configured (opt-in, fail-open for unenrolled users).
 *  2. The session has a fresh MFA stamp (within STEP_UP_MFA_TTL_MS).
 *
 * Returns `{ ok: false, status, error }` when:
 *  - The user has MFA configured but the session stamp is missing or stale.
 */
export async function requireStepUpMfa(
  auth: AuthContext,
  db: DatabaseAdapter,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const mfaEnabled = await db.getUserMfaEnabled(auth.userId);
  if (!mfaEnabled) return { ok: true }; // user not enrolled — bypass
  if (isMfaFresh(auth.mfaVerifiedAt)) return { ok: true };
  return { ok: false, status: 403, error: 'mfa_required' };
}

/* ─── Route handlers ────────────────────────────────────────────────── */

/**
 * POST /api/admin/mfa/setup — generate a TOTP secret for the authenticated user.
 * Returns { secret, otpauthUrl } for QR code display.
 * The secret is pending — MFA is not enabled until /mfa/setup/confirm succeeds.
 */
export async function handleMfaSetup(
  _req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, body: unknown) => void,
  appName = 'WeaveIntel',
): Promise<void> {
  const secret = generateTotpSecret();
  await saveMfaSecret(auth.userId, secret, db);
  // Disable MFA while pending confirmation (setup not yet confirmed).
  await db.setUserMfaEnabled(auth.userId, false);
  const otpauthUrl = `otpauth://totp/${encodeURIComponent(appName)}:${encodeURIComponent(auth.email)}?secret=${secret}&issuer=${encodeURIComponent(appName)}&algorithm=SHA1&digits=6&period=30`;
  json(res, 200, { secret, otpauthUrl });
}

/**
 * POST /api/admin/mfa/setup/confirm — verify first TOTP code and enable MFA.
 * Body: { code: string }
 */
export async function handleMfaSetupConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  const body = await readBody(req) as Record<string, unknown> | null;
  const code = typeof body?.['code'] === 'string' ? body['code'].trim() : '';
  if (!code) { json(res, 400, { error: 'code is required' }); return; }

  const secret = await loadMfaSecret(auth.userId, db);
  if (!secret) { json(res, 400, { error: 'mfa_not_initialized' }); return; }

  if (!verifyTotp(secret, code)) {
    json(res, 400, { error: 'invalid_code' });
    return;
  }

  await db.setUserMfaEnabled(auth.userId, true);
  // Immediately stamp the session so the user doesn't need to verify again.
  await stampSessionMfa(auth.sessionId, db);
  json(res, 200, { ok: true, message: 'MFA enabled' });
}

/**
 * POST /api/admin/mfa/verify — complete a step-up MFA challenge.
 * Body: { code: string }
 * Stamps `mfa_verified_at` on the session on success.
 */
export async function handleMfaVerify(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  const body = await readBody(req) as Record<string, unknown> | null;
  const code = typeof body?.['code'] === 'string' ? body['code'].trim() : '';
  if (!code) { json(res, 400, { error: 'code is required' }); return; }

  const mfaEnabled = await db.getUserMfaEnabled(auth.userId);
  if (!mfaEnabled) { json(res, 400, { error: 'mfa_not_enabled' }); return; }

  const secret = await loadMfaSecret(auth.userId, db);
  if (!secret) { json(res, 500, { error: 'mfa_secret_missing' }); return; }

  if (!verifyTotp(secret, code)) {
    json(res, 400, { error: 'invalid_code' });
    return;
  }

  await stampSessionMfa(auth.sessionId, db);
  json(res, 200, { ok: true, expiresInMs: STEP_UP_MFA_TTL_MS });
}

/**
 * DELETE /api/admin/mfa — disable MFA for the authenticated user.
 * Requires a valid TOTP code as a final confirmation.
 * Body: { code: string }
 */
export async function handleMfaDisable(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  const body = await readBody(req) as Record<string, unknown> | null;
  const code = typeof body?.['code'] === 'string' ? body['code'].trim() : '';
  if (!code) { json(res, 400, { error: 'code is required' }); return; }

  const secret = await loadMfaSecret(auth.userId, db);
  if (!secret) { json(res, 400, { error: 'mfa_not_initialized' }); return; }

  if (!verifyTotp(secret, code)) {
    json(res, 400, { error: 'invalid_code' });
    return;
  }

  await db.setUserMfaEnabled(auth.userId, false);
  await db.setUserMfaSecret(auth.userId, null);
  json(res, 200, { ok: true, message: 'MFA disabled' });
}
