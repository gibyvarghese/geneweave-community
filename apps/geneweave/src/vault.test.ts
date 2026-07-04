import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential, clearVaultKeyCache } from './vault.js';

const ALGO = 'aes-256-gcm';
const LEGACY_IV_LEN = 16;
const LEGACY_TAG_LEN = 16;
const LEGACY_SALT = 'weaveintel-vault-v1';
const LEGACY_KEY_LEN = 32;
const ORIGINAL_VAULT_KEY = process.env['VAULT_KEY'];

afterEach(() => {
  // Clear the module-level key cache so each test starts with a clean slate
  // (see L-5: the cache persists across calls; without clearing it the
  // "VAULT_KEY missing" test would see the previous test's cached key).
  clearVaultKeyCache();
  process.env['VAULT_KEY'] = ORIGINAL_VAULT_KEY;
});

describe('vault credential encryption', () => {
  it('writes and reads versioned payloads', () => {
    process.env['VAULT_KEY'] = 'test-vault-key-material';
    const plain = { provider: 'github', token: 'abc123' };

    const encrypted = encryptCredential(plain);
    expect(encrypted.encrypted.startsWith('v1:')).toBe(true);

    const decrypted = decryptCredential<typeof plain>(encrypted.encrypted);
    expect(decrypted).toEqual(plain);
  });

  it('decrypts legacy payloads for backward compatibility', () => {
    process.env['VAULT_KEY'] = 'test-vault-key-material';
    const key = scryptSync(Buffer.from(process.env['VAULT_KEY'] ?? '', 'utf8'), LEGACY_SALT, LEGACY_KEY_LEN);
    const iv = randomBytes(LEGACY_IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);

    const json = JSON.stringify({ legacy: true, value: 'ok' });
    const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, enc, tag]).toString('base64');

    const decrypted = decryptCredential<{ legacy: boolean; value: string }>(payload);
    expect(decrypted).toEqual({ legacy: true, value: 'ok' });
  });

  it('fails on tampered payloads', () => {
    process.env['VAULT_KEY'] = 'test-vault-key-material';
    const encrypted = encryptCredential({ x: 1 }).encrypted;
    const tampered = encrypted.slice(0, -2) + 'aa';
    expect(() => decryptCredential(tampered)).toThrow();
  });

  it('fails fast when VAULT_KEY is missing', () => {
    delete process.env['VAULT_KEY'];
    expect(() => encryptCredential({ provider: 'x' })).toThrow(/VAULT_KEY must be set/);
  });
});
