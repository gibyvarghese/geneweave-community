/**
 * expo-async-store.ts — a {@link KeyValueStore} backed by `expo-secure-store`
 * WITHOUT hardware-backed accessibility constraints.
 *
 * Use this for non-sensitive preferences (e.g. theme choice) that do not
 * require hardware attestation. Hardware-backed SecureStore slots are a scarce
 * resource on some devices; storing non-sensitive data there wastes them and
 * can cause failures when the quota is exhausted.
 */
import * as SecureStore from 'expo-secure-store';
import type { KeyValueStore } from '@weaveintel/api-client';

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

/** Builds a {@link KeyValueStore} that persists to expo-secure-store without hardware-backed options, suitable for non-sensitive preferences. */
export function createAsyncStoreKv(): KeyValueStore {
  return {
    async getItem(key: string): Promise<string | null> {
      return (await SecureStore.getItemAsync(safeKey(key))) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      await SecureStore.setItemAsync(safeKey(key), value);
    },
    async removeItem(key: string): Promise<void> {
      await SecureStore.deleteItemAsync(safeKey(key));
    },
  };
}
