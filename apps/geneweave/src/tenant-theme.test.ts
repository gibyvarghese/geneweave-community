/**
 * tenant-theme.test.ts — pure unit tests for per-tenant token resolution.
 *
 * No DB: `resolveTenantThemeTokens` is exercised against a structural stub of
 * the two `tenant_configs` adapter reads. Covers sanitization (drop garbage),
 * platform→tenant merge precedence, override write/clear semantics, and the
 * fail-soft degrade-to-null path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeTheme,
  parseThemeFromOverrides,
  mergeThemeTokens,
  setThemeInOverrides,
  resolveTenantThemeTokens,
  invalidateThemeCache,
  type TenantThemeTokens,
} from './tenant-theme.js';

beforeEach(() => invalidateThemeCache());

describe('sanitizeTheme', () => {
  it('keeps valid colors / families / radii and drops the rest', () => {
    const out = sanitizeTheme({
      colors: { accent: '#1FB6A5', text: '#fff', bad: 42, '': 'x' },
      typography: { families: { display: 'Fraunces', bad: 9 } },
      radii: { md: 12, neg: -1, str: 'no' },
      junk: 'ignored',
    });
    expect(out).toEqual({
      colors: { accent: '#1FB6A5', text: '#fff' },
      typography: { families: { display: 'Fraunces' } },
      radii: { md: 12 },
    });
  });

  it('returns null for empty / non-object / array input', () => {
    expect(sanitizeTheme(null)).toBeNull();
    expect(sanitizeTheme('x')).toBeNull();
    expect(sanitizeTheme([])).toBeNull();
    expect(sanitizeTheme({})).toBeNull();
    expect(sanitizeTheme({ colors: {} })).toBeNull();
  });

  it('rejects over-long values and caps key count', () => {
    const big = 'x'.repeat(100);
    expect(sanitizeTheme({ colors: { accent: big } })).toBeNull();
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i++) many[`c${i}`] = '#000';
    const out = sanitizeTheme({ colors: many });
    expect(Object.keys(out?.colors ?? {}).length).toBeLessThanOrEqual(48);
  });
});

describe('parseThemeFromOverrides', () => {
  it('extracts the theme key and sanitizes it', () => {
    const json = JSON.stringify({ limits: { chat_max_steps: 30 }, theme: { colors: { accent: '#abc' } } });
    expect(parseThemeFromOverrides(json)).toEqual({ colors: { accent: '#abc' } });
  });
  it('returns null for missing / malformed JSON', () => {
    expect(parseThemeFromOverrides(null)).toBeNull();
    expect(parseThemeFromOverrides('{not json')).toBeNull();
    expect(parseThemeFromOverrides(JSON.stringify({ limits: {} }))).toBeNull();
  });
});

describe('mergeThemeTokens', () => {
  it('tenant keys win over platform keys', () => {
    const platform: TenantThemeTokens = { colors: { accent: '#000', text: '#111' } };
    const tenant: TenantThemeTokens = { colors: { accent: '#1FB6A5' }, radii: { md: 16 } };
    expect(mergeThemeTokens(platform, tenant)).toEqual({
      colors: { accent: '#1FB6A5', text: '#111' },
      radii: { md: 16 },
    });
  });
  it('passes a single side through when the other is null', () => {
    const t: TenantThemeTokens = { colors: { accent: '#abc' } };
    expect(mergeThemeTokens(null, t)).toEqual(t);
    expect(mergeThemeTokens(t, null)).toEqual(t);
    expect(mergeThemeTokens(null, null)).toBeNull();
  });
});

describe('setThemeInOverrides', () => {
  it('writes the theme while preserving other keys', () => {
    const existing = JSON.stringify({ limits: { chat_max_steps: 30 } });
    const next = setThemeInOverrides(existing, { colors: { accent: '#abc' } });
    expect(JSON.parse(next)).toEqual({ limits: { chat_max_steps: 30 }, theme: { colors: { accent: '#abc' } } });
  });
  it('clears the theme key when passed null, keeping siblings', () => {
    const existing = JSON.stringify({ limits: { x: 1 }, theme: { colors: { accent: '#abc' } } });
    expect(JSON.parse(setThemeInOverrides(existing, null))).toEqual({ limits: { x: 1 } });
  });
  it('starts from empty when existing is unparseable', () => {
    expect(JSON.parse(setThemeInOverrides('garbage', { radii: { md: 8 } }))).toEqual({ theme: { radii: { md: 8 } } });
  });
});

describe('resolveTenantThemeTokens', () => {
  const stub = (global?: unknown, tenant?: unknown) => ({
    async getGlobalTenantConfig() {
      return global !== undefined ? { config_overrides: JSON.stringify({ theme: global }) } : null;
    },
    async getTenantConfigForTenant() {
      return tenant !== undefined ? { config_overrides: JSON.stringify({ theme: tenant }) } : null;
    },
  });

  it('merges platform base with tenant override', async () => {
    const db = stub({ colors: { accent: '#000', text: '#111' } }, { colors: { accent: '#1FB6A5' } });
    const out = await resolveTenantThemeTokens(db as never, 't1');
    expect(out).toEqual({ colors: { accent: '#1FB6A5', text: '#111' } });
  });

  it('returns the platform theme when no tenant override exists', async () => {
    const db = stub({ colors: { accent: '#000' } }, undefined);
    expect(await resolveTenantThemeTokens(db as never, 't2')).toEqual({ colors: { accent: '#000' } });
  });

  it('returns null when neither scope defines a theme', async () => {
    const db = stub(undefined, undefined);
    expect(await resolveTenantThemeTokens(db as never, 't3')).toBeNull();
  });

  it('degrades to null when the DB read throws', async () => {
    const db = {
      async getGlobalTenantConfig() { throw new Error('db down'); },
      async getTenantConfigForTenant() { return null; },
    };
    expect(await resolveTenantThemeTokens(db as never, 't4')).toBeNull();
  });

  it('caches by tenant until invalidated', async () => {
    let calls = 0;
    const db = {
      async getGlobalTenantConfig() { calls++; return { config_overrides: JSON.stringify({ theme: { colors: { accent: '#000' } } }) }; },
      async getTenantConfigForTenant() { return null; },
    };
    await resolveTenantThemeTokens(db as never, 't5');
    await resolveTenantThemeTokens(db as never, 't5');
    expect(calls).toBe(1);
    invalidateThemeCache('t5');
    await resolveTenantThemeTokens(db as never, 't5');
    expect(calls).toBe(2);
  });
});
