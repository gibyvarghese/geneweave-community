/**
 * Encryption domain repository — extracted from db-sqlite.ts.
 *
 * Owns all SQLite queries for tenant encryption: policies, key material
 * (KEK/DEK/BIK), audit log, alert configs, GDPR deletion lifecycle, and
 * BYOK/break-glass/attestation (Phase 10).
 *
 * Constructed with a live `better-sqlite3` Database; `SQLiteAdapter`
 * delegates every encryption method here.
 */

import type {
  TenantEncryptionPolicyRow,
  TenantKekRow,
  TenantDekRow,
  TenantBikRow,
  EncryptionAuditRow,
  TenantEncryptionAlertConfigRow,
  TenantDeletionRequestRow,
  TenantByokConfigRow,
  TenantBreakGlassRequestRow,
  TenantAttestationLogRow,
  SystemAttestationSigningKeyRow,
} from './db-types.js';

type Db = import('better-sqlite3').Database;

export class SqliteEncryptionStore {
  // better-sqlite3 caches prepared statements internally, but dynamic SQL
  // (e.g. UPDATE ... SET status = ?, ${col} = ? ...) generates multiple
  // SQL strings at runtime. This cache avoids repeated prepare() overhead
  // for the fixed set of column-variant UPDATE statements.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _stmtCache = new Map<string, import('better-sqlite3').Statement<any[]>>();

  constructor(private readonly db: Db) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmt(sql: string): import('better-sqlite3').Statement<any[]> {
    let s = this._stmtCache.get(sql);
    if (!s) { s = this.db.prepare(sql) as import('better-sqlite3').Statement<any[]>; this._stmtCache.set(sql, s); }
    return s;
  }

  // ── Policies ──────────────────────────────────────────────

  async getTenantEncryptionPolicy(tenantId: string): Promise<TenantEncryptionPolicyRow | null> {
    return (this.db.prepare('SELECT * FROM tenant_encryption_policy WHERE tenant_id = ?').get(tenantId) as TenantEncryptionPolicyRow | undefined) ?? null;
  }

  async listTenantEncryptionPolicies(opts?: { enabledOnly?: boolean }): Promise<TenantEncryptionPolicyRow[]> {
    if (opts?.enabledOnly) {
      return this.db.prepare('SELECT * FROM tenant_encryption_policy WHERE enabled = 1 ORDER BY tenant_id ASC').all() as TenantEncryptionPolicyRow[];
    }
    return this.db.prepare('SELECT * FROM tenant_encryption_policy ORDER BY tenant_id ASC').all() as TenantEncryptionPolicyRow[];
  }

  async deleteTenantEncryptionPolicy(tenantId: string): Promise<void> {
    this.db.prepare('DELETE FROM tenant_encryption_policy WHERE tenant_id = ?').run(tenantId);
  }

  async upsertTenantEncryptionPolicy(p: Omit<TenantEncryptionPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.db.prepare(
      `INSERT INTO tenant_encryption_policy (tenant_id, enabled, kms_provider_id, kms_config, active_kek_id, active_dek_id, active_bik_id, rotation_schedule, blind_index_enabled, field_policy, shred_requested_at, shred_completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         enabled = excluded.enabled,
         kms_provider_id = excluded.kms_provider_id,
         kms_config = excluded.kms_config,
         active_kek_id = excluded.active_kek_id,
         active_dek_id = excluded.active_dek_id,
         active_bik_id = excluded.active_bik_id,
         rotation_schedule = excluded.rotation_schedule,
         blind_index_enabled = excluded.blind_index_enabled,
         field_policy = excluded.field_policy,
         shred_requested_at = excluded.shred_requested_at,
         shred_completed_at = excluded.shred_completed_at,
         updated_at = datetime('now')`,
    ).run(p.tenant_id, p.enabled, p.kms_provider_id, p.kms_config, p.active_kek_id, p.active_dek_id, p.active_bik_id, p.rotation_schedule, p.blind_index_enabled, p.field_policy, p.shred_requested_at, p.shred_completed_at);
  }

  // ── Key material (KEK / DEK / BIK) ────────────────────────

