/**
 * actions-list.tsx — the Actions tab body (M7).
 *
 * Device-gated, presentational. Renders the segmented control and the active
 * segment's list (Approvals / Tasks / Reminders) with pull-to-refresh and
 * loading / empty / error states. All segmentation + counts are computed by the
 * pure brain in `src/lib`; this component only renders what it is handed and
 * lifts interaction to the screen. Icons go through the central {@link Icon}.
 */
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import type { Reminder, Task } from '@weaveintel/api-client';
import type { ActionSegment, SnoozeChoice } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';
import { ActionSegments } from './action-segments';
import { ApprovalRow } from './approval-row';
import { TaskRow } from './task-row';
import { ReminderRow } from './reminder-row';

export interface ActionsListProps {
  segment: ActionSegment;
  onSegmentChange: (segment: ActionSegment) => void;
  approvals: Task[];
  actionItems: Task[];
  reminders: Reminder[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  onRefresh: () => void;
  onApprove: (taskId: string) => void;
  onDeny: (taskId: string) => void;
  onComplete: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
  onSnooze: (reminderId: string, choice: SnoozeChoice) => void;
  onDelete: (reminderId: string) => void;
  onOpenConversation: (conversationId: string) => void;
}

const EMPTY_COPY: Record<ActionSegment, string> = {
  approvals: 'No approvals waiting. Decisions an agent needs from you show up here.',
  tasks: 'No action items. Follow-ups from your conversations land here.',
  reminders: 'No reminders. Ask in chat to be reminded about something.',
};

export function ActionsList(props: ActionsListProps) {
  const { theme } = useTheme();
  const {
    segment,
    onSegmentChange,
    approvals,
    actionItems,
    reminders,
    isLoading,
    isRefetching,
    isError,
    onRefresh,
  } = props;

  const counts = { approvals: approvals.length, tasks: actionItems.length, reminders: reminders.length };

  const refreshControl = (
    <RefreshControl
      refreshing={isRefetching}
      onRefresh={onRefresh}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
    />
  );

  const emptyState = (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.md, padding: theme.spacing.xl }}>
      <Icon name={isError ? 'error' : 'empty'} size="lg" tone={isError ? 'danger' : 'muted'} />
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontFamily: theme.typography.families.body,
          fontSize: theme.typography.scale.body.fontSize,
          textAlign: 'center',
        }}
      >
        {isError ? 'Could not load. Pull to retry.' : EMPTY_COPY[segment]}
      </Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ActionSegments active={segment} onChange={onSegmentChange} counts={counts} />

      {isLoading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : segment === 'approvals' ? (
        <FlatList
          data={approvals}
          keyExtractor={(t) => t.id}
          contentContainerStyle={approvals.length === 0 ? { flexGrow: 1 } : { paddingBottom: theme.spacing.xl }}
          refreshControl={refreshControl}
          renderItem={({ item }) => (
            <ApprovalRow
              task={item}
              onApprove={props.onApprove}
              onDeny={props.onDeny}
              onOpenConversation={props.onOpenConversation}
            />
          )}
          ListEmptyComponent={emptyState}
        />
      ) : segment === 'tasks' ? (
        <FlatList
          data={actionItems}
          keyExtractor={(t) => t.id}
          contentContainerStyle={actionItems.length === 0 ? { flexGrow: 1 } : { paddingBottom: theme.spacing.xl }}
          refreshControl={refreshControl}
          renderItem={({ item }) => (
            <TaskRow
              task={item}
              onComplete={props.onComplete}
              onDismiss={props.onDismiss}
              onOpenConversation={props.onOpenConversation}
            />
          )}
          ListEmptyComponent={emptyState}
        />
      ) : (
        <FlatList
          data={reminders}
          keyExtractor={(r) => r.id}
          contentContainerStyle={reminders.length === 0 ? { flexGrow: 1 } : { paddingBottom: theme.spacing.xl }}
          refreshControl={refreshControl}
          renderItem={({ item }) => (
            <ReminderRow
              reminder={item}
              onSnooze={props.onSnooze}
              onDelete={props.onDelete}
              onOpenConversation={props.onOpenConversation}
            />
          )}
          ListEmptyComponent={emptyState}
        />
      )}
    </View>
  );
}
