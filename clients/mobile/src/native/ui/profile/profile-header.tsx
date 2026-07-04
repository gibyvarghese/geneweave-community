/**
 * profile-header.tsx — the identity card atop the Profile tab (M8).
 *
 * Device-gated, presentational. Renders the avatar initials, display name,
 * persona label, and connected host from the derived {@link useProfile} fields.
 * Initials + labels are computed by the pure brain in `src/lib`; this component
 * only lays them out with theme tokens.
 */
import { Text, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';

export interface ProfileHeaderProps {
  name: string;
  initials: string;
  persona: string;
  host: string | null;
}

export function ProfileHeader({ name, initials, persona, host }: ProfileHeaderProps) {
  const { theme } = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.lg }}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: theme.radii.pill,
          backgroundColor: theme.colors.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            color: theme.colors.accentStrong,
            fontFamily: theme.typography.families.display,
            fontSize: theme.typography.scale.title.fontSize,
            fontWeight: '700',
          }}
        >
          {initials}
        </Text>
      </View>
      <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.display, fontSize: theme.typography.scale.headline.fontSize, fontWeight: '600' }}>
        {name}
      </Text>
      <View
        style={{
          paddingHorizontal: theme.spacing.md,
          paddingVertical: 4,
          borderRadius: theme.radii.pill,
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.surfaceElevated,
        }}
      >
        <Text style={{ color: theme.colors.textSecondary, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
          {persona}
        </Text>
      </View>
      {host ? (
        <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
          {host}
        </Text>
      ) : null}
    </View>
  );
}
