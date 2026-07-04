/**
 * push-provider.tsx — orchestrates the entire push notification lifecycle.
 *
 * Device-gated. Responsibilities:
 *   1. Configure foreground notification handler (suppress OS alerts → in-app banners).
 *   2. Register interactive notification categories (Approve/Deny).
 *   3. Auto-register the device token when the user signs in (once per session).
 *   4. Handle foreground notifications → render {@link ForegroundBanner}.
 *   5. Handle notification responses (taps / action buttons):
 *        - If the app is foregrounded: navigate immediately.
 *        - If the app was backgrounded / killed: handled by background-action-handler
 *          at module level (before React renders). On next foreground, read the last
 *          response via getLastNotificationResponse and navigate to the target.
 *   6. Register the background fetch task for 15-min badge refresh.
 *
 * The context exposes `requestPushPermission()` so the Settings screen can prompt
 * the user at an appropriate moment (not on cold start).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'expo-router';
import type { GeneweaveClient } from '@weaveintel/api-client';
import { useAuth } from './auth-provider';
import {
  configureForegroundNotificationHandler,
  addForegroundNotificationListener,
  addNotificationResponseListener,
  getLastNotificationResponse,
} from '../adapters/expo-notifications-adapter';
import { registerNotificationCategories } from '../push/notification-categories';
import { usePushRegistration } from '../push/use-push-registration';
import { useBackgroundFetch } from '../push/use-background-fetch';
import { ForegroundBanner, type ForegroundBannerPayload } from '../ui/push/foreground-banner';
import { parseDeepLink, intentToRoute } from '../../lib';

interface PushContextValue {
  /** Trigger permission request + device registration. Call from settings / first action. */
  requestPushPermission: () => Promise<void>;
  permissionStatus: 'granted' | 'denied' | 'undetermined';
  isRegistering: boolean;
}

const PushContext = createContext<PushContextValue | null>(null);

export function usePush(): PushContextValue {
  const ctx = useContext(PushContext);
  if (!ctx) throw new Error('usePush must be used within <PushProvider>');
  return ctx;
}

/** One-time setup: runs foreground handler + category registration. */
function usePushSetup() {
  const didSetup = useRef(false);
  useEffect(() => {
    if (didSetup.current) return;
    didSetup.current = true;
    configureForegroundNotificationHandler();
    void registerNotificationCategories().catch((err: unknown) => {
      console.warn('[push] category registration failed:', String(err));
    });
  }, []);
}

/** Handles cold-start tap-through: reads the last notification response and navigates. */
function useColdStartNavigation(isAuthenticated: boolean) {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || handled.current) return;
    handled.current = true;

    void getLastNotificationResponse().then((response) => {
      if (!response) return;
      const deepLink = response.notification.request.content.data?.['deepLink'] as string | undefined;
      if (!deepLink) return;
      const intent = parseDeepLink(deepLink);
      if (intent.kind === 'unknown') return;
      const target = intentToRoute(intent);
      router.navigate({ pathname: target.pathname as never, params: target.params });
    }).catch(() => {});
  }, [isAuthenticated, router]);
}

export function PushProvider({ children }: { children: ReactNode }) {
  const { state, client } = useAuth();
  const router = useRouter();
  const isAuthenticated = state.status === 'authenticated';

  const { permissionStatus, isRegistering, requestAndRegister } = usePushRegistration();
  const [bannerPayload, setBannerPayload] = useState<ForegroundBannerPayload | null>(null);

  // Setup
  usePushSetup();
  useBackgroundFetch();
  useColdStartNavigation(isAuthenticated);

  // Auto-register when the user signs in (idempotent — skipped if token unchanged).
  useEffect(() => {
    if (isAuthenticated && client) {
      void requestAndRegister(client).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // Foreground notification → show in-app banner.
  useEffect(() => {
    const sub = addForegroundNotificationListener((notification) => {
      const { title, body, data } = notification.request.content;
      setBannerPayload({
        title: title ?? undefined,
        body: body ?? undefined,
        deepLink: data?.['deepLink'] as string | undefined,
      });
    });
    return () => sub.remove();
  }, []);

  // Notification response (tap or action button while foregrounded / from background).
  useEffect(() => {
    const sub = addNotificationResponseListener((response) => {
      const deepLink = response.notification.request.content.data?.['deepLink'] as string | undefined;
      if (!deepLink) return;
      const intent = parseDeepLink(deepLink);
      if (intent.kind === 'unknown') return;
      const target = intentToRoute(intent);
      router.navigate({ pathname: target.pathname as never, params: target.params });
    });
    return () => sub.remove();
  }, [router]);

  const requestPushPermission = useCallback(async () => {
    if (!client) return;
    await requestAndRegister(client);
  }, [client, requestAndRegister]);

  return (
    <PushContext.Provider value={{ requestPushPermission, permissionStatus, isRegistering }}>
      {children}
      <ForegroundBanner
        payload={bannerPayload}
        onDismiss={() => setBannerPayload(null)}
      />
    </PushContext.Provider>
  );
}
