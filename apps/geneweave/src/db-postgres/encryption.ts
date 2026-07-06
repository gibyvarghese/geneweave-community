// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `IEncryptionStore` domain slice of the geneWeave `DatabaseAdapter` —
 * tenant encryption policies, the KEK/DEK/BIK key hierarchy, the encryption audit log, alert
 * configs, the GDPR deletion lifecycle, and BYOK/HYOK/break-glass/attestation (Phase 10).
 *
 * Each method mirrors the SQLite implementation in `../db-encryption-store.ts`
 * (`SqliteEncryptionStore`, which `SQLiteAdapter` delegates to) statement-for-statement: same
 * SQL, same column order, same return shapes. Only the SQLite→Postgres dialect differences are
 * translated:
 *   - `?` placeholders → `$n`.
 *   - text `ORDER BY <col>` → `COLLATE "C"` (byte order); INTEGER/REAL orderings left bare.
 *   - `INSERT ... ON CONFLICT(pk) DO UPDATE` / `INSERT OR IGNORE` → `ON CONFLICT ... DO NOTHING`.
 *   - `rowid` tiebreak → the primary-key `id` column.
 *   - `better-sqlite3` `.transaction(...)` blocks → sequential awaits (same statements, same order).
 *   - `result.changes > 0` boolean → `RETURNING <pk>` + `rows.length > 0` (stays within `PgCtx`).
 *
 * Booleans are INTEGER 0/1; all key material / config columns are TEXT (JSON pass-through — this
 * domain has no BLOB/BYTEA columns, so no byte-array handling is needed); timestamps are INTEGER
 * epoch-millis supplied by the caller (`Date.now()`), so `datetime('now')`/`ctx.now` is unused
 * here. Every value is a bound parameter.
 */
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
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
} from '../db-types/encryption.js';

