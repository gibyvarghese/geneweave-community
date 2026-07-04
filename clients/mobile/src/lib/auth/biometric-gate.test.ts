import { describe, it, expect } from 'vitest';
import {
  BIOMETRIC_RELOCK_MS,
  isGateActive,
  requiresUnlockOnColdStart,
  requiresUnlockOnForeground,
} from './biometric-gate.js';

describe('biometric gate', () => {
  it('is inactive unless both enabled and enrolled', () => {
    expect(isGateActive({ enabled: false, enrolled: true })).toBe(false);
    expect(isGateActive({ enabled: true, enrolled: false })).toBe(false);
    expect(isGateActive({ enabled: true, enrolled: true })).toBe(true);
  });

  it('always requires an unlock on cold start when active', () => {
    expect(requiresUnlockOnColdStart({ enabled: true, enrolled: true })).toBe(true);
    expect(requiresUnlockOnColdStart({ enabled: false, enrolled: true })).toBe(false);
  });

  it('does not re-prompt when never backgrounded', () => {
    const state = { enabled: true, enrolled: true, backgroundedAt: null };
    expect(requiresUnlockOnForeground(state, 1_000_000)).toBe(false);
  });

  it('re-prompts only after the relock window elapses', () => {
    const bg = 1_000_000;
    const state = { enabled: true, enrolled: true, backgroundedAt: bg };
    expect(requiresUnlockOnForeground(state, bg + BIOMETRIC_RELOCK_MS - 1)).toBe(false);
    expect(requiresUnlockOnForeground(state, bg + BIOMETRIC_RELOCK_MS)).toBe(true);
  });

  it('never re-prompts when the gate is inactive', () => {
    const state = { enabled: false, enrolled: true, backgroundedAt: 0 };
    expect(requiresUnlockOnForeground(state, 10 * BIOMETRIC_RELOCK_MS)).toBe(false);
  });
});
