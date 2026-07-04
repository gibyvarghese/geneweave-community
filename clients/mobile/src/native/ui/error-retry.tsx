/**
 * error-retry.tsx — reusable error state component with retry affordance.
 *
 * Shown by list screens (Chats, Actions, Memory) when a query fails. Renders
 * a contextual message, an optional technical detail (development only), and
 * a primary Retry button. For offline-specific errors, delegates to the
 * offline banner instead of showing an error card.
 */
import { Text, View, Pressable } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './icon';

interface ErrorRetryProps {
  /** Human-readable description of what failed. */
  message?: string;
  /** Optional technical detail shown in dev mode. */
  detail?: string;
  /** Called when the user taps Retry. */
  onRetry?: () => void;
  /** When true the button label changes to "Try again" (for post-action errors). */
  isPostAction?: boolean;
}

export function ErrorRetry({
  message = 'Something went wrong',
  detail,
  onRetry,
  isPostAction = false,
}: ErrorRetryProps) {
  const { theme } = useTheme();
  const isDev = process.env['NODE_ENV'] !== 'production';

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.spacing.xl,
        gap: theme.spacing.md,
      }}
    >
      <Icon name="error" size="lg" color={theme.colors.textMuted} />
      <Text
        style={{
          color: theme.colors.text,
          fontFamily: theme.typography.families.body,
          fontSize: theme.typography.scale.body.fontSize,
          textAlign: 'center',
        }}
      >
        {message}
      </Text>
      {isDev && detail ? (
        <Text
          style={{
            color: theme.colors.textMuted,
            fontFamily: theme.typography.families.mono,
            fontSize: theme.typography.scale.bodySmall.fontSize,
            textAlign: 'center',
          }}
        >
          {detail}
        </Text>
      ) : null}
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => ({
            backgroundColor: pressed ? theme.colors.accent + 'CC' : theme.colors.accent,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.sm,
            borderRadius: theme.radii.md,
            marginTop: theme.spacing.sm,
          })}
        >
          <Text
            style={{
              color: '#fff',
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.body.fontSize,
              fontWeight: '600',
            }}
          >
            {isPostAction ? 'Try again' : 'Retry'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Inline error row for use within list items (non-full-screen). */
export function InlineError({ message }: { message: string }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        padding: theme.spacing.md,
        backgroundColor: theme.colors.danger + '18',
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.danger + '33',
      }}
    >
      <Icon name="error" size="sm" color={theme.colors.danger} />
      <Text
        style={{
          flex: 1,
          color: theme.colors.danger,
          fontFamily: theme.typography.families.body,
          fontSize: theme.typography.scale.bodySmall.fontSize,
        }}
      >
        {message}
      </Text>
    </View>
  );
}
