/**
 * (auth)/sign-in.tsx — email + password sign-in / registration and social (OAuth).
 *
 * One screen toggles between "Sign in" and "Create account" (mirroring the web
 * app). Sign-in delegates to the pure controller's `signIn`; registration adds a
 * Name field and delegates to `register`. Social sign-in delegates to the
 * `useOAuthSignIn` hook for either mode. Only providers the server reports as
 * configured are rendered. On success the route gate navigates into `(tabs)`
 * automatically.
 */
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { useAuth, useTheme } from '../../src/native/providers';
import { Screen, Heading, Body, Field, PrimaryButton, ErrorText } from '../../src/native/ui/primitives';
import { SocialSignInButtons } from '../../src/native/ui/social-sign-in-buttons';
import { useOAuthSignIn } from '../../src/native/auth/use-oauth-sign-in';
import { parseAuthProviders, type OAuthProviderId } from '../../src/lib';

type Mode = 'sign-in' | 'register';

export default function SignInScreen() {
  const { controller, client, state } = useAuth();
  const { theme } = useTheme();
  const host = state.status === 'signed-out' ? state.host : undefined;
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProviderId[]>([]);
  const { signInWith, pending: oauthPending } = useOAuthSignIn();

  const isRegister = mode === 'register';

  // Discover which social providers the server has configured.
  useEffect(() => {
    let active = true;
    if (!client) return;
    void client
      .getAuthProviders()
      .then((raw) => {
        if (active) setProviders(parseAuthProviders(raw));
      })
      .catch((err: unknown) => {
        console.warn('[sign-in] getAuthProviders failed — social sign-in buttons will be hidden', err);
        if (active) setProviders([]);
      });
    return () => {
      active = false;
    };
  }, [client]);

  function toggleMode() {
    setMode((m) => (m === 'sign-in' ? 'register' : 'sign-in'));
    setError(null);
  }

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      if (isRegister) {
        await controller.register(name.trim(), email.trim(), password);
      } else {
        await controller.signIn(email.trim(), password);
      }
    } catch {
      setError(
        isRegister
          ? 'Could not create your account. Check your details and try again.'
          : 'Sign-in failed. Check your email and password, then try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function onSocial(provider: OAuthProviderId) {
    setError(null);
    const result = await signInWith(provider);
    if (!result.ok && result.error) {
      setError('Social sign-in failed. Please try again.');
    }
  }

  const submitDisabled =
    email.trim().length === 0 ||
    password.length === 0 ||
    (isRegister && name.trim().length === 0);

  return (
    <Screen>
      <Heading>{isRegister ? 'Create account' : 'Sign in'}</Heading>
      {host ? <Body muted>{host}</Body> : null}
      {isRegister ? (
        <Field
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          autoCapitalize="words"
          autoCorrect={false}
          textContentType="name"
        />
      ) : null}
      <Field
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        inputMode="email"
        textContentType={isRegister ? 'emailAddress' : 'username'}
      />
      <Field
        value={password}
        onChangeText={setPassword}
        placeholder={isRegister ? 'Password (8+ characters)' : 'Password'}
        secureTextEntry
        textContentType={isRegister ? 'newPassword' : 'password'}
        returnKeyType="go"
        onSubmitEditing={onSubmit}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton
        label={isRegister ? 'Create account' : 'Sign in'}
        onPress={onSubmit}
        busy={busy}
        disabled={submitDisabled}
      />
      <SocialSignInButtons
        providers={providers}
        onSelect={onSocial}
        pending={oauthPending}
        disabled={busy}
      />
      <Pressable onPress={toggleMode} disabled={busy} hitSlop={8} style={{ alignItems: 'center', paddingVertical: theme.spacing.sm }}>
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.bodySmall.fontSize,
          }}
        >
          {isRegister ? 'Already have an account? ' : 'No account? '}
          <Text style={{ color: theme.colors.accent, fontWeight: '600' }}>
            {isRegister ? 'Sign in' : 'Register'}
          </Text>
        </Text>
      </Pressable>
    </Screen>
  );
}
