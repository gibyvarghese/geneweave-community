/**
 * task-row.tsx — a single action-item in the Actions tab (M7).
 *
 * Device-gated, presentational over one action-item {@link Task}. Tapping the
 * row opens the originating conversation (provenance deep-link); a Complete
 * affordance marks it done and a Dismiss affordance cancels it. A due-date chip
 * surfaces "Today" / "Tomorrow" / "Overdue". Icons go through the central
 * {@link Icon}; colors come from {@link useTheme}.
 */
import { Pressable, Text, View } from 'react-native';
import type { Task } from '@weaveintel/api-client';
import { formatDueLabel, isDueToday, taskConversationId } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';

export interface TaskRowProps {
  task: Task;
  onComplete: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
  onOpenConversation: (conversationId: string) => void;
}

export function TaskRow({ task, onComplete, onDismiss, onOpenConversation }: TaskRowProps) {
  const { theme } = useTheme();
  const conversationId = taskConversationId(task);
  const due = formatDueLabel(task.dueAt);
  const overdue = due === 'Overdue';
  const today = isDueToday(task.dueAt);
  const description = typeof task.description === 'string' ? task.description.trim() : '';

  const openConversation = () => {
    if (conversationId) onOpenConversation(conversationId);
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <Pressable
        onPress={() => onComplete(task.id)}
        hitSlop={8}
        accessibilityLabel="Complete task"
        style={{ padding: 2 }}
      >
        <Icon name="task" size="md" tone="inactive" />
      </Pressable>

      <Pressable
        onPress={openConversation}
        disabled={!conversationId}
        style={{ flex: 1, gap: 4 }}
      >
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.text,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.body.fontSize,
            fontWeight: '600',
          }}
        >
          {task.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          {due ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="due" size="sm" tone={overdue ? 'danger' : today ? 'attention' : 'muted'} />
              <Text
                style={{
                  color: overdue ? theme.colors.danger : today ? theme.colors.warning : theme.colors.textMuted,
                  fontFamily: theme.typography.families.body,
                  fontSize: theme.typography.scale.caption.fontSize,
                }}
              >
                {due}
              </Text>
            </View>
          ) : null}
          {description ? (
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                color: theme.colors.textMuted,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.caption.fontSize,
              }}
            >
              {description}
            </Text>
          ) : null}
        </View>
      </Pressable>

      <Pressable
        onPress={() => onDismiss(task.id)}
        hitSlop={8}
        accessibilityLabel="Dismiss task"
        style={{ padding: 2 }}
      >
        <Icon name="close" size="sm" tone="muted" />
      </Pressable>
    </View>
  );
}
