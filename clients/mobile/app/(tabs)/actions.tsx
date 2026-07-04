/**
 * (tabs)/actions.tsx — the M7 Actions surface.
 *
 * Device-gated screen holding **no** list logic: it composes the
 * {@link useActions} hook (task + reminder queries with optimistic mutations)
 * with the presentational {@link ActionsList}. Segmentation, badge counts, and
 * snooze math are computed by the pure brain in `src/lib`. Every row deep-links
 * to its originating conversation on the Chat tab via a `conversationId` route
 * param (the same resume path the Chats tab uses).
 */
import { useCallback, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/native/providers/theme-provider';
import { useActions } from '../../src/native/actions/use-actions';
import { ActionsList } from '../../src/native/ui/actions/actions-list';
import type { ActionSegment } from '../../src/lib';

export default function ActionsScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const [segment, setSegment] = useState<ActionSegment>('approvals');

  const {
    approvals,
    actionItems,
    reminders,
    isLoading,
    isRefetching,
    isError,
    refetch,
    resolveApproval,
    completeTask,
    cancelTask,
    snoozeReminder,
    deleteReminder,
  } = useActions();

  const openConversation = useCallback(
    (conversationId: string) => {
      // Switch to the Chat tab carrying the conversation id (navigate, not push,
      // so we reuse the existing tab navigator rather than stacking a new one).
      router.navigate({ pathname: '/(tabs)', params: { conversationId } });
    },
    [router],
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ActionsList
        segment={segment}
        onSegmentChange={setSegment}
        approvals={approvals}
        actionItems={actionItems}
        reminders={reminders}
        isLoading={isLoading}
        isRefetching={isRefetching}
        isError={isError}
        onRefresh={refetch}
        onApprove={(taskId) => resolveApproval(taskId, 'approve')}
        onDeny={(taskId) => resolveApproval(taskId, 'deny')}
        onComplete={completeTask}
        onDismiss={cancelTask}
        onSnooze={snoozeReminder}
        onDelete={deleteReminder}
        onOpenConversation={openConversation}
      />
    </SafeAreaView>
  );
}
