/**
 * secure-token-store.ts — per-tenant credential + host persistence over a
 * generic secure key/value store (`expo-secure-store` in the app, an in-memory
 * map in tests).
 *
 * The api-client already ships {@link namespacedTokenStore}; this module adds
 * the geneWeave namespace policy so a single device can hold isolated sessions
 * for several tenants/hosts at once, plus tiny helpers to remember the last
 * validated host and tenant across launches. No React / RN / expo imports.
 */

import { namespacedTokenStore, type KeyValueStore, type TokenStore } from '@weaveintel/api-client';

const HOST_KEY = '@geneweave/config:host';
const TENANT_KEY = '@geneweave/config:tenant';
const BIOMETRIC_KEY = '@geneweave/config:biometric';

/**
 * The namespace used to scope a tenant's stored session. Combines tenant id and
 * host so two tenants on the same server — or one tenant across two servers —
 * never collide. When no tenant id is configured the host alone is the scope.
 */
export function tenantNamespace(host: string, tenantId?: string): string {
  return tenantId ? `${tenantId}@${host}` : host;
}

/**
 * Builds a {@link TokenStore} scoped to `(tenantId, host)` over a secure
 * key/value store. This is the per-tenant configurability hook: pass a
 * different `tenantId` (or none) to get an independent, non-colliding session
 * slot on the same device.
 */
export function createTenantTokenStore(kv: KeyValueStore, host: string, tenantId?: string): TokenStore {
  return namespacedTokenStore(kv, tenantNamespace(host, tenantId));
}

/** Reads the last validated host from secure storage, or `null`. */
export async function getStoredHost(kv: KeyValueStore): Promise<string | null> {
  return (await kv.getItem(HOST_KEY)) ?? null;
}

/** Persists the validated host so the picker is skipped on the next launch. */
export async function setStoredHost(kv: KeyValueStore, host: string): Promise<void> {
  await kv.setItem(HOST_KEY, host);
}

/** Reads the configured tenant id from secure storage, or `null`. */
export async function getStoredTenant(kv: KeyValueStore): Promise<string | null> {
  return (await kv.getItem(TENANT_KEY)) ?? null;
}

/** Persists the tenant id used to namespace this device's sessions. */
export async function setStoredTenant(kv: KeyValueStore, tenantId: string): Promise<void> {
  await kv.setItem(TENANT_KEY, tenantId);
}

/**
 * Reads the persisted biometric-gate preference. Returns `null` when the user
 * has never made a choice, so the caller can fall back to the build default.
 */
export async function getStoredBiometricEnabled(kv: KeyValueStore): Promise<boolean | null> {
  const raw = await kv.getItem(BIOMETRIC_KEY);
  if (raw === null || raw === undefined) return null;
  return raw === '1';
}

/** Persists the user's biometric-gate preference. */
export async function setStoredBiometricEnabled(kv: KeyValueStore, enabled: boolean): Promise<void> {
  await kv.setItem(BIOMETRIC_KEY, enabled ? '1' : '0');
}



