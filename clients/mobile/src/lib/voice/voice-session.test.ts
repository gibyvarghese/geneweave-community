/**
 * voice-session.test.ts — unit tests for the pure voice dictation state machine.
 */
import { describe, expect, it } from 'vitest';
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
} from './voice-session.js';

describe('lifecycle', () => {
  it('runs the happy path: start → granted → partial → final → stop', () => {
    let s = emptyVoiceState();
    expect(s.status).toBe('idle');

    s = startVoice(s, 'Remind me to');
    expect(s.status).toBe('requesting');
    expect(s.baseText).toBe('Remind me to');

    s = voiceGranted(s);
    expect(s.status).toBe('listening');
    expect(isVoiceActive(s)).toBe(true);

    s = voicePartial(s, 'call');
    expect(composedText(s)).toBe('Remind me to call');

    s = voiceFinal(s, 'call Dana');
    expect(s.committed).toBe('call Dana');
    expect(s.partial).toBe('');

    s = voicePartial(s, 'tomorrow');
    s = stopVoice(s);
    expect(s.status).toBe('idle');
    expect(composedText(s)).toBe('Remind me to call Dana tomorrow');
  });

  it('appends multiple final segments with single spaces', () => {
    let s = voiceGranted(startVoice(emptyVoiceState(), ''));
    s = voiceFinal(s, 'hello');
    s = voiceFinal(s, 'world');
    expect(voiceTranscript(s)).toBe('hello world');
  });
});

describe('guards', () => {
  it('ignores partial/final when not listening', () => {
    const s = startVoice(emptyVoiceState(), '');
    expect(voicePartial(s, 'x')).toBe(s);
    expect(voiceFinal(s, 'x')).toBe(s);
  });

  it('does not restart while already active or unsupported', () => {
    const active = voiceGranted(startVoice(emptyVoiceState(), 'a'));
    expect(startVoice(active, 'b')).toBe(active);
    const unsupported = markVoiceUnsupported(emptyVoiceState(), 'no engine');
    expect(startVoice(unsupported, 'b')).toBe(unsupported);
  });
});

describe('errors + unsupported', () => {
  it('captures a recoverable error and can reset to idle', () => {
    let s = voiceGranted(startVoice(emptyVoiceState(), 'keep'));
    s = failVoice(s, 'permission denied');
    expect(s.status).toBe('error');
    expect(s.message).toBe('permission denied');
    s = resetVoice(s);
    expect(s.status).toBe('idle');
    expect(s.baseText).toBe('keep');
  });

  it('stays unsupported through reset', () => {
    const s = markVoiceUnsupported(emptyVoiceState(), 'needs dev build');
    expect(resetVoice(s)).toBe(s);
  });
});
