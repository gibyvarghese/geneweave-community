/**
 * tenant-theme-gate.tsx — sources the per-tenant brand override at runtime.
 *
 * Device-gated (part of the native view layer). This thin wrapper sits between
 * Auth/Query and the pure {@link ThemeProvider}: it fetches the caller's tenant
 * design tokens from `GET /api/me/theme` (only once authenticated) and feeds
 * them in as the `tenantTheme` prop. Keeping the fetch here means ThemeProvider
 * stays pure + prop-driven (and unit-tested via `resolveAppTheme`), while the
 * data source lives in one place.
 *
 * Graceful by construction: before sign-in, or on any fetch error, no override
 * is applied and the base brand theme renders. WCAG-AA enforcement on the
 * resolved override happens inside ThemeProvider/`@weaveintel/tokens`.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TenantThemeOverride } from '@weaveintel/tokens';
import { ThemeProvider } from './theme-provider';
import { useAuth } from './auth-provider';
import type { ThemePreference } from '../../lib';

export interface TenantThemeGateProps {
  children: ReactNode;
  preference?: ThemePreference;
  /**
   * Static override (tests / storybook). When provided it wins over the fetched
   * tenant theme so the gate can be driven deterministically.
   */
  tenantTheme?: TenantThemeOverride;
}

export function TenantThemeGate({ children, preference, tenantTheme }: TenantThemeGateProps) {
  const { state, client } = useAuth();
  const authed = state.status === 'authenticated' && client !== null;

  const { data } = useQuery({
    queryKey: ['tenant-theme'],
    enabled: authed,
    queryFn: async () => {
      if (!client) return null;
      // The api-client token shape is structurally the brand override.
      return (await client.getTenantTheme()) as TenantThemeOverride | null;
    },
  });

  const override = tenantTheme ?? data ?? undefined;

  return (
    <ThemeProvider
      preference={preference}
      {...(override !== undefined ? { tenantTheme: override } : {})}
    >
      {children}
    </ThemeProvider>
  );
}
