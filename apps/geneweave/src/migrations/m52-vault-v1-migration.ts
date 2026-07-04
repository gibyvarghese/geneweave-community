/**
 * Migration m52 — Vault v1 format migration (H-5)
 *
 * H-5: Legacy vault records used a static HKDF salt
 * (`LEGACY_SALT = 'weaveintel-vault-v1'`) and a 16-byte AES-CBC IV, making
 * every record with the same master key derive the same encryption key — if the
 * master key ever leaks, all legacy records decrypt identically with zero
 * per-record key diversity.
 *
 * The v1 format (`v1:base64(salt || iv || ciphertext || authTag)`) uses a
 * random 16-byte salt per record fed into HKDF-SHA256 so every record derives
 * an independent key. It also switches from AES-CBC to AES-256-GCM for
 * authenticated encryption (tamper-detection via authTag).
 *
 * This migration re-encrypts all legacy `website_credentials.credentials_encrypted`
 * rows that do NOT start with the `v1:` prefix. The VAULT_KEY must be set in the
 * environment at migration time.
 *
 * Safe to run multiple times (idempotent): rows already in v1 format are
 * left untouched.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { scryptSync, hkdfSync, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';

/** Matches the vault.ts constants exactly — keep in sync. */
const VAULT_FORMAT_PREFIX = 'v1:';
const LEGACY_SALT = 'weaveintel-vault-v1';
const ALGO = 'aes-256-gcm';
const LEGACY_IV_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 16;
const KEY_LEN = 32;
const HKDF_INFO = Buffer.from('weaveintel-vault-key-v1', 'utf8');

function getMasterKey(): Buffer {
  const master = process.env['VAULT_KEY'];
  if (!master) throw new Error('[m52] VAULT_KEY must be set to run the vault v1 migration');
  return Buffer.from(master, 'utf8');
}

function deriveLegacyKey(masterKey: Buffer): Buffer {
  return scryptSync(masterKey, LEGACY_SALT, KEY_LEN);
}

function deriveV1Key(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, salt, HKDF_INFO, KEY_LEN));
}

/**
 * Decrypt a legacy record → plaintext JSON string.
 * Legacy format: base64(16-byte IV || ciphertext || 16-byte authTag)
 * (AES-256-GCM with scrypt-derived key)
 */
function decryptLegacy(encrypted: string, legacyKey: Buffer): string {
  const buf = Buffer.from(encrypted, 'base64');
  if (buf.length <= LEGACY_IV_LEN + TAG_LEN) {
    throw new Error('Invalid legacy credential payload (too short)');
  }
  const iv = buf.subarray(0, LEGACY_IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(LEGACY_IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, legacyKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Re-encrypt a plaintext JSON string in v1 format.
 * v1 format: `v1:` + base64(16-byte salt || 12-byte IV || ciphertext || 16-byte authTag)
 */
function encryptV1(plainJson: string, masterKey: Buffer): { encrypted: string; iv: string } {
  const salt = randomBytes(SALT_LEN);
  const key = deriveV1Key(masterKey, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([salt, iv, enc, tag]);
  return {
    encrypted: `${VAULT_FORMAT_PREFIX}${payload.toString('base64')}`,
    iv: iv.toString('hex'),
  };
}

export function applyM52VaultV1Migration(db: BetterSqlite3.Database): void {
  // If VAULT_KEY is not set, skip silently — the vault feature is disabled on
  // this deployment and there are no records to migrate.
  if (!process.env['VAULT_KEY']) {
    console.log('[m52] VAULT_KEY not set — skipping vault v1 migration (vault feature disabled)');
    return;
  }

  const masterKey = getMasterKey();
  const legacyKey = deriveLegacyKey(masterKey);

  // Fetch all credential rows not yet in v1 format.
  interface CredRow { id: string; credentials_encrypted: string }
  const legacy = db
    .prepare(`SELECT id, credentials_encrypted FROM website_credentials WHERE credentials_encrypted NOT LIKE 'v1:%'`)
    .all() as CredRow[];

  if (legacy.length === 0) {
    console.log('[m52] No legacy vault records found — nothing to migrate');
    return;
  }

  console.log(`[m52] Migrating ${legacy.length} legacy vault record(s) to v1 format…`);
  let migratedCount = 0;
  let errorCount = 0;

  const update = db.prepare(
    `UPDATE website_credentials SET credentials_encrypted = ?, encryption_iv = ? WHERE id = ?`,
  );

  for (const row of legacy) {
    try {
      const plainJson = decryptLegacy(row.credentials_encrypted, legacyKey);
      const v1 = encryptV1(plainJson, masterKey);
      update.run(v1.encrypted, v1.iv, row.id);
      migratedCount++;
    } catch (err) {
      // Log but don't abort — partially-migrated databases are better than
      // aborting the entire migration on a single corrupt record.
      console.error(
        `[m52] Failed to migrate credential row "${row.id}":`,
        err instanceof Error ? err.message : String(err),
      );
      errorCount++;
    }
  }

  console.log(`[m52] Vault v1 migration complete: ${migratedCount} migrated, ${errorCount} errors`);
}
