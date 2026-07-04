/**
 * widget-shell.tsx — themed UI atoms shared by every widget renderer.
 *
 * These keep each renderer tiny and guarantee a consistent, fully
 * token-driven look (so per-tenant theming flows through automatically — no
 * hard-coded colors or sizes anywhere in the widget surface). Nothing here
 * holds widget logic; that all lives in the pure `buildWidgetSpec`.
 */
import type { ReactNode } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import type { ActionSpec } from '../../../lib';

/** The card chrome every widget renders inside. Carries the a11y label. */
export function WidgetCard({ a11yLabel, children }: { a11yLabel: string; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={a11yLabel}
      style={{
        backgroundColor: theme.colors.surfaceElevated,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radii.lg,
        padding: theme.spacing.md,
        gap: theme.spacing.sm,
      }}
    >
      {children}
    </View>
  );
}

/** A widget heading (Fraunces title style). */
export function WidgetHeading({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <Text
      style={{
        color: theme.colors.text,
        fontFamily: theme.typography.families.display,
        fontSize: theme.typography.scale.headline.fontSize,
        lineHeight: theme.typography.scale.headline.lineHeight,
      }}
    >
      {children}
    </Text>
  );
}

/** Body text inside a widget. */
export function WidgetText({
  children,
  muted,
  size = 'body',
}: {
  children: ReactNode;
  muted?: boolean;
  size?: 'body' | 'bodySmall' | 'caption' | 'label';
}) {
  const { theme } = useTheme();
  const style = theme.typography.scale[size];
  return (
    <Text
      style={{
        color: muted ? theme.colors.textMuted : theme.colors.textSecondary,
        fontFamily: theme.typography.families.body,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      }}
    >
      {children}
    </Text>
  );
}

/** Monospace text (code / numeric values). */
export function WidgetMono({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <Text
      style={{
        color: theme.colors.text,
        fontFamily: theme.typography.families.mono,
        fontSize: theme.typography.scale.mono.fontSize,
        lineHeight: theme.typography.scale.mono.lineHeight,
      }}
    >
      {children}
    </Text>
  );
}

/** A tappable action button styled by the spec's emphasis. */
export function WidgetButton({
  action,
  disabled,
  pending,
  onPress,
}: {
  action: ActionSpec;
  disabled?: boolean;
  pending?: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const bg =
    action.style === 'danger'
      ? theme.colors.danger
      : action.style === 'secondary'
        ? theme.colors.surface
        : theme.colors.accentStrong;
  const fg = action.style === 'secondary' ? theme.colors.text : theme.colors.onAccent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!pending }}
      disabled={disabled || pending}
      onPress={onPress}
      style={{
        backgroundColor: bg,
        borderRadius: theme.radii.sm,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        opacity: disabled ? 0.4 : pending ? 0.7 : 1,
        alignItems: 'center',
      }}
    >
      <Text
        style={{
          color: fg,
          fontFamily: theme.typography.families.body,
          fontSize: theme.typography.scale.label.fontSize,
          fontWeight: '600',
        }}
      >
        {pending ? `${action.label}…` : action.label}
      </Text>
    </Pressable>
  );
}

/** A row of action buttons. */
export function WidgetActions({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>{children}</View>
  );
}

/** An "Open on desktop" / external link line. */
export function WidgetLink({ href, label }: { href: string; label?: string }) {
  const { theme } = useTheme();
  return (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(href).catch(() => {})}>
      <Text
        style={{
          color: theme.colors.accent,
          fontFamily: theme.typography.families.body,
          fontSize: theme.typography.scale.bodySmall.fontSize,
          lineHeight: theme.typography.scale.bodySmall.lineHeight,
        }}
      >
        {label ?? 'Open on desktop'}
      </Text>
    </Pressable>
  );
}
