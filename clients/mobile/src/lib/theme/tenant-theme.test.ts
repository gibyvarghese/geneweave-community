import { describe, it, expect } from 'vitest';
import { geneweaveThemes as themes } from '@weaveintel/geneweave-ui/brand';
import { resolveThemeName, resolveAppTheme } from './tenant-theme.js';

describe('resolveThemeName', () => {
  it('honors an explicit preference', () => {
    expect(resolveThemeName('dark', 'light')).toBe('dark');
    expect(resolveThemeName('light', 'dark')).toBe('light');
  });
  it('follows the OS scheme when preference is system', () => {
    expect(resolveThemeName('system', 'light')).toBe('light');
    expect(resolveThemeName('system', 'dark')).toBe('dark');
  });
  it('defaults to dark when system scheme is unknown', () => {
    expect(resolveThemeName('system', null)).toBe('dark');
  });
});

describe('resolveAppTheme', () => {
  it('returns the base theme unchanged with no override', () => {
    const { theme, name, degraded } = resolveAppTheme('dark', null);
    expect(name).toBe('dark');
    expect(degraded).toBe(false);
    expect(theme.colors.text).toBe(themes.dark.colors.text);
  });

  it('applies a non-color tenant brand override without degrading', () => {
    const { theme, degraded } = resolveAppTheme('dark', null, {
      typography: { families: { display: 'Tenant Display' } },
    });
    expect(degraded).toBe(false);
    expect(theme.typography.families.display).toBe('Tenant Display');
  });

  it('degrades to the base theme when an override breaks AA contrast', () => {
    // text == background → contrast ~1:1, fails AA → must fall back.
    const { theme, degraded } = resolveAppTheme('dark', null, {
      colors: { text: themes.dark.colors.background },
    });
    expect(degraded).toBe(true);
    expect(theme.colors.text).toBe(themes.dark.colors.text);
  });
});
