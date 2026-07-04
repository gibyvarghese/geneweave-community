/**
 * GeneWeave: SQLite-backed EncryptionStore implementation for
 * @weaveintel/encryption. Translates between the package's record shapes and
 * the `tenant_encryption_policy`, `tenant_keks`, `tenant_deks`, `tenant_biks`
 * SQLite tables. The package never imports DB types — this adapter wraps
 * `DatabaseAdapter` and feeds the package via the structural `EncryptionStore`
 * interface.
 */

import {
  type EncryptionStore,
  type TenantPolicyRecord,
  type KekRecord,
  type DekRecord,
  type BikRecord,
  type KeyStatus,
  type FieldPolicy,
  type SerializedWrappedKey,
} from '@weaveintel/encryption';
import type {
  DatabaseAdapter,
  TenantEncryptionPolicyRow,
  TenantKekRow,
  TenantDekRow,
  TenantBikRow,
} from '../db-types.js';

function rowToPolicy(r: TenantEncryptionPolicyRow): TenantPolicyRecord {
  let kmsConfig: Record<string, unknown> | null = null;
  if (r.kms_config) {
    try { kmsConfig = JSON.parse(r.kms_config) as Record<string, unknown>; } catch { kmsConfig = null; }
  }
  let fieldPolicy: FieldPolicy = {};
  try { fieldPolicy = JSON.parse(r.field_policy || '{}') as FieldPolicy; } catch { fieldPolicy = {}; }
  return {
    tenantId: r.tenant_id,
    enabled: r.enabled === 1,
    kmsProviderId: r.kms_provider_id,
    kmsConfig,
    activeKekId: r.active_kek_id,
    activeDekId: r.active_dek_id,
    activeBikId: r.active_bik_id,
    rotationSchedule: r.rotation_schedule,
    blindIndexEnabled: r.blind_index_enabled === 1,
    fieldPolicy,
    shredRequestedAt: r.shred_requested_at,
    shredCompletedAt: r.shred_completed_at,
  };
}

function rowToKek(r: TenantKekRow): KekRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    version: r.version,
    status: r.status as KeyStatus,
    wrapped: JSON.parse(r.wrapped) as SerializedWrappedKey,
    createdAt: r.created_at,
    rotatedAt: r.rotated_at,
    revokedAt: r.revoked_at,
  };
}

function rowToDek(r: TenantDekRow): DekRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kekId: r.kek_id,
    epoch: r.epoch,
    status: r.status as KeyStatus,
    wrapped: JSON.parse(r.wrapped) as SerializedWrappedKey,
    createdAt: r.created_at,
    rotatedAt: r.rotated_at,
    revokedAt: r.revoked_at,
  };
}

function rowToBik(r: TenantBikRow): BikRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    epoch: r.epoch,
    status: r.status as KeyStatus,
    wrapped: JSON.parse(r.wrapped) as SerializedWrappedKey,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    kekId: r.kek_id,
  };
}

export function createDbEncryptionStore(db: DatabaseAdapter): EncryptionStore {
  return {
    async getPolicy(tenantId) {
      const r = await db.getTenantEncryptionPolicy(tenantId);
      return r ? rowToPolicy(r) : null;
    },
    async upsertPolicy(p) {
      await db.upsertTenantEncryptionPolicy({
        tenant_id: p.tenantId,
        enabled: p.enabled ? 1 : 0,
        kms_provider_id: p.kmsProviderId,
        kms_config: p.kmsConfig ? JSON.stringify(p.kmsConfig) : null,
        active_kek_id: p.activeKekId,
        active_dek_id: p.activeDekId,
        active_bik_id: p.activeBikId,
        rotation_schedule: p.rotationSchedule,
        blind_index_enabled: p.blindIndexEnabled ? 1 : 0,
        field_policy: JSON.stringify(p.fieldPolicy ?? {}),
        shred_requested_at: p.shredRequestedAt,
        shred_completed_at: p.shredCompletedAt,
      });
    },
    async listKeks(tenantId) {
      return (await db.listTenantKeks(tenantId)).map(rowToKek);
    },
    // H-13: Point lookup — avoids O(n) list scan on every encrypt/decrypt.
    async getKekById(tenantId, kekId) {
      const r = await db.getTenantKekById(tenantId, kekId);
      return r ? rowToKek(r) : null;
    },
    async insertKek(k) {
      await db.insertTenantKek({
        id: k.id,
        tenant_id: k.tenantId,
        version: k.version,
        status: k.status,
        wrapped: JSON.stringify(k.wrapped),
        created_at: k.createdAt,
        rotated_at: k.rotatedAt,
        revoked_at: k.revokedAt,
      });
    },
    async updateKekStatus(id, status, ts) {
      await db.updateTenantKekStatus(id, status, ts);
    },
    async listDeks(tenantId) {
      return (await db.listTenantDeks(tenantId)).map(rowToDek);
    },
    // H-13: Point lookup — avoids O(n) list scan on every decrypt.
    async getDekById(tenantId, dekId) {
      const r = await db.getTenantDekById(tenantId, dekId);
      return r ? rowToDek(r) : null;
    },
    // H-13: Returns the highest active DEK epoch — used by rotation path.
    async getMaxDekEpoch(tenantId) {
      return db.getMaxTenantDekEpoch(tenantId);
    },
    async insertDek(d) {
      await db.insertTenantDek({
        id: d.id,
        tenant_id: d.tenantId,
        kek_id: d.kekId,
        epoch: d.epoch,
        status: d.status,
        wrapped: JSON.stringify(d.wrapped),
        created_at: d.createdAt,
        rotated_at: d.rotatedAt,
        revoked_at: d.revokedAt,
      });
    },
    async updateDekStatus(id, status, ts) {
      await db.updateTenantDekStatus(id, status, ts);
    },
    async listBiks(tenantId) {
      return (await db.listTenantBiks(tenantId)).map(rowToBik);
    },
    async insertBik(b) {
      await db.insertTenantBik({
        id: b.id,
        tenant_id: b.tenantId,
        epoch: b.epoch,
        status: b.status,
        wrapped: JSON.stringify(b.wrapped),
        created_at: b.createdAt,
        revoked_at: b.revokedAt,
        kek_id: b.kekId,
      });
    },
    async updateBikStatus(id, status, ts) {
      await db.updateTenantBikStatus(id, status, ts);
    },
    async deletePolicy(tenantId) {
      await db.deleteTenantEncryptionPolicy(tenantId);
    },
    async deleteAllWrappedMaterial(tenantId) {
      return db.deleteAllTenantWrappedMaterial(tenantId);
    },
  };
}
