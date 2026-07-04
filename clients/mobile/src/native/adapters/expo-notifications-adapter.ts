/**
 * expo-notifications-adapter.ts — wraps expo-notifications for the push
 * notification lifecycle.
 *
 * Device-gated: imports expo-notifications and expo-device. The pure logic
 * layer only sees {@link PushChannel} / {@link PushDevice} types. This adapter
 * provides the one place where device-specific calls live.
 *
 * Architecture note: foreground notification display is suppressed here (we
 * render in-app banners instead via {@link PushProvider}). Background and
 * killed-app notifications are handled by the OS and the registered background
 * task handler ({@link notification-categories}).
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { PushChannel, PushDevice } from '../../lib/push/push-token';

/** Registers an Android notification channel (no-op on iOS). */
function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  return Notifications.setNotificationChannelAsync('default', {
    name: 'General',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#7C5CFC',
  }).then(() => {});
}

/**
 * Configures how foreground notifications are handled. We suppress the OS
 * banner and instead show an in-app banner via {@link PushProvider}. Badge
 * updates are still applied.
 */
export function configureForegroundNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: false,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

/** Requests notification permission. Returns the final permission status. */
export async function requestNotificationPermission(): Promise<'granted' | 'denied' | 'undetermined'> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return 'granted';
  if (existing === 'denied') return 'denied';
  const { status: asked } = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
      allowAnnouncements: false,
    },
  });
  return asked as 'granted' | 'denied' | 'undetermined';
}

/**
 * Retrieves the device push token (APNs on iOS, FCM on Android).
 * Returns null when running in a simulator/emulator (no real push infrastructure).
 */
export async function getDevicePushToken(): Promise<PushDevice | null> {
  // Physical device required for real push tokens.
  if (!Device.isDevice) return null;

  await ensureAndroidChannel();

  try {
    const tokenResult = await Notifications.getDevicePushTokenAsync();
    const channel: PushChannel = tokenResult.type === 'ios' ? 'apns' : 'fcm';
    return { channel, token: tokenResult.data };
  } catch {
    return null;
  }
}

/** Sets the app badge count (iOS). On Android this calls the Notifications badge API. */
export async function setAppBadgeCount(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch {
    /* badge updates are best-effort */
  }
}

/** Clears the app badge. */
export async function clearAppBadge(): Promise<void> {
  await setAppBadgeCount(0);
}

export type NotificationReceivedListener = (
  notification: Notifications.Notification,
) => void;

export type NotificationResponseListener = (
  response: Notifications.NotificationResponse,
) => void;

/** Subscribe to notifications received while the app is foregrounded. */
export function addForegroundNotificationListener(
  handler: NotificationReceivedListener,
): Notifications.EventSubscription {
  return Notifications.addNotificationReceivedListener(handler);
}

/** Subscribe to user interactions with notifications (tap, action button). */
export function addNotificationResponseListener(
  handler: NotificationResponseListener,
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(handler);
}

/** Read the notification that launched the app from a killed/suspended state. */
export async function getLastNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  return Notifications.getLastNotificationResponseAsync();
}
