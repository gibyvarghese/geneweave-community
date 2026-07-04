/**
 * Notification wiring (W9b Gap 3)
 *
 * Constructs the platform NotificationDispatcher and binds it to the /api/me
 * run / task / reminder lifecycle. Three concerns are wired here:
 *
 *   1. SuppressionPolicy backed by `notification_preferences` — honours the
 *      per-principal master toggle, a category allow-list, and quiet-hours
 *      evaluated in the principal's stored timezone (default Pacific/Auckland).
 *      Any resolution error suppresses delivery (fail-closed).
 *   2. A device-backed TargetStore — maps `user_devices` rows to channel
 *      targets so registrations made via POST /api/me/devices are honoured.
 *   3. Lifecycle helpers — `notifyRunTerminal` (owner notified only when the
 *      run is detached, i.e. no live subscriber), `notifyTask` (actionable
 *      approvals delivered high-priority with approve/deny actions), and
 *      `notifyReminderDue`.
 *
 * SECURITY: principal / tenant identifiers are never placed in outbound URLs;
 * deep links are opaque `geneweave://<kind>/<id>` URIs.
 */

import {
  createNotificationDispatcher,
  createChannelRegistry,
  createWebhookChannel,
  createWebPushChannel,
  createApnsChannel,
  createFcmChannel,
  type NotificationDispatcher,
  type ChannelRegistry,
  type TargetStore,
  type SuppressionPolicy,
  type DispatchResult,
  type WebPushChannelOptions,
  type ApnsChannelOptions,
  type FcmChannelOptions,
} from '@weaveintel/notifications';
import { newUUIDv7, createLogger, weaveContext } from '@weaveintel/core';
import type { NotificationMessage } from '@weaveintel/core';

const logger = createLogger('notifications-wiring');
import type { DatabaseAdapter } from './db-types.js';
import type { UserRunRow, NotificationPrefsRow, UserDeviceRow } from './db-types/adapter-me.js';

const DEFAULT_TIMEZONE = 'Pacific/Auckland';
const GLOBAL_TENANT = '__global__';

// ─── SuppressionPolicy ──────────────────────────────────────────────────────

function parseCategories(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch { return []; }
}

