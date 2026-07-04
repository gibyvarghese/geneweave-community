import { describe, expect, it } from 'vitest';
import {
  OAUTH_PROVIDER_IDS,
  oauthProviderLabel,
  isOAuthProviderId,
  parseAuthProviders,
  parseNativeOAuthCallback,
  isNativeOAuthError,
} from './oauth-providers.js';

describe('oauthProviderLabel', () => {
  it('renders a "Continue with" label for every known provider', () => {
    for (const id of OAUTH_PROVIDER_IDS) {
      expect(oauthProviderLabel(id)).toMatch(/^Continue with /);
    }
  });
});

describe('isOAuthProviderId', () => {
  it('narrows known ids and rejects unknowns', () => {
    expect(isOAuthProviderId('google')).toBe(true);
    expect(isOAuthProviderId('twitter')).toBe(false);
    expect(isOAuthProviderId(42)).toBe(false);
    expect(isOAuthProviderId(undefined)).toBe(false);
  });
});

describe('parseAuthProviders', () => {
  it('keeps only known ids, dedupes, and returns canonical order', () => {
    expect(parseAuthProviders(['github', 'google', 'github', 'twitter'])).toEqual([
      'google',
      'github',
    ]);
  });

  it('tolerates non-array and empty input', () => {
    expect(parseAuthProviders(null)).toEqual([]);
    expect(parseAuthProviders('google')).toEqual([]);
    expect(parseAuthProviders([])).toEqual([]);
  });
});

describe('parseNativeOAuthCallback', () => {
  it('extracts the session from a fragment-encoded redirect (primary path)', () => {
    const result = parseNativeOAuthCallback(
      'geneweave://oauth#token=tok&csrfToken=csrf&expiresAt=2030-01-01T00:00:00.000Z',
    );
    expect(isNativeOAuthError(result)).toBe(false);
    if (!isNativeOAuthError(result)) {
      expect(result.token).toBe('tok');
      expect(result.csrfToken).toBe('csrf');
      expect(result.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    }
  });

  it('falls back to query-string for backward compat during rolling deploys', () => {
    const result = parseNativeOAuthCallback(
      'geneweave://oauth?token=tok&csrfToken=csrf&expiresAt=2030-01-01T00:00:00.000Z',
    );
    expect(isNativeOAuthError(result)).toBe(false);
    if (!isNativeOAuthError(result)) {
      expect(result.token).toBe('tok');
    }
  });

  it('parses an Expo Go fragment redirect', () => {
    const result = parseNativeOAuthCallback('exp://192.168.1.5:8081/--/oauth#token=t&csrfToken=c');
    expect(isNativeOAuthError(result)).toBe(false);
    if (!isNativeOAuthError(result)) {
      expect(result.token).toBe('t');
      expect(result.expiresAt).toBeUndefined();
    }
  });

  it('surfaces a provider error (fragment)', () => {
    const result = parseNativeOAuthCallback('geneweave://oauth#error=access_denied');
    expect(isNativeOAuthError(result)).toBe(true);
    if (isNativeOAuthError(result)) expect(result.error).toBe('access_denied');
  });

  it('surfaces a provider error (query string, backward compat)', () => {
    const result = parseNativeOAuthCallback('geneweave://oauth?error=access_denied');
    expect(isNativeOAuthError(result)).toBe(true);
    if (isNativeOAuthError(result)) expect(result.error).toBe('access_denied');
  });

  it('fails closed when the session is missing', () => {
    const result = parseNativeOAuthCallback('geneweave://oauth');
    expect(isNativeOAuthError(result)).toBe(true);
  });
});
