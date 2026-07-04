/**
 * push-token.ts — pure logic for push notification token lifecycle.
 *
 * Framework-free: no Expo, no React Native. Models the registration/
 * deregistration lifecycle so auth-controller can call getDeviceToken()
 * without importing anything device-specific. The native layer supplies a
 * concrete storage key via {@link PUSH_TOKEN_STORE_KEY}.
 */

import type { KeyValueStore } from '@weaveintel/api-client';

/** SecureStore key where the device push token is persisted between launches. */
export const PUSH_TOKEN_STORE_KEY = '@geneweave/push:device-token';

/** The channel identifier sent to POST /api/me/devices. */
export type PushChannel = 'apns' | 'fcm';

/** Platform-resolved channel from the device's OS. */
export interface PushDevice {
  channel: PushChannel;
  token: string;
}

/** Permission grant status — matches expo-notifications PermissionStatus values. */
export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

/** Persisted token details — stored as JSON in SecureStore. */
export interface StoredPushToken {
  token: string;
  channel: PushChannel;
  registeredAt: string;
}

/** Reads the stored push token, or null if none is persisted. */
export async function getStoredPushToken(kv: KeyValueStore): Promise<StoredPushToken | null> {
  const raw = await kv.getItem(PUSH_TOKEN_STORE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredPushToken;
  } catch {
    return null;
  }
}

/** Persists the push token (called after successful device registration). */
export async function setStoredPushToken(kv: KeyValueStore, device: PushDevice): Promise<void> {
  const stored: StoredPushToken = {
    token: device.token,
    channel: device.channel,
    registeredAt: new Date().toISOString(),
  };
  await kv.setItem(PUSH_TOKEN_STORE_KEY, JSON.stringify(stored));
}

/** Removes the persisted push token (called on sign-out). */
export async function clearStoredPushToken(kv: KeyValueStore): Promise<void> {
  await kv.removeItem(PUSH_TOKEN_STORE_KEY);
}

/**
 * Resolve the channel for the current platform. The caller (native adapter)
 * already knows the platform; this is just a typed helper so the mapping
 * lives in the pure layer.
 */
export function channelForPlatform(platform: 'ios' | 'android'): PushChannel {
  return platform === 'ios' ? 'apns' : 'fcm';
}
