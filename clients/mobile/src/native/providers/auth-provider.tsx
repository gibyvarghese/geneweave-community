/**
 * auth-provider.tsx — drives the auth controller and publishes auth state.
 *
 * Device-gated (imports `react` / `react-native`): part of the native view
 * layer. All decision logic lives in the pure controller from `src/lib`; this
 * component only (1) builds the controller once via the composition root,
 * (2) mirrors its observable store into React with `useSyncExternalStore`,
 * (3) runs `initialize()` on mount, and (4) forwards OS app-state transitions
 * so the biometric re-lock window is enforced when the app is backgrounded.
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { GeneweaveClient } from '@weaveintel/api-client';
import { createAppAuth, type AppAuth } from '../composition-root';
import type { AuthController, AuthState } from '../../lib';

interface AuthContextValue {
  state: AuthState;
  controller: AuthController;
  /** The active client for the current host, or null before a host is set. */
  client: GeneweaveClient | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Build the controller + store exactly once for the app's lifetime.
  const ref = useRef<AppAuth | null>(null);
  ref.current ??= createAppAuth();
  const { store, controller } = ref.current;

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    void controller.initialize();
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active' || next === 'background' || next === 'inactive') {
        controller.handleAppStateChange(next);
      }
    });
    return () => sub.remove();
  }, [controller]);

  return (
    <AuthContext.Provider value={{ state, controller, client: controller.getClient() }}>
      {children}
    </AuthContext.Provider>
  );
}

/** Access auth state + actions. Throws if used outside {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/**
 * The active geneWeave client for the current host. Throws when no host is set
 * yet (callers gate on auth state, so a client is always present once
 * authenticated).
 */
export function useClient(): GeneweaveClient {
  const { client } = useAuth();
  if (!client) throw new Error('No geneWeave client — a host must be selected first');
  return client;
}
