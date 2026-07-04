import { describe, it, expect, vi } from 'vitest';
import type { GeneweaveClient, MeUser, TokenStore, KeyValueStore } from '@weaveintel/api-client';
import { AuthExpiredError } from '@weaveintel/api-client';
import { createAuthStore } from './auth-store.js';
import { createAuthController, type BiometricAuthenticator } from './auth-controller.js';
import { createTenantTokenStore } from './secure-token-store.js';
import { BIOMETRIC_RELOCK_MS } from './biometric-gate.js';

function memoryKv(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const USER: MeUser = { id: 'u1', email: 'a@example.com', name: 'A', persona: 'member', tenantId: 't1' };

interface FakeSpies {
  signOut: ReturnType<typeof vi.fn>;
  removeDevice: ReturnType<typeof vi.fn>;
  getCurrentUser: ReturnType<typeof vi.fn>;
  authenticate: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
}

/** A client factory whose clients persist tokens into their injected token store. */
function fakeFactory(behavior: { getCurrentUser?: () => Promise<MeUser> } = {}): {
  factory: (opts: { host: string; tokenStore: TokenStore }) => GeneweaveClient;
  spies: FakeSpies;
} {
  const spies: FakeSpies = {
    signOut: vi.fn(),
    removeDevice: vi.fn(),
    getCurrentUser: vi.fn(behavior.getCurrentUser ?? (async () => USER)),
    authenticate: vi.fn(),
    register: vi.fn(),
  };
  const factory = (opts: { host: string; tokenStore: TokenStore }): GeneweaveClient => {
    const { tokenStore } = opts;
    spies.authenticate.mockImplementation(async (email: string) => {
      await tokenStore.set({ token: 'jwt', csrfToken: 'csrf' });
      return { token: 'jwt', csrfToken: 'csrf', expiresAt: 'soon', user: { ...USER, email }, permissions: [] };
    });
    spies.register.mockImplementation(async ({ email, name }: { email: string; name: string }) => {
      await tokenStore.set({ token: 'jwt', csrfToken: 'csrf' });
      return { token: 'jwt', csrfToken: 'csrf', expiresAt: 'soon', user: { ...USER, email, name }, permissions: [] };
    });
    spies.signOut.mockImplementation(async () => {
      await tokenStore.clear();
    });
    return {
      authenticate: spies.authenticate,
      register: spies.register,
      getCurrentUser: spies.getCurrentUser,
      signOut: spies.signOut,
      removeDevice: spies.removeDevice,
    } as unknown as GeneweaveClient;
  };
  return { factory, spies };
}

const noBiometric: BiometricAuthenticator = {
  isEnrolled: async () => false,
  authenticate: async () => true,
};

const enrolledBiometric = (authResult: boolean): BiometricAuthenticator => ({
  isEnrolled: async () => true,
  authenticate: async () => authResult,
});

const HOST = 'https://api.example.com';

describe('createAuthController — initialize', () => {
  it('with no host → needs-host', async () => {
    const store = createAuthStore();
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { biometricEnabledByDefault: false },
    });
    await c.initialize();
    expect(store.getState().status).toBe('needs-host');
  });

  it('with env host but no stored tokens → signed-out', async () => {
    const store = createAuthStore();
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
    });
    await c.initialize();
    expect(store.getState()).toEqual({ status: 'signed-out', host: HOST });
  });

  it('with stored tokens + biometrics off → authenticated', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    await createTenantTokenStore(kv, HOST).set({ token: 'jwt', csrfToken: 'csrf' });
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
    });
    await c.initialize();
    const state = store.getState();
    expect(state.status).toBe('authenticated');
    if (state.status === 'authenticated') expect(state.user.id).toBe('u1');
  });

  it('with stored tokens + biometric gate on → locked on cold start', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    await createTenantTokenStore(kv, HOST).set({ token: 'jwt', csrfToken: 'csrf' });
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: enrolledBiometric(true),
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: true },
    });
    await c.initialize();
    expect(store.getState().status).toBe('locked');
  });

  it('AuthExpiredError on rehydrate → clears tokens and signs out', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    const tokenStore = createTenantTokenStore(kv, HOST);
    await tokenStore.set({ token: 'jwt', csrfToken: 'csrf' });
    const { factory } = fakeFactory({
      getCurrentUser: async () => {
        throw new AuthExpiredError({ request: { method: 'GET', path: '/api/auth/me' } });
      },
    });
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
    });
    await c.initialize();
    expect(store.getState()).toEqual({ status: 'signed-out', host: HOST });
    expect(await tokenStore.get()).toBeNull();
  });
});

describe('createAuthController — host + sign-in', () => {
  it('setHost rejects an unreachable server without changing state', async () => {
    const store = createAuthStore();
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: false }),
      env: { biometricEnabledByDefault: false },
    });
    await c.initialize();
    const result = await c.setHost('api.example.com');
    expect(result.ok).toBe(false);
    expect(store.getState().status).toBe('needs-host');
  });

  it('setHost accepts a reachable server and persists it', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true, surfaceId: 'mobile' }),
      env: { biometricEnabledByDefault: false },
    });
    await c.initialize();
    const result = await c.setHost('api.example.com');
    expect(result.ok).toBe(true);
    expect(store.getState()).toEqual({ status: 'signed-out', host: HOST });
  });

  it('signIn authenticates and persists tokens', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    const { factory, spies } = fakeFactory();
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
    });
    await c.initialize();
    await c.signIn('a@example.com', 'pw');
    expect(spies.authenticate).toHaveBeenCalledOnce();
    expect(store.getState().status).toBe('authenticated');
    expect(await createTenantTokenStore(kv, HOST).get()).toEqual({ token: 'jwt', csrfToken: 'csrf' });
  });

  it('register creates an account and persists tokens', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    const { factory, spies } = fakeFactory();
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
    });
    await c.initialize();
    await c.register('New Person', 'new@example.com', 'password1');
    expect(spies.register).toHaveBeenCalledOnce();
    expect(store.getState().status).toBe('authenticated');
    expect(await createTenantTokenStore(kv, HOST).get()).toEqual({ token: 'jwt', csrfToken: 'csrf' });
  });
});

