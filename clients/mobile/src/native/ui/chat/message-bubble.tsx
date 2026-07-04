/**
 * message-bubble.tsx — one chat entry (user message or assistant run).
 *
 * Device-gated. Memoized so a 2,000-token stream only re-renders the single
 * in-flight assistant bubble, keeping the inverted list at 60fps. User bubbles
 * are right-aligned on the accent surface; assistant bubbles are left-aligned
 * and render tool-call lines, the markdown body, a streaming indicator, and any
 * error. Long-press exposes the per-role actions (edit/resend, copy/regenerate).
 */
import { memo, useCallback, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { isTerminalStatus, type AssistantEntry, type ChatEntry, type UserEntry } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { MarkdownText } from './markdown-text';
import { ToolCallLine } from './tool-call-line';
import { WidgetActionProvider, WidgetBlock } from '../widgets';

/** Fired when a user taps an interactive widget action (a tap is a turn). */
export type WidgetActionHandler = (
  runId: string,
  widgetId: string,
  actionId: string,
  value?: unknown,
) => void;

export interface MessageBubbleProps {
  entry: ChatEntry;
  onEditUser: (entry: UserEntry) => void;
  onAssistantActions: (entry: AssistantEntry) => void;
  /** Posts an interactive widget action for the run that owns the widget. */
  onWidgetAction?: WidgetActionHandler;
  /** Widget ids with an action in flight → the submitted action id. */
  pendingWidgetActions?: Record<string, string>;
}

function UserBubble({ entry, onEdit }: { entry: UserEntry; onEdit: (e: UserEntry) => void }) {
  const { theme } = useTheme();
  const superseded = entry.supersededByRunId != null;
  return (
    <View style={{ alignItems: 'flex-end', paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs }}>
      <Pressable
        onLongPress={() => onEdit(entry)}
        style={{
          maxWidth: '85%',
          backgroundColor: theme.colors.accent,
          borderRadius: theme.radii.lg,
          borderBottomRightRadius: theme.radii.sm,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          opacity: superseded ? 0.45 : 1,
        }}
      >
        <Text
          style={{
            color: theme.colors.onAccent,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.body.fontSize,
            lineHeight: theme.typography.scale.body.lineHeight,
          }}
        >
          {entry.text}
        </Text>
      </Pressable>
    </View>
  );
}

function AssistantBubble({
  entry,
  onActions,
  onWidgetAction,
  pendingWidgetActions,
}: {
  entry: AssistantEntry;
  onActions: (e: AssistantEntry) => void;
  onWidgetAction?: WidgetActionHandler;
  pendingWidgetActions?: Record<string, string>;
}) {
  const { theme } = useTheme();
  const { model } = entry;
  const producing = !isTerminalStatus(model.status);
  const hasText = model.fullText.length > 0;
  const widgets = useMemo(() => Array.from(model.widgets.values()), [model.widgets]);

  // Run-bound action context: a widget tap posts against THIS run.
  const actionValue = useMemo(
    () => ({
      submit: (widgetId: string, actionId: string, value?: unknown) =>
        onWidgetAction?.(entry.runId, widgetId, actionId, value),
      pending: pendingWidgetActions ?? {},
    }),
    [onWidgetAction, entry.runId, pendingWidgetActions],
  );

  return (
    <View
      style={{
        alignItems: 'flex-start',
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.xs,
        gap: theme.spacing.sm,
      }}
    >
      <Pressable
        onLongPress={() => onActions(entry)}
        style={{
          maxWidth: '92%',
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          borderBottomLeftRadius: theme.radii.sm,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          gap: theme.spacing.sm,
        }}
      >
        {model.toolCalls.length > 0 ? (
          <View style={{ gap: 2 }}>
            {model.toolCalls.map((c, i) => (
              <ToolCallLine key={`${c.toolName}-${i}`} call={c} />
            ))}
          </View>
        ) : null}

        {hasText ? <MarkdownText source={model.fullText} /> : null}

        {producing && !hasText ? (
          <Text
            style={{
              color: theme.colors.accent,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.bodySmall.fontSize,
            }}
          >
            weaving…
          </Text>
        ) : null}

        {model.status === 'failed' ? (
          <Text
            style={{
              color: theme.colors.danger,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.bodySmall.fontSize,
            }}
          >
            {model.lastError?.message ?? 'Run failed.'}
          </Text>
        ) : null}

        {model.status === 'cancelled' ? (
          <Text
            style={{
              color: theme.colors.textMuted,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.bodySmall.fontSize,
            }}
          >
            Stopped.
          </Text>
        ) : null}
      </Pressable>

      {widgets.length > 0 ? (
        <WidgetActionProvider value={actionValue}>
          <View style={{ width: '92%', gap: theme.spacing.sm }}>
            {widgets.map((w) => (
              <WidgetBlock key={w.id} view={w} />
            ))}
          </View>
        </WidgetActionProvider>
      ) : null}
    </View>
  );
}

export const MessageBubble = memo(function MessageBubble({
  entry,
  onEditUser,
  onAssistantActions,
  onWidgetAction,
  pendingWidgetActions,
}: MessageBubbleProps) {
  const handleEdit = useCallback(
    (e: UserEntry) => onEditUser(e),
    [onEditUser],
  );
  const handleActions = useCallback(
    (e: AssistantEntry) => onAssistantActions(e),
    [onAssistantActions],
  );

  if (entry.kind === 'user') return <UserBubble entry={entry} onEdit={handleEdit} />;
  return (
    <AssistantBubble
      entry={entry}
      onActions={handleActions}
      {...(onWidgetAction !== undefined ? { onWidgetAction } : {})}
      {...(pendingWidgetActions !== undefined ? { pendingWidgetActions } : {})}
    />
  );
});
