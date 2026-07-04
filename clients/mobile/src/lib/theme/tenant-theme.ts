/**
 * tenant-theme.ts — resolve the active theme from a user preference, the OS
 * color scheme, and an optional per-tenant brand override.
 *
 * Thin, pure composition over `@weaveintel/tokens`: it picks `dark`/`light` from
 * a `'dark' | 'light' | 'system'` preference, then applies a tenant override
 * with WCAG-AA enforcement so a misconfigured brand degrades gracefully to the
 * accessible base theme. No React / RN / expo imports — the provider feeds in
 * the live `useColorScheme()` value.
 */

import {
  applyTenantTheme,
  type Theme,
  type ThemeName,
  type TenantThemeOverride,
} from '@weaveintel/tokens';
// The geneWeave BRAND themes are app-owned now (composed on the neutral engine above). In the private
// commercial repo this is a shared `@geneweave/brand`; here the web app owns the single source of truth.
import { geneweaveThemes as themes } from '@weaveintel/geneweave-ui/brand';

/** The user-facing appearance preference. */
export type ThemePreference = 'dark' | 'light' | 'system';

/** The OS color scheme as reported by RN's `useColorScheme()` (may be null). */
export type SystemColorScheme = 'dark' | 'light' | null;

/** geneWeave defaults to dark when the preference is `system` and the OS is unknown. */
export function resolveThemeName(pref: ThemePreference, system: SystemColorScheme): ThemeName {
  if (pref === 'dark' || pref === 'light') return pref;
  return system === 'light' ? 'light' : 'dark';
}

/** The fully-resolved theme plus whether a tenant override was rejected for AA. */
export interface ResolvedAppTheme {
  theme: Theme;
  name: ThemeName;
  /** True when a tenant override failed AA and the base theme was used instead. */
  degraded: boolean;
}

/**
 * Resolves the active theme. The per-tenant `override` re-brands colors / fonts
 * / corner radii; `applyTenantTheme` enforces contrast and falls back to the
 * base theme when the override would ship an inaccessible UI.
 */
export function resolveAppTheme(
  pref: ThemePreference,
  system: SystemColorScheme,
  override?: TenantThemeOverride,
): ResolvedAppTheme {
  const name = resolveThemeName(pref, system);
  const base = themes[name];
  const { theme, degraded } = applyTenantTheme(base, override);
  return { theme, name, degraded };
}
