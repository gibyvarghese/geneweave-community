/**
 * expo-biometric.ts — a {@link BiometricAuthenticator} over
 * `expo-local-authentication` (Face ID / Touch ID / Android biometrics).
 *
 * Device-gated: imports `expo-local-authentication`, so it lives in the native
 * view layer and is not loaded by the Node logic-layer tests. The pure gate
 * decisions (cold-start lock, re-lock window) live in `src/lib/auth/
 * biometric-gate.ts` and are fully unit-tested with a fake of this interface.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import type { BiometricAuthenticator } from '../../lib';

/**
 * Builds the native biometric authenticator. `isEnrolled` is true only when the
 * device has biometric hardware AND the user has enrolled at least one factor —
 * otherwise the gate stays inactive and the app never traps the user behind an
 * unusable prompt.
 */
export function createExpoBiometric(): BiometricAuthenticator {
  return {
    async isEnrolled(): Promise<boolean> {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      return hasHardware && isEnrolled;
    },
    async authenticate(reason: string): Promise<boolean> {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      return result.success;
    },
  };
}
