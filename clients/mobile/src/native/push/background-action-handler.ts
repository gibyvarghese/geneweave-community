/**
 * background-action-handler.ts — notification action + background-fetch tasks.
 *
 * Device-gated: imports expo-task-manager, expo-background-fetch, expo-notifications.
 * These tasks must be DEFINED at module level (not inside React) because the OS
 * may launch a background context before any React component renders.
 *
 * Two tasks are registered here:
 *
 *  1. NOTIFICATION_ACTION_TASK — handles Approve/Deny actions from the OS.
 *     When a user responds to an approval notification without foregrounding the
 *     app, iOS/Android launch a minimal background context. We read auth tokens
 *     from SecureStore, build a lightweight client, call resolveNotificationAction,
 *     then either update the badge silently (success) or schedule a local
 *     "open app" notification (failure).
 *
 *  2. BACKGROUND_FETCH_TASK — runs every 15 minutes to refresh the Actions badge
 *     count (pending approvals). This keeps the badge accurate even when the app
 *     is suspended.
 *
 * Module-level task definitions must run before any component mounts. Import this
 * file at the top of app/_layout.tsx so it is evaluated during the JS bundle load.
 */
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import { createGeneweaveClient } from '@weaveintel/api-client';
import { createSecureStoreKv } from '../adapters/expo-secure-store';
import {
  getStoredHost,
  getStoredTenant,
  createTenantTokenStore,
  countActionsBadge,
} from '../../lib';
import {
  APPROVAL_ACTION_APPROVE,
  APPROVAL_ACTION_DENY,
  APPROVAL_CATEGORY_ID,
} from './notification-categories';
import { setAppBadgeCount } from '../adapters/expo-notifications-adapter';

export const NOTIFICATION_ACTION_TASK = 'geneweave-notification-action';
export const BACKGROUND_FETCH_TASK = 'geneweave-background-fetch';

/** Data shape embedded in approval push notification payloads by the server. */
interface ApprovalNotificationData {
  taskId?: string;
  runId?: string;
  conversationId?: string;
}

/** Build a minimal geneWeave client from persisted credentials (background context). */
async function buildBackgroundClient() {
  const kv = createSecureStoreKv();
  const host = await getStoredHost(kv);
  if (!host) return null;
  const tenantId = (await getStoredTenant(kv)) ?? undefined;
  const tokenStore = createTenantTokenStore(kv, host, tenantId);
  const tokens = await tokenStore.get();
  if (!tokens) return null;
  return createGeneweaveClient({ host, tokenStore });
}

// ── 1. Notification action handler ────────────────────────────────────────────

TaskManager.defineTask(NOTIFICATION_ACTION_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody) => {
  if (error) {
    console.warn('[push] notification action task error:', error.message);
    return;
  }

  // expo-notifications delivers the response under data.notification for bg tasks
  const response = (data as { notification?: { request?: { content?: { data?: ApprovalNotificationData }; categoryIdentifier?: string }; actionIdentifier?: string } } | undefined)
    ?.notification;
  if (!response) return;

  const actionId = response.request?.actionIdentifier ?? response.actionIdentifier;
  const category = response.request?.categoryIdentifier;
  const notifData = response.request?.content?.data ?? {};

  if (category !== APPROVAL_CATEGORY_ID) return;
  if (actionId !== APPROVAL_ACTION_APPROVE && actionId !== APPROVAL_ACTION_DENY) return;

  const taskId = (notifData as ApprovalNotificationData).taskId;
  if (!taskId) return;

  const notifAction = actionId === APPROVAL_ACTION_APPROVE ? 'approve' : 'deny';

  try {
    const client = await buildBackgroundClient();
    if (!client) return;

    await client.resolveNotificationAction({ taskId, actionId: notifAction });

    // Refresh badge after success
    const tasks = await client.listTasks();
    const badge = countActionsBadge(tasks);
    await setAppBadgeCount(badge);
  } catch (err) {
    console.warn('[push] background action resolve failed:', String(err));
    // On failure, schedule a local notification prompting the user to open the app.
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Action needed',
        body: 'Could not process your response. Tap to review.',
        data: notifData as Record<string, unknown>,
      },
      trigger: null,
    }).catch(() => {});
  }
});

// ── 2. Background fetch (badge refresh) ───────────────────────────────────────

TaskManager.defineTask(BACKGROUND_FETCH_TASK, async (): Promise<BackgroundFetch.BackgroundFetchResult> => {
  try {
    const client = await buildBackgroundClient();
    if (!client) return BackgroundFetch.BackgroundFetchResult.NoData;

    const tasks = await client.listTasks();
    const badge = countActionsBadge(tasks);
    await setAppBadgeCount(badge);
    return badge > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/**
 * Register the background fetch task with the OS. Call once from the app root
 * after fonts/providers are ready. Safe to call multiple times; expo-background-fetch
 * is idempotent for already-registered tasks.
 */
export async function registerBackgroundFetch(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
  if (isRegistered) return;
  await BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
    minimumInterval: 15 * 60, // 15 minutes
    stopOnTerminate: false,
    startOnBoot: true,
  });
}
