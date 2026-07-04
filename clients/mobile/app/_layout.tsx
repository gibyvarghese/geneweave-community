/**
 * Root layout for the geneWeave mobile app (Expo Router) — M10.
 *
 * Responsibilities:
 *  - Import background task definitions (module-level side effect — must be
 *    the first import so TaskManager.defineTask() is called before any OS
 *    background wake-up can fire).
 *  - Initialise Sentry crash-reporting before any component renders.
 *  - Load the brand fonts (Fraunces / Plus Jakarta Sans / DM Mono) and hold the
 *    splash screen until they are ready.
 *  - Wrap the whole app in the composed provider tree
 *    (Query → Auth → Theme → Push → Offline).
 *  - Render the two route groups — `(auth)` and `(tabs)` — and let
 *    `useProtectedRoute` switch between them based on the observable auth state.
 *  - Handle deep-link URL from cold start via expo-linking.
 *
 * Device-gated: imports `expo-router` / `react-native` / `expo-font`.
 */

// !! MUST be the first imports — registers background task definitions and
// initialises Sentry before the OS can fire a background wake-up or any
// component renders.
import '../src/native/push/background-action-handler';
import { initSentry, withSentryWrapper } from '../src/sentry';

initSentry();

import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import { useFonts } from 'expo-font';
import { Fraunces_400Regular } from '@expo-google-fonts/fraunces';
import { PlusJakartaSans_400Regular } from '@expo-google-fonts/plus-jakarta-sans';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono';
import { ActivityIndicator, View } from 'react-native';
import { AppProviders, AppearanceProvider, useAppearance, useAuth, useTheme } from '../src/native/providers';
import { useProtectedRoute } from '../src/native/navigation/use-protected-route';
import { parseDeepLink, intentToRoute } from '../src/lib';
import { OfflineBanner } from '../src/native/ui/offline-banner';

void SplashScreen.preventAutoHideAsync();

function RootLayoutInner() {
  const [fontsLoaded] = useFonts({
    Fraunces: Fraunces_400Regular,
    'Plus Jakarta Sans': PlusJakartaSans_400Regular,
    'DM Mono': DMMono_400Regular,
  });

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <AppearanceProvider>
      <ThemedApp />
    </AppearanceProvider>
  );
}

// Sentry wraps the root component to capture React render errors.
export default withSentryWrapper(RootLayoutInner);

function ThemedApp() {
  const { preference } = useAppearance();
  return (
    <AppProviders themePreference={preference}>
      <RootNavigator />
      <OfflineBanner />
    </AppProviders>
  );
}

function RootNavigator() {
  const { state } = useAuth();
  const { theme } = useTheme();
  const router = useRouter();
  useProtectedRoute(state);

  // Deep-link handler (non-notification path — URL scheme / universal link).
  // Notification tap-through is handled inside PushProvider.
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (!url) return;
      const intent = parseDeepLink(url);
      if (intent.kind === 'unknown') return;
      const target = intentToRoute(intent);
      router.navigate({ pathname: target.pathname as never, params: target.params });
    }).catch(() => {});

    const sub = Linking.addEventListener('url', ({ url }) => {
      const intent = parseDeepLink(url);
      if (intent.kind === 'unknown') return;
      const target = intentToRoute(intent);
      router.navigate({ pathname: target.pathname as never, params: target.params });
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === 'initializing') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="memory" />
      <Stack.Screen name="note/[id]" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="widget-gallery" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
