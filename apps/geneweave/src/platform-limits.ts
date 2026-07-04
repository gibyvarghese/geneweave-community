/**
 * Platform-level and per-tenant operational limit resolution.
 *
 * Every limit has a code default (floor) that is always safe and functional.
 * Platform operators can raise or lower limits via the global tenant_configs
 * row (scope='global'). Individual tenants can override within the bounds of
 * the platform config via their own tenant_configs row.
 *
 * Resolution order (later wins):
 *   CODE_DEFAULTS  →  platform (global scope row)  →  tenant (by tenantId)
 *
 * Limits are stored in the `limits` key of tenant_configs.config_overrides:
 *   { "limits": { "chat_max_steps": 30, "cse_memory_mb": 1024 } }
 *
 * Results are cached with a 60-second TTL. The admin API invalidates the cache
 * on writes so changes are effective within one TTL cycle at most.
 */

import type { DatabaseAdapter } from './db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlatformLimits {
  // Chat / agent
  /** Max agent reasoning steps per turn (supervisor or agent mode). Default: 20. */
  chat_max_steps: number;
  /** Default max output tokens when the caller does not specify. Default: 4096. */
  chat_max_tokens: number;

  // Guardrails
  /** Max input chars passed to the guardrail pipeline. Flood-input protection. Default: 8000. */
  guardrail_input_max_chars: number;
  /** Max chars of a serialised tool-call action passed into guardrail regex evaluators. Default: 4000. */
  guardrail_action_max_chars: number;

  // Attachments
  /** Max chars of attachment content inlined into the model context. Default: 12000. */
  attachment_inline_max_chars: number;

  // Chat input
  /** Max chars for a user-supplied systemPrompt. Default: 32000. */
  system_prompt_max_chars: number;

  // CSE / sandbox
  /** Execution wall-clock timeout ms. Default: 30000. */
  cse_timeout_ms: number;
  /** Container memory limit in MiB. Default: 512. */
  cse_memory_mb: number;
  /** Container CPU cores. Default: 1. */
  cse_cpu_count: number;
  /** Max processes inside the container (prevents fork bombs). Default: 256. */
  cse_pids_limit: number;
  /** Session idle TTL ms. Default: 600000 (10 min). */
  cse_session_ttl_ms: number;
  /** Max concurrent session containers per server. Default: 20. */
  cse_max_sessions: number;
}

// ─── Code defaults (floors) ───────────────────────────────────────────────────

export const CODE_DEFAULTS: Readonly<PlatformLimits> = {
  chat_max_steps: 20,
  chat_max_tokens: 4096,
  guardrail_input_max_chars: 8_000,
  guardrail_action_max_chars: 4_000,
  attachment_inline_max_chars: 12_000,
  system_prompt_max_chars: 32_000,
  cse_timeout_ms: 30_000,
  cse_memory_mb: 512,
  cse_cpu_count: 1,
  cse_pids_limit: 256,
  cse_session_ttl_ms: 10 * 60_000,
  cse_max_sessions: 20,
};

/** Absolute floor values — no DB override can push a limit below these. */
const HARD_FLOORS: Readonly<Partial<PlatformLimits>> = {
  chat_max_steps: 1,
  chat_max_tokens: 256,
  guardrail_input_max_chars: 512,
  guardrail_action_max_chars: 256,
  attachment_inline_max_chars: 256,
  system_prompt_max_chars: 256,
  cse_timeout_ms: 1_000,
  cse_memory_mb: 64,
  cse_cpu_count: 0.1,
  cse_pids_limit: 64,
  cse_session_ttl_ms: 30_000,
  cse_max_sessions: 1,
};

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: PlatformLimits;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

function cacheGet(key: string): PlatformLimits | null {
  const entry = _cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: PlatformLimits): void {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseLimitsFromOverrides(configOverrides: string | null | undefined): Partial<PlatformLimits> {
  if (!configOverrides) return {};
  try {
    const parsed = JSON.parse(configOverrides) as Record<string, unknown>;
    const raw = parsed['limits'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const limits: Partial<PlatformLimits> = {};
    const keys = Object.keys(CODE_DEFAULTS) as Array<keyof PlatformLimits>;
    for (const key of keys) {
      const val = (raw as Record<string, unknown>)[key];
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        (limits as Record<string, number>)[key] = val;
      }
    }
    return limits;
  } catch {
    return {};
  }
}

function applyFloors(limits: PlatformLimits): PlatformLimits {
  const result = { ...limits };
  for (const [k, floor] of Object.entries(HARD_FLOORS) as Array<[keyof PlatformLimits, number]>) {
    if ((result[k] as number) < floor) {
      (result as Record<string, number>)[k] = floor;
    }
  }
  return result;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the effective limits for an optional tenantId.
 *
 * Cache is module-level with a 60 s TTL. Hot path: cache hit costs one Map
 * lookup and a Date.now() comparison. Cache miss costs two async DB reads.
 */
export async function resolveLimits(
  db: DatabaseAdapter,
  tenantId?: string | null,
): Promise<PlatformLimits> {
  const cacheKey = tenantId ?? '__platform__';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const [globalRow, tenantRow] = await Promise.all([
    db.getGlobalTenantConfig(),
    tenantId ? db.getTenantConfigForTenant(tenantId) : Promise.resolve(null),
  ]);

  const platformOverrides = parseLimitsFromOverrides(globalRow?.config_overrides);
  const tenantOverrides = tenantId ? parseLimitsFromOverrides(tenantRow?.config_overrides) : {};

  const merged = applyFloors({
    ...CODE_DEFAULTS,
    ...platformOverrides,
    ...tenantOverrides,
  });

  cacheSet(cacheKey, merged);
  return merged;
}

/**
 * Invalidate cache entries. Call after writing limit overrides to the DB.
 * Passing a tenantId invalidates only that tenant's entry. No argument clears all.
 */
export function invalidateLimitsCache(tenantId?: string | null): void {
  if (tenantId) {
    _cache.delete(tenantId);
    _cache.delete('__platform__'); // platform change affects all derived entries
  } else {
    _cache.clear();
  }
}

/**
 * Merge limit overrides into an existing config_overrides JSON string.
 * Preserves all non-limits keys already present.
 */
export function mergeLimitsIntoOverrides(
  existing: string | null | undefined,
  limits: Partial<PlatformLimits>,
): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try { base = JSON.parse(existing) as Record<string, unknown>; } catch { /* ignore */ }
  }
  const currentLimits = (base['limits'] as Record<string, unknown>) ?? {};
  base['limits'] = { ...currentLimits, ...limits };
  return JSON.stringify(base);
}
