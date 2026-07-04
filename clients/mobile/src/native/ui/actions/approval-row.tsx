/**
 * approval-row.tsx — a single approval in the Actions tab (M7).
 *
 * Device-gated, presentational over one approval {@link Task}. Shows the title,
 * optional description, a provenance deep-link to the originating conversation,
 * and Approve / Deny affordances. Approve uses the one sanctioned accent;
 * Deny is a bordered danger affordance. All icons go through the central
 * {@link Icon}; colors come from {@link useTheme}.
 */
import { Pressable, Text, View } from 'react-native';
import type { Task } from '@weaveintel/api-client';
import { taskConversationId } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';

export interface ApprovalRowProps {
  task: Task;
  onApprove: (taskId: string) => void;
  onDeny: (taskId: string) => void;
  onOpenConversation: (conversationId: string) => void;
}

export function ApprovalRow({ task, onApprove, onDeny, onOpenConversation }: ApprovalRowProps) {
  const { theme } = useTheme();
  const conversationId = taskConversationId(task);
  const description = typeof task.description === 'string' ? task.description.trim() : '';

  return (
    <View
      style={{
        marginHorizontal: theme.spacing.lg,
        marginTop: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.surfaceElevated,
        backgroundColor: theme.colors.surface,
        gap: theme.spacing.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Icon name="approval" size="sm" tone="attention" />
        <Text
          numberOfLines={2}
          style={{
            flex: 1,
            color: theme.colors.text,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.body.fontSize,
            fontWeight: '600',
          }}
        >
          {task.title}
        </Text>
      </View>

      {description ? (
        <Text
          numberOfLines={3}
          style={{
            color: theme.colors.textMuted,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.bodySmall.fontSize,
          }}
        >
          {description}
        </Text>
      ) : null}

      {conversationId ? (
        <Pressable
          onPress={() => onOpenConversation(conversationId)}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <Icon name="chat" size="sm" tone="muted" />
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.caption.fontSize,
            }}
          >
            Open conversation
          </Text>
          <Icon name="chevron" size="sm" tone="muted" />
        </Pressable>
      ) : null}

      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
        <Pressable
          onPress={() => onApprove(task.id)}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.accent,
          }}
        >
          <Icon name="check" size="sm" tone="onAccent" />
          <Text
            style={{
              color: theme.colors.onAccent,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.body.fontSize,
              fontWeight: '600',
            }}
          >
            Approve
          </Text>
        </Pressable>
        <Pressable
          onPress={() => onDeny(task.id)}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.danger,
          }}
        >
          <Icon name="close" size="sm" tone="danger" />
          <Text
            style={{
              color: theme.colors.danger,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.body.fontSize,
              fontWeight: '600',
            }}
          >
            Deny
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
