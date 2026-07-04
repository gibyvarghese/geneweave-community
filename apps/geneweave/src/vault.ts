/**
 * @weaveintel/geneweave — Credential vault (AES-256-GCM encryption)
 *
 * Encrypts / decrypts website credentials at rest.
 * Current format: v1:base64(salt || iv || ciphertext || authTag)
 * Legacy format (still readable): base64(iv || ciphertext || authTag)
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT_LEN = 16;
const VAULT_FORMAT_VERSION = 'v1';
const HKDF_INFO = Buffer.from('weaveintel-vault-key-v1', 'utf8');

const LEGACY_IV_LEN = 16;
// Read-only legacy support — do NOT use for new encryptions (static salt = zero per-record key diversity).
// m52 migration re-encrypts existing rows to v1 format. This constant stays for backward-compat reads.
const LEGACY_SALT = 'weaveintel-vault-v1';

/**
 * L-5: Cache the VAULT_KEY as a Buffer at first use rather than calling
 * `process.env['VAULT_KEY']` on every encrypt/decrypt. Benefits:
 *  - Avoids repeated string→Buffer allocations on the hot path.
 *  - Ensures the key is only read once so a runtime env-var mutation (possible
 *    in test harnesses) does not silently change the active key mid-flight.
 *  - Makes it easier to wipe the key from memory (call `clearVaultKeyCache()`).
 *
 * The cache is module-level; call `initVaultKey()` at startup to fail fast if
 * VAULT_KEY is missing rather than discovering the problem at first usage.
 */
let _cachedVaultKey: Buffer | null = null;

/** Prime the module-level vault key cache. Throws if VAULT_KEY is not set. */
export function initVaultKey(): void {
  _cachedVaultKey = null; // reset so the next call re-reads the env var
  _cachedVaultKey = getVaultMasterKey();
}

/** Zero and clear the in-memory key cache (call on graceful shutdown or key rotation). */
export function clearVaultKeyCache(): void {
  _cachedVaultKey?.fill(0);
  _cachedVaultKey = null;
}

function getVaultMasterKey(): Buffer {
  if (_cachedVaultKey) return _cachedVaultKey;
  const master = process.env['VAULT_KEY'];
  if (!master) throw new Error('VAULT_KEY must be set for credential encryption');
  _cachedVaultKey = Buffer.from(master, 'utf8');
  return _cachedVaultKey;
}

function deriveKeyForSalt(salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', getVaultMasterKey(), salt, HKDF_INFO, KEY_LEN));
}

function deriveLegacyKey(): Buffer {
  return scryptSync(getVaultMasterKey(), LEGACY_SALT, KEY_LEN);
}

/**
 * Encrypt a JSON-serialisable object → base64 string.
 * Format: base64( IV || ciphertext || authTag )
 */
export function encryptCredential(plainObj: unknown): { encrypted: string; iv: string } {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKeyForSalt(salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const json = JSON.stringify(plainObj);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([salt, iv, enc, tag]);
  return {
    encrypted: `${VAULT_FORMAT_VERSION}:${payload.toString('base64')}`,
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt base64 string → parsed JSON object.
 */
export function decryptCredential<T = unknown>(encrypted: string): T {
  if (encrypted.startsWith(`${VAULT_FORMAT_VERSION}:`)) {
    const encoded = encrypted.slice(VAULT_FORMAT_VERSION.length + 1);
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length <= SALT_LEN + IV_LEN + TAG_LEN) {
      throw new Error('Invalid credential payload');
    }
    const salt = buf.subarray(0, SALT_LEN);
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ciphertext = buf.subarray(SALT_LEN + IV_LEN, buf.length - TAG_LEN);
    const decipher = createDecipheriv(ALGO, deriveKeyForSalt(salt), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(dec.toString('utf8')) as T;
  }

  // Backward compatibility for existing records written before versioned payloads.
  const buf = Buffer.from(encrypted, 'base64');
  if (buf.length <= LEGACY_IV_LEN + TAG_LEN) {
    throw new Error('Invalid credential payload');
  }
  const iv = buf.subarray(0, LEGACY_IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(LEGACY_IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, deriveLegacyKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}
