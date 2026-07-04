/**
 * biometric-gate.ts — pure decision logic for the optional biometric re-prompt.
 *
 * Decides *whether* a biometric unlock is required; performing the actual
 * prompt is the native adapter's job. The gate re-prompts on cold start and
 * after the app has been backgrounded for at least {@link BIOMETRIC_RELOCK_MS}.
 * No React / RN / expo imports — every input is a plain value.
 */

/** Re-lock threshold: how long backgrounded before a foreground re-prompts. */
export const BIOMETRIC_RELOCK_MS = 5 * 60 * 1000;

/** The inputs the gate reasons over. */
export interface BiometricGateState {
  /** User has opted the gate on. */
  enabled: boolean;
  /** Device actually has biometrics enrolled (else the gate is a no-op). */
  enrolled: boolean;
  /** Epoch ms of the last time the app moved to background, or `null`. */
  backgroundedAt: number | null;
}

/** The gate is only active when opted-in AND the device can satisfy it. */
export function isGateActive(state: Pick<BiometricGateState, 'enabled' | 'enrolled'>): boolean {
  return state.enabled && state.enrolled;
}

/**
 * On cold start, an active gate always requires an unlock — there is no trusted
 * recent unlock to carry over from a previous process.
 */
export function requiresUnlockOnColdStart(state: Pick<BiometricGateState, 'enabled' | 'enrolled'>): boolean {
  return isGateActive(state);
}

/**
 * On returning to the foreground, an active gate requires an unlock once the
 * backgrounded duration reaches {@link BIOMETRIC_RELOCK_MS}. A never-backgrounded
 * session (`backgroundedAt === null`) does not re-prompt.
 */
export function requiresUnlockOnForeground(
  state: BiometricGateState,
  now: number,
  relockMs: number = BIOMETRIC_RELOCK_MS,
): boolean {
  if (!isGateActive(state)) return false;
  if (state.backgroundedAt === null) return false;
  return now - state.backgroundedAt >= relockMs;
}
