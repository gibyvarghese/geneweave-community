/**
 * notification-prefs.ts — pure logic for notification preferences (M8).
 *
 * Frameworks-free: no React, no react-native, no network. Models the
 * `{ enabled, categories, quietHours }` shape served by
 * `GET/PUT /api/me/notification-preferences`, where `quietHours` is an opaque
 * string the server round-trips verbatim. Per build-plan flag #3 there is no
 * dedicated timezone column, so the IANA timezone is ENCODED INTO the quietHours
 * string here (`"22:00-07:00 America/New_York"`) and decoded back on read. The
 * "suppress a test push during quiet hours" accept criterion is the pure
 * {@link isWithinQuietHours} predicate, which respects the encoded timezone and
 * the across-midnight wrap. The settings screen is a thin view over these
 * helpers.
 */

import type { NotificationPreferences } from '@weaveintel/api-client';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** A notifiable category the user can independently enable. */
export interface NotificationCategory {
  id: string;
  label: string;
  description: string;
}

/** The known notification categories, in display order. */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  { id: 'mentions', label: 'Mentions', description: 'When an agent needs your attention' },
  { id: 'tasks', label: 'Tasks', description: 'Updates on your action items' },
  { id: 'reminders', label: 'Reminders', description: 'Scheduled nudges you set' },
  { id: 'approvals', label: 'Approvals', description: 'Decisions waiting on you' },
  { id: 'digests', label: 'Digests', description: 'Periodic activity summaries' },
] as const;

const KNOWN_CATEGORY_IDS = new Set(NOTIFICATION_CATEGORIES.map((c) => c.id));

/** Default preferences when the server has none stored yet. */
export function defaultNotificationPreferences(): NotificationPreferences {
  return { enabled: true, categories: NOTIFICATION_CATEGORIES.map((c) => c.id), quietHours: null };
}

/**
 * Normalize a (possibly partial / forward-compatible) preferences record into a
 * clean shape: a boolean `enabled`, a deduped category list filtered to known
 * ids (preserving display order), and a `quietHours` string or null.
 */
export function normalizeNotificationPreferences(raw: Partial<NotificationPreferences> | null | undefined): NotificationPreferences {
  if (!raw) return defaultNotificationPreferences();
  const seen = new Set((raw.categories ?? []).filter((c) => KNOWN_CATEGORY_IDS.has(c)));
  return {
    enabled: raw.enabled !== false,
    categories: NOTIFICATION_CATEGORIES.map((c) => c.id).filter((id) => seen.has(id)),
    quietHours: typeof raw.quietHours === 'string' && raw.quietHours.trim().length > 0 ? raw.quietHours : null,
  };
}

/** True when a category is currently enabled. */
export function isCategoryEnabled(prefs: NotificationPreferences, categoryId: string): boolean {
  return prefs.categories.includes(categoryId);
}

/** Toggle a single category on/off, returning a new preferences object. Pure. */
export function toggleCategory(prefs: NotificationPreferences, categoryId: string): NotificationPreferences {
  if (!KNOWN_CATEGORY_IDS.has(categoryId)) return prefs;
  const enabled = isCategoryEnabled(prefs, categoryId);
  const next = enabled
    ? prefs.categories.filter((c) => c !== categoryId)
    : [...prefs.categories, categoryId];
  return { ...prefs, categories: NOTIFICATION_CATEGORIES.map((c) => c.id).filter((id) => next.includes(id)) };
}

// ---------------------------------------------------------------------------
// Quiet hours (timezone encoded into the opaque string)
// ---------------------------------------------------------------------------

/** A structured quiet-hours window. `start`/`end` are `HH:MM` (24h, local to `timezone`). */
export interface QuietHours {
  start: string;
  end: string;
  timezone: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const QUIET_HOURS_RE = /^(\d{2}:\d{2})-(\d{2}:\d{2})\s+(\S+)$/;

/** Encode a quiet-hours window into the opaque server string, e.g. `"22:00-07:00 America/New_York"`. */
export function encodeQuietHours(q: QuietHours): string {
  return `${q.start}-${q.end} ${q.timezone}`;
}

/** Decode the opaque server string back into a structured window, or null when absent/malformed. */
export function decodeQuietHours(raw: string | null | undefined): QuietHours | null {
  if (!raw) return null;
  const m = QUIET_HOURS_RE.exec(raw.trim());
  if (!m) return null;
  const [, start, end, timezone] = m;
  if (!HHMM.test(start!) || !HHMM.test(end!) || !timezone) return null;
  return { start: start!, end: end!, timezone };
}

/** A friendly label for a quiet-hours window, or "Off" when none is set. */
export function quietHoursLabel(raw: string | null | undefined): string {
  const q = decodeQuietHours(raw);
  if (!q) return 'Off';
  return `${q.start}–${q.end} (${q.timezone})`;
}

/** Read the wall-clock minutes-since-midnight for `date` in the given IANA timezone. */
function minutesInZone(date: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    // Intl can emit "24" for midnight in some engines; normalize to 0.
    return ((hour % 24) * 60 + minute);
  } catch {
    return null;
  }
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * True when `date` falls inside the quiet-hours window (inclusive of `start`,
 * exclusive of `end`), evaluated in the window's encoded timezone. Handles a
 * window that wraps past midnight (e.g. 22:00–07:00). This is the predicate the
 * "quiet hours suppress a test push" accept criterion checks. On any timezone
 * error it fails OPEN (returns false) so a misconfigured tz never silently
 * swallows every notification.
 */
export function isWithinQuietHours(raw: string | null | undefined, date: Date = new Date()): boolean {
  const q = decodeQuietHours(raw);
  if (!q) return false;
  const now = minutesInZone(date, q.timezone);
  if (now === null) return false;
  const start = hhmmToMinutes(q.start);
  const end = hhmmToMinutes(q.end);
  if (start === end) return false; // zero-length window = never quiet
  if (start < end) return now >= start && now < end; // same-day window
  return now >= start || now < end; // wraps past midnight
}

/**
 * Whether a push in `category` should be SUPPRESSED right now: notifications
 * globally disabled, the category turned off, or we are inside quiet hours.
 */
export function shouldSuppressPush(
  prefs: NotificationPreferences,
  categoryId: string,
  date: Date = new Date(),
): boolean {
  if (!prefs.enabled) return true;
  if (!isCategoryEnabled(prefs, categoryId)) return true;
  return isWithinQuietHours(prefs.quietHours, date);
}
