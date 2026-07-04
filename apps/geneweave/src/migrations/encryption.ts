import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

export function applyEncryption(db: BetterSqlite3.Database): void {
  // ─── Cost Governor Phase 2 — Cost Policies ───────────────────────────────
  // Operator-defined cost tiers and lever overrides. Bound to agents / meshes
  // / workflows via capability_policy_bindings (policy_kind = 'cost_policy').
  // levers_json stores the optional CostPolicy fields (modelCascade,
  // promptCaching, toolSubset, intelGating, historyCompaction, maxStepsCap,
  // reasoningEffort, toolOutputTruncation, budgetCeilingUsd). UUID PK.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS cost_policies (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'balanced',
      levers_json TEXT,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_cost_policies_enabled ON cost_policies(enabled)`);

  // ─── Cost Governor Phase 8 — Tool Embeddings (Intent-RAG) ────────────────
  // Pre-computed embeddings for every tool description, used by the
  // intent-RAG strategy of the L3 (toolSubset) lever. Keyed by tool_key
  // (matches BUILTIN_TOOLS / tool_catalog.tool_key). description_hash
  // detects when a tool description changes and the embedding needs to
  // be recomputed. The embedding warmer at startup walks every BUILTIN
  // tool, hashes its description, and re-embeds on mismatch. UUID PK.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_embeddings (
      id TEXT PRIMARY KEY,
      tool_key TEXT NOT NULL UNIQUE,
      model_id TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      description_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_embeddings_model ON tool_embeddings(model_id)`);

  // ─── Encryption Phase 1 — Tenant-scoped Envelope Encryption ──────────────
  // Per-tenant policy + key hierarchy (KEK -> DEK, optional BIK) + audit ledger.
  // KEKs are wrapped under a root key managed by a KMS provider (LocalKmsProvider
  // in dev; cloud KMS providers in production). DEKs are wrapped under their KEK.
  // All wrapped key material is JSON-serialized via SerializedWrappedKey.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_encryption_policy (
      tenant_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      kms_provider_id TEXT NOT NULL DEFAULT 'local',
      kms_config TEXT,
      active_kek_id TEXT,
      active_dek_id TEXT,
      active_bik_id TEXT,
      rotation_schedule TEXT NOT NULL DEFAULT 'manual',
      blind_index_enabled INTEGER NOT NULL DEFAULT 0,
      field_policy TEXT NOT NULL DEFAULT '{}',
      shred_requested_at INTEGER,
      shred_completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    )
  `);
  // M13 — migrate existing DBs where created_at/updated_at are TEXT ISO strings.
  // Use table recreation (SQLite lacks ALTER COLUMN). Only runs when the column is TEXT.
  try {
    const col = db.prepare(`SELECT type FROM pragma_table_info('tenant_encryption_policy') WHERE name='created_at'`).get() as { type?: string } | undefined;
    if (col?.type?.toUpperCase() === 'TEXT') {
      db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE tenant_encryption_policy RENAME TO _tep_m13_backup;
        CREATE TABLE tenant_encryption_policy (
          tenant_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          kms_provider_id TEXT NOT NULL DEFAULT 'local',
          kms_config TEXT,
          active_kek_id TEXT,
          active_dek_id TEXT,
          active_bik_id TEXT,
          rotation_schedule TEXT NOT NULL DEFAULT 'manual',
          blind_index_enabled INTEGER NOT NULL DEFAULT 0,
          field_policy TEXT NOT NULL DEFAULT '{}',
          shred_requested_at INTEGER,
          shred_completed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
        );
        INSERT INTO tenant_encryption_policy
          SELECT tenant_id, enabled, kms_provider_id, kms_config,
            active_kek_id, active_dek_id, active_bik_id,
            rotation_schedule, blind_index_enabled, field_policy,
            shred_requested_at, shred_completed_at,
            CAST(strftime('%s', created_at) * 1000 AS INTEGER),
            CAST(strftime('%s', updated_at) * 1000 AS INTEGER)
          FROM _tep_m13_backup;
        DROP TABLE _tep_m13_backup;
        COMMIT;
      `);
    }
  } catch { /* migration already applied or unsupported SQLite version */ }

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_keks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      wrapped TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER,
      revoked_at INTEGER
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_keks_tenant ON tenant_keks(tenant_id, status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_deks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kek_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      wrapped TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER,
      revoked_at INTEGER
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_deks_tenant ON tenant_deks(tenant_id, status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_deks_epoch ON tenant_deks(tenant_id, epoch)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_biks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      wrapped TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      kek_id TEXT NOT NULL DEFAULT ''
    )
  `);
  // Backfill: add kek_id column to existing databases (no-op if already present).
  safeExec(db, `ALTER TABLE tenant_biks ADD COLUMN kek_id TEXT NOT NULL DEFAULT ''`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_biks_tenant ON tenant_biks(tenant_id, status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS encryption_audit (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      actor TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_encryption_audit_tenant ON encryption_audit(tenant_id, created_at)`);

  // Forward-compat: row-level rewrite progress for background re-encryption
  // jobs after rotation. Phase 1 inserts no rows; Phase 2+ background job
  // claims a (table, column) and walks rows.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS encryption_rewrite_progress (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      from_epoch INTEGER NOT NULL,
      to_epoch INTEGER NOT NULL,
      last_row_id TEXT,
      rows_rewritten INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_encryption_rewrite_tenant ON encryption_rewrite_progress(tenant_id, status)`);

  // ─── Encryption Phase 6 — GDPR Tenant Deletion Lifecycle ─────────────────
  // Operator-initiated tenant deletion requests with retention window. After
  // request, policy keeps decryption working until retention_until elapses;
  // background purge scheduler then calls hardShred(). Status transitions:
  // pending -> cancelled OR pending -> purged. UUID PK.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_deletion_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      retention_until INTEGER NOT NULL,
      requested_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      purged_at INTEGER,
      cancelled_at INTEGER,
      reason TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_deletion_requests_tenant ON tenant_deletion_requests(tenant_id, status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_deletion_requests_due ON tenant_deletion_requests(status, retention_until)`);

  // ─── Encryption Phase 8 — Blind-index companion columns ─────────────────
  // For every (table, column) listed in DEFAULT_BLIND_INDEX_SPECS we add a
  // `<column>_bidx TEXT` companion to enable equality lookups against
  // encrypted values. Currently shipped: users.email_bidx. Apps that ship
  // additional specs add their ALTERs alongside this block.
  //
  // Lookup pattern (geneweave login): SELECT ... WHERE email_bidx = ?
  // The bidx is computed client-side via `km.computeBlindIndex(...)`.
  // Backfill on enable / on BIK rotation runs through the admin
  // `/rebuild-bidx` endpoint (audit kind: bidx_rebuild).
  safeExec(db, `ALTER TABLE users ADD COLUMN email_bidx TEXT`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_users_email_bidx ON users(email_bidx)`);

  // ─── Encryption Phase 9 — Operator-configurable alert rules ──────────────
  // Per-tenant (or fleet-wide when tenant_id IS NULL) alert thresholds. The
  // alert evaluator (@weaveintel/encryption.evaluateAlerts) consumes these
  // rows + the in-memory metrics snapshot + per-tenant rotation status to
  // decide which rules fire right now. Defaults are seeded for the
  // SYSTEM tenant on first boot in `bootstrapEncryptionAlerts`.
  //
  // tenant_id NULL  → fleet-wide rule (applies across all tenants).
  // window_ms NULL  → kind-specific default (see DEFAULT_ALERT_RULES).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_encryption_alert_config (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      kind TEXT NOT NULL,
      threshold REAL NOT NULL,
      window_ms INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  safeExec(
    db,
    `CREATE INDEX IF NOT EXISTS idx_tenant_encryption_alert_tenant ON tenant_encryption_alert_config(tenant_id)`,
  );
  safeExec(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_encryption_alert_tenant_kind ON tenant_encryption_alert_config(IFNULL(tenant_id,'__fleet__'), kind)`,
  );

  // ─── Encryption Phase 10 — BYOK / HYOK / break-glass / attestation ──────
  // Per-tenant customer-managed key registration. When a row exists for a
  // tenant the resolver hands out a `byok-pem` provider that wraps with the
  // customer's RSA-4096 public key and unwraps via the configured delegate
  // (HYOK proxy in prod, local key for dev only). `mode` is informational —
  // the actual unwrap path is decided by which fields are populated.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_byok_config (
      tenant_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'byok',
      public_key_pem TEXT NOT NULL,
      public_key_fingerprint TEXT NOT NULL,
      hyok_endpoint TEXT,
      hyok_bearer_secret_id TEXT,
      hyok_timeout_ms INTEGER,
      private_key_pem_dev TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_byok_status ON tenant_byok_config(status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tenant_byok_fp ON tenant_byok_config(public_key_fingerprint)`);

  // Break-glass grants. A pending request requires a different customer
  // approver to flip it to `approved`; the window is capped server-side
  // (see `break-glass.ts MAX_GRANT_WINDOW_MS`). `consume_count` is bumped
  // every time the unwrap delegate redeems the grant — useful for audit
  // forensics. Status flow: pending → approved | denied | expired; the
  // reaper transitions stale `approved` rows to `expired` once they pass
  // their `expires_at`.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_break_glass_request (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      customer_approver TEXT,
      approved_at INTEGER,
      expires_at INTEGER NOT NULL,
      consume_count INTEGER NOT NULL DEFAULT 0,
      denial_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_break_glass_tenant ON tenant_break_glass_request(tenant_id, status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_break_glass_due ON tenant_break_glass_request(status, expires_at)`);

  // Compliance attestation export log. Each row is the signed JSON the
  // customer's auditor can verify with the platform's published Ed25519
  // public key. `payload_hash` is the SHA-256 of the canonical payload —
  // safe to share without exposing the per-event audit content.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tenant_attestation_log (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      signature_alg TEXT NOT NULL,
      signature TEXT NOT NULL,
      signing_key_fingerprint TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      requested_by TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_attestation_tenant ON tenant_attestation_log(tenant_id, generated_at DESC)`);

  // Platform-level signing key for compliance attestations. Single-row table
  // (key='default') so we can later support key rotation by adding more rows
  // and a `is_active` flag without schema churn. The Ed25519 private key is
  // stored as PEM. Customers verify with the published public key (returned
  // by the admin /attestation/public-key route).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS system_attestation_signing_key (
      key TEXT PRIMARY KEY,
      private_key_pem TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}
