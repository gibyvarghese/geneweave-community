/**
 * notification-prefs.test.ts — unit tests for the pure notification-prefs logic.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CATEGORIES,
  decodeQuietHours,
  defaultNotificationPreferences,
  encodeQuietHours,
  isCategoryEnabled,
  isWithinQuietHours,
  normalizeNotificationPreferences,
  quietHoursLabel,
  shouldSuppressPush,
  toggleCategory,
} from './notification-prefs.js';

describe('defaults + normalization', () => {
  it('defaults to enabled with all categories and no quiet hours', () => {
    const d = defaultNotificationPreferences();
    expect(d.enabled).toBe(true);
    expect(d.categories).toEqual(NOTIFICATION_CATEGORIES.map((c) => c.id));
    expect(d.quietHours).toBe(null);
  });

  it('filters unknown categories and dedupes, preserving display order', () => {
    const n = normalizeNotificationPreferences({ enabled: true, categories: ['digests', 'bogus', 'mentions', 'mentions'], quietHours: '' });
    expect(n.categories).toEqual(['mentions', 'digests']);
    expect(n.quietHours).toBe(null);
  });

  it('treats missing record as defaults', () => {
    expect(normalizeNotificationPreferences(null).enabled).toBe(true);
  });
});

describe('category toggling', () => {
  it('toggles a category off then on', () => {
    const base = defaultNotificationPreferences();
    const off = toggleCategory(base, 'tasks');
    expect(isCategoryEnabled(off, 'tasks')).toBe(false);
    const on = toggleCategory(off, 'tasks');
    expect(isCategoryEnabled(on, 'tasks')).toBe(true);
    // order preserved
    expect(on.categories).toEqual(NOTIFICATION_CATEGORIES.map((c) => c.id));
  });

  it('ignores unknown categories', () => {
    const base = defaultNotificationPreferences();
    expect(toggleCategory(base, 'nope')).toBe(base);
  });
});

describe('quiet-hours encode/decode (timezone embedded)', () => {
  it('round-trips a window', () => {
    const q = { start: '22:00', end: '07:00', timezone: 'America/New_York' };
    const s = encodeQuietHours(q);
    expect(s).toBe('22:00-07:00 America/New_York');
    expect(decodeQuietHours(s)).toEqual(q);
  });

  it('returns null for malformed / absent strings', () => {
    expect(decodeQuietHours(null)).toBe(null);
    expect(decodeQuietHours('garbage')).toBe(null);
    expect(decodeQuietHours('25:00-07:00 UTC')).toBe(null);
    expect(decodeQuietHours('22:00-07:00')).toBe(null);
  });

  it('labels a window and Off', () => {
    expect(quietHoursLabel('22:00-07:00 UTC')).toBe('22:00–07:00 (UTC)');
    expect(quietHoursLabel(null)).toBe('Off');
  });
});

describe('isWithinQuietHours', () => {
  it('handles a same-day window in UTC', () => {
    const s = '09:00-17:00 UTC';
    expect(isWithinQuietHours(s, new Date('2026-01-01T12:00:00Z'))).toBe(true);
    expect(isWithinQuietHours(s, new Date('2026-01-01T08:59:00Z'))).toBe(false);
    expect(isWithinQuietHours(s, new Date('2026-01-01T17:00:00Z'))).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    const s = '22:00-07:00 UTC';
    expect(isWithinQuietHours(s, new Date('2026-01-01T23:30:00Z'))).toBe(true);
    expect(isWithinQuietHours(s, new Date('2026-01-01T03:00:00Z'))).toBe(true);
    expect(isWithinQuietHours(s, new Date('2026-01-01T12:00:00Z'))).toBe(false);
  });

  it('respects the encoded timezone', () => {
    // 02:00 UTC is 21:00 in America/New_York (UTC-5 in January) → inside 20:00-23:00 ET.
    const s = '20:00-23:00 America/New_York';
    expect(isWithinQuietHours(s, new Date('2026-01-01T02:00:00Z'))).toBe(true);
    // 12:00 UTC is 07:00 ET → outside.
    expect(isWithinQuietHours(s, new Date('2026-01-01T12:00:00Z'))).toBe(false);
  });

  it('fails open on an invalid timezone', () => {
    expect(isWithinQuietHours('22:00-07:00 Not/AZone', new Date())).toBe(false);
  });
});

describe('shouldSuppressPush', () => {
  it('suppresses when globally disabled', () => {
    const prefs = { enabled: false, categories: ['tasks'], quietHours: null };
    expect(shouldSuppressPush(prefs, 'tasks')).toBe(true);
  });

  it('suppresses when the category is off', () => {
    const prefs = { enabled: true, categories: ['mentions'], quietHours: null };
    expect(shouldSuppressPush(prefs, 'tasks')).toBe(true);
  });

  it('suppresses inside quiet hours and delivers outside', () => {
    const prefs = { enabled: true, categories: ['tasks'], quietHours: '22:00-07:00 UTC' };
    expect(shouldSuppressPush(prefs, 'tasks', new Date('2026-01-01T23:00:00Z'))).toBe(true);
    expect(shouldSuppressPush(prefs, 'tasks', new Date('2026-01-01T12:00:00Z'))).toBe(false);
  });
});
