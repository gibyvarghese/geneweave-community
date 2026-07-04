/**
 * recognizer-registry.ts — the single swappable slot for the speech engine.
 *
 * The default is the {@link createUnsupportedVoiceRecognizer} (safe in Expo Go).
 * A custom development build that has `expo-speech-recognition` installed wires
 * the real engine ONCE at the composition root:
 *
 *   import * as Speech from 'expo-speech-recognition';
 *   import { createSpeechRecognizerFromModule } from './expo-speech-recognizer';
 *   setVoiceRecognizer(createSpeechRecognizerFromModule(Speech as any));
 *
 * Everything else (the hook, the composer) reads the engine through
 * {@link resolveVoiceRecognizer} and never imports the native module, so the
 * default build keeps working everywhere.
 */
import { createUnsupportedVoiceRecognizer, type VoiceRecognizer } from './voice-recognizer';

let current: VoiceRecognizer = createUnsupportedVoiceRecognizer();

/** The active speech recognizer (unsupported by default). */
export function resolveVoiceRecognizer(): VoiceRecognizer {
  return current;
}

/** Swap in a real recognizer (called once in a dev build's composition root). */
export function setVoiceRecognizer(recognizer: VoiceRecognizer): void {
  current = recognizer;
}
