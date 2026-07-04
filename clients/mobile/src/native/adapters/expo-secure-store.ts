/**
 * expo-secure-store.ts — a {@link KeyValueStore} backed by `expo-secure-store`.
 *
 * Device-gated (imports `expo-secure-store`): this file is part of the native
 * view layer and is NOT loaded by the Node logic-layer tests. The pure
 * `namespacedTokenStore` / `createTenantTokenStore` helpers in `src/lib` sit on
 * top of this, so per-tenant session isolation is tested without a device.
 *
 * SecureStore restricts keys to `[A-Za-z0-9._-]`. Our namespaced keys contain
 * `@`, `/`, and `:`, so we escape every disallowed character to a collision-free
 * `_<hex>_` token (raw `_` is escaped too, so the mapping is reversible and two
 * distinct logical keys can never map to the same physical key).
 */
import * as SecureStore from 'expo-secure-store';
import type { KeyValueStore } from '@weaveintel/api-client';

/** Escape a logical key into the SecureStore-allowed character set. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

/**
 * Builds a {@link KeyValueStore} over `expo-secure-store`. Values are stored
 * with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so credentials never sync off-device.
 */
export function createSecureStoreKv(): KeyValueStore {
  const options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  return {
    async getItem(key: string): Promise<string | null> {
      return (await SecureStore.getItemAsync(safeKey(key), options)) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      await SecureStore.setItemAsync(safeKey(key), value, options);
    },
    async removeItem(key: string): Promise<void> {
      await SecureStore.deleteItemAsync(safeKey(key), options);
    },
  };
}
