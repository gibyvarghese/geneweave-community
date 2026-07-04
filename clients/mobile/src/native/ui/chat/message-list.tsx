/**
 * message-list.tsx — the scrollable transcript.
 *
 * Device-gated. An **inverted** `FlatList` (RN built-in — no native FlashList
 * dependency) so new content appears at the bottom and the list stays pinned
 * there while streaming. Entries are reversed for the inverted axis. Each row is
 * a memoized {@link MessageBubble}, so a 2,000-token stream only re-renders the
 * single in-flight assistant bubble — keeping the list at 60fps.
 */
import { useCallback, useMemo } from 'react';
import { FlatList, type ListRenderItemInfo } from 'react-native';
import type { AssistantEntry, ChatEntry, UserEntry } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { MessageBubble, type WidgetActionHandler } from './message-bubble';

export interface MessageListProps {
  entries: ChatEntry[];
  onEditUser: (entry: UserEntry) => void;
  onAssistantActions: (entry: AssistantEntry) => void;
  /** Posts an interactive widget action for the run that owns the widget. */
  onWidgetAction?: WidgetActionHandler;
  /** Widget ids with an action in flight → the submitted action id. */
  pendingWidgetActions?: Record<string, string>;
}

export function MessageList({
  entries,
  onEditUser,
  onAssistantActions,
  onWidgetAction,
  pendingWidgetActions,
}: MessageListProps) {
  const { theme } = useTheme();
  // Inverted axis renders newest-first; reverse the chronological entries.
  const data = useMemo(() => [...entries].reverse(), [entries]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatEntry>) => (
      <MessageBubble
        entry={item}
        onEditUser={onEditUser}
        onAssistantActions={onAssistantActions}
        {...(onWidgetAction !== undefined ? { onWidgetAction } : {})}
        {...(pendingWidgetActions !== undefined ? { pendingWidgetActions } : {})}
      />
    ),
    [onEditUser, onAssistantActions, onWidgetAction, pendingWidgetActions],
  );

  return (
    <FlatList
      data={data}
      inverted
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingVertical: theme.spacing.md }}
      windowSize={11}
      removeClippedSubviews
    />
  );
}

function keyExtractor(entry: ChatEntry): string {
  return entry.id;
}
