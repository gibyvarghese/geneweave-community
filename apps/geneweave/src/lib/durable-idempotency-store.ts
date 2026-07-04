/**
 * Shared DB-backed durable idempotency store for geneweave admin + feature routes.
 *
 * Phase B (Durable consumers): both admin idempotency and feature-route
 * idempotency now share one canonical helper that delegates to
 * `idempotency_records` via the `DatabaseAdapter`. Replaces the previous
 * per-file `createIdempotencyStore({ ttlMs })` (in-memory, lost on
 * restart) with `createDurableIdempotencyStore(...)` from
 * `@weaveintel/resilience`.
 *
 * The same `idempotency_records` table is used everywhere so operators
 * have one place to inspect / clear stale keys, and replays survive
 * across process restarts.
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  createDurableIdempotencyStore,
  type AsyncIdempotencyStore,
  type DurableIdempotencyEntry,
  type IdempotencyPolicy,
} from '@weaveintel/resilience';
import type { DatabaseAdapter } from '../db.js';

const DEFAULT_POLICY: IdempotencyPolicy = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 10_000,
};

export function createDbBackedIdempotencyStore(
  db: DatabaseAdapter,
  policy: IdempotencyPolicy = DEFAULT_POLICY,
): AsyncIdempotencyStore {
  return createDurableIdempotencyStore(policy, {
    async get(key: string) {
      const record = await db.getIdempotencyRecordByKey(key);
      if (!record) return null;
      return {
        result: JSON.parse(record.result_json) as unknown,
        expiresAt: Date.parse(record.expires_at),
      };
    },
    async set(key: string, entry: DurableIdempotencyEntry) {
      await db.createIdempotencyRecord({
        id: newUUIDv7(),
        key,
        result_json: JSON.stringify(entry.result),
        expires_at: new Date(entry.expiresAt).toISOString(),
      });
    },
    async deleteExpired(nowMs: number) {
      await db.deleteExpiredIdempotencyRecords(new Date(nowMs).toISOString());
    },
    async trimOldest(maxEntries: number) {
      await db.trimIdempotencyRecords(maxEntries);
    },
    async clear() {
      await db.clearIdempotencyRecords();
    },
  });
}
