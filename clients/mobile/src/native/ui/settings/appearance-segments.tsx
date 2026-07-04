/**
 * appearance-segments.tsx — the System / Light / Dark selector (M8).
 *
 * Device-gated, presentational. Three pills bound to the local
 * {@link ThemePreference}; the active pill uses the one accent. Selection is
 * lifted to the Settings screen, which writes it through {@link useAppearance}.
 */
import { Pressable, Text, View } from 'react-native';
import type { ThemePreference } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon, type IconName } from '../icon';

interface Option {
  id: ThemePreference;
  label: string;
  icon: IconName;
}

const OPTIONS: readonly Option[] = [
  { id: 'system', label: 'System', icon: 'settings' },
  { id: 'light', label: 'Light', icon: 'appearance' },
  { id: 'dark', label: 'Dark', icon: 'quiet' },
];

export interface AppearanceSegmentsProps {
  active: ThemePreference;
  onChange: (pref: ThemePreference) => void;
}

export function AppearanceSegments({ active, onChange }: AppearanceSegmentsProps) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
      {OPTIONS.map((opt) => {
        const isActive = opt.id === active;
        return (
          <Pressable
            key={opt.id}
            onPress={() => onChange(opt.id)}
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
            <Icon name={opt.icon} size="sm" tone={isActive ? 'accent' : 'inactive'} />
            <Text
              style={{
                color: isActive ? theme.colors.accent : theme.colors.textSecondary,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.bodySmall.fontSize,
                fontWeight: isActive ? '600' : '400',
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
