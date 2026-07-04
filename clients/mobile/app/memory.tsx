/**
 * memory.tsx — what the assistant remembers (M8).
 *
 * Pushed as a root Stack screen over the tabs. Groups memory into Your notes /
 * Learned / Entities, lets the user add a note, rewrite a memory as a sentence
 * (lineage preserved server-side), delete a row, and clear everything behind a
 * typed double-confirm. Org-managed memory is read-only with a banner. All
 * grouping/provenance/validation lives in the pure brain; mutations + optimistic
 * state live in {@link useMemory}. This screen is a thin renderer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { goBack } from '../src/native/navigation/go-back';
import type { MemoryItem } from '@weaveintel/api-client';
import {
  CLEAR_ALL_CONFIRM_PHRASE,
  defaultMemoryKind,
  isClearAllConfirmed,
  memoriesForKind,
  memoryKindLabel,
  type MemoryKind,
} from '../src/lib';
import { useMemory } from '../src/native/memory/use-memory';
import { useTheme } from '../src/native/providers';
import { Icon } from '../src/native/ui/icon';
import { ListScreen, ScreenHeader, Section, RowDivider, SectionNote } from '../src/native/ui/list';
import { Field, PrimaryButton, ErrorText } from '../src/native/ui/primitives';
import { MemoryKindTabs } from '../src/native/ui/memory/memory-kind-tabs';
import { MemoryRow } from '../src/native/ui/memory/memory-row';
import { MemoryEditor } from '../src/native/ui/memory/memory-editor';

export default function MemoryScreen() {
  const { theme } = useTheme();
  const { groups, total, isLoading, isError, refetch, managedByOrg, error, addNote, correct, remove, clearAll } = useMemory();

  const [activeKind, setActiveKind] = useState<MemoryKind>('user-authored');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  // Once memory first loads, open on the first populated tab so an extracted
  // entity or learned insight is visible immediately — but never override a
  // tab the user has tapped themselves.
  const userPicked = useRef(false);
  useEffect(() => {
    if (isLoading || userPicked.current) return;
    setActiveKind(defaultMemoryKind(groups));
  }, [isLoading, groups]);

  function selectKind(kind: MemoryKind) {
    userPicked.current = true;
    setActiveKind(kind);
  }

  const counts: Record<MemoryKind, number> = useMemo(
    () => ({
      'user-authored': groups['user-authored'].length,
      semantic: groups.semantic.length,
      entity: groups.entity.length,
    }),
    [groups],
  );

  const rows = memoriesForKind(groups, activeKind);

  function openAdd() {
    setEditing(null);
    setEditorOpen(true);
  }
  function openEdit(item: MemoryItem) {
    setEditing(item);
    setEditorOpen(true);
  }
  function submitEditor(content: string) {
    if (editing) correct(editing.id, content);
    else addNote(content);
  }
  async function confirmClear() {
    if (!isClearAllConfirmed(confirmText)) return;
    try {
      await clearAll();
      setClearOpen(false);
      setConfirmText('');
    } catch {
      // onError in useMemory rolls back the optimistic update and sets the
      // error state shown as <ErrorText> on the screen. Just keep the dialog
      // open so the user knows the action did not succeed.
    }
  }

  return (
    <ListScreen>
      <ScreenHeader title="Memory" onBack={goBack} />

      {managedByOrg ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, backgroundColor: theme.colors.surface, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.surfaceElevated, padding: theme.spacing.md }}>
          <Icon name="locked" size="sm" tone="muted" />
          <Text style={{ flex: 1, color: theme.colors.textSecondary, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
            Some memory is managed by your organization and is read-only.
          </Text>
        </View>
      ) : null}

      <MemoryKindTabs active={activeKind} onChange={selectKind} counts={counts} />

      {error ? <ErrorText>{error}</ErrorText> : null}

      {isLoading ? (
        <ActivityIndicator color={theme.colors.accent} style={{ marginTop: theme.spacing.xl }} />
      ) : isError ? (
        <View style={{ alignItems: 'center', gap: theme.spacing.md, marginTop: theme.spacing.xl }}>
          <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body }}>Couldn’t load memory.</Text>
          <Pressable onPress={refetch} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="refresh" size="sm" tone="accent" />
            <Text style={{ color: theme.colors.accent, fontFamily: theme.typography.families.body }}>Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View style={{ alignItems: 'center', gap: theme.spacing.sm, marginTop: theme.spacing.xl, paddingHorizontal: theme.spacing.lg }}>
          <Icon name="empty" size="lg" tone="muted" />
          <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, textAlign: 'center' }}>
            {activeKind === 'user-authored' ? 'No notes yet. Add something you want remembered.' : `Nothing under ${memoryKindLabel(activeKind)} yet.`}
          </Text>
        </View>
      ) : (
        <Section>
          {rows.map((item, i) => (
            <View key={item.id}>
              {i > 0 ? <RowDivider /> : null}
              <MemoryRow item={item} onEdit={openEdit} onDelete={remove} />
            </View>
          ))}
        </Section>
      )}

      <PrimaryButton label="Add a note" onPress={openAdd} disabled={managedByOrg} />

      {total > 0 ? (
        <Pressable onPress={() => setClearOpen(true)} hitSlop={8} style={{ alignItems: 'center', paddingVertical: theme.spacing.sm }}>
          <Text style={{ color: theme.colors.danger, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
            Clear all memory
          </Text>
        </Pressable>
      ) : null}

      <SectionNote>The assistant uses these to personalize replies. You control what it keeps.</SectionNote>

      <MemoryEditor visible={editorOpen} item={editing} onSubmit={submitEditor} onClose={() => setEditorOpen(false)} />

      <Modal visible={clearOpen} animationType="fade" transparent onRequestClose={() => setClearOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'center', padding: theme.spacing.lg }} onPress={() => setClearOpen(false)}>
          <Pressable style={{ backgroundColor: theme.colors.background, borderRadius: theme.radii.xl, padding: theme.spacing.lg, gap: theme.spacing.md }}>
            <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.display, fontSize: theme.typography.scale.headline.fontSize, fontWeight: '600' }}>
              Clear all memory?
            </Text>
            <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
              This permanently removes every note, learned insight, and entity. Type {CLEAR_ALL_CONFIRM_PHRASE} to confirm.
            </Text>
            <Field value={confirmText} onChangeText={setConfirmText} placeholder={CLEAR_ALL_CONFIRM_PHRASE} autoCapitalize="characters" autoCorrect={false} />
            <Pressable
              onPress={confirmClear}
              disabled={!isClearAllConfirmed(confirmText)}
              style={{
                backgroundColor: isClearAllConfirmed(confirmText) ? theme.colors.danger : theme.colors.surfaceElevated,
                borderRadius: theme.radii.md,
                paddingVertical: theme.spacing.md,
                alignItems: 'center',
                opacity: isClearAllConfirmed(confirmText) ? 1 : 0.7,
              }}
            >
              <Text style={{ color: theme.colors.onAccent, fontFamily: theme.typography.families.body, fontWeight: '600' }}>Delete everything</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </ListScreen>
  );
}
