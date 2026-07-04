/**
 * GeneWeave — anyWeave Task-Aware Routing Phase 6: Capability Matrix Cache
 *
 * Process-wide TTL cache for the three DB reads that `routeModel()` does on
 * every chat turn:
 *   - listCapabilityScores({ tenantId })
 *   - listTaskTypes()
 *   - listModelPricing()
 *
 * Default TTL: 60 s (per spec §13 Phase 6 #1).
 * Override via env: GENEWEAVE_ROUTING_CACHE_TTL_MS (number, ms).
 *
 * The cache exposes invalidate hooks so admin mutations can flush eagerly.
 */

import type {
  DatabaseAdapter,
  ModelCapabilityScoreRow,
  TaskTypeDefinitionRow,
  ModelPricingRow,
} from './db-types.js';

const DEFAULT_TTL_MS = 60_000;

function envTtl(): number {
  const raw = process.env['GENEWEAVE_ROUTING_CACHE_TTL_MS'];
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  ttlMs: number;
}

export class CapabilityMatrixCache {
  private readonly ttlMs: number;
  private capabilityScores = new Map<string, CacheEntry<ModelCapabilityScoreRow[]>>();
  private taskTypes: CacheEntry<TaskTypeDefinitionRow[]> | null = null;
  private modelPricing: CacheEntry<ModelPricingRow[]> | null = null;
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? envTtl();
  }

  async getCapabilityScores(
    db: DatabaseAdapter,
    tenantId: string | null,
  ): Promise<ModelCapabilityScoreRow[]> {
    const key = tenantId ?? '__global__';
    const hit = this.capabilityScores.get(key);
    const now = Date.now();
    if (hit && hit.expiresAt > now) {
      this.hits++;
      return hit.value;
    }
    this.misses++;
    const value = await db.listCapabilityScores({ tenantId });
    this.capabilityScores.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  async getTaskTypes(db: DatabaseAdapter): Promise<TaskTypeDefinitionRow[]> {
    const now = Date.now();
    if (this.taskTypes && this.taskTypes.expiresAt > now) {
      this.hits++;
      return this.taskTypes.value;
    }
    this.misses++;
    const value = await db.listTaskTypes();
    this.taskTypes = { value, expiresAt: now + this.ttlMs };
    return value;
  }

  async getModelPricing(db: DatabaseAdapter): Promise<ModelPricingRow[]> {
    const now = Date.now();
    if (this.modelPricing && this.modelPricing.expiresAt > now) {
      this.hits++;
      return this.modelPricing.value;
    }
    this.misses++;
    const value = await db.listModelPricing();
    this.modelPricing = { value, expiresAt: now + this.ttlMs };
    return value;
  }

  /** Flush all entries. Call from admin mutations on capability/task/pricing tables. */
  invalidateAll(): void {
    this.capabilityScores.clear();
    this.taskTypes = null;
    this.modelPricing = null;
    this.invalidations++;
  }

  invalidateCapabilityScores(): void {
    this.capabilityScores.clear();
    this.invalidations++;
  }

  invalidateTaskTypes(): void {
    this.taskTypes = null;
    this.invalidations++;
  }

  invalidateModelPricing(): void {
    this.modelPricing = null;
    this.invalidations++;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, invalidations: this.invalidations, ttlMs: this.ttlMs };
  }
}

// Process-wide singleton — shared across all chat turns.
let _instance: CapabilityMatrixCache | null = null;

export function getCapabilityMatrixCache(): CapabilityMatrixCache {
  if (!_instance) _instance = new CapabilityMatrixCache();
  return _instance;
}

/** Test-only: reset the singleton (used by examples / tests). */
export function resetCapabilityMatrixCache(): void {
  _instance = null;
}
