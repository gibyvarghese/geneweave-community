/**
 * conversation-actions-sheet.tsx — long-press action menu for a conversation (M6).
 *
 * Device-gated. A bottom-sheet modal exposing the mutations the server actually
 * supports via `PATCH /api/me/conversations/:id`: pin/unpin, archive, and
 * rename. There is no hard-delete endpoint, so "remove" is archive (the default
 * list hides archived). Rename swaps the row for an inline text field. Every
 * affordance uses the central {@link Icon}; colors come from {@link useTheme}.
 */
import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import type { Conversation } from '@weaveintel/api-client';
import type { ConversationFlagPatch } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon, type IconName, type IconTone } from '../icon';

const TITLE_MAX = 200;

export interface ConversationActionsSheetProps {
  /** The conversation the menu targets, or null when closed. */
  conversation: Conversation | null;
  onClose: () => void;
  onApply: (id: string, patch: ConversationFlagPatch) => void;
}

interface ActionDef {
  key: string;
  label: string;
  icon: IconName;
  tone: IconTone;
}

export function ConversationActionsSheet({ conversation, onClose, onApply }: ConversationActionsSheetProps) {
  const { theme } = useTheme();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  // Reset transient rename state whenever the target changes (open/close).
  useEffect(() => {
    setRenaming(false);
    setDraft(conversation?.title ?? '');
  }, [conversation]);

  const visible = conversation !== null;

  const actions: ActionDef[] = conversation
    ? [
        conversation.pinned
          ? { key: 'unpin', label: 'Unpin', icon: 'unpin', tone: 'inactive' }
          : { key: 'pin', label: 'Pin', icon: 'pin', tone: 'inactive' },
        { key: 'rename', label: 'Rename', icon: 'rename', tone: 'inactive' },
        { key: 'archive', label: 'Archive', icon: 'archive', tone: 'inactive' },
      ]
    : [];

  function handle(action: string) {
    if (!conversation) return;
    if (action === 'rename') {
      setRenaming(true);
      return;
    }
    if (action === 'pin') onApply(conversation.id, { pinned: true });
    else if (action === 'unpin') onApply(conversation.id, { pinned: false });
    else if (action === 'archive') onApply(conversation.id, { archived: true });
    onClose();
  }

  function commitRename() {
    if (!conversation) return;
    const trimmed = draft.trim().slice(0, TITLE_MAX);
    if (trimmed && trimmed !== conversation.title) {
      onApply(conversation.id, { title: trimmed });
    }
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#0008' }} onPress={onClose} />
      <View
        style={{
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: theme.radii.xl,
          borderTopRightRadius: theme.radii.xl,
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
      >
        <View
          style={{
            alignSelf: 'center',
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.surfaceElevated,
          }}
        />

        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.text,
            fontFamily: theme.typography.families.display,
            fontSize: theme.typography.scale.title.fontSize,
            fontWeight: '600',
          }}
        >
          {conversation?.title?.trim() || 'Untitled chat'}
        </Text>

        {renaming ? (
          <View style={{ gap: theme.spacing.md }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Conversation title"
              placeholderTextColor={theme.colors.textMuted}
              autoFocus
              maxLength={TITLE_MAX}
              onSubmitEditing={commitRename}
              returnKeyType="done"
              style={{
                color: theme.colors.text,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.body.fontSize,
                borderWidth: 1,
                borderColor: theme.colors.surfaceElevated,
                borderRadius: theme.radii.md,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
                backgroundColor: theme.colors.surface,
              }}
            />
            <Pressable
              onPress={commitRename}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.spacing.sm,
                borderRadius: theme.radii.md,
                paddingVertical: theme.spacing.md,
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
                Save
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ gap: 2 }}>
            {actions.map((a) => (
              <Pressable
                key={a.key}
                onPress={() => handle(a.key)}
                android_ripple={{ color: theme.colors.surfaceElevated }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  paddingVertical: theme.spacing.md,
                  paddingHorizontal: theme.spacing.sm,
                  borderRadius: theme.radii.md,
                  backgroundColor: pressed ? theme.colors.surface : 'transparent',
                })}
              >
                <Icon name={a.icon} size="md" tone={a.tone} />
                <Text
                  style={{
                    color: theme.colors.text,
                    fontFamily: theme.typography.families.body,
                    fontSize: theme.typography.scale.body.fontSize,
                  }}
                >
                  {a.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </Modal>
  );
}
