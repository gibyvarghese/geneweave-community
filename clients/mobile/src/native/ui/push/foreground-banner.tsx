/**
 * foreground-banner.tsx — in-app notification banner shown when a push arrives
 * while the app is foregrounded.
 *
 * We suppress the OS alert (via the setNotificationHandler in the adapter) and
 * render this themed banner at the top of the screen instead. It auto-dismisses
 * after 4 seconds and can be dismissed by tap or swipe-up. On tap it navigates
 * to the deep-link target embedded in the notification payload.
 *
 * Design: matches the app's surface/elevated palette — not a floating overlay
 * (we avoid the native UIAlertView feel) but a slide-in panel from the top that
 * respects safe area insets.
 */
import { useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '../../providers/theme-provider';
import { parseDeepLink, intentToRoute } from '../../../lib';

const AUTO_DISMISS_MS = 4000;
const SLIDE_DURATION_MS = 220;

export interface ForegroundBannerPayload {
  title?: string;
  body?: string;
  /** Deep-link URL in the notification payload, e.g. `geneweave://task/abc`. */
  deepLink?: string;
}

interface ForegroundBannerProps {
  payload: ForegroundBannerPayload | null;
  onDismiss: () => void;
}

export function ForegroundBanner({ payload, onDismiss }: ForegroundBannerProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const translateY = useRef(new Animated.Value(-120)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visible = payload !== null;

  useEffect(() => {
    if (visible) {
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 14,
      }).start();

      dismissTimer.current = setTimeout(() => {
        slideOut();
      }, AUTO_DISMISS_MS);
    } else {
      Animated.timing(translateY, {
        toValue: -120,
        duration: SLIDE_DURATION_MS,
        useNativeDriver: true,
      }).start();
    }

    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function slideOut() {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    Animated.timing(translateY, {
      toValue: -120,
      duration: SLIDE_DURATION_MS,
      useNativeDriver: true,
    }).start(() => onDismiss());
  }

  function handleTap() {
    if (payload?.deepLink) {
      const intent = parseDeepLink(payload.deepLink);
      const target = intentToRoute(intent);
      router.navigate({ pathname: target.pathname as never, params: target.params });
    }
    slideOut();
  }

  if (!visible) return null;

  const bannerStyle: ViewStyle = {
    position: 'absolute',
    top: insets.top,
    left: 12,
    right: 12,
    zIndex: 1000,
  };

  return (
    <Animated.View style={[bannerStyle, { transform: [{ translateY }] }]}>
      <Pressable
        onPress={handleTap}
        style={{
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.md,
          flexDirection: 'column',
          gap: theme.spacing.xxs,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
          elevation: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        {payload?.title ? (
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.text,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.label.fontSize,
              fontWeight: '600',
            }}
          >
            {payload.title}
          </Text>
        ) : null}
        {payload?.body ? (
          <Text
            numberOfLines={2}
            style={{
              color: theme.colors.textSecondary,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.body.fontSize,
            }}
          >
            {payload.body}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
