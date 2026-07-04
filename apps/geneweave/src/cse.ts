/**
 * @weaveintel/geneweave — Compute Sandbox Engine integration
 *
 * Lazy singleton that initialises the CSE from environment variables.
 * All CSE routes in server.ts use `getCSE()` to access the engine.
 */

import { ComputeSandboxEngine, buildCSEConfig } from '@weaveintel/sandbox';
import type { DatabaseAdapter } from './db.js';
import { resolveLimits } from './platform-limits.js';

let engine: ComputeSandboxEngine | null = null;
let initPromise: Promise<ComputeSandboxEngine> | null = null;

/** Returns true when CSE is available (local Docker is always available as fallback). */
export function isCSEEnabled(): boolean {
  const env = process.env;
  // If explicitly disabled, respect that.
  if (env['CSE_ENABLED'] === 'false') return false;
  // Local Docker is always the fallback — no env vars required.
  return true;
}

/**
 * Build a CSE config merging env-var overrides with platform DB limits.
 * DB limits take effect only when a db reference is supplied; env vars
 * always win over DB values so operators can still use env overrides.
 */
export async function buildCSEConfigWithLimits(db?: DatabaseAdapter) {
  const base = buildCSEConfig();
  if (!db) return base;

  const limits = await resolveLimits(db);
  const env = process.env;

  return {
    ...base,
    // DB limit is used only when the corresponding env var is absent
    timeoutMs:      base.timeoutMs      ?? (env['CSE_TIMEOUT_MS']   ? undefined : limits.cse_timeout_ms),
    memoryMb:       base.memoryMb       ?? (env['CSE_MEMORY_MB']    ? undefined : limits.cse_memory_mb),
    cpuCount:       base.cpuCount       ?? (env['CSE_CPU_COUNT']    ? undefined : limits.cse_cpu_count),
    pidsLimit:      base.pidsLimit      ?? (env['CSE_PIDS_LIMIT']   ? undefined : limits.cse_pids_limit),
    sessionTtlMs:   base.sessionTtlMs   ?? (env['CSE_SESSION_TTL_MS'] ? undefined : limits.cse_session_ttl_ms),
    maxSessions:    base.maxSessions    ?? (env['CSE_MAX_SESSIONS'] ? undefined : limits.cse_max_sessions),
  };
}

/**
 * Get (or lazily initialise) the ComputeSandboxEngine.
 * Returns null if CSE is not configured.
 */
export async function getCSE(db?: DatabaseAdapter): Promise<ComputeSandboxEngine | null> {
  if (!isCSEEnabled()) return null;
  if (engine) return engine;
  if (initPromise) return initPromise;

  initPromise = buildCSEConfigWithLimits(db).then((cfg) =>
    ComputeSandboxEngine.create(cfg)
  ).then((e) => {
    engine = e;
    return e;
  }).catch((err: unknown) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

/** Shut down the engine (call on process exit). */
export async function shutdownCSE(): Promise<void> {
  if (engine) await engine.shutdown();
  engine = null;
  initPromise = null;
}
