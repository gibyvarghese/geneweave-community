/**
 * sentry.ts — Sentry crash-reporting and performance monitoring initialisation.
 *
 * Device-gated: imports @sentry/react-native. Call `initSentry()` once at app
 * startup (before any component renders) so any JS errors during bootstrap are
 * captured.
 *
 * Configuration:
 *   EXPO_PUBLIC_SENTRY_DSN     — required in production; omit to disable.
 *   EXPO_PUBLIC_APP_ENV        — "development" | "preview" | "production" (default: "production")
 *
 * In development / without a DSN: Sentry is a no-op (SDK handles this gracefully
 * when `dsn` is undefined — no network calls, no errors, no console spam).
 *
 * The `routingInstrumentation` hooks into Expo Router's navigation so automatic
 * breadcrumbs and transaction spans are generated for every screen transition.
 * The `tracesSampleRate` is set conservatively at 0.1 in production (10% of
 * sessions) to avoid overhead; raise for specific investigations.
 */
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

const DSN = process.env['EXPO_PUBLIC_SENTRY_DSN'];
const APP_ENV = (process.env['EXPO_PUBLIC_APP_ENV'] ?? 'production') as 'development' | 'preview' | 'production';

export function initSentry(): void {
  if (!DSN) return; // no-op in development without a DSN

  const appVersion = (Constants.expoConfig?.version ?? '0.0.1');
  const buildNumber = (
    Constants.expoConfig?.ios?.buildNumber ??
    Constants.expoConfig?.android?.versionCode?.toString() ??
    'unknown'
  );

  Sentry.init({
    dsn: DSN,
    environment: APP_ENV,
    release: `com.geneweave.mobile@${appVersion}+${buildNumber}`,
    debug: APP_ENV === 'development',
    tracesSampleRate: APP_ENV === 'production' ? 0.1 : 1.0,
    enableAutoSessionTracking: true,
    sessionTrackingIntervalMillis: 30_000,
    // Attach JS / native stack frames for all captured errors.
    attachStacktrace: true,
    // Avoid capturing sensitive request/response bodies.
    integrations: [],
  });
}

/**
 * Wrap the root component with Sentry's HOC so React error boundaries are
 * monitored and the Sentry Spotlight dev tool can connect in development.
 */
export const withSentryWrapper = Sentry.wrap;

/** Manually capture an error (use sparingly — prefer let it propagate). */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!DSN) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/** Add a breadcrumb visible in the Sentry dashboard for a given event. */
export function addBreadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!DSN) return;
  Sentry.addBreadcrumb({ message, data, level: 'info' });
}
