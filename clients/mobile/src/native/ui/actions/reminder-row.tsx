/**
 * reminder-row.tsx — a single reminder in the Actions tab (M7).
 *
 * Device-gated, presentational over one {@link Reminder}. Shows the label, the
 * next fire time (or a recurring badge), a provenance deep-link, snooze chips
 * (1h / tonight / tomorrow → reschedule) and a delete affordance. Icons go
 * through the central {@link Icon}; colors come from {@link useTheme}.
 */
import { Pressable, Text, View } from 'react-native';
import type { Reminder } from '@weaveintel/api-client';
import {
  formatDueLabel,
  reminderConversationId,
  reminderFireAt,
  reminderIsEnabled,
  reminderIsRecurring,
  reminderLabel,
  type SnoozeChoice,
} from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';

const SNOOZE_CHIPS: ReadonlyArray<{ choice: SnoozeChoice; label: string }> = [
  { choice: '1h', label: '1h' },
  { choice: 'tonight', label: 'Tonight' },
  { choice: 'tomorrow', label: 'Tomorrow' },
];

export interface ReminderRowProps {
  reminder: Reminder;
  onSnooze: (reminderId: string, choice: SnoozeChoice) => void;
  onDelete: (reminderId: string) => void;
  onOpenConversation: (conversationId: string) => void;
}

export function ReminderRow({ reminder, onSnooze, onDelete, onOpenConversation }: ReminderRowProps) {
  const { theme } = useTheme();
  const label = reminderLabel(reminder);
  const recurring = reminderIsRecurring(reminder);
  const fireAt = reminderFireAt(reminder);
  const due = formatDueLabel(fireAt);
  const enabled = reminderIsEnabled(reminder);
  const conversationId = reminderConversationId(reminder);

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
        opacity: enabled ? 1 : 0.6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Icon name="reminder" size="sm" tone="inactive" />
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
          {label}
        </Text>
        <Pressable onPress={() => onDelete(reminder.id)} hitSlop={8} accessibilityLabel="Delete reminder">
          <Icon name="delete" size="sm" tone="danger" />
        </Pressable>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Icon name={recurring ? 'recurring' : 'snooze'} size="sm" tone="muted" />
        <Text
          style={{
            color: theme.colors.textMuted,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.caption.fontSize,
          }}
        >
          {recurring ? 'Repeats' : due || 'Scheduled'}
        </Text>
        {conversationId ? (
          <Pressable
            onPress={() => onOpenConversation(conversationId)}
            hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' }}
          >
            <Icon name="chat" size="sm" tone="muted" />
            <Icon name="chevron" size="sm" tone="muted" />
          </Pressable>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
        {SNOOZE_CHIPS.map((c) => (
          <Pressable
            key={c.choice}
            onPress={() => onSnooze(reminder.id, c.choice)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
              borderRadius: theme.radii.pill,
              borderWidth: 1,
              borderColor: theme.colors.surfaceElevated,
            }}
          >
            <Icon name="snooze" size="sm" tone="muted" />
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.bodySmall.fontSize,
              }}
            >
              {c.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