describe('createAuthController — lock / unlock / sign-out', () => {
  it('lock then unlock with a successful biometric prompt', async () => {
    const store = createAuthStore();
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: enrolledBiometric(true),
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: true },
    });
    await c.initialize();
    await c.signIn('a@example.com', 'pw');
    expect(store.getState().status).toBe('authenticated'); // fresh sign-in is an explicit unlock
    c.lock();
    expect(store.getState().status).toBe('locked');
    const ok = await c.unlock();
    expect(ok).toBe(true);
    expect(store.getState().status).toBe('authenticated');
  });

  it('a failed biometric prompt keeps the app locked', async () => {
    const store = createAuthStore();
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: enrolledBiometric(false),
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: true },
    });
    await c.initialize();
    await c.signIn('a@example.com', 'pw');
    c.lock();
    const ok = await c.unlock();
    expect(ok).toBe(false);
    expect(store.getState().status).toBe('locked');
  });

  it('signOut deregisters the device and clears the session', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    const { factory, spies } = fakeFactory();
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
      getDeviceToken: async () => 'push-token-xyz',
    });
    await c.initialize();
    await c.signIn('a@example.com', 'pw');
    await c.signOut();
    expect(spies.removeDevice).toHaveBeenCalledWith('push-token-xyz');
    expect(spies.signOut).toHaveBeenCalled();
    expect(store.getState()).toEqual({ status: 'signed-out', host: HOST });
    expect(await createTenantTokenStore(kv, HOST).get()).toBeNull();
  });

  it('signOut still completes when device deregistration fails', async () => {
    const store = createAuthStore();
    const { factory, spies } = fakeFactory();
    spies.removeDevice.mockRejectedValue(new Error('network'));
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: noBiometric,
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
      getDeviceToken: async () => 'push-token-xyz',
    });
    await c.initialize();
    await c.signIn('a@example.com', 'pw');
    await c.signOut();
    expect(store.getState().status).toBe('signed-out');
  });
});

describe('createAuthController — re-lock window', () => {
  it('backgrounding past the threshold re-locks on foreground', async () => {
    const store = createAuthStore();
    let now = 1_000_000;
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: enrolledBiometric(true),
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: true },
      clock: () => now,
    });
    await c.initialize();
    await c.signIn('a@example.com', 'pw'); // authenticated
    c.handleAppStateChange('background');
    now += BIOMETRIC_RELOCK_MS + 1;
    c.handleAppStateChange('active');
    expect(store.getState().status).toBe('locked');
  });

  it('a brief background does not re-lock', async () => {
    const store = createAuthStore();
    let now = 1_000_000;
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv: memoryKv(),
      makeClient: factory,
      biometric: enrolledBiometric(true),
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: true },
      clock: () => now,
    });
    await c.initialize();
    await c.signIn('a@example.com', 'pw');
    c.handleAppStateChange('background');
    now += 1000;
    c.handleAppStateChange('active');
    expect(store.getState().status).toBe('authenticated');
  });
});

describe('createAuthController — biometric preference', () => {
  it('persists the biometric preference and reflects it via the getter', async () => {
    const store = createAuthStore();
    const kv = memoryKv();
    const { factory } = fakeFactory();
    const c = createAuthController({
      store,
      kv,
      makeClient: factory,
      biometric: enrolledBiometric(true),
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
    });
    await c.initialize();
    expect(c.isBiometricEnabled()).toBe(false);
    expect(c.isBiometricAvailable()).toBe(true);
    await c.setBiometricEnabled(true);
    expect(c.isBiometricEnabled()).toBe(true);
    // Persisted: a fresh controller on the same kv reads the stored preference.
    const store2 = createAuthStore();
    const c2 = createAuthController({
      store: store2,
      kv,
      makeClient: factory,
      biometric: enrolledBiometric(true),
      hostProbe: async () => ({ reachable: true }),
      env: { defaultHost: HOST, biometricEnabledByDefault: false },
    });
    await c2.initialize();
    expect(c2.isBiometricEnabled()).toBe(true);
  });
});

describe('createAuthController — per-tenant isolation', () => {
  it('two tenants share one device with isolated sessions', async () => {
    const kv = memoryKv();
    const makeFor = (tenantId: string) => {
      const store = createAuthStore();
      const { factory } = fakeFactory();
      const c = createAuthController({
        store,
        kv,
        makeClient: factory,
        biometric: noBiometric,
        hostProbe: async () => ({ reachable: true }),
        env: { defaultHost: HOST, tenantId, biometricEnabledByDefault: false },
      });
      return { store, c };
    };
    const a = makeFor('tenant-a');
    const b = makeFor('tenant-b');
    await a.c.initialize();
    await b.c.initialize();
    await a.c.signIn('a@example.com', 'pw');
    // tenant-a is authenticated; tenant-b stays signed-out until it signs in.
    expect(a.store.getState().status).toBe('authenticated');
    expect(b.store.getState().status).toBe('signed-out');
    expect(await createTenantTokenStore(kv, HOST, 'tenant-a').get()).not.toBeNull();
    expect(await createTenantTokenStore(kv, HOST, 'tenant-b').get()).toBeNull();
  });
});
