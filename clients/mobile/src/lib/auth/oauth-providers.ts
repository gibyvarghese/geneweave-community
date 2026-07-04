/**
 * OAuth / social sign-in catalog + parsers — pure, framework-agnostic logic.
 *
 * The server is the source of truth for *which* providers are configured; this
 * module narrows the server's open string list to the ids the app knows how to
 * render, in a canonical order, and parses the native callback URL the server
 * 302s back to the app scheme.
 *
 * No React / React Native / Expo imports — testable in plain Node.
 */

/** Schemes that may carry a native OAuth callback. Must be kept in sync with the
 *  server-side `isAllowedNativeRedirect` allowlist in apps/geneweave. */
const ALLOWED_OAUTH_CALLBACK_SCHEMES = ['geneweave:', 'exp:'] as const;

/** Every OAuth provider the app can render, in canonical display order. */
export const OAUTH_PROVIDER_IDS = ['google', 'github', 'microsoft', 'apple', 'facebook'] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

const PROVIDER_LABELS: Record<OAuthProviderId, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
  microsoft: 'Continue with Microsoft',
  apple: 'Continue with Apple',
  facebook: 'Continue with Facebook',
};

/** Human label shown on a provider's sign-in button. */
export function oauthProviderLabel(id: OAuthProviderId): string {
  return PROVIDER_LABELS[id];
}

/** Narrowing guard for the canonical provider ids. */
export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === 'string' && (OAUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Normalize the server's provider list: keep only known ids, dedupe, and return
 * them in canonical order regardless of the order the server sent them.
 */
export function parseAuthProviders(raw: unknown): OAuthProviderId[] {
  const list = Array.isArray(raw) ? raw : [];
  const present = new Set<OAuthProviderId>();
  for (const item of list) {
    if (isOAuthProviderId(item)) present.add(item);
  }
  return OAUTH_PROVIDER_IDS.filter((id) => present.has(id));
}

/** A successfully parsed native OAuth callback (bearer session handed to the app). */
export interface NativeOAuthResult {
  token: string;
  csrfToken: string;
  expiresAt?: string;
}

/** A failed native OAuth callback (provider error or missing session). */
export interface NativeOAuthError {
  error: string;
}

/**
 * Parse the redirect URL the server sends back to the app scheme after a native
 * OAuth flow.
 *
 * The server encodes the session as a URL fragment (`#`) so the bearer token
 * does not appear in server logs or Referer headers. The fragment is only
 * visible to the app receiving the redirect — never transmitted over HTTP.
 *
 * Example: `geneweave://oauth#token=...&csrfToken=...&expiresAt=...`
 *
 * Falls back to query-string parsing for backward compatibility with any
 * in-flight requests during a rolling deploy.
 */
export function parseNativeOAuthCallback(url: string): NativeOAuthResult | NativeOAuthError {
  // Guard: only accept URLs with a known app scheme. Rejects web URLs (https://)
  // and protocol-relative strings (//evil.example) that could reach this parser
  // through deep-link spoofing.
  try {
    const parsed = new URL(url);
    if (!(ALLOWED_OAUTH_CALLBACK_SCHEMES as readonly string[]).includes(parsed.protocol)) {
      return { error: 'OAuth callback URL has unexpected scheme' };
    }
  } catch {
    return { error: 'OAuth callback URL is not a valid URL' };
  }

  const hashStart = url.indexOf('#');
  const queryStart = url.indexOf('?');

  // Prefer fragment; fall back to query string.
  let paramStr = '';
  if (hashStart >= 0) {
    paramStr = url.slice(hashStart + 1);
  } else if (queryStart >= 0) {
    paramStr = url.slice(queryStart + 1);
  }

  const params = new URLSearchParams(paramStr);

  const error = params.get('error');
  if (error) return { error };

  const token = params.get('token');
  const csrfToken = params.get('csrfToken');
  if (!token || !csrfToken) return { error: 'Missing session in OAuth callback' };

  const expiresAt = params.get('expiresAt');
  return { token, csrfToken, ...(expiresAt ? { expiresAt } : {}) };
}

/** Type guard distinguishing a parsed native OAuth result from an error. */
export function isNativeOAuthError(
  value: NativeOAuthResult | NativeOAuthError,
): value is NativeOAuthError {
  return 'error' in value;
}
