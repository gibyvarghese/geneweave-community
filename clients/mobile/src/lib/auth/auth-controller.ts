/**
 * auth-controller.ts — the framework-agnostic auth "brain".
 *
 * Owns the auth lifecycle (host selection → sign-in → biometric gate → sign-out)
 * and drives an {@link AuthStore}. Every capability it needs is injected as an
 * interface — a {@link GeneweaveClient} factory, a secure {@link KeyValueStore},
 * a {@link BiometricAuthenticator}, and a clock — so the entire controller runs
 * and is tested in Node with no React / RN / expo present. The native layer
 * (`src/native/`) supplies real adapters; tests supply fakes.
 */

import type { GeneweaveClient, MeUser, TokenStore, KeyValueStore } from '@weaveintel/api-client';
import { AuthExpiredError } from '@weaveintel/api-client';
import type { AuthStore } from './auth-store.js';
import type { HostProbe, HostValidation } from './host.js';
import { validateHost } from './host.js';
import {
  createTenantTokenStore,
  getStoredHost,
  setStoredHost,
  getStoredBiometricEnabled,
  setStoredBiometricEnabled,
} from './secure-token-store.js';
import {
  requiresUnlockOnColdStart,
  requiresUnlockOnForeground,
  type BiometricGateState,
} from './biometric-gate.js';

/** Performs the native biometric prompt. Implemented over `expo-local-authentication`. */
export interface BiometricAuthenticator {
  /** Whether the device has biometrics enrolled and usable. */
  isEnrolled(): Promise<boolean>;
  /** Prompts; resolves `true` on success, `false` on cancel/failure. Never throws. */
  authenticate(reason: string): Promise<boolean>;
}

/** Builds a per-(host, tenant) client. The composition root wires this to `createGeneweaveClient`. */
export type ClientFactory = (opts: { host: string; tokenStore: TokenStore }) => GeneweaveClient;

export interface AuthControllerOptions {
  store: AuthStore;
  /** Secure key/value storage (`expo-secure-store` in the app). */
  kv: KeyValueStore;
  makeClient: ClientFactory;
  biometric: BiometricAuthenticator;
  /** Reachability probe for {@link validateHost}; built over a throwaway client. */
  hostProbe: HostProbe;
  /** Resolved build env: a default host skips the picker; a tenant id namespaces sessions. */
  env: { defaultHost?: string; tenantId?: string; biometricEnabledByDefault: boolean };
  /** Injectable clock for the re-lock window (defaults to `Date.now`). */
  clock?: () => number;
  /** Optional: the current push token, so sign-out can deregister the device. */
  getDeviceToken?: () => Promise<string | null>;
}

/** The public controller surface consumed by the React providers. */
export interface AuthController {
  /** Rehydrate from secure storage and resolve the initial state. */
  initialize(): Promise<void>;
  /** Validate + persist a user-entered host (used by the server-picker screen). */
  setHost(rawHost: string): Promise<HostValidation>;
  /** Credential sign-in against the active host. */
  signIn(email: string, password: string): Promise<void>;
  /** Create a new account against the active host, then transition to `authenticated`. */
  register(name: string, email: string, password: string): Promise<void>;
  /**
   * Complete a native OAuth sign-in: persist the bearer session minted by the
   * server callback, fetch the user, and transition to `authenticated`.
   */
  completeOAuthSignIn(tokens: { token: string; csrfToken: string }): Promise<void>;
  /** Run the biometric prompt; on success transition `locked` → `authenticated`. */
  unlock(): Promise<boolean>;
  /** Force the biometric gate on (no-op when the gate is inactive). */
  lock(): void;
  /** Clear the session + best-effort device deregistration. */
  signOut(): Promise<void>;
  /** Toggle the biometric preference (persisted). */
  setBiometricEnabled(enabled: boolean): Promise<void>;
  /** Whether the biometric-gate preference is currently on. */
  isBiometricEnabled(): boolean;
  /** Whether the device has an enrolled biometric (so the gate can be enabled). */
  isBiometricAvailable(): boolean;
  /** Feed OS app-state transitions so the re-lock window can engage. */
  handleAppStateChange(next: 'active' | 'background' | 'inactive'): void;
  /** The active client for the signed-in host, or `null`. */
  getClient(): GeneweaveClient | null;
}

const UNLOCK_REASON = 'Unlock geneWeave';

