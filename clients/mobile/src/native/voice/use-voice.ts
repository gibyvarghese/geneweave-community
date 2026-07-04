/**
 * use-voice.ts — React hook driving the pure dictation state machine (M8).
 *
 * Device-gated. Bridges the {@link VoiceRecognizer} port to the framework-free
 * state machine in `src/lib/voice`: it owns the {@link VoiceState}, maps engine
 * events onto the pure transitions, and pushes the live composed text up to the
 * composer via `onText` so the user can edit before sending. No transcript math
 * lives here — only the wiring. The default engine reports `unsupported` (Expo
 * Go), so the mic renders a friendly hint rather than failing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  composedText,
  emptyVoiceState,
  failVoice,
  isVoiceActive,
  markVoiceUnsupported,
  resetVoice,
  startVoice,
  stopVoice,
  voiceFinal,
  voiceGranted,
  voicePartial,
  voiceTranscript,
  type VoiceState,
  type VoiceStatus,
} from '../../lib';
import { VOICE_UNSUPPORTED_MESSAGE } from './voice-recognizer';
import { resolveVoiceRecognizer } from './recognizer-registry';

export interface UseVoiceOptions {
  /** Called with the live composed text (base + transcript) as dictation flows. */
  onText: (text: string) => void;
}

export interface UseVoiceResult {
  status: VoiceStatus;
  isActive: boolean;
  isSupported: boolean;
  message: string | null;
  /** Start dictation, appending to the current composer text. */
  start: (currentText: string) => void;
  /** Stop dictation (keeps the transcript for editing). */
  stop: () => void;
  /** Toggle start/stop based on the current state. */
  toggle: (currentText: string) => void;
  /** Clear an error back to idle. */
  reset: () => void;
}

export function useVoice({ onText }: UseVoiceOptions): UseVoiceResult {
  const recognizer = useMemo(() => resolveVoiceRecognizer(), []);
  const supported = recognizer.isSupported();
  // Start idle regardless of support so the mic stays quiet until tapped; the
  // unsupported hint surfaces only after the user actually tries to dictate.
  const [state, setState] = useState<VoiceState>(() => emptyVoiceState());

  // Keep the latest onText without re-subscribing engine handlers.
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  // Push composed text up whenever there is something to show (active or has transcript).
  useEffect(() => {
    if (isVoiceActive(state) || voiceTranscript(state).length > 0) {
      onTextRef.current(composedText(state));
    }
  }, [state]);

  const handlers = useMemo(
    () => ({
      onStart: () => setState((s) => voiceGranted(s)),
      onPartial: (text: string) => setState((s) => voicePartial(s, text)),
      onFinal: (text: string) => setState((s) => voiceFinal(s, text)),
      onError: (message: string) => setState((s) => failVoice(s, message)),
      onEnd: () => setState((s) => stopVoice(s)),
    }),
    [],
  );

  const start = useCallback(
    (currentText: string) => {
      if (!supported) {
        setState((s) => markVoiceUnsupported(s, VOICE_UNSUPPORTED_MESSAGE));
        return;
      }
      setState((s) => startVoice(s, currentText));
      void recognizer.start(handlers);
    },
    [supported, recognizer, handlers],
  );

  const stop = useCallback(() => {
    void recognizer.stop();
    setState((s) => stopVoice(s));
  }, [recognizer]);

  const toggle = useCallback(
    (currentText: string) => {
      if (isVoiceActive(state)) stop();
      else start(currentText);
    },
    [state, start, stop],
  );

  const reset = useCallback(() => setState((s) => resetVoice(s)), []);

  // Stop the engine if the component unmounts mid-session.
  useEffect(() => {
    return () => {
      void recognizer.stop();
    };
  }, [recognizer]);

  return {
    status: state.status,
    isActive: isVoiceActive(state),
    isSupported: supported,
    message: state.message ?? null,
    start,
    stop,
    toggle,
    reset,
  };
}
