/**
 * Tenant Encryption — Phase 5
 *
 * Background job that honors `tenant_encryption_policy.rotation_schedule`
 * (monthly | quarterly | annual) and auto-rotates DEKs when the active
 * key's age exceeds the schedule threshold.
 *
 * Consumes the frozen `weaveDekRotator` primitive from `@weaveintel/encryption`
 * (which delegates to `manager.rotateDek` — that already emits a `'dek_rotate'`
 * audit event, so the scheduler MUST NOT double-emit).
 *
 * Reads policy + DEK rows directly via the geneweave `DatabaseAdapter`
 * (bypasses `EncryptionStore`, which is engine-internal). Per-tenant
 * try/catch ensures one failure does not halt iteration.
 *
 * Designed for `setInterval(...).unref()` — same pattern as
 * `startToolHealthJob`. `tickNow()` is exposed for deterministic testing
 * without real timers.
 */

import { weaveDekRotator, type TenantKeyManager } from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../db-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_THRESHOLDS_MS: Record<string, number> = {
  monthly: 30 * DAY_MS,
  quarterly: 90 * DAY_MS,
  annual: 365 * DAY_MS,
};

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SCHEDULER_ACTOR = 'system:rotation-scheduler';

export interface RotationSchedulerTickResult {
  readonly checked: number;
  readonly rotated: number;
  readonly errors: number;
  readonly skipped?: 'manager_unavailable';
}

export interface StartEncryptionRotationSchedulerOptions {
  readonly db: DatabaseAdapter;
  readonly getManager: () => TenantKeyManager | null;
  readonly intervalMs?: number;
  readonly log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EncryptionRotationSchedulerHandle {
  readonly stop: () => void;
  readonly tickNow: () => Promise<RotationSchedulerTickResult>;
}

export function startEncryptionRotationScheduler(
  opts: StartEncryptionRotationSchedulerOptions,
): EncryptionRotationSchedulerHandle {
  const { db, getManager } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.log ?? ((msg, meta) => console.log(msg, meta ?? {}));

  async function runOnce(): Promise<RotationSchedulerTickResult> {
    const manager = getManager();
    if (!manager) {
      return { checked: 0, rotated: 0, errors: 0, skipped: 'manager_unavailable' };
    }
    const rotator = weaveDekRotator({ manager });
    const policies = await db.listTenantEncryptionPolicies({ enabledOnly: true });
    const now = Date.now();
    let checked = 0;
    let rotated = 0;
    let errors = 0;

    for (const policy of policies) {
      const threshold = SCHEDULE_THRESHOLDS_MS[policy.rotation_schedule];
      if (!threshold) continue; // 'manual' or unknown schedule → skip
      checked++;
      try {
        const deks = await db.listTenantDeks(policy.tenant_id);
        const active = deks
          .filter((d) => d.status === 'active')
          .sort((a, b) => b.epoch - a.epoch)[0];
        if (!active) continue;
        const age = now - active.created_at;
        if (age <= threshold) continue;
        await rotator.rotate(policy.tenant_id, SCHEDULER_ACTOR);
        rotated++;
        log('[encryption] rotation scheduler: rotated DEK', {
          tenantId: policy.tenant_id,
          schedule: policy.rotation_schedule,
          previousEpoch: active.epoch,
          ageDays: Math.floor(age / DAY_MS),
        });
      } catch (err) {
        errors++;
        log('[encryption] rotation scheduler: tenant rotation failed', {
          tenantId: policy.tenant_id,
          error: String(err),
        });
      }
    }

    log('[encryption] rotation scheduler tick', { checked, rotated, errors });
    return { checked, rotated, errors };
  }

  const timer = setInterval(() => {
    runOnce().catch((err) => {
      log('[encryption] rotation scheduler tick threw', { error: String(err) });
    });
  }, intervalMs);
  // Allow process to exit cleanly during tests / shutdown.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => clearInterval(timer),
    tickNow: runOnce,
  };
}
