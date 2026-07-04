/**
 * expo-haptics-adapter.ts — haptic feedback with reduced-motion awareness.
 *
 * Device-gated: imports expo-haptics and react-native's AccessibilityInfo.
 * Exposes a typed haptic API that the rest of the app calls without knowing
 * about expo-haptics internals. All calls are no-ops on platforms that don't
 * support haptics (web, some Android devices).
 *
 * Reduced-motion: when the user has enabled "Reduce Motion" in the OS
 * accessibility settings, all haptics are suppressed to avoid sensory overload.
 * The check is cached after the first query; AccessibilityInfo changes are not
 * subscribed (re-checking on each haptic call is fast enough and avoids leaking
 * a listener here).
 */
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo, Platform } from 'react-native';

let _reducedMotionCache: boolean | null = null;

async function isReducedMotion(): Promise<boolean> {
  if (_reducedMotionCache !== null) return _reducedMotionCache;
  try {
    _reducedMotionCache = await AccessibilityInfo.isReduceMotionEnabled();
    return _reducedMotionCache;
  } catch {
    _reducedMotionCache = false;
    return false;
  }
}

/** Invalidate the reduced-motion cache (e.g., after accessibility settings change). */
export function invalidateReducedMotionCache(): void {
  _reducedMotionCache = null;
}

type HapticFeedbackType = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error';

/** Fire haptic feedback of the given intensity, if supported and reduced-motion is off. */
export async function haptic(type: HapticFeedbackType = 'medium'): Promise<void> {
  if (Platform.OS === 'web') return;
  if (await isReducedMotion()) return;

  try {
    switch (type) {
      case 'light':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        break;
      case 'medium':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        break;
      case 'heavy':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        break;
      case 'selection':
        await Haptics.selectionAsync();
        break;
      case 'success':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'warning':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
      case 'error':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        break;
    }
  } catch {
    /* haptics are best-effort; never let a haptic failure bubble up */
  }
}
