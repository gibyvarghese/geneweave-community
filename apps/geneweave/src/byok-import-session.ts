/**
 * byok-import-session.ts — Secure ephemeral key-wrapping session for BYOK import.
 *
 * Production private-key import ceremony (Azure Key Vault / AWS KMS pattern):
 *
 *   1. Operator calls  POST /api/admin/byok/import-session
 *      Server generates a one-time RSA-4096 key pair in memory.
 *      Returns { sessionId, ephemeralPublicKeyPem, algorithm, expiresAt }.
 *
 *   2. Operator encrypts their BYOK private key (PEM) with the ephemeral
 *      public key using RSA-OAEP-SHA-256 padding:
 *        ciphertext = RSAES-OAEP(ephemeralPublicKey, privateKeyPem_utf8_bytes)
 *      Wraps as Base64 and sends:
 *        POST /api/admin/byok/config { importSessionId, wrappedPrivateKey, publicKeyPem, tenantId }
 *
 *   3. Server looks up the session by ID, decrypts with the ephemeral private
 *      key, deletes the session immediately (single use), then processes the
 *      unwrapped PEM exactly as it would have processed privateKeyPemDev.
 *
 * Security properties:
 *   • The BYOK private key is never transmitted in plaintext (not even over TLS —
 *     defence in depth).
 *   • The ephemeral RSA key pair exists only in memory; it is never persisted.
 *   • Session TTL: 15 minutes. Expired sessions are rejected and garbage-collected.
 *   • Single-use: consuming the session deletes it before decryption is returned.
 *   • RSA-4096 with OAEP-SHA256 exceeds NIST SP 800-131A requirements.
 *   • Session IDs are crypto-random UUIDs (128 bits of entropy).
 */

import { generateKeyPairSync, privateDecrypt, constants, randomUUID } from 'node:crypto';

export interface ByokImportSession {
  sessionId: string;
  ephemeralPublicKeyPem: string;
  privateKeyPem: string;         // never leaves this process
  createdAt: number;             // Date.now()
  expiresAt: number;             // Date.now() + TTL
}

export interface ByokImportSessionPublic {
  sessionId: string;
  ephemeralPublicKeyPem: string;
  algorithm: 'RSA-OAEP-SHA256';
  modulusLengthBits: 4096;
  expiresAt: string;             // ISO 8601 for the API response
}

const SESSION_TTL_MS = 15 * 60 * 1_000; // 15 minutes

// In-memory store — sessions are transient and intentionally lost on restart
// (operators simply create a new import session if the server restarts).
const sessions = new Map<string, ByokImportSession>();

// Garbage-collect expired sessions lazily on every call.
function purgeExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(id);
  }
}

/**
 * Create a new import session.
 * Generating a 4096-bit RSA pair is ~200–400ms; this is intentional —
 * the ceremony is a rare privileged operation, not a hot path.
 */
export function createByokImportSession(): ByokImportSessionPublic {
  purgeExpired();

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const sessionId = randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  sessions.set(sessionId, {
    sessionId,
    ephemeralPublicKeyPem: publicKey as string,
    privateKeyPem: privateKey as string,
    createdAt: now,
    expiresAt,
  });

  return {
    sessionId,
    ephemeralPublicKeyPem: publicKey as string,
    algorithm: 'RSA-OAEP-SHA256',
    modulusLengthBits: 4096,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Consume a session and decrypt the wrapped private key.
 *
 * Returns the plaintext PEM string on success, null if the session is
 * unknown / expired. The session is deleted before this function returns
 * regardless of success/failure.
 *
 * @param sessionId  The session ID returned by createByokImportSession.
 * @param wrappedB64 Base64-encoded RSA-OAEP ciphertext of the private key PEM.
 */
export function consumeByokImportSession(sessionId: string, wrappedB64: string): string | null {
  purgeExpired();

  const session = sessions.get(sessionId);
  sessions.delete(sessionId); // single-use regardless of outcome

  if (!session) return null;
  if (Date.now() > session.expiresAt) return null;

  try {
    const ciphertext = Buffer.from(wrappedB64, 'base64');
    const plaintext = privateDecrypt(
      {
        key: session.privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      ciphertext,
    );
    return plaintext.toString('utf8');
  } catch {
    // Decryption failure (wrong key, corrupted ciphertext, wrong algorithm).
    return null;
  }
}

/** Return the number of active (non-expired) sessions — for health checks. */
export function activeImportSessionCount(): number {
  purgeExpired();
  return sessions.size;
}
