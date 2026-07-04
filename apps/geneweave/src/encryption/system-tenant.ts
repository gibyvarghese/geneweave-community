/**
 * GeneWeave: SYSTEM tenant scope for cross-tenant lookups.
 *
 * Some columns must support equality lookups before any user-tenant context
 * is known — the canonical case is `users.email` during login. Per-tenant
 * blind-index keys can't help there, so we mint a single SYSTEM tenant whose
 * BIK is used for every `users.email_bidx` write and lookup.
 *
 * This is purely a scoping decision: `__system__` is a reserved tenant id
 * that owns its own KEK/DEK/BIK and policy row. Real user tenants are still
 * isolated for everything else.
 *
 * `bootstrapSystemTenant` is idempotent — first call materialises the
 * policy + initial keys, subsequent calls flip `blind_index_enabled = 1`
 * if it was off and otherwise no-op.
 */
import type { TenantKeyManager } from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../db-types.js';

export const SYSTEM_TENANT_ID = '__system__';

export interface BootstrapSystemTenantOptions {
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function bootstrapSystemTenant(
  db: DatabaseAdapter,
  manager: TenantKeyManager,
  opts: BootstrapSystemTenantOptions = {},
): Promise<void> {
  const log = opts.log ?? ((msg, meta) => console.log(`[encryption/system-tenant] ${msg}`, meta ?? {}));
  const existing = await db.getTenantEncryptionPolicy(SYSTEM_TENANT_ID);
  if (!existing) {
    await manager.bootstrapTenant({ tenantId: SYSTEM_TENANT_ID });
    log('system tenant bootstrapped');
  }
  // Always force blind-index on for the system tenant — it has no other purpose.
  const policy = await db.getTenantEncryptionPolicy(SYSTEM_TENANT_ID);
  if (policy && policy.blind_index_enabled !== 1) {
    await db.upsertTenantEncryptionPolicy({
      ...policy,
      blind_index_enabled: 1,
      enabled: 1,
    });
    log('system tenant blind_index_enabled flipped on');
  }
}
