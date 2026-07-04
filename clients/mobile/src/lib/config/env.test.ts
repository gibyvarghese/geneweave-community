import { describe, it, expect } from 'vitest';
import { readMobileEnv, normalizeHost, tryNormalizeHost, InvalidHostError } from './env.js';

describe('normalizeHost', () => {
  it('adds https:// when no scheme is present', () => {
    expect(normalizeHost('api.example.com')).toBe('https://api.example.com');
  });

  it('preserves an explicit http scheme (local dev)', () => {
    expect(normalizeHost('http://localhost:3500')).toBe('http://localhost:3500');
  });

  it('strips path, query, and trailing slash down to the origin', () => {
    expect(normalizeHost('https://api.example.com/foo/bar?x=1')).toBe('https://api.example.com');
    expect(normalizeHost('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('lowercases the host and keeps the port', () => {
    expect(normalizeHost('API.Example.COM:8443')).toBe('https://api.example.com:8443');
  });

  it('throws InvalidHostError on empty or garbage input', () => {
    expect(() => normalizeHost('   ')).toThrow(InvalidHostError);
    expect(() => normalizeHost('not a url')).toThrow(InvalidHostError);
    expect(() => normalizeHost('ftp://example.com')).toThrow(InvalidHostError);
  });
});

describe('tryNormalizeHost', () => {
  it('returns null instead of throwing on bad input', () => {
    expect(tryNormalizeHost('::::')).toBeNull();
    expect(tryNormalizeHost('https://ok.example.com')).toBe('https://ok.example.com');
  });
});

describe('readMobileEnv', () => {
  it('reads and normalizes the default host', () => {
    const env = readMobileEnv({ EXPO_PUBLIC_DEFAULT_HOST: 'api.example.com' });
    expect(env.defaultHost).toBe('https://api.example.com');
  });

  it('omits absent keys and defaults biometrics off', () => {
    const env = readMobileEnv({});
    expect(env.defaultHost).toBeUndefined();
    expect(env.tenantId).toBeUndefined();
    expect(env.biometricEnabledByDefault).toBe(false);
  });

  it('reads tenant id and biometric default', () => {
    const env = readMobileEnv({
      EXPO_PUBLIC_TENANT_ID: 'tenant-a',
      EXPO_PUBLIC_BIOMETRIC_DEFAULT: 'true',
    });
    expect(env.tenantId).toBe('tenant-a');
    expect(env.biometricEnabledByDefault).toBe(true);
  });

  it('throws on a malformed default host so misconfig surfaces at startup', () => {
    expect(() => readMobileEnv({ EXPO_PUBLIC_DEFAULT_HOST: 'not a url' })).toThrow(InvalidHostError);
  });
});
