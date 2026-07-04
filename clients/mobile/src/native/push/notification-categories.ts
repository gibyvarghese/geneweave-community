/**
 * notification-categories.ts — registers interactive notification categories.
 *
 * Device-gated: imports expo-notifications. Must be called once on app start
 * (before any notification arrives) so iOS/Android know about the Approve/Deny
 * action buttons. The category is embedded in every approval push payload by
 * the geneWeave server (`categoryIdentifier: APPROVAL_CATEGORY_ID`).
 *
 * Background action handling: when the user acts on a notification without
 * foregrounding the app, iOS launches a background execution context and fires
 * the notification response handler registered in {@link background-action-handler}.
 * We use `destructive: false` for Deny so iOS does not tint the button red
 * (a deny here is a workflow decision, not a destructive file operation).
 */
import * as Notifications from 'expo-notifications';

/** The notification category ID embedded in approval push payloads. */
export const APPROVAL_CATEGORY_ID = 'geneweave.approval';

/** Action identifiers for the approval category. */
export const APPROVAL_ACTION_APPROVE = 'APPROVE';
export const APPROVAL_ACTION_DENY = 'DENY';

/**
 * Registers all interactive notification categories with the OS.
 * Safe to call multiple times; expo-notifications is idempotent.
 */
export async function registerNotificationCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY_ID, [
    {
      identifier: APPROVAL_ACTION_APPROVE,
      buttonTitle: 'Approve',
      options: { opensAppToForeground: false, isDestructive: false, isAuthenticationRequired: false },
    },
    {
      identifier: APPROVAL_ACTION_DENY,
      buttonTitle: 'Deny',
      options: { opensAppToForeground: false, isDestructive: false, isAuthenticationRequired: false },
    },
  ]);
}
