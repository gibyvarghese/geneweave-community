/**
 * env.ts — read mobile environment config and normalize a server host.
 *
 * Pure and framework-agnostic: no React, no `react-native`, no `expo-*`. The
 * environment source is injected (defaults to `process.env`) so this is fully
 * unit-testable. Expo exposes build-time vars prefixed `EXPO_PUBLIC_` on
 * `process.env` in both the bundler and the native runtime, so reading from
 * `process.env` works on-device too.
 */

/** A typed view of the mobile build-time environment. */
export interface MobileEnv {
  /** `EXPO_PUBLIC_DEFAULT_HOST` — when set, the server-picker screen is skipped. */
  defaultHost?: string;
  /** `EXPO_PUBLIC_TENANT_ID` — optional per-tenant namespace for stored sessions. */
  tenantId?: string;
  /** `EXPO_PUBLIC_BIOMETRIC_DEFAULT` — whether the biometric gate defaults on. */
  biometricEnabledByDefault: boolean;
}

/** Raised when a host string cannot be parsed into a usable origin. */
export class InvalidHostError extends Error {
  constructor(public readonly raw: string) {
    super(`That doesn't look like a valid server address: ${raw}`);
    this.name = 'InvalidHostError';
  }
}

function readBool(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Reads the mobile environment from an injected source (default `process.env`).
 * Absent keys come back `undefined`; the default host is normalized eagerly so
 * a malformed `EXPO_PUBLIC_DEFAULT_HOST` surfaces at startup, not first request.
 */
export function readMobileEnv(source: Record<string, string | undefined> = process.env): MobileEnv {
  const rawHost = source['EXPO_PUBLIC_DEFAULT_HOST'];
  const tenantId = source['EXPO_PUBLIC_TENANT_ID'];
  return {
    ...(rawHost ? { defaultHost: normalizeHost(rawHost) } : {}),
    ...(tenantId ? { tenantId } : {}),
    biometricEnabledByDefault: readBool(source['EXPO_PUBLIC_BIOMETRIC_DEFAULT']),
  };
}

/**
 * Normalizes a user- or env-supplied host into a clean origin
 * (`https://host[:port]`). Adds `https://` when no scheme is present, lowercases
 * the host, drops any path/query/trailing slash, and validates the result.
 * Throws {@link InvalidHostError} on anything that is not a usable http(s) URL.
 */
export function normalizeHost(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new InvalidHostError(raw);
  // Reject an explicit non-http(s) scheme (ftp://, ws://, …) rather than
  // silently mangling it into a hostname.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) throw new InvalidHostError(raw);
  const withScheme = scheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidHostError(raw);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InvalidHostError(raw);
  if (!url.hostname) throw new InvalidHostError(raw);
  return url.origin;
}

/** Like {@link normalizeHost} but returns `null` instead of throwing. */
export function tryNormalizeHost(raw: string): string | null {
  try {
    return normalizeHost(raw);
  } catch {
    return null;
  }
}
