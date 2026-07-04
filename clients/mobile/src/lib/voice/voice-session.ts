/**
 * voice-session.ts — pure state machine for voice dictation into the composer (M8).
 *
 * Frameworks-free: no React, no react-native, no expo, no native module. Models
 * "press the mic, speak, watch a live transcript fill the composer, then edit
 * before sending". The native layer ({@link ../../native/voice}) owns the actual
 * `expo-speech-recognition` adapter and simply feeds recognition events
 * (granted / partial / final / error / end) into this reducer; everything about
 * how those events accumulate into the composer text is decided here and
 * unit-tested in Node.
 *
 * Edit-before-send: dictation APPENDS to whatever the user had already typed
 * (`baseText`). The composer renders {@link composedText} live while listening,
 * and on stop the partial hypothesis is committed so the user can keep editing
 * with the keyboard. Full-duplex / barge-in is intentionally out of scope.
 */

/**
 * Recognition lifecycle:
 *   idle        — not listening; the mic is a passive affordance.
 *   requesting  — permission / engine warm-up in flight.
 *   listening   — actively transcribing; partial + committed text accumulate.
 *   error       — a recoverable failure (permission denied, engine error).
 *   unsupported — the device/runtime has no speech engine (e.g. Expo Go without
 *                 a dev build); the mic is shown but disabled with a hint.
 */
export type VoiceStatus = 'idle' | 'requesting' | 'listening' | 'error' | 'unsupported';

export interface VoiceState {
  status: VoiceStatus;
  /** The composer text captured when dictation started; dictation appends to it. */
  baseText: string;
  /** Finalized recognition segments joined with spaces. */
  committed: string;
  /** The current in-progress hypothesis (replaced on every partial result). */
  partial: string;
  /** A user-facing message when `status === 'error' | 'unsupported'`. */
  message?: string;
}

/** Schema version of the voice state surface. */
export const VOICE_SESSION_SCHEMA_VERSION = 1 as const;

/** A fresh, idle voice state. */
export function emptyVoiceState(): VoiceState {
  return { status: 'idle', baseText: '', committed: '', partial: '' };
}

/** Join two text fragments with exactly one space, trimming redundant whitespace. */
function joinText(a: string, b: string): string {
  const left = a.replace(/\s+$/, '');
  const right = b.replace(/^\s+/, '');
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

/**
 * Begin a dictation session over the current composer text. Moves to
 * `requesting` (the adapter then resolves permission and emits `granted`).
 * Resets any prior transcript. No-op when already active or unsupported.
 */
export function startVoice(state: VoiceState, baseText: string): VoiceState {
  if (state.status === 'requesting' || state.status === 'listening' || state.status === 'unsupported') {
    return state;
  }
  return { status: 'requesting', baseText, committed: '', partial: '' };
}

/** Permission granted / engine ready → begin listening. */
export function voiceGranted(state: VoiceState): VoiceState {
  if (state.status !== 'requesting') return state;
  return { ...state, status: 'listening' };
}

/** A partial (interim) hypothesis replaces the current `partial` text. */
export function voicePartial(state: VoiceState, text: string): VoiceState {
  if (state.status !== 'listening') return state;
  return { ...state, partial: text };
}

/** A final segment is appended to `committed` and the partial is cleared. */
export function voiceFinal(state: VoiceState, text: string): VoiceState {
  if (state.status !== 'listening') return state;
  const committed = joinText(state.committed, text.trim());
  return { ...state, committed, partial: '' };
}

/**
 * Stop listening normally: fold any outstanding partial into the committed
 * transcript and return to `idle`. The accumulated text stays available via
 * {@link composedText} so the composer can keep it for editing.
 */
export function stopVoice(state: VoiceState): VoiceState {
  if (state.status !== 'listening' && state.status !== 'requesting') return state;
  const committed = state.partial ? joinText(state.committed, state.partial.trim()) : state.committed;
  return { ...state, status: 'idle', committed, partial: '' };
}

/** A recoverable failure (permission denied, engine error). */
export function failVoice(state: VoiceState, message: string): VoiceState {
  return { ...state, status: 'error', partial: '', message };
}

/** Mark the runtime as having no speech engine (disables the mic with a hint). */
export function markVoiceUnsupported(state: VoiceState, message: string): VoiceState {
  return { ...state, status: 'unsupported', partial: '', message };
}

/** Clear an error/unsupported state back to idle so the user can retry. */
export function resetVoice(state: VoiceState): VoiceState {
  if (state.status === 'unsupported') return state;
  return { ...emptyVoiceState(), baseText: state.baseText };
}

// ---------------------------------------------------------------------------
// Derived selectors
// ---------------------------------------------------------------------------

/** True while the engine is warming up or actively listening. */
export function isVoiceActive(state: VoiceState): boolean {
  return state.status === 'requesting' || state.status === 'listening';
}

/** The recognized transcript so far (committed + live partial). */
export function voiceTranscript(state: VoiceState): string {
  return joinText(state.committed, state.partial).trim();
}

/**
 * The text the composer should display: the user's original typed text with the
 * live transcript appended. This is what the user edits before sending.
 */
export function composedText(state: VoiceState): string {
  return joinText(state.baseText, voiceTranscript(state));
}
