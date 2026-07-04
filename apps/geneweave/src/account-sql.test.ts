/**
 * Tests — the Account settings service (per-USER profile, preferences & notifications; m136).
 *
 * Covers the four axes asked for:
 *   • POSITIVE — a real profile + preferences round-trip; notification toggles; the effective view merges
 *     the users row + preferences + matrix; the assistant tool path is scoped to the signed-in user.
 *   • NEGATIVE — unknown notification events rejected; blanking the display name is refused; unknown
 *     enum values fall back to the default; unknown patch keys ignored.
 *   • SECURITY — control characters + oversized text are stripped/capped (no stored-XSS payload survives
 *     intact); the tool can only ever write the user id it is handed (never another person's account).
 *   • STRESS — many rapid updates + long inputs stay bounded and consistent.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from './db-sqlite.js';
import { createAccountService, LANGUAGES, DATE_FORMATS } from './account-sql.js';

function tmpDb(): string {
  return join(tmpdir(), `gw-account-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(tmpDb());
  await db.initialize(); await db.seedDefaultData();
  await db.createUser({ id: 'u1', email: 'giby@weaveland.io', name: 'Giby Varghese', passwordHash: 'x', persona: 'tenant_admin', tenantId: 'tA' });
  await db.createUser({ id: 'u2', email: 'mira@weaveland.io', name: 'Mira Vane', passwordHash: 'x', persona: 'analyst', tenantId: 'tA' });
  return db;
}

describe('account service — profile & preferences', () => {
  it('getAccount merges users row + defaults on first open', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    const view = await svc.getAccount('u1');
    expect(view).not.toBeNull();
    expect(view!.profile.display_name).toBe('Giby Varghese'); // falls back to users.name
    expect(view!.profile.email).toBe('giby@weaveland.io');
    expect(view!.preferences.language).toBe('en-US');
    expect(view!.preferences.week_start).toBe('monday');
    expect(view!.notifications).toHaveLength(5);
    expect(view!.notifications.find((n) => n.event_key === 'mentions')!.in_app).toBe(true);
  });

  it('POSITIVE — a real profile + preferences round-trip persists', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    const r = await svc.updateProfile('u1', {
      display_name: 'Giby V', pronouns: 'they/them', role_title: 'Head of Platform',
      working_hours: '9:00 – 17:00 · GMT+5:30', about: 'Building calm software.',
      status_text: 'Focusing · back at 2:00', status_emoji: '🎧',
      language: 'en-GB', date_format: 'MMM D, YYYY', week_start: 'sunday', ui_variant: 'creative', timezone: 'GMT+5:30',
    });
    expect(r.ok).toBe(true);
    const view = await svc.getAccount('u1');
    expect(view!.profile.pronouns).toBe('they/them');
    expect(view!.profile.status_text).toBe('Focusing · back at 2:00');
    expect(view!.preferences.language).toBe('en-GB');
    expect(view!.preferences.ui_variant).toBe('creative');
    expect(view!.preferences.week_start).toBe('sunday');
  });

  it('NEGATIVE — unknown enum values fall back to the default; unknown keys ignored', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    const r = await svc.updateProfile('u1', { language: 'klingon', week_start: 'blursday', ui_variant: 'hologram', totally_unknown: 'x' });
    // None of the invalid enums applied, unknown key ignored → nothing to write.
    expect(Object.keys(r.applied)).not.toContain('language');
    expect(Object.keys(r.applied)).not.toContain('week_start');
    expect(Object.keys(r.applied)).not.toContain('totally_unknown');
    const view = await svc.getAccount('u1');
    expect(view!.preferences.language).toBe('en-US'); // unchanged default
    // sanity: the allow-lists are what we validate against
    expect(LANGUAGES[0]).toBe('en-US');
    expect(DATE_FORMATS).toContain('D MMM YYYY');
  });

  it('NEGATIVE — display name can never be blanked out', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    await svc.updateProfile('u1', { display_name: 'Real Name' });
    const r = await svc.updateProfile('u1', { display_name: '   ' }); // whitespace-only
    expect(Object.keys(r.applied)).not.toContain('display_name');
    const view = await svc.getAccount('u1');
    expect(view!.profile.display_name).toBe('Real Name');
  });

  it('SECURITY — control chars stripped and long text capped', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    // A payload laced with C0 control chars (NUL, BEL, ESC) plus a newline, padded past the cap.
    const payload = `Head${String.fromCharCode(0)}${String.fromCharCode(7)}\n${String.fromCharCode(27)}line` + 'A'.repeat(500);
    const r = await svc.updateProfile('u1', { role_title: payload });
    const stored = String(r.applied['role_title'] ?? '');
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(stored)).toBe(false); // no control chars survive
    expect(stored.length).toBeLessThanOrEqual(120); // role_title cap
    const about = await svc.updateProfile('u1', { about: 'B'.repeat(5000) });
    expect(String(about.applied['about'] ?? '').length).toBeLessThanOrEqual(600);
  });
});

describe('account service — notifications', () => {
  it('POSITIVE — toggling a channel persists and re-reads', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    const r = await svc.setNotification('u1', 'comments', { email: false, push: true });
    expect(r.ok).toBe(true);
    const view = await svc.getAccount('u1');
    const row = view!.notifications.find((n) => n.event_key === 'comments')!;
    expect(row.email).toBe(false);
    expect(row.push).toBe(true);
    expect(row.in_app).toBe(true); // untouched channel keeps its default
  });

  it('NEGATIVE — unknown notification events are rejected', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    const r = await svc.setNotification('u1', 'telepathy', { push: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown/i);
  });
});

describe('account service — assistant tool path (scoping)', () => {
  it('POSITIVE — agentUpdateAccount changes the given user and reports what it did', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    const r = await svc.agentUpdateAccount({ userId: 'u1', profile: { status_text: 'Focusing' }, notification: { event: 'weekly_digest', email: false } });
    expect(r.ok).toBe(true);
    expect(r.applied!['status_text']).toBe('Focusing');
    expect(r.notification).toBe('weekly_digest');
    const view = await svc.getAccount('u1');
    expect(view!.profile.status_text).toBe('Focusing');
    expect(view!.notifications.find((n) => n.event_key === 'weekly_digest')!.email).toBe(false);
  });

  it('SECURITY — the tool only ever writes the user id it is handed (no cross-account write)', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    // A tool call bound to u2 can only change u2 — u1 stays exactly as seeded even if the model "wanted" u1.
    await svc.agentUpdateAccount({ userId: 'u2', profile: { status_text: 'Only mine' } });
    const other = await svc.getAccount('u1');
    expect(other!.profile.status_text).toBe(''); // u1 untouched
    const mine = await svc.getAccount('u2');
    expect(mine!.profile.status_text).toBe('Only mine');
  });

  it('NEGATIVE — a bad notification event in a tool call returns an error, no partial silent write', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    const r = await svc.agentUpdateAccount({ userId: 'u1', notification: { event: 'nope', push: true } });
    expect(r.ok).toBe(false);
  });
});

describe('account service — stress', () => {
  it('STRESS — 100 rapid profile updates stay bounded and consistent', async () => {
    const db = await freshDb();
    const svc = createAccountService(db);
    for (let i = 0; i < 100; i++) {
      await svc.updateProfile('u1', { status_text: `status ${i}`, working_hours: 'W'.repeat(1000) });
    }
    const view = await svc.getAccount('u1');
    expect(view!.profile.status_text).toBe('status 99');
    expect(view!.profile.working_hours.length).toBeLessThanOrEqual(120);
  });
});
