/**
 * voice-recognizer.ts — the device-facing speech-recognition port (M8).
 *
 * The pure dictation state machine ({@link ../../lib/voice/voice-session}) is
 * driven by recognition events. This file defines the thin PORT those events
 * come through, plus a zero-dependency `unsupported` implementation that is the
 * DEFAULT wired by the composition root.
 *
 * Why a port (and an unsupported default): live speech recognition needs a
 * native engine (`expo-speech-recognition`) that is NOT available in Expo Go —
 * it requires a custom development build + config plugin. Rather than crash the
 * Expo Go bundle on import, the app ships the {@link createUnsupportedVoiceRecognizer}
 * by default (the mic shows a friendly "needs a dev build" hint), and the real
 * adapter in `expo-speech-recognizer.ts` is wired only in a dev build via
 * {@link ../voice/expo-speech-recognizer.createSpeechRecognizerFromModule}. This
 * keeps the logic fully testable and the default app build working everywhere.
 */

/** Events the recognizer emits back to the hook, mapped 1:1 onto the state machine. */
export interface VoiceRecognizerHandlers {
  /** Permission granted / engine ready — begin listening. */
  onStart(): void;
  /** An interim hypothesis (replaces the live partial). */
  onPartial(text: string): void;
  /** A finalized segment (appended to the transcript). */
  onFinal(text: string): void;
  /** A recoverable failure (permission denied, engine error). */
  onError(message: string): void;
  /** The engine stopped (end of speech / explicit stop). */
  onEnd(): void;
}

/** Options for a dictation session. */
export interface VoiceStartOptions {
  /** BCP-47 language tag, e.g. `en-US`. */
  lang?: string;
}

/** The speech-recognition port. */
export interface VoiceRecognizer {
  /** True when a usable speech engine is present (false in Expo Go). */
  isSupported(): boolean;
  /** Begin a recognition session, wiring the handlers. */
  start(handlers: VoiceRecognizerHandlers, options?: VoiceStartOptions): Promise<void>;
  /** Stop the current session (idempotent). */
  stop(): Promise<void>;
}

/** A friendly hint shown when no speech engine is available. */
export const VOICE_UNSUPPORTED_MESSAGE = 'Voice input needs a development build of the app.';

/**
 * The default recognizer: reports unsupported and never starts. Pure, no native
 * imports — safe in Expo Go and in the Node tests.
 */
export function createUnsupportedVoiceRecognizer(): VoiceRecognizer {
  return {
    isSupported: () => false,
    async start(handlers: VoiceRecognizerHandlers): Promise<void> {
      handlers.onError(VOICE_UNSUPPORTED_MESSAGE);
    },
    async stop(): Promise<void> {
      /* nothing to stop */
    },
  };
}
