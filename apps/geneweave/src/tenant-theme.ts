/**
 * Per-tenant design-token (theme) resolution.
 *
 * Brand tokens — colors, font families, corner radii — are configurable per
 * tenant. Like platform limits, the override JSON lives in the existing
 * `tenant_configs.config_overrides` blob under the `theme` key, so no new table
 * or migration is needed and platform/tenant scoping reuses the same rows.
 *
 * Resolution order (later wins):
 *   {}  →  platform (global scope row)  →  tenant (by tenantId)
 *
 * The server only STORES and SERVES the override. WCAG-AA enforcement and the
 * graceful degrade-to-base-theme behaviour live client-side in
 * `@weaveintel/tokens` (`applyTenantTheme`), already unit-tested. Keeping the
 * accessibility gate on the client means every consumer (mobile, future web)
 * shares one implementation and a misconfigured brand can never ship an
 * inaccessible UI — the server stays framework-agnostic and never imports a
 * client token package.
 *
 * Results are cached with a 60-second TTL, mirroring platform-limits. The admin
 * API invalidates the cache on writes so changes are effective within one TTL
 * cycle at most.
 */

import { createLogger } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';

const logger = createLogger('tenant-theme');

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The brandable token subset a tenant may override. Structurally identical to
 * the client's `TenantThemeOverride` (`@weaveintel/tokens`) but expressed with
 * open string/number maps so the server stays decoupled from the client token
 * names. Only colors, font families, and corner radii are overridable; the
 * spacing grid, elevation, and motion tokens are fixed for layout correctness.
 */
export interface TenantThemeTokens {
  colors?: Record<string, string>;
  typography?: { families?: Record<string, string> };
  radii?: Record<string, number>;
}

// ─── Validation bounds ──────────────────────────────────────────────────────
// Defensive caps so a malformed or hostile override can never bloat the row.
const MAX_KEYS = 48;
const MAX_STRING_LEN = 64;

function sanitizeStringMap(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break;
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_STRING_LEN) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STRING_LEN) continue;
    out[k] = v;
    count++;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeNumberMap(raw: unknown): Record<string, number> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break;
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_STRING_LEN) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out[k] = v;
    count++;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Coerce an untrusted value into a {@link TenantThemeTokens}, dropping every
 * malformed entry. Returns `null` when nothing valid survives, so callers can
 * treat "no theme" and "garbage theme" identically. Never throws.
 */
export function sanitizeTheme(raw: unknown): TenantThemeTokens | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const colors = sanitizeStringMap(rec['colors']);
  const families =
    rec['typography'] !== null && typeof rec['typography'] === 'object' && !Array.isArray(rec['typography'])
      ? sanitizeStringMap((rec['typography'] as Record<string, unknown>)['families'])
      : undefined;
  const radii = sanitizeNumberMap(rec['radii']);
  const theme: TenantThemeTokens = {
    ...(colors ? { colors } : {}),
    ...(families ? { typography: { families } } : {}),
    ...(radii ? { radii } : {}),
  };
  return Object.keys(theme).length > 0 ? theme : null;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: TenantThemeTokens | null;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

function cacheGet(key: string): { hit: true; value: TenantThemeTokens | null } | { hit: false } {
  const entry = _cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    _cache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

function cacheSet(key: string, value: TenantThemeTokens | null): void {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/** Read and sanitize the `theme` override out of a config_overrides JSON blob. */
export function parseThemeFromOverrides(configOverrides: string | null | undefined): TenantThemeTokens | null {
  if (!configOverrides) return null;
  try {
    const parsed = JSON.parse(configOverrides) as Record<string, unknown>;
    return sanitizeTheme(parsed['theme']);
  } catch {
    return null;
  }
}

/**
 * Deep-merge a tenant override over a platform base. Tenant keys win; absent
 * sub-objects fall through to the base. Returns `null` only when both are empty.
 */
export function mergeThemeTokens(
  base: TenantThemeTokens | null,
  over: TenantThemeTokens | null,
): TenantThemeTokens | null {
  if (!base) return over;
  if (!over) return base;
  const colors = { ...(base.colors ?? {}), ...(over.colors ?? {}) };
  const families = { ...(base.typography?.families ?? {}), ...(over.typography?.families ?? {}) };
  const radii = { ...(base.radii ?? {}), ...(over.radii ?? {}) };
  const merged: TenantThemeTokens = {
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(Object.keys(families).length > 0 ? { typography: { families } } : {}),
    ...(Object.keys(radii).length > 0 ? { radii } : {}),
  };
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Replace the `theme` key inside a config_overrides JSON string, preserving all
 * other keys (e.g. `limits`). Passing `null` clears the theme. Returns the new
 * JSON string.
 */
export function setThemeInOverrides(
  existing: string | null | undefined,
  theme: TenantThemeTokens | null,
): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      base = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      /* ignore — start from empty */
    }
  }
  if (theme) {
    base['theme'] = theme;
  } else {
    delete base['theme'];
  }
  return JSON.stringify(base);
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the effective theme override for an optional tenantId: the platform
 * global theme merged with the tenant's own. Returns `null` when neither scope
 * defines one. Fail-soft — any DB error degrades to `null` (base theme).
 *
 * 60 s TTL module cache. Hot path on a cache hit costs one Map lookup.
 */
export async function resolveTenantThemeTokens(
  db: DatabaseAdapter,
  tenantId?: string | null,
): Promise<TenantThemeTokens | null> {
  const cacheKey = tenantId ?? '__platform__';
  const cached = cacheGet(cacheKey);
  if (cached.hit) return cached.value;

  try {
    const [globalRow, tenantRow] = await Promise.all([
      db.getGlobalTenantConfig(),
      tenantId ? db.getTenantConfigForTenant(tenantId) : Promise.resolve(null),
    ]);
    const platformTheme = parseThemeFromOverrides(globalRow?.config_overrides);
    const tenantTheme = tenantId ? parseThemeFromOverrides(tenantRow?.config_overrides) : null;
    const merged = mergeThemeTokens(platformTheme, tenantTheme);
    cacheSet(cacheKey, merged);
    return merged;
  } catch (err) {
    // Never let a theme lookup break a request — degrade to the base theme.
    // Do NOT cache the error state: let the next request retry the DB.
    logger.error('DB lookup failed, returning base theme', { err });
    return null;
  }
}

/**
 * Invalidate cache entries. Call after writing theme overrides. Passing a
 * tenantId invalidates that tenant plus the platform entry (a platform change
 * affects every derived tenant); no argument clears all.
 */
export function invalidateThemeCache(tenantId?: string | null): void {
  if (tenantId) {
    _cache.delete(tenantId);
    _cache.delete('__platform__');
  } else {
    _cache.clear();
  }
}
