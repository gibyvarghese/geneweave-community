/**
 * conversation-row.tsx — a single conversation row in the Chats list (M6).
 *
 * Device-gated. Pure presentation over one {@link Conversation}: title, last
 * snippet, a relative timestamp, and status affordances (pinned / pending /
 * running) rendered exclusively through the central {@link Icon} so the icon
 * rules hold. Tap resumes the conversation; long-press opens the action sheet.
 * All colors come from {@link useTheme}, so per-tenant themes re-skin the row.
 */
import { Pressable, Text, View } from 'react-native';
import type { Conversation } from '@weaveintel/api-client';
import { formatRelativeTimestamp, isActiveRunStatus } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';

export interface ConversationRowProps {
  conversation: Conversation;
  onPress: (conversation: Conversation) => void;
  onLongPress: (conversation: Conversation) => void;
}

export function ConversationRow({ conversation, onPress, onLongPress }: ConversationRowProps) {
  const { theme } = useTheme();
  const running = isActiveRunStatus(conversation.runStatus);
  const title = conversation.title?.trim() || 'Untitled chat';
  const when = formatRelativeTimestamp(conversation.updatedAt);

  return (
    <Pressable
      onPress={() => onPress(conversation)}
      onLongPress={() => onLongPress(conversation)}
      delayLongPress={300}
      android_ripple={{ color: theme.colors.surfaceElevated }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        backgroundColor: pressed ? theme.colors.surface : 'transparent',
      })}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          {conversation.pinned ? <Icon name="pin" size="sm" tone="muted" /> : null}
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              color: theme.colors.text,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.body.fontSize,
              fontWeight: '600',
            }}
          >
            {title}
          </Text>
          {conversation.hasPendingAction ? <Icon name="pending" size="sm" tone="attention" /> : null}
        </View>

        {conversation.snippet ? (
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.textMuted,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.bodySmall.fontSize,
            }}
          >
            {conversation.snippet}
          </Text>
        ) : null}
      </View>

      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {when ? (
          <Text
            style={{
              color: theme.colors.textMuted,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.caption.fontSize,
            }}
          >
            {when}
          </Text>
        ) : null}
        {running ? <Icon name="running" size="sm" tone="accent" /> : <Icon name="chevron" size="sm" tone="muted" />}
      </View>
    </Pressable>
  );
}