  async insertTenantKek(k: TenantKekRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO tenant_keks (id, tenant_id, version, status, wrapped, created_at, rotated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(k.id, k.tenant_id, k.version, k.status, k.wrapped, k.created_at, k.rotated_at, k.revoked_at);
  }

  async listTenantKeks(tenantId: string): Promise<TenantKekRow[]> {
    return this.db.prepare('SELECT * FROM tenant_keks WHERE tenant_id = ? ORDER BY version ASC').all(tenantId) as TenantKekRow[];
  }

  // H-13: Point lookup — O(1) vs O(n) from listTenantKeks().find().
  // Used by key-manager's #getKekRow() to avoid full KEK list scans on
  // every encrypt/decrypt operation.
  async getTenantKekById(tenantId: string, kekId: string): Promise<TenantKekRow | null> {
    return (this.db.prepare('SELECT * FROM tenant_keks WHERE tenant_id = ? AND id = ?').get(tenantId, kekId) as TenantKekRow | undefined) ?? null;
  }

  async updateTenantKekStatus(id: string, status: string, ts: number): Promise<void> {
    const col = status === 'rotated' ? 'rotated_at' : status === 'revoked' ? 'revoked_at' : null;
    if (col) {
      this.stmt(`UPDATE tenant_keks SET status = ?, ${col} = ? WHERE id = ?`).run(status, ts, id);
    } else {
      this.stmt('UPDATE tenant_keks SET status = ? WHERE id = ?').run(status, id);
    }
  }

  async insertTenantDek(dek: TenantDekRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO tenant_deks (id, tenant_id, kek_id, epoch, status, wrapped, created_at, rotated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(dek.id, dek.tenant_id, dek.kek_id, dek.epoch, dek.status, dek.wrapped, dek.created_at, dek.rotated_at, dek.revoked_at);
  }

  async listTenantDeks(tenantId: string): Promise<TenantDekRow[]> {
    return this.db.prepare('SELECT * FROM tenant_deks WHERE tenant_id = ? ORDER BY epoch ASC').all(tenantId) as TenantDekRow[];
  }

  // H-13: Point lookup by ID — avoids O(n) list scan for every decrypt.
  async getTenantDekById(tenantId: string, dekId: string): Promise<TenantDekRow | null> {
    return (this.db.prepare('SELECT * FROM tenant_deks WHERE tenant_id = ? AND id = ?').get(tenantId, dekId) as TenantDekRow | undefined) ?? null;
  }

  // H-13: Returns the highest epoch among active DEKs for a tenant.
  // Used by the rotation path to determine the next epoch without listing all DEKs.
  async getMaxTenantDekEpoch(tenantId: string): Promise<number | null> {
    const row = this.db.prepare(
      `SELECT MAX(epoch) AS max_epoch FROM tenant_deks WHERE tenant_id = ? AND status = 'active'`,
    ).get(tenantId) as { max_epoch: number | null } | undefined;
    return row?.max_epoch ?? null;
  }

  async updateTenantDekStatus(id: string, status: string, ts: number): Promise<void> {
    const col = status === 'rotated' ? 'rotated_at' : status === 'revoked' ? 'revoked_at' : null;
    if (col) {
      this.stmt(`UPDATE tenant_deks SET status = ?, ${col} = ? WHERE id = ?`).run(status, ts, id);
    } else {
      this.stmt('UPDATE tenant_deks SET status = ? WHERE id = ?').run(status, id);
    }
  }

  async insertTenantBik(b: TenantBikRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO tenant_biks (id, tenant_id, epoch, status, wrapped, created_at, revoked_at, kek_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(b.id, b.tenant_id, b.epoch, b.status, b.wrapped, b.created_at, b.revoked_at, b.kek_id);
  }

  async listTenantBiks(tenantId: string): Promise<TenantBikRow[]> {
    return this.db.prepare('SELECT * FROM tenant_biks WHERE tenant_id = ? ORDER BY epoch ASC').all(tenantId) as TenantBikRow[];
  }

  async updateTenantBikStatus(id: string, status: string, ts: number): Promise<void> {
    if (status === 'revoked') {
      this.stmt('UPDATE tenant_biks SET status = ?, revoked_at = ? WHERE id = ?').run(status, ts, id);
    } else {
      this.stmt('UPDATE tenant_biks SET status = ? WHERE id = ?').run(status, id);
    }
  }

  // ── Audit log ─────────────────────────────────────────────

  async insertEncryptionAudit(e: EncryptionAuditRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO encryption_audit (id, tenant_id, event_kind, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.tenant_id, e.event_kind, e.actor, e.details, e.created_at);
  }

  async listEncryptionAudit(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<EncryptionAuditRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    return this.db.prepare(
      'SELECT * FROM encryption_audit WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
    ).all(tenantId, limit, offset) as EncryptionAuditRow[];
  }

  // ── Alert configs (Phase 9) ───────────────────────────────

  async upsertEncryptionAlertConfig(r: Omit<TenantEncryptionAlertConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const existing = (
        r.tenant_id === null
          ? this.db.prepare('SELECT id, created_at FROM tenant_encryption_alert_config WHERE tenant_id IS NULL AND kind = ?').get(r.kind)
          : this.db.prepare('SELECT id, created_at FROM tenant_encryption_alert_config WHERE tenant_id = ? AND kind = ?').get(r.tenant_id, r.kind)
      ) as { id: string; created_at: number } | undefined;
      if (existing) {
        this.db.prepare(
          `UPDATE tenant_encryption_alert_config SET threshold = ?, window_ms = ?, enabled = ?, description = ?, updated_at = ? WHERE id = ?`,
        ).run(r.threshold, r.window_ms, r.enabled, r.description, now, existing.id);
      } else {
        this.db.prepare(
          `INSERT INTO tenant_encryption_alert_config (id, tenant_id, kind, threshold, window_ms, enabled, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(r.id, r.tenant_id, r.kind, r.threshold, r.window_ms, r.enabled, r.description, now, now);
      }
    });
    txn();
  }

  async listEncryptionAlertConfig(opts?: { tenantId?: string | null }): Promise<TenantEncryptionAlertConfigRow[]> {
    if (opts && 'tenantId' in opts) {
      const t = opts.tenantId;
      if (t === null) {
        return this.db.prepare('SELECT * FROM tenant_encryption_alert_config WHERE tenant_id IS NULL ORDER BY kind ASC').all() as TenantEncryptionAlertConfigRow[];
      }
      return this.db.prepare('SELECT * FROM tenant_encryption_alert_config WHERE tenant_id = ? ORDER BY kind ASC').all(t) as TenantEncryptionAlertConfigRow[];
    }
    return this.db.prepare('SELECT * FROM tenant_encryption_alert_config ORDER BY tenant_id IS NOT NULL, tenant_id, kind').all() as TenantEncryptionAlertConfigRow[];
  }

  async deleteEncryptionAlertConfig(id: string): Promise<boolean> {
    const r = this.db.prepare('DELETE FROM tenant_encryption_alert_config WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ── GDPR deletion lifecycle (Phase 6) ─────────────────────

  async deleteAllTenantWrappedMaterial(tenantId: string): Promise<{ keks: number; deks: number; biks: number }> {
    const txn = this.db.transaction((tid: string) => {
      const k = this.db.prepare('DELETE FROM tenant_keks WHERE tenant_id = ?').run(tid).changes;
      const d = this.db.prepare('DELETE FROM tenant_deks WHERE tenant_id = ?').run(tid).changes;
      const b = this.db.prepare('DELETE FROM tenant_biks WHERE tenant_id = ?').run(tid).changes;
      return { keks: k, deks: d, biks: b };
    });
    return txn(tenantId);
  }

  async createTenantDeletionRequest(r: Omit<TenantDeletionRequestRow, 'purged_at' | 'cancelled_at'>): Promise<void> {
    this.db.prepare(
      `INSERT INTO tenant_deletion_requests (id, tenant_id, requested_at, retention_until, requested_by, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.tenant_id, r.requested_at, r.retention_until, r.requested_by, r.status, r.reason);
  }

  async getTenantDeletionRequest(id: string): Promise<TenantDeletionRequestRow | null> {
    return (this.db.prepare('SELECT * FROM tenant_deletion_requests WHERE id = ?').get(id) as TenantDeletionRequestRow | undefined) ?? null;
  }

  async listTenantDeletionRequests(opts?: { tenantId?: string; status?: TenantDeletionRequestRow['status']; limit?: number; offset?: number }): Promise<TenantDeletionRequestRow[]> {
    const wheres: string[] = [];
    const vals: unknown[] = [];
    if (opts?.tenantId) { wheres.push('tenant_id = ?'); vals.push(opts.tenantId); }
    if (opts?.status) { wheres.push('status = ?'); vals.push(opts.status); }
    const sql = `SELECT * FROM tenant_deletion_requests ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY requested_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    vals.push(opts?.limit ?? 200, opts?.offset ?? 0);
    return this.db.prepare(sql).all(...vals) as TenantDeletionRequestRow[];
  }

  async listDueTenantPurges(nowMs: number): Promise<TenantDeletionRequestRow[]> {
    const realNow = Date.now();
    // Guard against seconds-vs-milliseconds bugs and large clock skew: reject
    // values that deviate from the real wall clock by more than one hour.
    if (Math.abs(nowMs - realNow) > 3_600_000) {
      throw new Error(`listDueTenantPurges: nowMs (${nowMs}) deviates from Date.now() (${realNow}) by more than 1 hour — possible seconds/ms unit mismatch`);
    }
    return this.db.prepare(
      `SELECT * FROM tenant_deletion_requests WHERE status = 'pending' AND retention_until <= ? ORDER BY retention_until ASC, rowid ASC`,
    ).all(nowMs) as TenantDeletionRequestRow[];
  }

  async markTenantPurged(id: string, purgedAtMs: number): Promise<void> {
    this.db.prepare(
      `UPDATE tenant_deletion_requests SET status = 'purged', purged_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(purgedAtMs, id);
  }

  async cancelTenantDeletionRequest(id: string, cancelledAtMs: number): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE tenant_deletion_requests SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(cancelledAtMs, id);
    return r.changes > 0;
  }

  // ── BYOK / HYOK / break-glass / attestation (Phase 10) ───

  async upsertTenantByokConfig(c: Omit<TenantByokConfigRow, 'created_at' | 'updated_at' | 'revoked_at'>): Promise<void> {
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT tenant_id FROM tenant_byok_config WHERE tenant_id = ?').get(c.tenant_id) as { tenant_id: string } | undefined;
      if (existing) {
        this.db.prepare(
          `UPDATE tenant_byok_config SET mode = ?, public_key_pem = ?, public_key_fingerprint = ?, hyok_endpoint = ?, hyok_bearer_secret_id = ?, hyok_timeout_ms = ?, private_key_pem_dev = ?, status = ?, created_by = ?, updated_at = ?, revoked_at = NULL WHERE tenant_id = ?`,
        ).run(c.mode, c.public_key_pem, c.public_key_fingerprint, c.hyok_endpoint, c.hyok_bearer_secret_id, c.hyok_timeout_ms, c.private_key_pem_dev, c.status, c.created_by, now, c.tenant_id);
      } else {
        this.db.prepare(
          `INSERT INTO tenant_byok_config (tenant_id, mode, public_key_pem, public_key_fingerprint, hyok_endpoint, hyok_bearer_secret_id, hyok_timeout_ms, private_key_pem_dev, status, created_by, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(c.tenant_id, c.mode, c.public_key_pem, c.public_key_fingerprint, c.hyok_endpoint, c.hyok_bearer_secret_id, c.hyok_timeout_ms, c.private_key_pem_dev, c.status, c.created_by, now, now);
      }
    });
    txn();
  }

  async getTenantByokConfig(tenantId: string): Promise<TenantByokConfigRow | null> {
    return (this.db.prepare('SELECT * FROM tenant_byok_config WHERE tenant_id = ?').get(tenantId) as TenantByokConfigRow | undefined) ?? null;
  }

  async listTenantByokConfigs(opts: { activeOnly?: boolean } = {}): Promise<TenantByokConfigRow[]> {
    const sql = opts.activeOnly
      ? `SELECT * FROM tenant_byok_config WHERE status = 'active' ORDER BY tenant_id`
      : `SELECT * FROM tenant_byok_config ORDER BY tenant_id`;
    return this.db.prepare(sql).all() as TenantByokConfigRow[];
  }

  async revokeTenantByokConfig(tenantId: string, revokedAtMs: number): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE tenant_byok_config SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE tenant_id = ? AND status = 'active'`,
    ).run(revokedAtMs, revokedAtMs, tenantId);
    return r.changes > 0;
  }

  async deleteTenantByokConfig(tenantId: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM tenant_byok_config WHERE tenant_id = ?`).run(tenantId);
    return r.changes > 0;
  }

  async insertBreakGlassRequest(r: Omit<TenantBreakGlassRequestRow, 'updated_at'>): Promise<void> {
    this.db.prepare(
      `INSERT INTO tenant_break_glass_request (id, tenant_id, requested_by, reason, status, customer_approver, approved_at, expires_at, consume_count, denial_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.tenant_id, r.requested_by, r.reason, r.status, r.customer_approver, r.approved_at, r.expires_at, r.consume_count, r.denial_reason, r.created_at, new Date().toISOString());
  }

  async getBreakGlassRequest(id: string): Promise<TenantBreakGlassRequestRow | null> {
    return (this.db.prepare('SELECT * FROM tenant_break_glass_request WHERE id = ?').get(id) as TenantBreakGlassRequestRow | undefined) ?? null;
  }

  async listBreakGlassRequests(opts: { tenantId?: string; status?: TenantBreakGlassRequestRow['status']; limit?: number; offset?: number } = {}): Promise<TenantBreakGlassRequestRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantId) { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.db.prepare(`SELECT * FROM tenant_break_glass_request ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as TenantBreakGlassRequestRow[];
  }

  async updateBreakGlassRequest(id: string, patch: Partial<Omit<TenantBreakGlassRequestRow, 'id' | 'tenant_id' | 'created_at'>>): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const allowed: (keyof typeof patch)[] = ['status', 'customer_approver', 'approved_at', 'expires_at', 'consume_count', 'denial_reason'];
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) {
        sets.push(`${k} = ?`);
        params.push(patch[k] as unknown);
      }
    }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);
    const r = this.db.prepare(`UPDATE tenant_break_glass_request SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return r.changes > 0;
  }

  async listExpiredApprovedBreakGlassRequests(nowMs: number): Promise<TenantBreakGlassRequestRow[]> {
    return this.db.prepare(
      `SELECT * FROM tenant_break_glass_request WHERE status = 'approved' AND expires_at <= ? ORDER BY expires_at ASC`,
    ).all(nowMs) as TenantBreakGlassRequestRow[];
  }

  async insertAttestationLog(a: Omit<TenantAttestationLogRow, 'created_at'>): Promise<void> {
    this.db.prepare(
      `INSERT INTO tenant_attestation_log (id, tenant_id, generated_at, signature_alg, signature, signing_key_fingerprint, payload_hash, payload_json, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.tenant_id, a.generated_at, a.signature_alg, a.signature, a.signing_key_fingerprint, a.payload_hash, a.payload_json, a.requested_by, Date.now());
  }

  async listAttestationLogs(opts: { tenantId?: string; limit?: number; offset?: number } = {}): Promise<TenantAttestationLogRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantId) { where.push('tenant_id = ?'); params.push(opts.tenantId); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const offset = Math.max(0, opts.offset ?? 0);
    return this.db.prepare(`SELECT * FROM tenant_attestation_log ${whereSql} ORDER BY generated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as TenantAttestationLogRow[];
  }

  async getAttestationLog(id: string): Promise<TenantAttestationLogRow | null> {
    return (this.db.prepare('SELECT * FROM tenant_attestation_log WHERE id = ?').get(id) as TenantAttestationLogRow | undefined) ?? null;
  }

  async getSystemAttestationSigningKey(): Promise<SystemAttestationSigningKeyRow | null> {
    return (this.db.prepare(`SELECT * FROM system_attestation_signing_key WHERE key = 'default'`).get() as SystemAttestationSigningKeyRow | undefined) ?? null;
  }

  async insertSystemAttestationSigningKeyIfMissing(r: Omit<SystemAttestationSigningKeyRow, 'created_at'>): Promise<boolean> {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO system_attestation_signing_key (key, private_key_pem, public_key_pem, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(r.key, r.private_key_pem, r.public_key_pem, r.fingerprint, Date.now());
    return result.changes > 0;
  }
}
