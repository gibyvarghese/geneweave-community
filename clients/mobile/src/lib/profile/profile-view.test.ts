/**
 * profile-view.test.ts — unit tests for the pure Profile presentation logic.
 */
import { describe, expect, it } from 'vitest';
import {
  avatarInitials,
  buildManageUrl,
  canManageOnWeb,
  displayName,
  personaLabel,
} from './profile-view.js';

describe('canManageOnWeb', () => {
  it('lights up for known admin personas', () => {
    for (const p of ['tenant_admin', 'platform_admin', 'owner', 'admin', 'TENANT_ADMIN']) {
      expect(canManageOnWeb(p)).toBe(true);
    }
  });

  it('lights up for forward-compatible *_admin / *_owner personas', () => {
    expect(canManageOnWeb('billing_admin')).toBe(true);
    expect(canManageOnWeb('workspace_owner')).toBe(true);
  });

  it('fails closed for regular users and missing personas', () => {
    expect(canManageOnWeb('tenant_user')).toBe(false);
    expect(canManageOnWeb('')).toBe(false);
    expect(canManageOnWeb(null)).toBe(false);
    expect(canManageOnWeb(undefined)).toBe(false);
  });
});

describe('buildManageUrl', () => {
  it('appends /admin and strips trailing slashes', () => {
    expect(buildManageUrl('https://app.example.com')).toBe('https://app.example.com/admin');
    expect(buildManageUrl('https://app.example.com///')).toBe('https://app.example.com/admin');
  });

  it('returns null for missing host', () => {
    expect(buildManageUrl(null)).toBe(null);
    expect(buildManageUrl('   ')).toBe(null);
  });
});

describe('displayName', () => {
  it('prefers name, falls back to email local-part', () => {
    expect(displayName({ name: 'Ada Lovelace', email: 'ada@x.io' })).toBe('Ada Lovelace');
    expect(displayName({ name: null, email: 'ada@x.io' })).toBe('ada');
    expect(displayName({ name: '   ', email: 'bob@x.io' })).toBe('bob');
  });
});

describe('avatarInitials', () => {
  it('uses first letters of two words', () => {
    expect(avatarInitials({ name: 'Ada Lovelace', email: 'a@x.io' })).toBe('AL');
  });

  it('uses first two letters of a single word', () => {
    expect(avatarInitials({ name: 'Ada', email: 'a@x.io' })).toBe('AD');
  });

  it('falls back to the email local-part', () => {
    expect(avatarInitials({ name: null, email: 'zoe@x.io' })).toBe('ZO');
  });
});

describe('personaLabel', () => {
  it('title-cases the persona', () => {
    expect(personaLabel('tenant_admin')).toBe('Tenant Admin');
    expect(personaLabel('tenant_user')).toBe('Tenant User');
  });

  it('defaults to Member when absent', () => {
    expect(personaLabel(null)).toBe('Member');
    expect(personaLabel('')).toBe('Member');
  });
});
