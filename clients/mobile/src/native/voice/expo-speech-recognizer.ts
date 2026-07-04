/**
 * expo-speech-recognizer.ts — the real {@link VoiceRecognizer} over
 * `expo-speech-recognition`, wired only in a custom development build.
 *
 * This module does NOT import `expo-speech-recognition` directly: that package
 * requires a native module that is absent in Expo Go and would break the bundle
 * on import. Instead it accepts the module STRUCTURALLY via
 * {@link createSpeechRecognizerFromModule}, so the file type-checks and bundles
 * everywhere even when the package is not installed. In a dev build the app does:
 *
 *   import * as Speech from 'expo-speech-recognition';
 *   const recognizer = createSpeechRecognizerFromModule(Speech as unknown as ExpoSpeechModule);
 *
 * and passes `recognizer` into the composition root in place of the default
 * unsupported one. All transcript accumulation stays in the pure state machine.
 */
import type { VoiceRecognizer, VoiceRecognizerHandlers, VoiceStartOptions } from './voice-recognizer';

/** A subscription returned by `addListener`. */
interface Subscription {
  remove(): void;
}

/** The minimal structural surface of `expo-speech-recognition` we depend on. */
export interface ExpoSpeechModule {
  ExpoSpeechRecognitionModule: {
    requestPermissionsAsync(): Promise<{ granted: boolean }>;
    start(options: { lang?: string; interimResults?: boolean; continuous?: boolean }): void;
    stop(): void;
  };
  /** Event subscriptions. `result` carries `{ results: [{ transcript }], isFinal }`. */
  addSpeechRecognitionListener(
    event: 'result' | 'error' | 'end' | 'start',
    listener: (payload: {
      results?: Array<{ transcript?: string }>;
      isFinal?: boolean;
      error?: string;
      message?: string;
    }) => void,
  ): Subscription;
}

/**
 * Build a recognizer over an already-imported `expo-speech-recognition` module.
 * Requests permission, starts the engine with interim results, and maps the
 * native events onto the handler port. Cleans up its listeners on stop.
 */
export function createSpeechRecognizerFromModule(mod: ExpoSpeechModule): VoiceRecognizer {
  let subscriptions: Subscription[] = [];

  function teardown(): void {
    for (const sub of subscriptions) sub.remove();
    subscriptions = [];
  }

  return {
    isSupported: () => true,

    async start(handlers: VoiceRecognizerHandlers, options?: VoiceStartOptions): Promise<void> {
      const perm = await mod.ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        handlers.onError('Microphone permission denied.');
        return;
      }

      teardown();
      subscriptions.push(
        mod.addSpeechRecognitionListener('start', () => handlers.onStart()),
        mod.addSpeechRecognitionListener('result', (e) => {
          const transcript = e.results?.[0]?.transcript ?? '';
          if (!transcript) return;
          if (e.isFinal) handlers.onFinal(transcript);
          else handlers.onPartial(transcript);
        }),
        mod.addSpeechRecognitionListener('error', (e) => {
          handlers.onError(e.error ?? e.message ?? 'Speech recognition failed.');
        }),
        mod.addSpeechRecognitionListener('end', () => {
          handlers.onEnd();
          teardown();
        }),
      );

      mod.ExpoSpeechRecognitionModule.start({
        lang: options?.lang ?? 'en-US',
        interimResults: true,
        continuous: false,
      });
    },

    async stop(): Promise<void> {
      try {
        mod.ExpoSpeechRecognitionModule.stop();
      } finally {
        teardown();
      }
    },
  };
}
