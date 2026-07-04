/**
 * (tabs)/chats.tsx — the M6 Chats surface.
 *
 * Device-gated screen holding **no** list logic: it composes the
 * {@link useConversations} hook (debounced server search + optimistic mutations)
 * with the presentational {@link ConversationList} and {@link ConversationActionsSheet}.
 * Sectioning/filtering is computed by the pure brain in `src/lib`. Tapping a row
 * resumes the conversation on the Chat tab via a `conversationId` route param;
 * long-press opens pin / archive / rename actions.
 */
import { useCallback, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import type { Conversation } from '@weaveintel/api-client';
import { useTheme } from '../../src/native/providers/theme-provider';
import { useConversations } from '../../src/native/chat/use-conversations';
import { ConversationList } from '../../src/native/ui/conversations/conversation-list';
import { ConversationActionsSheet } from '../../src/native/ui/conversations/conversation-actions-sheet';
import type { ConversationChip } from '../../src/lib';

export default function ChatsScreen() {
  const { theme } = useTheme();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<ConversationChip>('all');
  const [actionTarget, setActionTarget] = useState<Conversation | null>(null);

  const { sections, isLoading, isRefetching, isError, refetch, setFlags } = useConversations({ query, chip });

  const handlePressRow = useCallback(
    (conversation: Conversation) => {
      // Switch to the Chat tab (the `(tabs)` index) carrying the conversation id.
      // `navigate` (not `push`) so we reuse the existing tab navigator instead of
      // stacking a second one on every row tap.
      router.navigate({ pathname: '/(tabs)', params: { conversationId: conversation.id } });
    },
    [router],
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ConversationList
        sections={sections}
        isLoading={isLoading}
        isRefetching={isRefetching}
        isError={isError}
        query={query}
        chip={chip}
        onQueryChange={setQuery}
        onChipChange={setChip}
        onRefresh={refetch}
        onPressRow={handlePressRow}
        onLongPressRow={setActionTarget}
      />
      <ConversationActionsSheet
        conversation={actionTarget}
        onClose={() => setActionTarget(null)}
        onApply={setFlags}
      />
    </SafeAreaView>
  );
}
