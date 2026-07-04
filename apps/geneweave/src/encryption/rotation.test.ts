/**
 * Phase 5 (5.13) — Encryption rotation integration test.
 *
 * Golden path: bootstrap tenant → encrypt records with epoch-1 DEK →
 * simulate age-triggered rotation via scheduler tickNow() → verify
 * old ciphertext (epoch 1) still decrypts correctly after rotation, and
 * new ciphertext uses epoch-2 DEK.
 *
 * Uses in-process InMemoryStore + LocalKmsProvider so the test is fully
 * hermetic — no DB, no KMS network calls.
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  weaveTenantKeyManager,
  LocalKmsProvider,
  type EncryptionStore,
  type AuditEmitter,
  type EncryptionAuditEvent,
  type BikRecord,
  type DekRecord,
  type KekRecord,
  type KeyStatus,
  type TenantPolicyRecord,
} from '@weaveintel/encryption';
import { startEncryptionRotationScheduler } from './rotation-scheduler.js';
import type { DatabaseAdapter } from '../db-types.js';

// ─── Minimal in-memory EncryptionStore (mirrors rotator.test.ts) ──────────

class InMemoryEncryptionStore implements EncryptionStore {
  policy: TenantPolicyRecord | null = null;
  keks: KekRecord[] = [];
  deks: DekRecord[] = [];
  biks: BikRecord[] = [];
  async getPolicy() { return this.policy; }
  async upsertPolicy(p: TenantPolicyRecord) { this.policy = p; }
  async listKeks() { return [...this.keks]; }
  async insertKek(k: KekRecord) { this.keks.push(k); }
  async updateKekStatus(id: string, s: KeyStatus, ts: number) {
    this.keks = this.keks.map((k) =>
      k.id === id ? { ...k, status: s, rotatedAt: s === 'previous' ? ts : k.rotatedAt, revokedAt: s === 'revoked' ? ts : k.revokedAt } : k,
    );
  }
  async getKekById(_t: string, id: string) { return this.keks.find((k) => k.id === id) ?? null; }
  async listDeks() { return [...this.deks]; }
  async insertDek(d: DekRecord) { this.deks.push(d); }
  async updateDekStatus(id: string, s: KeyStatus, ts: number) {
    this.deks = this.deks.map((d) =>
      d.id === id ? { ...d, status: s, rotatedAt: s === 'previous' ? ts : d.rotatedAt, revokedAt: s === 'revoked' ? ts : d.revokedAt } : d,
    );
  }
  async getDekById(_t: string, id: string) { return this.deks.find((d) => d.id === id) ?? null; }
  async getMaxDekEpoch(_t: string) {
    const active = this.deks.filter((d) => d.status === 'active');
    return active.length ? Math.max(...active.map((d) => d.epoch)) : null;
  }
  async listBiks() { return [...this.biks]; }
  async insertBik(b: BikRecord) { this.biks.push(b); }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map((bk) =>
      bk.id === id ? { ...bk, status: s, revokedAt: s === 'revoked' ? ts : bk.revokedAt } : bk,
    );
  }
  async deletePolicy() { this.policy = null; }
  async deleteAllWrappedMaterial() {
    const counts = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = []; this.deks = []; this.biks = [];
    return counts;
  }
}

class CapturingAuditEmitter implements AuditEmitter {
  events: EncryptionAuditEvent[] = [];
  async emit(e: EncryptionAuditEvent) { this.events.push(e); }
}

// ─── Minimal stub DatabaseAdapter for the scheduler ──────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function makeSchedulerDb(encStore: InMemoryEncryptionStore, tenantId: string): DatabaseAdapter {
  return {
    listTenantEncryptionPolicies: async (filters?: { enabledOnly?: boolean }) => {
      const rows = [{ tenant_id: tenantId, enabled: 1 as const, rotation_schedule: 'monthly' }];
      if (filters?.enabledOnly) return rows.filter((r) => r.enabled === 1);
      return rows;
    },
    listTenantDeks: async (tid: string) => {
      if (tid !== tenantId) return [];
      return encStore.deks
        .filter((d) => d.tenantId === tid)
        .map((d) => ({
          id: d.id,
          tenant_id: d.tenantId,
          epoch: d.epoch,
          status: d.status as 'active' | 'previous' | 'revoked',
          created_at: d.createdAt ?? 0,
        }));
    },
  } as unknown as DatabaseAdapter;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Encryption rotation integration', () => {
  it('decrypts epoch-1 ciphertext after age-triggered DEK rotation', async () => {
    const store = new InMemoryEncryptionStore();
    const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
    const audit = new CapturingAuditEmitter();
    const manager = weaveTenantKeyManager({ store, kms, audit });

    const tenantId = 'tenant-rotation-test';
    await manager.bootstrapTenant({ tenantId });

    // Backdate the active DEK's createdAt to 31 days ago so the scheduler
    // sees it as overdue for monthly rotation.
    const activeDek = store.deks.find((d) => d.status === 'active' && d.tenantId === tenantId);
    expect(activeDek).toBeDefined();
    if (activeDek) {
      (activeDek as { createdAt: number }).createdAt = Date.now() - 31 * DAY_MS;
    }
    expect(activeDek?.epoch).toBe(1);

    // Encrypt two rows with the epoch-1 DEK.
    const ct1 = await manager.encrypt({ tenantId, table: 'messages', column: 'content', rowId: 'r1', plaintext: 'hello world' });
    const ct2 = await manager.encrypt({ tenantId, table: 'messages', column: 'content', rowId: 'r2', plaintext: 'secret data' });
    expect(ct1).toMatch(/^enc:v1:1:/);
    expect(ct2).toMatch(/^enc:v1:1:/);

    // Run the scheduler — should rotate because 31 days > 30-day threshold.
    const schedulerDb = makeSchedulerDb(store, tenantId);
    const handle = startEncryptionRotationScheduler({
      db: schedulerDb,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result.rotated).toBe(1);
      expect(result.errors).toBe(0);
    } finally {
      handle.stop();
    }

    // A dek_rotate audit event must have been emitted.
    expect(audit.events.some((e) => e.eventKind === 'dek_rotate')).toBe(true);

    // Old epoch-1 ciphertext must still decrypt correctly.
    const pt1 = await manager.decrypt({ tenantId, table: 'messages', column: 'content', rowId: 'r1', value: ct1 });
    expect(pt1).toBe('hello world');

    const pt2 = await manager.decrypt({ tenantId, table: 'messages', column: 'content', rowId: 'r2', value: ct2 });
    expect(pt2).toBe('secret data');

    // New encryptions must use epoch 2.
    const ct3 = await manager.encrypt({ tenantId, table: 'messages', column: 'content', rowId: 'r3', plaintext: 'after rotation' });
    expect(ct3).toMatch(/^enc:v1:2:/);
    const pt3 = await manager.decrypt({ tenantId, table: 'messages', column: 'content', rowId: 'r3', value: ct3 });
    expect(pt3).toBe('after rotation');
  });

  it('does not rotate when active DEK is younger than the schedule threshold', async () => {
    const store = new InMemoryEncryptionStore();
    const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
    const audit = new CapturingAuditEmitter();
    const manager = weaveTenantKeyManager({ store, kms, audit });

    const tenantId = 'tenant-no-rotate';
    await manager.bootstrapTenant({ tenantId });

    const ct = await manager.encrypt({ tenantId, table: 'logs', column: 'body', rowId: 'r1', plaintext: 'payload' });
    expect(ct).toMatch(/^enc:v1:1:/);

    // DEK was just created — well within the 30-day threshold.
    const schedulerDb = makeSchedulerDb(store, tenantId);
    const handle = startEncryptionRotationScheduler({
      db: schedulerDb,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });
    try {
      const result = await handle.tickNow();
      expect(result.rotated).toBe(0);
    } finally {
      handle.stop();
    }

    // Ciphertext still decrypts correctly and epoch did not change.
    const pt = await manager.decrypt({ tenantId, table: 'logs', column: 'body', rowId: 'r1', value: ct });
    expect(pt).toBe('payload');

    const activeDekAfter = store.deks.find((d) => d.status === 'active' && d.tenantId === tenantId);
    expect(activeDekAfter?.epoch).toBe(1);
  });

  it('handles multiple rotations: epoch chain 1 → 2 → 3, all ciphertexts remain decryptable', async () => {
    const store = new InMemoryEncryptionStore();
    const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
    const manager = weaveTenantKeyManager({ store, kms });

    const tenantId = 'tenant-chain';
    await manager.bootstrapTenant({ tenantId });

    // Epoch 1 ciphertext.
    const ct1 = await manager.encrypt({ tenantId, table: 't', column: 'c', rowId: 'r1', plaintext: 'epoch-1' });
    expect(ct1).toMatch(/^enc:v1:1:/);

    // Force DEK age and run first rotation (1 → 2).
    const backdate = (epochTarget: number) => {
      const dek = store.deks.find((d) => d.status === 'active' && d.epoch === epochTarget);
      if (dek) (dek as { createdAt: number }).createdAt = Date.now() - 31 * DAY_MS;
    };

    backdate(1);
    const schedulerDb = makeSchedulerDb(store, tenantId);
    const handle = startEncryptionRotationScheduler({
      db: schedulerDb,
      getManager: () => manager,
      intervalMs: 999_999,
      log: () => {},
    });

    try {
      await handle.tickNow();

      const ct2 = await manager.encrypt({ tenantId, table: 't', column: 'c', rowId: 'r2', plaintext: 'epoch-2' });
      expect(ct2).toMatch(/^enc:v1:2:/);

      // Force second rotation (2 → 3).
      backdate(2);
      await handle.tickNow();

      const ct3 = await manager.encrypt({ tenantId, table: 't', column: 'c', rowId: 'r3', plaintext: 'epoch-3' });
      expect(ct3).toMatch(/^enc:v1:3:/);

      // All three epochs must still decrypt.
      expect(await manager.decrypt({ tenantId, table: 't', column: 'c', rowId: 'r1', value: ct1 })).toBe('epoch-1');
      expect(await manager.decrypt({ tenantId, table: 't', column: 'c', rowId: 'r2', value: ct2 })).toBe('epoch-2');
      expect(await manager.decrypt({ tenantId, table: 't', column: 'c', rowId: 'r3', value: ct3 })).toBe('epoch-3');
    } finally {
      handle.stop();
    }
  });
});
