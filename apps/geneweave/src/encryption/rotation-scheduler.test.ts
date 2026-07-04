/**
 * Phase 5 — Encryption rotation scheduler unit tests.
 *
 * Drives `tickNow()` directly with stubbed DatabaseAdapter + TenantKeyManager.
 * No real timers, no DB.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TenantKeyManager } from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../db-types.js';
import { startEncryptionRotationScheduler } from './rotation-scheduler.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeStubManager(): {
  manager: TenantKeyManager;
  rotateCalls: Array<{ tenantId: string; actor: string | null }>;
} {
  const rotateCalls: Array<{ tenantId: string; actor: string | null }> = [];
  const manager = {
    rotateDek: vi.fn(async (tenantId: string, actor: string | null) => {
      rotateCalls.push({ tenantId, actor });
      return { kekId: 'kek', dekId: 'dek-new', epoch: 99 };
    }),
  } as unknown as TenantKeyManager;
  return { manager, rotateCalls };
}

interface PolicyRow {
  tenant_id: string;
  enabled: 0 | 1;
  rotation_schedule: string;
}

interface DekRow {
  id: string;
  tenant_id: string;
  epoch: number;
  status: 'active' | 'previous' | 'revoked';
  created_at: number;
}

function makeStubDb(opts: {
  policies: PolicyRow[];
  deksByTenant: Record<string, DekRow[]>;
  listDeksThrowsFor?: string;
}): DatabaseAdapter {
  return {
    listTenantEncryptionPolicies: vi.fn(
      async (filters?: { enabledOnly?: boolean }) => {
        const rows = opts.policies;
        if (filters?.enabledOnly) return rows.filter((p) => p.enabled === 1);
        return rows;
      },
    ),
    listTenantDeks: vi.fn(async (tenantId: string) => {
      if (opts.listDeksThrowsFor === tenantId) {
        throw new Error('boom');
      }
      return opts.deksByTenant[tenantId] ?? [];
    }),
  } as unknown as DatabaseAdapter;
}

describe('startEncryptionRotationScheduler.tickNow', () => {
  const now = Date.now();

  it('returns manager_unavailable when getManager() is null', async () => {
    const db = makeStubDb({ policies: [], deksByTenant: {} });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => null,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result).toEqual({
        checked: 0,
        rotated: 0,
        errors: 0,
        skipped: 'manager_unavailable',
      });
    } finally {
      handle.stop();
    }
  });

  it('skips manual schedule entries', async () => {
    const { manager, rotateCalls } = makeStubManager();
    const db = makeStubDb({
      policies: [{ tenant_id: 't1', enabled: 1, rotation_schedule: 'manual' }],
      deksByTenant: {
        t1: [
          { id: 'd1', tenant_id: 't1', epoch: 1, status: 'active', created_at: now - 365 * DAY_MS },
        ],
      },
    });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result).toEqual({ checked: 0, rotated: 0, errors: 0 });
      expect(rotateCalls).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it('rotates monthly tenant whose active DEK is older than 30 days', async () => {
    const { manager, rotateCalls } = makeStubManager();
    const db = makeStubDb({
      policies: [{ tenant_id: 't1', enabled: 1, rotation_schedule: 'monthly' }],
      deksByTenant: {
        t1: [
          { id: 'd1', tenant_id: 't1', epoch: 1, status: 'active', created_at: now - 31 * DAY_MS },
        ],
      },
    });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result).toEqual({ checked: 1, rotated: 1, errors: 0 });
      expect(rotateCalls).toEqual([
        { tenantId: 't1', actor: 'system:rotation-scheduler' },
      ]);
    } finally {
      handle.stop();
    }
  });

  it('skips monthly tenant whose active DEK is younger than threshold', async () => {
    const { manager, rotateCalls } = makeStubManager();
    const db = makeStubDb({
      policies: [{ tenant_id: 't1', enabled: 1, rotation_schedule: 'monthly' }],
      deksByTenant: {
        t1: [
          { id: 'd1', tenant_id: 't1', epoch: 1, status: 'active', created_at: now - 5 * DAY_MS },
        ],
      },
    });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result).toEqual({ checked: 1, rotated: 0, errors: 0 });
      expect(rotateCalls).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it('honors enabledOnly filter (does not see disabled policies)', async () => {
    const { manager, rotateCalls } = makeStubManager();
    const db = makeStubDb({
      policies: [
        { tenant_id: 't1', enabled: 0, rotation_schedule: 'monthly' },
      ],
      deksByTenant: {
        t1: [
          { id: 'd1', tenant_id: 't1', epoch: 1, status: 'active', created_at: now - 365 * DAY_MS },
        ],
      },
    });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result).toEqual({ checked: 0, rotated: 0, errors: 0 });
      expect(rotateCalls).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it('per-tenant error does not halt iteration; counts errors', async () => {
    const { manager, rotateCalls } = makeStubManager();
    const db = makeStubDb({
      policies: [
        { tenant_id: 't1', enabled: 1, rotation_schedule: 'monthly' },
        { tenant_id: 't2', enabled: 1, rotation_schedule: 'monthly' },
      ],
      deksByTenant: {
        t2: [
          { id: 'd2', tenant_id: 't2', epoch: 1, status: 'active', created_at: now - 31 * DAY_MS },
        ],
      },
      listDeksThrowsFor: 't1',
    });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result).toEqual({ checked: 2, rotated: 1, errors: 1 });
      expect(rotateCalls).toEqual([
        { tenantId: 't2', actor: 'system:rotation-scheduler' },
      ]);
    } finally {
      handle.stop();
    }
  });

  it('honors quarterly threshold (90 days)', async () => {
    const { manager, rotateCalls } = makeStubManager();
    const db = makeStubDb({
      policies: [{ tenant_id: 't1', enabled: 1, rotation_schedule: 'quarterly' }],
      deksByTenant: {
        t1: [
          { id: 'd1', tenant_id: 't1', epoch: 1, status: 'active', created_at: now - 60 * DAY_MS },
          { id: 'd0', tenant_id: 't1', epoch: 0, status: 'previous', created_at: now - 200 * DAY_MS },
        ],
      },
    });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      // 60 days < 90 day threshold → no rotation
      const result = await handle.tickNow();
      expect(result).toEqual({ checked: 1, rotated: 0, errors: 0 });
      expect(rotateCalls).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it('only considers max-epoch active DEK for age calculation', async () => {
    // Two active rows (defensive — shouldn't happen in practice). Newer
    // (higher epoch) should win even if older one exceeds threshold.
    const { manager, rotateCalls } = makeStubManager();
    const db = makeStubDb({
      policies: [{ tenant_id: 't1', enabled: 1, rotation_schedule: 'monthly' }],
      deksByTenant: {
        t1: [
          { id: 'd-old', tenant_id: 't1', epoch: 1, status: 'active', created_at: now - 365 * DAY_MS },
          { id: 'd-new', tenant_id: 't1', epoch: 2, status: 'active', created_at: now - 1 * DAY_MS },
        ],
      },
    });
    const handle = startEncryptionRotationScheduler({
      db,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result).toEqual({ checked: 1, rotated: 0, errors: 0 });
      expect(rotateCalls).toEqual([]);
    } finally {
      handle.stop();
    }
  });
});
