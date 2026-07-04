/**
 * memory-kind-tabs.tsx — the Your notes / Learned / Entities segmented control.
 *
 * Device-gated, presentational. Renders one pill per {@link MemoryKind} in the
 * canonical order with a count badge, mirroring the Actions segmented control.
 * Labels + icons come from the pure brain; the active pill uses the one accent.
 */
import { Pressable, Text, View } from 'react-native';
import { MEMORY_KIND_ORDER, memoryKindIcon, memoryKindLabel, type MemoryKind } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';

export interface MemoryKindTabsProps {
  active: MemoryKind;
  onChange: (kind: MemoryKind) => void;
  counts: Record<MemoryKind, number>;
}

export function MemoryKindTabs({ active, onChange, counts }: MemoryKindTabsProps) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
      {MEMORY_KIND_ORDER.map((kind) => {
        const isActive = kind === active;
        const count = counts[kind] ?? 0;
        return (
          <Pressable
            key={kind}
            onPress={() => onChange(kind)}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingVertical: theme.spacing.sm,
              borderRadius: theme.radii.pill,
              borderWidth: 1,
              borderColor: isActive ? theme.colors.accent : theme.colors.surfaceElevated,
              backgroundColor: isActive ? theme.colors.accentSoft : 'transparent',
            }}
          >
            <Icon name={memoryKindIcon(kind)} size="sm" tone={isActive ? 'accent' : 'inactive'} />
            <Text
              style={{
                color: isActive ? theme.colors.accent : theme.colors.textSecondary,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.bodySmall.fontSize,
                fontWeight: isActive ? '600' : '400',
              }}
            >
              {memoryKindLabel(kind)}
            </Text>
            {count > 0 ? (
              <Text
                style={{
                  color: isActive ? theme.colors.accent : theme.colors.textMuted,
                  fontFamily: theme.typography.families.body,
                  fontSize: theme.typography.scale.caption.fontSize,
                }}
              >
                {count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
