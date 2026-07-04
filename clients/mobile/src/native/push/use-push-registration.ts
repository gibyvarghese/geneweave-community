/**
 * use-push-registration.ts — manages the device push token lifecycle.
 *
 * Device-gated. This hook:
 *   1. Requests notification permission on first call (triggered post-sign-in).
 *   2. Fetches the APNs / FCM device token.
 *   3. Registers the token with the geneWeave server via POST /api/me/devices.
 *   4. Persists the token in SecureStore so sign-out can deregister it.
 *
 * The hook is intentionally idempotent — re-running it when the token is
 * already registered is a no-op (checked via the stored token). Calling it
 * before the user has signed in is safe; it bails when client is null.
 *
 * Permission is requested lazily (not on app open) in compliance with app-store
 * review guidelines: we ask only when the user has indicated they want
 * notifications (first visit to Settings → Notifications, or after creating a
 * reminder / receiving an approval).
 */
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { GeneweaveClient } from '@weaveintel/api-client';
import {
  requestNotificationPermission,
  getDevicePushToken,
} from '../adapters/expo-notifications-adapter';
import {
  getStoredPushToken,
  setStoredPushToken,
  channelForPlatform,
  type PushPermissionStatus,
} from '../../lib/push/push-token';
import { createSecureStoreKv } from '../adapters/expo-secure-store';

export interface UsePushRegistrationResult {
  /** Current permission status — only meaningful after requestAndRegister() is called. */
  permissionStatus: PushPermissionStatus;
  /** Whether registration is currently in-flight. */
  isRegistering: boolean;
  /** Any error from the last registration attempt. */
  registrationError: Error | null;
  /**
   * Request permission and register the device token. Safe to call multiple
   * times; re-registration is skipped when the stored token matches. Pass the
   * active geneWeave client (available from useClient() when authenticated).
   */
  requestAndRegister: (client: GeneweaveClient) => Promise<void>;
}

const kv = createSecureStoreKv();

export function usePushRegistration(): UsePushRegistrationResult {
  const [permissionStatus, setPermissionStatus] = useState<PushPermissionStatus>('undetermined');
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationError, setRegistrationError] = useState<Error | null>(null);
  const inFlightRef = useRef(false);

  const requestAndRegister = useCallback(async (client: GeneweaveClient) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsRegistering(true);
    setRegistrationError(null);

    try {
      const status = await requestNotificationPermission();
      setPermissionStatus(status);
      if (status !== 'granted') return;

      const pushDevice = await getDevicePushToken();
      if (!pushDevice) return; // simulator or unavailable

      // Skip re-registration if the token hasn't changed.
      const stored = await getStoredPushToken(kv);
      if (stored && stored.token === pushDevice.token) return;

      await client.registerDevice({
        channel: pushDevice.channel,
        token: pushDevice.token,
        label: `${Platform.OS}-${Platform.Version}`,
      });
      await setStoredPushToken(kv, pushDevice);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setRegistrationError(error);
      console.warn('[push] device registration failed:', error.message);
    } finally {
      setIsRegistering(false);
      inFlightRef.current = false;
    }
  }, []);

  return { permissionStatus, isRegistering, registrationError, requestAndRegister };
}
