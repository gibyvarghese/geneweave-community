/**
 * list.tsx — shared, themed list/settings primitives for the M8 screens.
 *
 * Device-gated. The Profile / Memory / Settings screens are grouped lists, so
 * these primitives give them a consistent look without each screen re-deriving
 * styling: a top-aligned scroll container, a header with an optional back
 * affordance, grouped sections (header + rounded card), tappable nav rows,
 * switch rows, and footnotes. Every icon goes through the central {@link Icon}
 * and every color comes from {@link useTheme}, so the whole surface re-skins
 * with a per-tenant theme.
 */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../providers/theme-provider';
import { Icon, type IconName } from './icon';

/** A top-aligned, padded scroll container (unlike the centered {@link Screen}). */
export function ListScreen({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.xl, paddingBottom: theme.spacing.xxxl }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A screen header: large title with an optional leading back button. */
export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const { theme } = useTheme();
  const s = theme.typography.scale.displayMedium;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back" style={{ marginLeft: -4 }}>
          <Icon name="back" size="lg" tone="active" />
        </Pressable>
      ) : null}
      <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.display, fontSize: s.fontSize, lineHeight: s.lineHeight }}>
        {title}
      </Text>
    </View>
  );
}

/** A titled group rendered as a rounded card. */
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      {title ? (
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.label.fontSize,
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            paddingHorizontal: theme.spacing.xs,
          }}
        >
          {title}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          borderWidth: 1,
          borderColor: theme.colors.surfaceElevated,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** A hairline divider between rows inside a {@link Section}. */
export function RowDivider() {
  const { theme } = useTheme();
  return <View style={{ height: 1, backgroundColor: theme.colors.surfaceElevated, marginLeft: theme.spacing.lg }} />;
}

interface RowBaseProps {
  icon?: IconName;
  iconTone?: 'inactive' | 'active' | 'muted' | 'accent' | 'attention' | 'danger';
  label: string;
  sublabel?: string;
  labelTone?: 'default' | 'danger' | 'accent';
}

/** A tappable navigation row (label + optional subtitle + chevron). */
export function NavRow({ icon, iconTone = 'inactive', label, sublabel, labelTone = 'default', onPress, trailingText }: RowBaseProps & { onPress: () => void; trailingText?: string }) {
  const { theme } = useTheme();
  const labelColor = labelTone === 'danger' ? theme.colors.danger : labelTone === 'accent' ? theme.colors.accent : theme.colors.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.md, paddingHorizontal: theme.spacing.lg }}
    >
      {icon ? <Icon name={icon} size="md" tone={iconTone} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: labelColor, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.body.fontSize }}>
          {label}
        </Text>
        {sublabel ? (
          <Text numberOfLines={1} style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      {trailingText ? (
        <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
          {trailingText}
        </Text>
      ) : null}
      <Icon name="chevron" size="sm" tone="muted" />
    </Pressable>
  );
}

/** A row with a trailing switch. */
export function SwitchRow({ icon, iconTone = 'inactive', label, sublabel, value, onValueChange, disabled = false }: RowBaseProps & { value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.md, paddingHorizontal: theme.spacing.lg, opacity: disabled ? 0.5 : 1 }}>
      {icon ? <Icon name={icon} size="md" tone={iconTone} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.body.fontSize }}>
          {label}
        </Text>
        {sublabel ? (
          <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: theme.colors.accent, false: theme.colors.surfaceElevated }}
        thumbColor={theme.colors.onAccent}
      />
    </View>
  );
}

/** A static info row (label + value, no affordance). */
export function InfoRow({ icon, label, value }: { icon?: IconName; label: string; value: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.md, paddingHorizontal: theme.spacing.lg }}>
      {icon ? <Icon name={icon} size="md" tone="inactive" /> : null}
      <Text style={{ flex: 1, color: theme.colors.text, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.body.fontSize }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ maxWidth: '55%', color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
        {value}
      </Text>
    </View>
  );
}

/** A small footnote under a section. */
export function SectionNote({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize, paddingHorizontal: theme.spacing.xs, lineHeight: 18 }}>
      {children}
    </Text>
  );
}
