/**
 * theme-provider.tsx — resolves the active app theme and exposes it via context.
 *
 * Device-gated (imports `react-native`): part of the native view layer, not the
 * Node logic tests. The actual theme decision (`resolveAppTheme`) and the
 * per-tenant override + WCAG-AA degradation live in `src/lib/theme/
 * tenant-theme.ts` and are unit-tested there. This component only bridges the OS
 * color scheme into that pure function and publishes the result.
 *
 * Per-tenant theming: pass a {@link TenantThemeOverride} (e.g. resolved from the
 * tenant's catalog) and it merges over the base theme; any override that would
 * break AA contrast is dropped and `degraded` is set, never shipped to users.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import type { TenantThemeOverride } from '@weaveintel/tokens';
import { resolveAppTheme, type ResolvedAppTheme, type ThemePreference } from '../../lib';

const ThemeContext = createContext<ResolvedAppTheme | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /** User preference; defaults to following the OS (`system`). */
  preference?: ThemePreference;
  /** Optional per-tenant brand override (colors / fonts / radii). */
  tenantTheme?: TenantThemeOverride;
}

export function ThemeProvider({ children, preference = 'system', tenantTheme }: ThemeProviderProps) {
  const scheme = useColorScheme() ?? null;
  const value = useMemo(
    () => resolveAppTheme(preference, scheme, tenantTheme),
    [preference, scheme, tenantTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the resolved theme. Throws if used outside {@link ThemeProvider}. */
export function useTheme(): ResolvedAppTheme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
