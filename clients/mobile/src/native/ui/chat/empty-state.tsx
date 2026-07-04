/**
 * empty-state.tsx — the zero-message chat home.
 *
 * Device-gated. A Fraunces greeting, a mode pill, and the catalog's starter
 * prompts as tappable chips. Tapping a starter sends it immediately. When the
 * catalog has no starters (or failed to load) it degrades to the greeting
 * alone — chat still works.
 */
import { ScrollView, Pressable, Text, View } from 'react-native';
import type { StarterPrompt } from '@weaveintel/api-client';
import { useTheme } from '../../providers/theme-provider';

export interface EmptyStateProps {
  starters: StarterPrompt[];
  onPick: (promptText: string) => void;
}

export function EmptyState({ starters, onPick }: EmptyStateProps) {
  const { theme } = useTheme();
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        padding: theme.spacing.xl,
        gap: theme.spacing.lg,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={{
          alignSelf: 'flex-start',
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.xs,
          borderRadius: theme.radii.pill,
          backgroundColor: theme.colors.surface,
        }}
      >
        <Text
          style={{
            color: theme.colors.accent,
            fontFamily: theme.typography.families.mono,
            fontSize: theme.typography.scale.caption.fontSize,
          }}
        >
          weaveIntel · mobile
        </Text>
      </View>

      <Text
        style={{
          color: theme.colors.text,
          fontFamily: theme.typography.families.display,
          fontSize: theme.typography.scale.displayMedium.fontSize,
          lineHeight: theme.typography.scale.displayMedium.lineHeight,
          fontWeight: '700',
        }}
      >
        What should we weave today?
      </Text>

      {starters.length > 0 ? (
        <View style={{ gap: theme.spacing.sm }}>
          {starters.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => onPick(s.promptText)}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.surfaceElevated,
                borderRadius: theme.radii.md,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.md,
                backgroundColor: theme.colors.surface,
              }}
            >
              <Text
                style={{
                  color: theme.colors.text,
                  fontFamily: theme.typography.families.body,
                  fontSize: theme.typography.scale.body.fontSize,
                }}
              >
                {s.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
