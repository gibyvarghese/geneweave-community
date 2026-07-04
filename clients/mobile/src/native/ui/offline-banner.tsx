/**
 * offline-banner.tsx — persistent banner shown when the device is offline.
 *
 * Slides in from the bottom of the safe area when `isOnline` is false. Shows
 * the number of queued runs when > 0, and a "Retry" button that flushes the
 * outbox (disabled while offline — the flush will succeed once connectivity
 * returns automatically, but letting the user retry is a clear affordance).
 *
 * Interactive widgets are disabled while offline (enforced via the OfflineContext
 * value read by each widget component). The banner signals this to the user.
 */
import { useEffect, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../providers/theme-provider';
import { useOffline } from '../providers/offline-provider';

const SLIDE_DURATION_MS = 240;

export function OfflineBanner() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { isOnline, queuedCount, flush } = useOffline();
  const translateY = useRef(new Animated.Value(80)).current;

  useEffect(() => {
    Animated.timing(translateY, {
      toValue: isOnline ? 80 : 0,
      duration: SLIDE_DURATION_MS,
      useNativeDriver: true,
    }).start();
  }, [isOnline, translateY]);

  const message = queuedCount > 0
    ? `Offline · ${queuedCount} message${queuedCount === 1 ? '' : 's'} queued`
    : 'No internet connection';

  return (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: insets.bottom,
        left: 0,
        right: 0,
        transform: [{ translateY }],
        zIndex: 900,
      }}
    >
      <View
        style={{
          backgroundColor: theme.colors.surfaceElevated,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
        }}
      >
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.bodySmall.fontSize,
            flex: 1,
          }}
        >
          {message}
        </Text>
        {queuedCount > 0 && (
          <Pressable
            onPress={() => void flush()}
            style={{
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xxs,
              borderRadius: theme.radii.sm,
              backgroundColor: theme.colors.accent,
              marginLeft: theme.spacing.sm,
            }}
          >
            <Text
              style={{
                color: '#fff',
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.label.fontSize,
                fontWeight: '600',
              }}
            >
              Retry
            </Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}
