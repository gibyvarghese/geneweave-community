/**
 * provider-marks.tsx — official OAuth provider brand logos for sign-in buttons.
 *
 * Most chrome icons go through the monochrome {@link Icon} chokepoint, but some
 * provider logos are *brand assets* whose owners require an exact, unmodified
 * form. The Google "G" in particular must keep its official four colors and may
 * not be recolored, tinted, or rendered as an outline glyph — so it cannot pass
 * through the theme-tinted Icon path. This file is the single, documented
 * exception: it renders those locked brand marks from their official vector
 * artwork via `react-native-svg`.
 *
 *   • Google  — official 4-color "G" (developers.google.com/identity/branding-guidelines).
 *               Colors are fixed brand values, intentionally NOT theme tokens.
 *   • Others  — no special brand-color requirement here, so they reuse the
 *               monochrome {@link Icon} set and re-skin with the theme.
 *
 * Add a locked brand mark only when the provider's guidelines forbid recoloring;
 * everything else stays on the monochrome Icon chokepoint.
 */
import Svg, { Path } from 'react-native-svg';
import { Icon, type IconName } from './icon';
import type { OAuthProviderId } from '../../lib';

/** Monochrome fallbacks for providers without a locked brand-color requirement. */
const FALLBACK_ICON: Record<Exclude<OAuthProviderId, 'google'>, IconName> = {
  github: 'oauthGithub',
  microsoft: 'oauthMicrosoft',
  apple: 'oauthApple',
  facebook: 'oauthFacebook',
};

/**
 * The official Google "G" logo, rendered from Google's published brand artwork.
 * The four hex colors are fixed brand values and must not be themed.
 */
export function GoogleGMark({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityRole="image" aria-label="Google">
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

/**
 * Renders the correct logo for an OAuth provider's sign-in button: the official
 * Google "G" for Google, and the monochrome {@link Icon} glyph for the rest.
 */
export function ProviderMark({ provider, size = 20 }: { provider: OAuthProviderId; size?: number }) {
  if (provider === 'google') return <GoogleGMark size={size} />;
  return <Icon name={FALLBACK_ICON[provider]} tone="inactive" />;
}
