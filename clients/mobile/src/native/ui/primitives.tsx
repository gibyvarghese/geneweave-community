/**
 * primitives.tsx — a tiny set of themed building blocks for M3 screens.
 *
 * Device-gated (imports `react-native`). These wrap raw RN components with the
 * resolved theme from {@link useTheme} so individual screens stay declarative
 * and free of repeated styling. Intentionally minimal — richer components
 * (message bubbles, action cards) arrive with their feature milestones.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useTheme } from '../providers/theme-provider';

export function Screen({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, padding: theme.spacing.lg, gap: theme.spacing.md, justifyContent: 'center' }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const s = theme.typography.scale.displayMedium;
  return (
    <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.display, fontSize: s.fontSize, lineHeight: s.lineHeight }}>
      {children}
    </Text>
  );
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const { theme } = useTheme();
  const s = theme.typography.scale.body;
  return (
    <Text style={{ color: muted ? theme.colors.textSecondary : theme.colors.text, fontFamily: theme.typography.families.body, fontSize: s.fontSize, lineHeight: s.lineHeight }}>
      {children}
    </Text>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const s = theme.typography.scale.bodySmall;
  return (
    <Text style={{ color: theme.colors.danger, fontFamily: theme.typography.families.body, fontSize: s.fontSize, lineHeight: s.lineHeight }}>
      {children}
    </Text>
  );
}

export function Field(props: TextInputProps) {
  const { theme } = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.colors.textMuted}
      style={{
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.surfaceElevated,
        borderWidth: 1,
        borderRadius: theme.radii.md,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        fontFamily: theme.typography.families.body,
        fontSize: theme.typography.scale.body.fontSize,
      }}
      {...props}
    />
  );
}

export function PrimaryButton({ label, onPress, busy = false, disabled = false }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean }) {
  const { theme } = useTheme();
  const isDisabled = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={{
        backgroundColor: isDisabled ? theme.colors.surfaceElevated : theme.colors.accent,
        borderRadius: theme.radii.md,
        paddingVertical: theme.spacing.md,
        alignItems: 'center',
        opacity: isDisabled ? 0.7 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator color={theme.colors.onAccent} />
      ) : (
        <Text style={{ color: theme.colors.onAccent, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.headline.fontSize, fontWeight: '600' }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
