/**
 * memory-editor.tsx — the add / edit-as-sentence sheet for memory (M8).
 *
 * Device-gated. A modal sheet that captures a memory sentence for either a new
 * note (no `item`) or a correction (rewriting an existing row). Validation runs
 * through the pure {@link validateMemoryContent}; on success it lifts the
 * trimmed value to the screen, which owns the optimistic mutation. Purely a
 * controlled view — no network here.
 */
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, Text, View } from 'react-native';
import type { MemoryItem } from '@weaveintel/api-client';
import { MEMORY_CONTENT_MAX, validateMemoryContent } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Field, PrimaryButton, ErrorText } from '../primitives';

export interface MemoryEditorProps {
  visible: boolean;
  /** Present when editing/correcting; absent when adding a new note. */
  item?: MemoryItem | null;
  onSubmit: (content: string) => void;
  onClose: () => void;
}

export function MemoryEditor({ visible, item, onSubmit, onClose }: MemoryEditorProps) {
  const { theme } = useTheme();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setText(item?.content ?? '');
      setError(null);
    }
  }, [visible, item]);

  function submit() {
    const result = validateMemoryContent(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSubmit(result.value);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable
            style={{
              backgroundColor: theme.colors.background,
              borderTopLeftRadius: theme.radii.xl,
              borderTopRightRadius: theme.radii.xl,
              padding: theme.spacing.lg,
              gap: theme.spacing.md,
            }}
          >
            <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.display, fontSize: theme.typography.scale.headline.fontSize, fontWeight: '600' }}>
              {item ? 'Rewrite this memory' : 'Add a note'}
            </Text>
            <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
              {item ? 'Write it as a sentence — the assistant keeps the history.' : 'Tell the assistant something to remember about you.'}
            </Text>
            <Field
              value={text}
              onChangeText={(t) => {
                setText(t);
                if (error) setError(null);
              }}
              placeholder="e.g. I prefer concise answers."
              multiline
              maxLength={MEMORY_CONTENT_MAX}
              autoFocus
            />
            {error ? <ErrorText>{error}</ErrorText> : null}
            <PrimaryButton label={item ? 'Save' : 'Remember'} onPress={submit} />
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
