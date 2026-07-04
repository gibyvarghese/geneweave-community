/**
 * providers/index.tsx — the composed provider tree for the app root.
 *
 * Order matters: SafeArea (insets) → Query (server state) → Auth (session +
 * controller) → TenantThemeGate (fetches the per-tenant brand override) →
 * Push (notification lifecycle — runs after auth so it has a client) →
 * Offline (network state + outbox flush coordination).
 * The root layout wraps the navigator in `<AppProviders>` once.
 */
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { TenantThemeOverride } from '@weaveintel/tokens';
import { QueryProvider } from './query-provider';
import { AuthProvider } from './auth-provider';
import { TenantThemeGate } from './tenant-theme-gate';
import { PushProvider } from './push-provider';
import { OfflineProvider } from './offline-provider';
import type { ThemePreference } from '../../lib';

export interface AppProvidersProps {
  children: ReactNode;
  themePreference?: ThemePreference;
  tenantTheme?: TenantThemeOverride;
}

export function AppProviders({ children, themePreference, tenantTheme }: AppProvidersProps) {
  return (
    <SafeAreaProvider>
      <QueryProvider>
        <AuthProvider>
          <TenantThemeGate
            preference={themePreference}
            {...(tenantTheme !== undefined ? { tenantTheme } : {})}
          >
            <PushProvider>
              <OfflineProvider>
                {children}
              </OfflineProvider>
            </PushProvider>
          </TenantThemeGate>
        </AuthProvider>
      </QueryProvider>
    </SafeAreaProvider>
  );
}

export { useTheme } from './theme-provider';
export { useAuth, useClient } from './auth-provider';
export { AppearanceProvider, useAppearance } from './appearance-provider';
export { usePush } from './push-provider';
export { useOffline } from './offline-provider';
