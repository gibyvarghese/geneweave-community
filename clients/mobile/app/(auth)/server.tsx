/**
 * (auth)/server.tsx — pick the geneWeave server to connect to.
 *
 * Calls the pure controller's `setHost`, which normalizes the address, probes
 * the catalog endpoint for reachability, and persists it per-tenant. A friendly,
 * non-technical message is shown when validation fails — all of that logic is
 * tested in `src/lib/auth/host.test.ts`; this screen is just the input surface.
 */
import { useState } from 'react';
import { useAuth } from '../../src/native/providers';
import { Screen, Heading, Body, Field, PrimaryButton, ErrorText } from '../../src/native/ui/primitives';

export default function ServerScreen() {
  const { controller } = useAuth();
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onContinue() {
    setBusy(true);
    setError(null);
    try {
      const result = await controller.setHost(host);
      if (!result.ok) setError(result.reason);
      // On success, the auth state flips to `signed-out` and the route gate
      // navigates to sign-in automatically.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Heading>Connect to geneWeave</Heading>
      <Body muted>Enter your server address to get started.</Body>
      <Field
        value={host}
        onChangeText={setHost}
        placeholder="your-team.geneweave.app"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
        returnKeyType="go"
        onSubmitEditing={onContinue}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton label="Continue" onPress={onContinue} busy={busy} disabled={host.trim().length === 0} />
    </Screen>
  );
}
