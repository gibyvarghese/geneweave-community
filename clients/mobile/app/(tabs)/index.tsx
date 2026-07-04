/**
 * (tabs)/index.tsx — the M4 chat surface.
 *
 * Device-gated screen, but holds **no** chat logic: it composes the pure
 * controller (via {@link useChatSession}) with the themed chat components. It
 * wires:
 *   - empty state (Fraunces greeting + catalog starter prompts),
 *   - the inverted transcript (60fps streaming),
 *   - the composer's send↔Stop affordance (cancel < 500ms),
 *   - the options half-sheet (the four catalog kinds; selection flows into each
 *     run's metadata for per-tenant model/token resolution),
 *   - long-press edit-and-resend (user) and regenerate (assistant),
 *   - the "running in background" banner after the 20s detach window.
 */
import { useCallback, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useChatSession } from '../../src/native/chat/use-chat-session';
import { useTheme } from '../../src/native/providers/theme-provider';
import { Composer } from '../../src/native/ui/chat/composer';
import { EmptyState } from '../../src/native/ui/chat/empty-state';
import { MessageList } from '../../src/native/ui/chat/message-list';
import { OptionsSheet } from '../../src/native/ui/chat/options-sheet';
import type { AssistantEntry, UserEntry } from '../../src/lib';

export default function ChatScreen() {
  const { theme } = useTheme();
  // Optional `?conversationId=` set when resuming from the Chats tab. Binds the
  // session to that server-side chat (history hydration is a known M6 follow-up).
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const { state, session, catalog, selectedOptions, setOption } = useChatSession(
    params.conversationId ? { conversationId: params.conversationId } : {},
  );

  const [optionsOpen, setOptionsOpen] = useState(false);
  // When set, the composer's text is an edit of a prior user message; sending
  // supersedes the original instead of appending a fresh turn.
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  const handleSend = useCallback(() => {
    const text = state.composerText;
    if (editingUserId) {
      const id = editingUserId;
      setEditingUserId(null);
      session.setComposerText('');
      void session.editAndResend(id, text);
      return;
    }
    void session.send();
  }, [state.composerText, editingUserId, session]);

  const handleStarter = useCallback(
    (promptText: string) => {
      void session.send(promptText);
    },
    [session],
  );

  const handleEditUser = useCallback(
    (entry: UserEntry) => {
      if (state.phase !== 'idle') return;
      setEditingUserId(entry.id);
      session.setComposerText(entry.text);
    },
    [state.phase, session],
  );

  const handleAssistantActions = useCallback(
    (entry: AssistantEntry) => {
      Alert.alert('Message', undefined, [
        { text: 'Regenerate', onPress: () => void session.regenerate(entry.id) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [session],
  );

  const handleWidgetAction = useCallback(
    (runId: string, widgetId: string, actionId: string, value?: unknown) => {
      void session.submitWidgetAction(runId, widgetId, actionId, value);
    },
    [session],
  );

  const hasMessages = state.entries.length > 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['top']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {state.runningInBackground ? <BackgroundBanner /> : null}

        <View style={{ flex: 1 }}>
          {hasMessages ? (
            <MessageList
              entries={state.entries}
              onEditUser={handleEditUser}
              onAssistantActions={handleAssistantActions}
              onWidgetAction={handleWidgetAction}
              pendingWidgetActions={state.pendingWidgetActions}
            />
          ) : (
            <EmptyState starters={catalog?.starterPrompts ?? []} onPick={handleStarter} />
          )}
        </View>

        {state.error ? <ErrorBanner message={state.error} /> : null}
        {editingUserId ? (
          <EditingBanner
            onCancel={() => {
              setEditingUserId(null);
              session.setComposerText('');
            }}
          />
        ) : null}

        <Composer
          text={state.composerText}
          phase={state.phase}
          onChangeText={session.setComposerText}
          onSend={handleSend}
          onStop={() => void session.stop()}
          onOpenOptions={() => setOptionsOpen(true)}
        />
      </KeyboardAvoidingView>

      <OptionsSheet
        visible={optionsOpen}
        catalog={catalog}
        selected={selectedOptions}
        onSelect={setOption}
        onClose={() => setOptionsOpen(false)}
      />
    </SafeAreaView>
  );
}

function BackgroundBanner() {
  const { theme } = useTheme();
  return (
    <View style={{ backgroundColor: theme.colors.surface, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}>
      <Text style={{ color: theme.colors.textSecondary, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
        Still running in the background…
      </Text>
    </View>
  );
}

function ErrorBanner({ message }: { message: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ backgroundColor: theme.colors.surface, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}>
      <Text style={{ color: theme.colors.danger, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
        {message}
      </Text>
    </View>
  );
}

function EditingBanner({ onCancel }: { onCancel: () => void }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: theme.colors.surface,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
      }}
    >
      <Text style={{ color: theme.colors.textSecondary, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
        Editing message
      </Text>
      <Pressable onPress={onCancel}>
        <Text style={{ color: theme.colors.accent, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
          Cancel
        </Text>
      </Pressable>
    </View>
  );
}
