/**
 * (auth)/unlock.tsx — biometric re-lock screen.
 *
 * Shown when the session is valid but the biometric gate is active (cold start
 * or a re-lock after the background window). `unlock` triggers the native
 * Face ID / Touch ID prompt via the controller; `signOut` provides an escape
 * hatch. The gate decision lives in `src/lib/auth/biometric-gate.ts`.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../src/native/providers';
import { Screen, Heading, Body, PrimaryButton, ErrorText } from '../../src/native/ui/primitives';

export default function UnlockScreen() {
  const { controller, state } = useAuth();
  const user = state.status === 'locked' ? state.user : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onUnlock() {
    if (!mounted.current) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await controller.unlock();
      if (mounted.current && !ok) setError('Could not verify. Try again, or sign out.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Prompt automatically on mount for a smooth return-to-app experience.
  useEffect(() => {
    void onUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen>
      <Heading>Welcome back</Heading>
      {user ? <Body muted>{user.email}</Body> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton label="Unlock" onPress={onUnlock} busy={busy} />
      <PrimaryButton label="Sign out" onPress={() => void controller.signOut()} disabled={busy} />
    </Screen>
  );
}