/** Minutes-of-day for `date` rendered in `timeZone` (0–1439). */
function minutesOfDayInZone(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** Parse "HH:MM-HH:MM" → [startMin, endMin] or null when malformed. */
function parseQuietHours(spec: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return null;
  const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  return [sh * 60 + sm, eh * 60 + em];
}

function withinQuietHours(spec: string, timeZone: string, now: Date): boolean {
  const window = parseQuietHours(spec);
  if (!window) return false;
  const [start, end] = window;
  const cur = minutesOfDayInZone(now, timeZone);
  if (start === end) return false;          // zero-length window
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;         // wraps past midnight
}

/**
 * SuppressionPolicy derived from `notification_preferences`. Fail-closed: any
 * error while resolving preferences suppresses the delivery.
 */
export function createPrefsSuppressionPolicy(
  db: Pick<DatabaseAdapter, 'getNotificationPrefs'>,
  opts: { defaultTimezone?: string; now?: () => Date } = {},
): SuppressionPolicy {
  const fallbackTz = opts.defaultTimezone ?? DEFAULT_TIMEZONE;
  const now = opts.now ?? (() => new Date());
  return {
    async shouldSuppress(_ctx, sc) {
      try {
        const prefs: NotificationPrefsRow | null = await db.getNotificationPrefs(sc.principalId);
        if (!prefs) return false;                 // no prefs → default allow
        if (prefs.enabled === 0) return true;     // master off → suppress all
        const categories = parseCategories(prefs.categories);
        if (categories.length > 0 && !categories.includes(sc.category)) return true;
        if (prefs.quiet_hours && withinQuietHours(prefs.quiet_hours, prefs.timezone ?? fallbackTz, now())) {
          return true;
        }
        return false;
      } catch (err) {
        logger.warn('suppression resolution failed — suppressing (fail-closed)', {
          principalId: sc.principalId, err,
        });
        return true;
      }
    },
  };
}

// ─── Device-backed TargetStore ────────────────────────────────────────────────

/**
 * Read-only TargetStore that surfaces `user_devices` registrations as channel
 * targets (channelId = device channel, address = device token). Registration
 * happens via POST /api/me/devices; this store only reads.
 */
export function createDeviceTargetStore(db: Pick<DatabaseAdapter, 'listDevices' | 'getDeviceById'>): TargetStore {
  return {
    async upsert() { throw new Error('device target store is read-only (register via /api/me/devices)'); },
    async getById(id: string) {
      try {
        const d = await db.getDeviceById(id);
        if (!d) return undefined;
        return { id: d.id, tenantId: d.tenant_id ?? GLOBAL_TENANT, principalId: d.user_id, channelId: d.channel, target: { kind: d.channel, address: d.token }, createdAt: d.created_at, updatedAt: d.created_at };
      } catch { return undefined; }
    },
    async listByPrincipal(_tenantId, principalId) {
      let devices: UserDeviceRow[] = [];
      try { devices = await db.listDevices(principalId); } catch { devices = []; }
      return devices.map((d) => ({
        id: d.id,
        tenantId: d.tenant_id ?? GLOBAL_TENANT,
        principalId: d.user_id,
        channelId: d.channel,
        target: { kind: d.channel, address: d.token },
        createdAt: d.created_at,
        updatedAt: d.created_at,
      }));
    },
    async remove(id) { logger.warn(`remove(${id}) called — device registrations are managed via DELETE /api/me/devices/:deviceId, not through the target store`); },
  };
}

// ─── Hub ──────────────────────────────────────────────────────────────────────

export interface NotificationsHub {
  readonly dispatcher: NotificationDispatcher;
  readonly channels: ChannelRegistry;
  readonly targets: TargetStore;
  /** Notify the run owner — only when the run is detached (no live subscriber). */
  notifyRunTerminal(run: UserRunRow, opts: { attached: boolean }): Promise<DispatchResult | null>;
  /** Notify a task assignee; actionable tasks deliver high-priority with approve/deny. */
  notifyTask(
    task: { id: string; assignee?: string; title: string; tenantId?: string | null },
    opts?: { actionable?: boolean },
  ): Promise<DispatchResult | null>;
  /** Notify the reminder owner that it is due. */
  notifyReminderDue(
    reminder: { id: string; ownerPrincipalId: string; label: string; tenantId?: string | null },
  ): Promise<DispatchResult>;
}

export interface NotificationsHubOptions {
  db: DatabaseAdapter;
  /** Inject a registry/targets/suppression (tests). Defaults are derived from `db`. */
  channels?: ChannelRegistry;
  targets?: TargetStore;
  suppression?: SuppressionPolicy;
  defaultTimezone?: string;
  /** Channel credentials — a channel is only registered when its config is present. */
  webhook?: { enabled?: boolean; signingSecret?: string };
  webPush?: WebPushChannelOptions;
  apns?: ApnsChannelOptions;
  fcm?: FcmChannelOptions;
}

function buildDefaultChannels(opts: NotificationsHubOptions): ChannelRegistry {
  const reg = createChannelRegistry();
  if (opts.webhook?.enabled !== false) {
    reg.register(createWebhookChannel(opts.webhook?.signingSecret ? { signingSecret: opts.webhook.signingSecret } : {}));
  }
  if (opts.webPush) reg.register(createWebPushChannel(opts.webPush));
  if (opts.apns) reg.register(createApnsChannel(opts.apns));
  if (opts.fcm) reg.register(createFcmChannel(opts.fcm));
  return reg;
}

export function createNotificationsHub(opts: NotificationsHubOptions): NotificationsHub {
  const channels = opts.channels ?? buildDefaultChannels(opts);
  const targets = opts.targets ?? createDeviceTargetStore(opts.db);
  const suppression = opts.suppression
    ?? createPrefsSuppressionPolicy(opts.db, { defaultTimezone: opts.defaultTimezone ?? DEFAULT_TIMEZONE });
  const dispatcher = createNotificationDispatcher({ channels, targets, suppression });

  function ctxFor(tenantId: string, principalId: string) {
    return weaveContext({ userId: principalId, ...(tenantId !== GLOBAL_TENANT ? { tenantId } : {}) });
  }

  return {
    dispatcher,
    channels,
    targets,

    async notifyRunTerminal(run, runOpts) {
      if (runOpts.attached) return null;          // a live subscriber is watching
      const tenantId = run.tenant_id ?? GLOBAL_TENANT;
      const msg: NotificationMessage = {
        id: newUUIDv7(),
        tenantId,
        principalId: run.user_id,
        category: 'run',
        title: `Run ${run.status}`,
        deepLink: `geneweave://run/${run.id}`,
        priority: run.status === 'failed' ? 'high' : 'normal',
      };
      return dispatcher.notify(ctxFor(tenantId, run.user_id), run.user_id, tenantId, msg);
    },

    async notifyTask(task, taskOpts) {
      if (!task.assignee) return null;
      const tenantId = task.tenantId ?? GLOBAL_TENANT;
      const actionable = taskOpts?.actionable === true;
      const msg: NotificationMessage = {
        id: newUUIDv7(),
        tenantId,
        principalId: task.assignee,
        category: 'task',
        title: task.title,
        deepLink: `geneweave://task/${task.id}`,
        priority: actionable ? 'high' : 'normal',
        ...(actionable
          ? { actions: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }] }
          : {}),
      };
      return dispatcher.notify(ctxFor(tenantId, task.assignee), task.assignee, tenantId, msg);
    },

    async notifyReminderDue(reminder) {
      const tenantId = reminder.tenantId ?? GLOBAL_TENANT;
      const msg: NotificationMessage = {
        id: newUUIDv7(),
        tenantId,
        principalId: reminder.ownerPrincipalId,
        category: 'reminder',
        title: reminder.label,
        deepLink: `geneweave://reminder/${reminder.id}`,
      };
      return dispatcher.notify(ctxFor(tenantId, reminder.ownerPrincipalId), reminder.ownerPrincipalId, tenantId, msg);
    },
  };
}
