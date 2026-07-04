/**
 * use-protected-route.ts — redirects between the `(auth)` and `(tabs)` groups
 * based on the observable auth state.
 *
 * Device-gated (uses `expo-router` hooks). The state machine it switches on is
 * produced entirely by the pure controller in `src/lib`, so the redirect
 * targets are a thin, declarative projection of already-tested states:
 *
 *   initializing → (hold splash, no navigation)
 *   needs-host   → /(auth)/server
 *   signed-out   → /(auth)/sign-in
 *   locked       → /(auth)/unlock
 *   authenticated→ /(tabs)
 */
import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';
import type { AuthState } from '../../lib';

export function useProtectedRoute(state: AuthState): void {
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'initializing') return;
    // Widen the typed-route tuple so the empty root-index case (`/`) is
    // expressible; the generated union does not include the zero-segment tuple.
    const seg = segments as readonly string[];
    const inAuthGroup = seg[0] === '(auth)';
    // The bare index route (`/`) is a transient spinner that exists only to be
    // redirected away from; it has no segments.
    const atRootIndex = seg.length === 0;

    switch (state.status) {
      case 'needs-host':
        router.replace('/(auth)/server');
        break;
      case 'signed-out':
        router.replace('/(auth)/sign-in');
        break;
      case 'locked':
        router.replace('/(auth)/unlock');
        break;
      case 'authenticated':
        // Rescue the user into the tabs from the auth group or the root index,
        // but never bounce them off a legitimate pushed account sub-screen
        // (memory, settings, widget-gallery).
        if (inAuthGroup || atRootIndex) router.replace('/(tabs)');
        break;
    }
  }, [state.status, segments, router]);
}
