/**
 * geneWeave SQL adapters for Collaboration Phase 3 — durable run subscriptions
 * and the in-app notification feed. These are the SQL implementations of the
 * `@weaveintel/collab` `SubscriptionManager` and `@weaveintel/notifications`
 * `NotificationFeedStore` PORTS; both pass the SAME shared contracts the
 * in-memory reference adapters pass (the Phase 0/1/2 pattern — one interface,
 * two interchangeable backends).
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  normalizeChannels,
  type SubscriptionManager,
  type RunSubscription,
  type SubscriptionChannel,
} from '@weaveintel/collab';
import type { NotificationFeedStore, FeedNotification } from '@weaveintel/notifications';
import type { DatabaseAdapter } from './db-types.js';
import type { RunSubscriptionRow, NotificationFeedRow } from './db-types/adapter-me.js';

const GLOBAL_TENANT = '__global__';

/** Parse the stored JSON channel array, defaulting to `['inapp']`. */
function parseChannels(raw: string): SubscriptionChannel[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeChannels(Array.isArray(parsed) ? (parsed as SubscriptionChannel[]) : undefined);
  } catch { return ['inapp']; }
}

function rowToSub(r: RunSubscriptionRow): RunSubscription {
  return {
    runId: r.run_id,
    tenantId: r.tenant_id ?? GLOBAL_TENANT,
    userId: r.user_id,
    channels: parseChannels(r.channels),
    createdAt: r.created_at,
  };
}

/** SQL adapter for the durable {@link SubscriptionManager} port (over `run_subscriptions`). */
export function createSqlSubscriptionManager(
  db: Pick<DatabaseAdapter, 'upsertRunSubscription' | 'deleteRunSubscription' | 'getRunSubscription' | 'listRunSubscribers' | 'listSubscriptionsForUser'>,
  opts: { now?: () => number } = {},
): SubscriptionManager {
  const now = opts.now ?? (() => Date.now());
  return {
    async subscribe(input) {
      const channels = normalizeChannels(input.channels);
      const row = await db.upsertRunSubscription({
        id: newUUIDv7(),
        run_id: input.runId,
        tenant_id: input.tenantId === GLOBAL_TENANT ? null : input.tenantId,
        user_id: input.userId,
        channels: JSON.stringify(channels),
        created_at: now(),
      });
      return rowToSub(row);
    },
    async unsubscribe(runId, userId) { await db.deleteRunSubscription(runId, userId); },
    async isSubscribed(runId, userId) { return (await db.getRunSubscription(runId, userId)) !== null; },
    async get(runId, userId) {
      const r = await db.getRunSubscription(runId, userId);
      return r ? rowToSub(r) : null;
    },
    async listSubscribers(runId) { return (await db.listRunSubscribers(runId)).map(rowToSub); },
    async listForUser(userId) { return (await db.listSubscriptionsForUser(userId)).map(rowToSub); },
  };
}

// ─── Notification feed SQL adapter ──────────────────────────────────────────────

function rowToFeed(r: NotificationFeedRow): FeedNotification {
  return {
    id: r.id,
    tenantId: r.tenant_id ?? GLOBAL_TENANT,
    principalId: r.principal_id,
    category: r.category,
    title: r.title,
    ...(r.body ? { body: r.body } : {}),
    ...(r.deep_link ? { deepLink: r.deep_link } : {}),
    priority: r.priority,
    createdAt: r.created_at,
    readAt: r.read_at,
    ...(r.dedupe_key ? { dedupeKey: r.dedupe_key } : {}),
  };
}

/** SQL adapter for the {@link NotificationFeedStore} port (over `notification_feed`). */
export function createSqlFeedStore(
  db: Pick<DatabaseAdapter, 'appendNotificationFeed' | 'listNotificationFeed' | 'countUnreadNotificationFeed' | 'markNotificationFeedRead' | 'markAllNotificationFeedRead'>,
  opts: { now?: () => number } = {},
): NotificationFeedStore {
  const now = opts.now ?? (() => Date.now());
  return {
    async append(n) {
      const saved = await db.appendNotificationFeed({
        id: n.id,
        tenant_id: n.tenantId === GLOBAL_TENANT ? null : n.tenantId,
        principal_id: n.principalId,
        category: n.category,
        title: n.title,
        body: n.body ?? null,
        deep_link: n.deepLink ?? null,
        priority: n.priority,
        dedupe_key: n.dedupeKey ?? null,
        created_at: n.createdAt,
        read_at: n.readAt,
      });
      return rowToFeed(saved);
    },
    async list(tenantId, principalId, listOpts) {
      return (await db.listNotificationFeed(tenantId, principalId, listOpts)).map(rowToFeed);
    },
    async unreadCount(tenantId, principalId) { return db.countUnreadNotificationFeed(tenantId, principalId); },
    async markRead(tenantId, principalId, id) { return db.markNotificationFeedRead(tenantId, principalId, id, now()); },
    async markAllRead(tenantId, principalId) { return db.markAllNotificationFeedRead(tenantId, principalId, now()); },
  };
}
