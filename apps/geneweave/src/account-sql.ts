/**
 * account-sql.ts — the Account settings service (per-USER profile, preferences & notifications).
 *
 * Backs the Account screen (design: "GeneWeave Account.dc.html") and the update_account_profile tool.
 * Everything here is scoped to a single signed-in user — a caller can only ever read or change their own
 * account. Validation + sanitisation lives here (not in the route or the tool) so both entry points share
 * one safe path: text fields are length-capped and stripped of control characters; enum fields
 * (language / date format / week start / editor variant) are checked against an allow-list and silently
 * fall back to the default if invalid; the notification matrix only accepts the five known events.
 */
import type { DatabaseAdapter } from './db.js';
import type { UserRow, UserPreferencesRow } from './db-types/core.js';
import { NOTIFICATION_EVENTS } from './migrations/m136-account-profile.js';

/** Allow-lists for the enum-style preference fields. First entry is the default. */
export const LANGUAGES = ['en-US', 'en-GB', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'hi', 'ja', 'zh', 'ko', 'ar'];
export const DATE_FORMATS = ['D MMM YYYY', 'MMM D, YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];
export const WEEK_STARTS = ['monday', 'sunday', 'saturday'];
export const UI_VARIANTS = ['pro', 'creative'];
export const NOTIFICATION_EVENT_KEYS = NOTIFICATION_EVENTS.map((e) => e.key);

/** Human labels for the notification events, used by the read model + the UI. */
export const NOTIFICATION_EVENT_META: Record<string, { label: string; desc: string }> = {
  mentions: { label: 'Mentions', desc: 'When someone @mentions you' },
  shares: { label: 'Shares', desc: 'A note is shared with you' },
  comments: { label: 'Comments', desc: 'Replies on your notes' },
  assistant_finished: { label: 'Assistant finished', desc: 'When the AI completes a task' },
  weekly_digest: { label: 'Weekly digest', desc: 'A summary every Monday' },
};

/** Per-field maximum lengths (characters) for the free-text profile fields. */
const TEXT_LIMITS: Record<string, number> = {
  display_name: 80, pronouns: 40, role_title: 120, working_hours: 120,
  about: 600, status_text: 120, status_emoji: 8, timezone: 64,
};

/** Strip control chars, collapse whitespace, and cap length. Returns null for an emptied string. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
function cleanText(v: unknown, max: number): string | null {
  if (v == null) return null;
  let s = String(v).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function pickEnum(v: unknown, allow: string[]): string | undefined {
  const s = typeof v === 'string' ? v : '';
  return allow.includes(s) ? s : undefined;
}

export interface AccountView {
  profile: {
    display_name: string; email: string; pronouns: string; role_title: string;
    working_hours: string; about: string; status_text: string; status_emoji: string;
    persona: string; email_verified: boolean; mfa_enabled: boolean;
  };
  preferences: { language: string; timezone: string; date_format: string; week_start: string; ui_variant: string; theme: string };
  notifications: Array<{ event_key: string; label: string; desc: string; in_app: boolean; email: boolean; push: boolean }>;
}

export function createAccountService(db: DatabaseAdapter) {
  /** The effective account view for a user, merging the users row + preferences + notification matrix. */
  async function getAccount(userId: string): Promise<AccountView | null> {
    const user = (await db.getUserById(userId)) as UserRow | null;
    if (!user) return null;
    const prefs = (await db.getUserPreferences(userId)) as UserPreferencesRow | null;
    const rows = await db.getUserNotificationPrefs(userId);
    const byEvent = new Map(rows.map((r) => [r.event_key, r]));

    const notifications = NOTIFICATION_EVENTS.map((e) => {
      const r = byEvent.get(e.key);
      const meta = NOTIFICATION_EVENT_META[e.key] ?? { label: e.key, desc: '' };
      return {
        event_key: e.key, label: meta.label, desc: meta.desc,
        in_app: r ? r.in_app === 1 : e.in_app === 1,
        email: r ? r.email === 1 : e.email === 1,
        push: r ? r.push === 1 : e.push === 1,
      };
    });

    return {
      profile: {
        display_name: prefs?.display_name || user.name || '',
        email: user.email,
        pronouns: prefs?.pronouns || '',
        role_title: prefs?.role_title || '',
        working_hours: prefs?.working_hours || '',
        about: prefs?.about || '',
        status_text: prefs?.status_text || '',
        status_emoji: prefs?.status_emoji || '',
        persona: user.persona,
        email_verified: (user.email_verified ?? 1) === 1,
        mfa_enabled: (user.mfa_enabled ?? 0) === 1,
      },
      preferences: {
        language: prefs?.language || 'en-US',
        timezone: prefs?.timezone || '',
        date_format: prefs?.date_format || 'D MMM YYYY',
        week_start: prefs?.week_start || 'monday',
        ui_variant: prefs?.ui_variant || 'pro',
        theme: prefs?.theme || 'light',
      },
      notifications,
    };
  }

  /**
   * Validate + persist a partial profile/preferences patch. Unknown keys are ignored; text is cleaned;
   * enum fields fall back to the current/default if invalid. Returns the fields actually applied.
   */
  async function updateProfile(userId: string, patch: Record<string, unknown>): Promise<{ ok: boolean; applied: Record<string, string | null> }> {
    const out: Record<string, string | null> = {};
    for (const key of Object.keys(TEXT_LIMITS)) {
      if (key in patch) out[key] = cleanText(patch[key], TEXT_LIMITS[key]!);
    }
    if ('display_name' in patch && (out['display_name'] == null || out['display_name'] === '')) {
      // Never blank the display name entirely — drop the change instead.
      delete out['display_name'];
    }
    const lang = pickEnum(patch['language'], LANGUAGES); if (lang) out['language'] = lang;
    const df = pickEnum(patch['date_format'], DATE_FORMATS); if (df) out['date_format'] = df;
    const ws = pickEnum(patch['week_start'], WEEK_STARTS); if (ws) out['week_start'] = ws;
    const uv = pickEnum(patch['ui_variant'], UI_VARIANTS); if (uv) out['ui_variant'] = uv;

    if (Object.keys(out).length === 0) return { ok: true, applied: {} };
    await db.updateUserAccountPrefs(userId, out);
    return { ok: true, applied: out };
  }

  /** Set one notification event's channels. Ignores unknown events. */
  async function setNotification(userId: string, eventKey: string, channels: { in_app?: boolean; email?: boolean; push?: boolean }): Promise<{ ok: boolean; error?: string }> {
    if (!NOTIFICATION_EVENT_KEYS.includes(eventKey)) return { ok: false, error: `Unknown notification event: ${eventKey}` };
    await db.setUserNotificationPref(userId, eventKey, channels);
    return { ok: true };
  }

  /**
   * Tool entry point. Applies a profile/preferences patch and/or a single notification change for the
   * SIGNED-IN user (userId is bound from the session, never from the model), returning a plain summary.
   */
  async function agentUpdateAccount(args: {
    userId: string;
    profile?: Record<string, unknown>;
    notification?: { event: string; in_app?: boolean; email?: boolean; push?: boolean };
  }): Promise<{ ok: boolean; error?: string; applied?: Record<string, string | null>; notification?: string }> {
    let applied: Record<string, string | null> | undefined;
    if (args.profile && typeof args.profile === 'object') {
      const r = await updateProfile(args.userId, args.profile);
      applied = r.applied;
    }
    let notification: string | undefined;
    if (args.notification && typeof args.notification.event === 'string') {
      const r = await setNotification(args.userId, args.notification.event, args.notification);
      if (!r.ok) return { ok: false, error: r.error };
      notification = args.notification.event;
    }
    return { ok: true, applied, notification };
  }

  return { getAccount, updateProfile, setNotification, agentUpdateAccount };
}

export type AccountService = ReturnType<typeof createAccountService>;
