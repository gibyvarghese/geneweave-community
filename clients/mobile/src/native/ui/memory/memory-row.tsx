/**
 * memory-row.tsx — a single memory item (M8).
 *
 * Device-gated, presentational over one {@link MemoryItem}. Shows the content,
 * a provenance subtitle, and — for org-managed rows — a lock glyph instead of
 * edit/delete affordances. Editable rows expose Edit (rewrite as a sentence)
 * and Delete. Provenance + lock state come from the pure brain; icons go
 * through the central {@link Icon} and colors from {@link useTheme}.
 */
import { Pressable, Text, View } from 'react-native';
import type { MemoryItem } from '@weaveintel/api-client';
import { memoryIsLocked, provenanceLabel } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';

export interface MemoryRowProps {
  item: MemoryItem;
  onEdit: (item: MemoryItem) => void;
  onDelete: (id: string) => void;
}

export function MemoryRow({ item, onEdit, onDelete }: MemoryRowProps) {
  const { theme } = useTheme();
  const locked = memoryIsLocked(item);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.body.fontSize, lineHeight: theme.typography.scale.body.lineHeight }}>
          {item.content}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {locked ? <Icon name="locked" size="sm" tone="muted" /> : null}
          <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
            {locked ? 'Managed by your organization' : provenanceLabel(item)}
          </Text>
        </View>
      </View>

      {locked ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Pressable onPress={() => onEdit(item)} hitSlop={8} accessibilityLabel="Edit memory" style={{ padding: 2 }}>
            <Icon name="rename" size="sm" tone="muted" />
          </Pressable>
          <Pressable onPress={() => onDelete(item.id)} hitSlop={8} accessibilityLabel="Delete memory" style={{ padding: 2 }}>
            <Icon name="delete" size="sm" tone="muted" />
          </Pressable>
        </View>
      )}
    </View>
  );
}