export function createAuthController(opts: AuthControllerOptions): AuthController {
  const { store, kv, makeClient, biometric, hostProbe, env } = opts;
  const clock = opts.clock ?? Date.now;

  // Mutable runtime state (intentionally private; the store holds the public state).
  let host: string | null = env.defaultHost ?? null;
  const tenantId = env.tenantId;
  let client: GeneweaveClient | null = null;
  let user: MeUser | null = null;
  let biometricEnabled = env.biometricEnabledByDefault;
  let enrolled = false;
  let backgroundedAt: number | null = null;

  function buildClient(forHost: string): GeneweaveClient {
    const tokenStore = createTenantTokenStore(kv, forHost, tenantId);
    return makeClient({ host: forHost, tokenStore });
  }

  function gateState(): BiometricGateState {
    return { enabled: biometricEnabled, enrolled, backgroundedAt };
  }

  /** Decide locked vs authenticated for a freshly-resolved session. */
  function settleAuthenticated(coldStart: boolean): void {
    if (!host || !user) return;
    const lock = coldStart
      ? requiresUnlockOnColdStart({ enabled: biometricEnabled, enrolled })
      : false;
    store.setState(
      lock
        ? { status: 'locked', host, user }
        : { status: 'authenticated', host, user },
    );
  }

  async function loadEnrollment(): Promise<void> {
    try {
      enrolled = await biometric.isEnrolled();
    } catch {
      enrolled = false;
    }
  }

  return {
    async initialize() {
      store.setState({ status: 'initializing' });
      await loadEnrollment();
      const storedPref = await getStoredBiometricEnabled(kv);
      if (storedPref !== null) biometricEnabled = storedPref;

      // Resolve effective host: env default wins, else last validated host.
      const hostFromEnv = !!host;
      if (!host) host = await getStoredHost(kv);
      if (!host) {
        store.setState({ status: 'needs-host' });
        return;
      }
      // Only persist when the host came from the environment config. A user-chosen
      // host was already saved by setHost() and must not be overwritten on every launch.
      if (hostFromEnv) await setStoredHost(kv, host);

      client = buildClient(host);
      const tokens = await createTenantTokenStore(kv, host, tenantId).get();
      if (!tokens) {
        store.setState({ status: 'signed-out', host });
        return;
      }
      try {
        user = await client.getCurrentUser();
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          await client.signOut().catch(() => {});
          user = null;
          store.setState({ status: 'signed-out', host });
          return;
        }
        throw err;
      }
      settleAuthenticated(/* coldStart */ true);
    },

    async setHost(rawHost: string): Promise<HostValidation> {
      const result = await validateHost(hostProbe, rawHost);
      if (!result.ok) return result;
      host = result.host;
      await setStoredHost(kv, host);
      client = buildClient(host);
      store.setState({ status: 'signed-out', host });
      return result;
    },

    async signIn(email: string, password: string) {
      if (!host) throw new Error('No host configured');
      if (!client) client = buildClient(host);
      const session = await client.authenticate(email, password);
      user = session.user;
      // A fresh sign-in is an explicit unlock — do not re-prompt biometrics now.
      backgroundedAt = null;
      settleAuthenticated(/* coldStart */ false);
    },

    async register(name: string, email: string, password: string) {
      if (!host) throw new Error('No host configured');
      if (!client) client = buildClient(host);
      const session = await client.register({ name, email, password });
      user = session.user;
      // A fresh registration is an explicit unlock — do not re-prompt biometrics now.
      backgroundedAt = null;
      settleAuthenticated(/* coldStart */ false);
    },

    async completeOAuthSignIn(tokens: { token: string; csrfToken: string }) {
      if (!host) throw new Error('No host configured');
      const tokenStore = createTenantTokenStore(kv, host, tenantId);
      await tokenStore.set(tokens);
      if (!client) client = buildClient(host);
      try {
        user = await client.getCurrentUser();
      } catch (err) {
        await tokenStore.clear().catch(() => {});
        throw err;
      }
      // A fresh OAuth sign-in is an explicit unlock — do not re-prompt biometrics now.
      backgroundedAt = null;
      settleAuthenticated(/* coldStart */ false);
    },

    async unlock(): Promise<boolean> {
      const current = store.getState();
      if (current.status !== 'locked') return current.status === 'authenticated';
      const ok = await biometric.authenticate(UNLOCK_REASON);
      if (ok) {
        backgroundedAt = null;
        store.setState({ status: 'authenticated', host: current.host, user: current.user });
      }
      return ok;
    },

    lock() {
      const current = store.getState();
      if (current.status === 'authenticated') {
        store.setState({ status: 'locked', host: current.host, user: current.user });
      }
    },

    async signOut() {
      if (client && opts.getDeviceToken) {
        try {
          const deviceToken = await opts.getDeviceToken();
          if (deviceToken) await client.removeDevice(deviceToken);
        } catch {
          /* best-effort device deregistration; never block sign-out */
        }
      }
      if (client) await client.signOut().catch(() => {});
      user = null;
      backgroundedAt = null;
      store.setState(host ? { status: 'signed-out', host } : { status: 'needs-host' });
    },

    async setBiometricEnabled(enabled: boolean) {
      biometricEnabled = enabled;
      await setStoredBiometricEnabled(kv, enabled);
    },

    isBiometricEnabled() {
      return biometricEnabled;
    },

    isBiometricAvailable() {
      return enrolled;
    },

    handleAppStateChange(next) {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt = clock();
        return;
      }
      // next === 'active'
      const current = store.getState();
      if (current.status === 'authenticated' && requiresUnlockOnForeground(gateState(), clock())) {
        store.setState({ status: 'locked', host: current.host, user: current.user });
      }
      backgroundedAt = null;
    },

    getClient() {
      return client;
    },
  };
}
