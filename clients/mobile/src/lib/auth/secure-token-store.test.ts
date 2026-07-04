import { describe, it, expect } from 'vitest';
import type { KeyValueStore } from '@weaveintel/api-client';
import {
  tenantNamespace,
  createTenantTokenStore,
  getStoredHost,
  setStoredHost,
  getStoredTenant,
  setStoredTenant,
  getStoredBiometricEnabled,
  setStoredBiometricEnabled,
} from './secure-token-store.js';

function memoryKv(): KeyValueStore & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe('tenantNamespace', () => {
  it('scopes by host alone when no tenant id', () => {
    expect(tenantNamespace('https://h')).toBe('https://h');
  });
  it('combines tenant id and host so neither collides', () => {
    expect(tenantNamespace('https://h', 'tenant-a')).toBe('tenant-a@https://h');
  });
});

describe('createTenantTokenStore', () => {
  it('keeps two tenants on the same host isolated', async () => {
    const kv = memoryKv();
    const a = createTenantTokenStore(kv, 'https://h', 'tenant-a');
    const b = createTenantTokenStore(kv, 'https://h', 'tenant-b');
    await a.set({ token: 'ta', csrfToken: 'ca' });
    await b.set({ token: 'tb', csrfToken: 'cb' });
    expect((await a.get())?.token).toBe('ta');
    expect((await b.get())?.token).toBe('tb');
    const keys = Object.keys(kv.dump());
    expect(keys.some((k) => k.includes('tenant-a@https://h'))).toBe(true);
    expect(keys.some((k) => k.includes('tenant-b@https://h'))).toBe(true);
  });

  it('clearing one tenant leaves the other intact', async () => {
    const kv = memoryKv();
    const a = createTenantTokenStore(kv, 'https://h', 'tenant-a');
    const b = createTenantTokenStore(kv, 'https://h', 'tenant-b');
    await a.set({ token: 'ta', csrfToken: 'ca' });
    await b.set({ token: 'tb', csrfToken: 'cb' });
    await a.clear();
    expect(await a.get()).toBeNull();
    expect((await b.get())?.token).toBe('tb');
  });
});

describe('persisted config', () => {
  it('round-trips host, tenant, and biometric preference', async () => {
    const kv = memoryKv();
    expect(await getStoredHost(kv)).toBeNull();
    expect(await getStoredTenant(kv)).toBeNull();
    expect(await getStoredBiometricEnabled(kv)).toBeNull();

    await setStoredHost(kv, 'https://api.example.com');
    await setStoredTenant(kv, 'tenant-a');
    await setStoredBiometricEnabled(kv, true);

    expect(await getStoredHost(kv)).toBe('https://api.example.com');
    expect(await getStoredTenant(kv)).toBe('tenant-a');
    expect(await getStoredBiometricEnabled(kv)).toBe(true);

    await setStoredBiometricEnabled(kv, false);
    expect(await getStoredBiometricEnabled(kv)).toBe(false);
  });
});
