/**
 * composition-root.ts — wires the pure auth controller to native adapters.
 *
 * This is the one place the device-only adapters (`expo-secure-store`,
 * `expo-local-authentication`) meet the framework-agnostic controller from
 * `src/lib`. Everything below is a thin assembly of already-tested pieces:
 *
 *   env (EXPO_PUBLIC_*) ─┐
 *   SecureStore KV ──────┼─→ createAuthController ─→ observable AuthStore
 *   Expo biometric ──────┤
 *   GeneweaveClient ─────┘
 *
 * Per-tenant tokens: `env.tenantId` (from `EXPO_PUBLIC_TENANT_ID`) flows into
 * the controller, which namespaces the SecureStore token store per
 * `tenant@host`, so one device can hold isolated sessions for several tenants.
 *
 * Push token: `getDeviceToken` is injected into the controller so sign-out can
 * call `client.removeDevice(token)` as a best-effort deregistration step without
 * pulling expo-notifications into the pure auth layer.
 */
import { createGeneweaveClient, type GeneweaveClient } from '@weaveintel/api-client';
import {
  createAuthController,
  createAuthStore,
  createCatalogHostProbe,
  readMobileEnv,
  type AuthController,
  type AuthStore,
  type ClientFactory,
} from '../lib';
import { createSecureStoreKv } from './adapters/expo-secure-store';
import { createExpoBiometric } from './adapters/expo-biometric';
import { createRnSseTransport } from './adapters/rn-sse-transport';
import { getStoredPushToken } from '../lib/push/push-token';

/** A client version tag sent on every request for server-side telemetry. */
const CLIENT_VERSION = 'geneweave-mobile/1.0.0';

/** The assembled auth surface shared by the app via {@link AuthProvider}. */
export interface AppAuth {
  store: AuthStore;
  controller: AuthController;
}

/**
 * Builds the app's auth controller + store from native adapters. Call once at
 * the composition root (the auth provider); the controller owns the active
 * `GeneweaveClient` and rebuilds it whenever the host changes.
 */
export function createAppAuth(): AppAuth {
  const env = readMobileEnv();
  const kv = createSecureStoreKv();
  const store = createAuthStore();

  const makeClient: ClientFactory = ({ host, tokenStore }): GeneweaveClient => {
    const extraHeaders = { 'X-Client-Version': CLIENT_VERSION };
    return createGeneweaveClient({
      host,
      tokenStore,
      extraHeaders,
      // React Native's fetch has no streaming `response.body`, so resumable SSE
      // needs an XHR-based transport. The default transport handles `request`.
      transport: createRnSseTransport({ host, tokenStore, extraHeaders }),
    });
  };

  const controller = createAuthController({
    store,
    kv,
    makeClient,
    biometric: createExpoBiometric(),
    hostProbe: createCatalogHostProbe(makeClient),
    env: {
      ...(env.defaultHost !== undefined ? { defaultHost: env.defaultHost } : {}),
      ...(env.tenantId !== undefined ? { tenantId: env.tenantId } : {}),
      biometricEnabledByDefault: env.biometricEnabledByDefault,
    },
    // Provide the push token getter so sign-out can deregister the device.
    getDeviceToken: async () => {
      const stored = await getStoredPushToken(kv);
      return stored?.token ?? null;
    },
  });

  return { store, controller };
}
