/**
 * use-oauth-sign-in.ts — native hook that drives a provider OAuth sign-in.
 *
 * Ties together the three pure pieces: the API client (to get the provider
 * authorize URL with the app's redirect URI), the in-app auth session runner
 * (to open the browser and capture the redirect), the pure callback parser, and
 * the auth controller (to persist the minted session). The component layer just
 * calls `signInWith(provider)` and reacts to the result.
 */
import { useMemo, useState } from 'react';
import * as Linking from 'expo-linking';
import { useAuth } from '../providers/auth-provider';
import { parseNativeOAuthCallback, isNativeOAuthError, type OAuthProviderId } from '../../lib';
import { createExpoOAuthRunner } from '../adapters/expo-web-browser-oauth';

export interface OAuthSignInResult {
  ok: boolean;
  /** Set when the flow failed (not set on user cancellation). */
  error?: string;
}

export interface UseOAuthSignIn {
  /** Run the full OAuth flow for a provider. Never throws — failures land in `result.error`. */
  signInWith(provider: OAuthProviderId): Promise<OAuthSignInResult>;
  /** The provider whose flow is currently in-flight, or null. */
  pending: OAuthProviderId | null;
}

export function useOAuthSignIn(): UseOAuthSignIn {
  const { controller, client } = useAuth();
  const runner = useMemo(() => createExpoOAuthRunner(), []);
  const [pending, setPending] = useState<OAuthProviderId | null>(null);

  async function signInWith(provider: OAuthProviderId): Promise<OAuthSignInResult> {
    if (!client) return { ok: false, error: 'No server selected' };
    setPending(provider);
    try {
      // In Expo Go this is exp://…/--/oauth; in a standalone build geneweave://oauth.
      const redirectUri = Linking.createURL('oauth');
      const { authUrl } = await client.getOAuthAuthorizeUrl(provider, { native: redirectUri });
      const resultUrl = await runner.open(authUrl, redirectUri);
      if (!resultUrl) return { ok: false }; // user cancelled

      const parsed = parseNativeOAuthCallback(resultUrl);
      if (isNativeOAuthError(parsed)) return { ok: false, error: parsed.error };

      await controller.completeOAuthSignIn({ token: parsed.token, csrfToken: parsed.csrfToken });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Sign-in failed' };
    } finally {
      setPending(null);
    }
  }

  return { signInWith, pending };
}
