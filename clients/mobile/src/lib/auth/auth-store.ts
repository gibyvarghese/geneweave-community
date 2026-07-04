/**
 * auth-store.ts — a minimal framework-agnostic observable for auth state.
 *
 * The controller mutates this store; the React layer subscribes via
 * `useSyncExternalStore` (see `src/native/providers/auth-provider.tsx`). Keeping
 * the store free of React means the whole auth brain is unit-testable in Node.
 */

import type { MeUser } from '@weaveintel/api-client';

/**
 * The auth lifecycle as a discriminated union. Screens render purely from
 * `status`, so there is no ambiguous "loading + maybe user" intermediate.
 *
 *  - `initializing` — rehydrating from secure storage on launch.
 *  - `needs-host`   — no validated server configured (server-picker screen).
 *  - `signed-out`   — host known, no valid session (sign-in screen).
 *  - `locked`       — valid session held but the biometric gate is engaged.
 *  - `authenticated`— ready; the tab navigator is shown.
 */
export type AuthState =
  | { status: 'initializing' }
  | { status: 'needs-host' }
  | { status: 'signed-out'; host: string }
  | { status: 'locked'; host: string; user: MeUser }
  | { status: 'authenticated'; host: string; user: MeUser };

export type AuthListener = (state: AuthState) => void;

/** A tiny observable store — `getState` / `subscribe` / `setState`. */
export interface AuthStore {
  getState(): AuthState;
  setState(next: AuthState): void;
  subscribe(listener: AuthListener): () => void;
}

/** Creates an {@link AuthStore} seeded with `initial` (defaults to initializing). */
export function createAuthStore(initial: AuthState = { status: 'initializing' }): AuthStore {
  let state = initial;
  const listeners = new Set<AuthListener>();
  return {
    getState: () => state,
    setState(next: AuthState) {
      state = next;
      for (const l of listeners) l(state);
    },
    subscribe(listener: AuthListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
