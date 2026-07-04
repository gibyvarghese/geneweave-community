/**
 * expo-web-browser-oauth.ts — native adapter for the OAuth sign-in flow.
 *
 * This is the only place that imports `expo-web-browser`. It opens an in-app
 * authentication session (ASWebAuthenticationSession on iOS, Custom Tabs on
 * Android) for the provider authorization URL and resolves with the redirect
 * URL the server 302s back to the app scheme. All decision logic (building the
 * authorize URL, parsing the callback, persisting the session) lives in the
 * pure lib + controller; this adapter only bridges to the OS.
 */
import * as WebBrowser from 'expo-web-browser';

// Required so a web-popup auth session can settle; harmless on native.
WebBrowser.maybeCompleteAuthSession();

/** Opens an in-app auth session and returns the redirect URL, or null if dismissed. */
export interface OAuthSessionRunner {
  /**
   * @param authUrl     the provider authorization URL (from the server)
   * @param redirectUri the app-scheme URL the session watches for completion
   * @returns the full redirect URL on success, or null when the user cancels.
   */
  open(authUrl: string, redirectUri: string): Promise<string | null>;
}

export function createExpoOAuthRunner(): OAuthSessionRunner {
  return {
    async open(authUrl, redirectUri) {
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
      return result.type === 'success' ? result.url : null;
    },
  };
}
