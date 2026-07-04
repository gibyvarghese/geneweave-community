/**
 * social-sign-in-buttons.tsx — OAuth provider buttons for the sign-in screen.
 *
 * Renders one round, logo-only button per *server-configured* provider, laid
 * out in a centered row under an "or" divider. Button styling is entirely
 * theme-token driven (no hardcoded hex), so it re-skins with any per-tenant
 * brand override. Provider logos go through {@link ProviderMark}: the official,
 * unmodified Google "G" for Google (brand rules forbid recoloring it) and the
 * monochrome {@link Icon} glyphs for the rest. The provider name is carried as
 * an accessibility label rather than visible text. All flow logic lives in the
 * `useOAuthSignIn` hook; this component is presentational.
 */
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { ProviderMark } from './provider-marks';
import { oauthProviderLabel, type OAuthProviderId } from '../../lib';

export interface SocialSignInButtonsProps {
  providers: OAuthProviderId[];
  onSelect: (provider: OAuthProviderId) => void;
  /** The provider whose flow is in-flight (shows a spinner), or null. */
  pending?: OAuthProviderId | null;
  /** Disable all buttons (e.g. while a password sign-in is running). */
  disabled?: boolean;
}

export function SocialSignInButtons({ providers, onSelect, pending = null, disabled = false }: SocialSignInButtonsProps) {
  const { theme } = useTheme();
  if (providers.length === 0) return null;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginVertical: theme.spacing.xs }}>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.surfaceElevated }} />
        <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
          or
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.surfaceElevated }} />
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: theme.spacing.md }}>
        {providers.map((provider) => {
          const busy = pending === provider;
          const isDisabled = disabled || pending !== null;
          return (
            <Pressable
              key={provider}
              onPress={() => onSelect(provider)}
              disabled={isDisabled}
              accessibilityRole="button"
              accessibilityLabel={oauthProviderLabel(provider)}
              style={{
                alignItems: 'center',
                justifyContent: 'center',
                width: 56,
                height: 56,
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.surfaceElevated,
                borderWidth: 1,
                borderRadius: 28,
                opacity: isDisabled && !busy ? 0.6 : 1,
              }}
            >
              {busy ? (
                <ActivityIndicator color={theme.colors.textSecondary} />
              ) : (
                <ProviderMark provider={provider} size={24} />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