export function pgEncryptionStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    // ── Policies ──────────────────────────────────────────────

    async getTenantEncryptionPolicy(tenantId: string): Promise<TenantEncryptionPolicyRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_encryption_policy WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantEncryptionPolicyRow | undefined) ?? null;
    },

    async listTenantEncryptionPolicies(opts?: { enabledOnly?: boolean }): Promise<TenantEncryptionPolicyRow[]> {
      if (opts?.enabledOnly) {
        const { rows } = await ctx.query('SELECT * FROM tenant_encryption_policy WHERE enabled = 1 ORDER BY tenant_id COLLATE "C" ASC', []);
        return rows as unknown as TenantEncryptionPolicyRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM tenant_encryption_policy ORDER BY tenant_id COLLATE "C" ASC', []);
      return rows as unknown as TenantEncryptionPolicyRow[];
    },

    async deleteTenantEncryptionPolicy(tenantId: string): Promise<void> {
      await ctx.query('DELETE FROM tenant_encryption_policy WHERE tenant_id = $1', [tenantId]);
    },

    async upsertTenantEncryptionPolicy(p: Omit<TenantEncryptionPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_encryption_policy (tenant_id, enabled, kms_provider_id, kms_config, active_kek_id, active_dek_id, active_bik_id, rotation_schedule, blind_index_enabled, field_policy, shred_requested_at, shred_completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
           updated_at = extract(epoch from now())::bigint`,
        [p.tenant_id, p.enabled, p.kms_provider_id, p.kms_config, p.active_kek_id, p.active_dek_id, p.active_bik_id, p.rotation_schedule, p.blind_index_enabled, p.field_policy, p.shred_requested_at, p.shred_completed_at],
      );
    },

    // ── Key material (KEK / DEK / BIK) ────────────────────────

    async insertTenantKek(k: TenantKekRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_keks (id, tenant_id, version, status, wrapped, created_at, rotated_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [k.id, k.tenant_id, k.version, k.status, k.wrapped, k.created_at, k.rotated_at, k.revoked_at],
      );
    },

    async listTenantKeks(tenantId: string): Promise<TenantKekRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_keks WHERE tenant_id = $1 ORDER BY version ASC', [tenantId]);
      return rows as unknown as TenantKekRow[];
    },

    async getTenantKekById(tenantId: string, kekId: string): Promise<TenantKekRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_keks WHERE tenant_id = $1 AND id = $2', [tenantId, kekId]);
      return (rows[0] as TenantKekRow | undefined) ?? null;
    },

    async updateTenantKekStatus(id: string, status: string, ts: number): Promise<void> {
      const col = status === 'rotated' ? 'rotated_at' : status === 'revoked' ? 'revoked_at' : null;
      if (col) {
        await ctx.query(`UPDATE tenant_keks SET status = $1, ${col} = $2 WHERE id = $3`, [status, ts, id]);
      } else {
        await ctx.query('UPDATE tenant_keks SET status = $1 WHERE id = $2', [status, id]);
      }
    },

    async insertTenantDek(dek: TenantDekRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_deks (id, tenant_id, kek_id, epoch, status, wrapped, created_at, rotated_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [dek.id, dek.tenant_id, dek.kek_id, dek.epoch, dek.status, dek.wrapped, dek.created_at, dek.rotated_at, dek.revoked_at],
      );
    },

    async listTenantDeks(tenantId: string): Promise<TenantDekRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_deks WHERE tenant_id = $1 ORDER BY epoch ASC', [tenantId]);
      return rows as unknown as TenantDekRow[];
    },

    async getTenantDekById(tenantId: string, dekId: string): Promise<TenantDekRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_deks WHERE tenant_id = $1 AND id = $2', [tenantId, dekId]);
      return (rows[0] as TenantDekRow | undefined) ?? null;
    },

    async getMaxTenantDekEpoch(tenantId: string): Promise<number | null> {
      const { rows } = await ctx.query(
        `SELECT MAX(epoch) AS max_epoch FROM tenant_deks WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId],
      );
      const row = rows[0] as { max_epoch: number | null } | undefined;
      return row?.max_epoch ?? null;
    },

    async updateTenantDekStatus(id: string, status: string, ts: number): Promise<void> {
      const col = status === 'rotated' ? 'rotated_at' : status === 'revoked' ? 'revoked_at' : null;
      if (col) {
        await ctx.query(`UPDATE tenant_deks SET status = $1, ${col} = $2 WHERE id = $3`, [status, ts, id]);
      } else {
        await ctx.query('UPDATE tenant_deks SET status = $1 WHERE id = $2', [status, id]);
      }
    },

    async insertTenantBik(b: TenantBikRow): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_biks (id, tenant_id, epoch, status, wrapped, created_at, revoked_at, kek_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [b.id, b.tenant_id, b.epoch, b.status, b.wrapped, b.created_at, b.revoked_at, b.kek_id],
      );
    },

    async listTenantBiks(tenantId: string): Promise<TenantBikRow[]> {
      const { rows } = await ctx.query('SELECT * FROM tenant_biks WHERE tenant_id = $1 ORDER BY epoch ASC', [tenantId]);
      return rows as unknown as TenantBikRow[];
    },

    async updateTenantBikStatus(id: string, status: string, ts: number): Promise<void> {
      if (status === 'revoked') {
        await ctx.query('UPDATE tenant_biks SET status = $1, revoked_at = $2 WHERE id = $3', [status, ts, id]);
      } else {
        await ctx.query('UPDATE tenant_biks SET status = $1 WHERE id = $2', [status, id]);
      }
    },

    // ── Audit log ─────────────────────────────────────────────

    async insertEncryptionAudit(e: EncryptionAuditRow): Promise<void> {
      await ctx.query(
        `INSERT INTO encryption_audit (id, tenant_id, event_kind, actor, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.id, e.tenant_id, e.event_kind, e.actor, e.details, e.created_at],
      );
    },

    async listEncryptionAudit(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<EncryptionAuditRow[]> {
      const limit = opts?.limit ?? 100;
      const offset = opts?.offset ?? 0;
      // SQLite tiebreaks on rowid (insertion order); Postgres has no rowid, so fall back to the
      // primary key `id` for a stable, deterministic secondary sort.
      const { rows } = await ctx.query(
        'SELECT * FROM encryption_audit WHERE tenant_id = $1 ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $2 OFFSET $3',
        [tenantId, limit, offset],
      );
      return rows as unknown as EncryptionAuditRow[];
    },

    // ── Alert configs (Phase 9) ───────────────────────────────

    async upsertEncryptionAlertConfig(r: Omit<TenantEncryptionAlertConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
      const now = Date.now();
      // SQLite ran this SELECT-then-branch inside a `.transaction(...)`; mirror it as sequential
      // awaits (same statements, same order).
      const { rows } =
        r.tenant_id === null
          ? await ctx.query('SELECT id, created_at FROM tenant_encryption_alert_config WHERE tenant_id IS NULL AND kind = $1', [r.kind])
          : await ctx.query('SELECT id, created_at FROM tenant_encryption_alert_config WHERE tenant_id = $1 AND kind = $2', [r.tenant_id, r.kind]);
      const existing = rows[0] as { id: string; created_at: number } | undefined;
      if (existing) {
        await ctx.query(
          `UPDATE tenant_encryption_alert_config SET threshold = $1, window_ms = $2, enabled = $3, description = $4, updated_at = $5 WHERE id = $6`,
          [r.threshold, r.window_ms, r.enabled, r.description, now, existing.id],
        );
      } else {
        await ctx.query(
          `INSERT INTO tenant_encryption_alert_config (id, tenant_id, kind, threshold, window_ms, enabled, description, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.id, r.tenant_id, r.kind, r.threshold, r.window_ms, r.enabled, r.description, now, now],
        );
      }
    },

    async listEncryptionAlertConfig(opts?: { tenantId?: string | null }): Promise<TenantEncryptionAlertConfigRow[]> {
      if (opts && 'tenantId' in opts) {
        const t = opts.tenantId;
        if (t === null) {
          const { rows } = await ctx.query('SELECT * FROM tenant_encryption_alert_config WHERE tenant_id IS NULL ORDER BY kind COLLATE "C" ASC', []);
          return rows as unknown as TenantEncryptionAlertConfigRow[];
        }
        const { rows } = await ctx.query('SELECT * FROM tenant_encryption_alert_config WHERE tenant_id = $1 ORDER BY kind COLLATE "C" ASC', [t]);
        return rows as unknown as TenantEncryptionAlertConfigRow[];
      }
      const { rows } = await ctx.query('SELECT * FROM tenant_encryption_alert_config ORDER BY tenant_id IS NOT NULL, tenant_id COLLATE "C", kind COLLATE "C"', []);
      return rows as unknown as TenantEncryptionAlertConfigRow[];
    },

    async deleteEncryptionAlertConfig(id: string): Promise<boolean> {
      const { rows } = await ctx.query('DELETE FROM tenant_encryption_alert_config WHERE id = $1 RETURNING id', [id]);
      return rows.length > 0;
    },

    // ── GDPR deletion lifecycle (Phase 6) ─────────────────────

    async deleteAllTenantWrappedMaterial(tenantId: string): Promise<{ keks: number; deks: number; biks: number }> {
      // SQLite ran these three deletes inside `.transaction(...)` and returned `.changes`;
      // mirror as sequential awaits, using `RETURNING id` row counts for the change totals.
      const k = await ctx.query('DELETE FROM tenant_keks WHERE tenant_id = $1 RETURNING id', [tenantId]);
      const d = await ctx.query('DELETE FROM tenant_deks WHERE tenant_id = $1 RETURNING id', [tenantId]);
      const b = await ctx.query('DELETE FROM tenant_biks WHERE tenant_id = $1 RETURNING id', [tenantId]);
      return { keks: k.rows.length, deks: d.rows.length, biks: b.rows.length };
    },

    async createTenantDeletionRequest(r: Omit<TenantDeletionRequestRow, 'purged_at' | 'cancelled_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_deletion_requests (id, tenant_id, requested_at, retention_until, requested_by, status, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.tenant_id, r.requested_at, r.retention_until, r.requested_by, r.status, r.reason],
      );
    },

    async getTenantDeletionRequest(id: string): Promise<TenantDeletionRequestRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_deletion_requests WHERE id = $1', [id]);
      return (rows[0] as TenantDeletionRequestRow | undefined) ?? null;
    },

    async listTenantDeletionRequests(opts?: { tenantId?: string; status?: TenantDeletionRequestRow['status']; limit?: number; offset?: number }): Promise<TenantDeletionRequestRow[]> {
      const wheres: string[] = [];
      const vals: unknown[] = [];
      if (opts?.tenantId) { wheres.push(`tenant_id = $${vals.length + 1}`); vals.push(opts.tenantId); }
      if (opts?.status) { wheres.push(`status = $${vals.length + 1}`); vals.push(opts.status); }
      // SQLite rowid tiebreak → primary key `id`.
      const limitIdx = vals.length + 1;
      const offsetIdx = vals.length + 2;
      const sql = `SELECT * FROM tenant_deletion_requests ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''} ORDER BY requested_at DESC, id COLLATE "C" DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
      vals.push(opts?.limit ?? 200, opts?.offset ?? 0);
      const { rows } = await ctx.query(sql, vals);
      return rows as unknown as TenantDeletionRequestRow[];
    },

    async listDueTenantPurges(nowMs: number): Promise<TenantDeletionRequestRow[]> {
      const realNow = Date.now();
      // Guard against seconds-vs-milliseconds bugs and large clock skew: reject values that
      // deviate from the real wall clock by more than one hour.
      if (Math.abs(nowMs - realNow) > 3_600_000) {
        throw new Error(`listDueTenantPurges: nowMs (${nowMs}) deviates from Date.now() (${realNow}) by more than 1 hour — possible seconds/ms unit mismatch`);
      }
      // SQLite rowid tiebreak → primary key `id`.
      const { rows } = await ctx.query(
        `SELECT * FROM tenant_deletion_requests WHERE status = 'pending' AND retention_until <= $1 ORDER BY retention_until ASC, id COLLATE "C" ASC`,
        [nowMs],
      );
      return rows as unknown as TenantDeletionRequestRow[];
    },

    async markTenantPurged(id: string, purgedAtMs: number): Promise<void> {
      await ctx.query(
        `UPDATE tenant_deletion_requests SET status = 'purged', purged_at = $1 WHERE id = $2 AND status = 'pending'`,
        [purgedAtMs, id],
      );
    },

    async cancelTenantDeletionRequest(id: string, cancelledAtMs: number): Promise<boolean> {
      const { rows } = await ctx.query(
        `UPDATE tenant_deletion_requests SET status = 'cancelled', cancelled_at = $1 WHERE id = $2 AND status = 'pending' RETURNING id`,
        [cancelledAtMs, id],
      );
      return rows.length > 0;
    },

    // ── BYOK / HYOK / break-glass / attestation (Phase 10) ───

    async upsertTenantByokConfig(c: Omit<TenantByokConfigRow, 'created_at' | 'updated_at' | 'revoked_at'>): Promise<void> {
      const now = Date.now();
      // SQLite ran this SELECT-then-branch inside a `.transaction(...)`; mirror as sequential awaits.
      const { rows } = await ctx.query('SELECT tenant_id FROM tenant_byok_config WHERE tenant_id = $1', [c.tenant_id]);
      const existing = rows[0] as { tenant_id: string } | undefined;
      if (existing) {
        await ctx.query(
          `UPDATE tenant_byok_config SET mode = $1, public_key_pem = $2, public_key_fingerprint = $3, hyok_endpoint = $4, hyok_bearer_secret_id = $5, hyok_timeout_ms = $6, private_key_pem_dev = $7, status = $8, created_by = $9, updated_at = $10, revoked_at = NULL WHERE tenant_id = $11`,
          [c.mode, c.public_key_pem, c.public_key_fingerprint, c.hyok_endpoint, c.hyok_bearer_secret_id, c.hyok_timeout_ms, c.private_key_pem_dev, c.status, c.created_by, now, c.tenant_id],
        );
      } else {
        await ctx.query(
          `INSERT INTO tenant_byok_config (tenant_id, mode, public_key_pem, public_key_fingerprint, hyok_endpoint, hyok_bearer_secret_id, hyok_timeout_ms, private_key_pem_dev, status, created_by, created_at, updated_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)`,
          [c.tenant_id, c.mode, c.public_key_pem, c.public_key_fingerprint, c.hyok_endpoint, c.hyok_bearer_secret_id, c.hyok_timeout_ms, c.private_key_pem_dev, c.status, c.created_by, now, now],
        );
      }
    },

    async getTenantByokConfig(tenantId: string): Promise<TenantByokConfigRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_byok_config WHERE tenant_id = $1', [tenantId]);
      return (rows[0] as TenantByokConfigRow | undefined) ?? null;
    },

    async listTenantByokConfigs(opts: { activeOnly?: boolean } = {}): Promise<TenantByokConfigRow[]> {
      const sql = opts.activeOnly
        ? `SELECT * FROM tenant_byok_config WHERE status = 'active' ORDER BY tenant_id COLLATE "C"`
        : `SELECT * FROM tenant_byok_config ORDER BY tenant_id COLLATE "C"`;
      const { rows } = await ctx.query(sql, []);
      return rows as unknown as TenantByokConfigRow[];
    },

    async revokeTenantByokConfig(tenantId: string, revokedAtMs: number): Promise<boolean> {
      const { rows } = await ctx.query(
        `UPDATE tenant_byok_config SET status = 'revoked', revoked_at = $1, updated_at = $2 WHERE tenant_id = $3 AND status = 'active' RETURNING tenant_id`,
        [revokedAtMs, revokedAtMs, tenantId],
      );
      return rows.length > 0;
    },

    async deleteTenantByokConfig(tenantId: string): Promise<boolean> {
      const { rows } = await ctx.query(`DELETE FROM tenant_byok_config WHERE tenant_id = $1 RETURNING tenant_id`, [tenantId]);
      return rows.length > 0;
    },

    async insertBreakGlassRequest(r: Omit<TenantBreakGlassRequestRow, 'updated_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_break_glass_request (id, tenant_id, requested_by, reason, status, customer_approver, approved_at, expires_at, consume_count, denial_reason, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [r.id, r.tenant_id, r.requested_by, r.reason, r.status, r.customer_approver, r.approved_at, r.expires_at, r.consume_count, r.denial_reason, r.created_at, new Date().toISOString()],
      );
    },

    async getBreakGlassRequest(id: string): Promise<TenantBreakGlassRequestRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_break_glass_request WHERE id = $1', [id]);
      return (rows[0] as TenantBreakGlassRequestRow | undefined) ?? null;
    },

    async listBreakGlassRequests(opts: { tenantId?: string; status?: TenantBreakGlassRequestRow['status']; limit?: number; offset?: number } = {}): Promise<TenantBreakGlassRequestRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.tenantId) { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      if (opts.status) { where.push(`status = $${params.length + 1}`); params.push(opts.status); }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
      const offset = Math.max(0, opts.offset ?? 0);
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;
      const { rows } = await ctx.query(`SELECT * FROM tenant_break_glass_request ${whereSql} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, [...params, limit, offset]);
      return rows as unknown as TenantBreakGlassRequestRow[];
    },

    async updateBreakGlassRequest(id: string, patch: Partial<Omit<TenantBreakGlassRequestRow, 'id' | 'tenant_id' | 'created_at'>>): Promise<boolean> {
      const sets: string[] = [];
      const params: unknown[] = [];
      const allowed: (keyof typeof patch)[] = ['status', 'customer_approver', 'approved_at', 'expires_at', 'consume_count', 'denial_reason'];
      for (const k of allowed) {
        if (k in patch && patch[k] !== undefined) {
          sets.push(`${k} = $${params.length + 1}`);
          params.push(patch[k] as unknown);
        }
      }
      if (sets.length === 0) return false;
      sets.push(`updated_at = $${params.length + 1}`);
      params.push(Date.now());
      params.push(id);
      const { rows } = await ctx.query(`UPDATE tenant_break_glass_request SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
      return rows.length > 0;
    },

    async listExpiredApprovedBreakGlassRequests(nowMs: number): Promise<TenantBreakGlassRequestRow[]> {
      const { rows } = await ctx.query(
        `SELECT * FROM tenant_break_glass_request WHERE status = 'approved' AND expires_at <= $1 ORDER BY expires_at ASC`,
        [nowMs],
      );
      return rows as unknown as TenantBreakGlassRequestRow[];
    },

    async insertAttestationLog(a: Omit<TenantAttestationLogRow, 'created_at'>): Promise<void> {
      await ctx.query(
        `INSERT INTO tenant_attestation_log (id, tenant_id, generated_at, signature_alg, signature, signing_key_fingerprint, payload_hash, payload_json, requested_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [a.id, a.tenant_id, a.generated_at, a.signature_alg, a.signature, a.signing_key_fingerprint, a.payload_hash, a.payload_json, a.requested_by, Date.now()],
      );
    },

    async listAttestationLogs(opts: { tenantId?: string; limit?: number; offset?: number } = {}): Promise<TenantAttestationLogRow[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.tenantId) { where.push(`tenant_id = $${params.length + 1}`); params.push(opts.tenantId); }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
      const offset = Math.max(0, opts.offset ?? 0);
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;
      const { rows } = await ctx.query(`SELECT * FROM tenant_attestation_log ${whereSql} ORDER BY generated_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, [...params, limit, offset]);
      return rows as unknown as TenantAttestationLogRow[];
    },

    async getAttestationLog(id: string): Promise<TenantAttestationLogRow | null> {
      const { rows } = await ctx.query('SELECT * FROM tenant_attestation_log WHERE id = $1', [id]);
      return (rows[0] as TenantAttestationLogRow | undefined) ?? null;
    },

    async getSystemAttestationSigningKey(): Promise<SystemAttestationSigningKeyRow | null> {
      const { rows } = await ctx.query(`SELECT * FROM system_attestation_signing_key WHERE key = 'default'`, []);
      return (rows[0] as SystemAttestationSigningKeyRow | undefined) ?? null;
    },

    async insertSystemAttestationSigningKeyIfMissing(r: Omit<SystemAttestationSigningKeyRow, 'created_at'>): Promise<boolean> {
      // SQLite `INSERT OR IGNORE ... ; return changes > 0` → `ON CONFLICT DO NOTHING RETURNING key`.
      const { rows } = await ctx.query(
        `INSERT INTO system_attestation_signing_key (key, private_key_pem, public_key_pem, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING RETURNING key`,
        [r.key, r.private_key_pem, r.public_key_pem, r.fingerprint, Date.now()],
      );
      return rows.length > 0;
    },
  };
}
