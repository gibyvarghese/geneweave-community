// Natural voice conversation — two pipeline modes:
//
// CHAINED (default): Whisper STT → ChatEngine LLM → tts-1 TTS
//   State machine: INACTIVE → LISTENING → RECORDING → PROCESSING → PLAYING → LISTENING
//   Audio captured via MediaRecorder, sent as one REST turn per utterance.
//
// REALTIME: OpenAI Realtime API (native speech-to-speech)
//   Proxied via /api/voice/sessions/:id/realtime WebSocket.
//   Server VAD handles turn detection; audio streamed as PCM16 chunks.
//   State machine: INACTIVE → LISTENING (streaming) → PLAYING → LISTENING
//
// Common to both modes:
//   • Microphone stream stays open for the whole session.
//   • Waveform bars mutated directly in DOM every rAF — no re-render.
//   • Status/transcript patches go through updateVoiceBar() — no re-render.
//   • rerender() called only at session start/end.

import { state } from './state.js';

// ── Thresholds (chained mode VAD) ───────────────────────────
const SPEECH_THRESHOLD    = 0.015;
const BARGE_IN_THRESHOLD  = 0.020;
const SPEECH_ONSET_MS     = 150;
const BARGE_IN_ONSET_MS   = 200;
const SILENCE_DURATION_MS = 1000;
const MIN_UTTERANCE_MS    = 300;
const WAVEFORM_BARS       = 24;
const REALTIME_SAMPLE_RATE = 24000;  // OpenAI Realtime requires 24kHz PCM16

// ── Audio pipeline ──────────────────────────────────────────
let micStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let tdData: Float32Array | null = null;
let freqData: Uint8Array | null = null;
let vadRafId: number | null = null;

// ── Chained mode: MediaRecorder ─────────────────────────────
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recMimeType = '';

// ── Chained mode: playback ───────────────────────────────────
let playbackSrc: AudioBufferSourceNode | null = null;

// ── Realtime mode: WebSocket + PCM worklet ───────────────────
let realtimeWs: WebSocket | null = null;
let pcmWorkletNode: AudioWorkletNode | null = null;
let pcmWorkletSource: MediaStreamAudioSourceNode | null = null;
let pcmWorkletLoaded = false;   // AudioWorklet processors register once per AudioContext
let pcmPlayer: Pcm16Player | null = null;
// item_id of the assistant audio currently being played (set from server audio messages)
let realtimeCurrentItemId: string | null = null;

// ── VAD state (chained mode) ─────────────────────────────────
let aboveThreshold = false;
let speechOnsetMs  = 0;
let silenceOnsetMs = 0;
let utteranceStartMs = 0;

// ── Loop / session control ───────────────────────────────────
let loopActive = false;
let pipelineMode: 'chained' | 'realtime' = 'chained';

// ── Status labels ────────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  idle:       'Ready',
  listening:  'Listening...',
  recording:  'Hearing you...',
  processing: 'Thinking...',
  playing:    'Agent speaking...',
  paused:     'Paused',
};

// ─── DOM helpers ─────────────────────────────────────────────

function rerender() { (globalThis as any).render?.(); }

function updateVoiceBar(): void {
  const st    = state.voiceStatus;
  const dot   = document.getElementById('va-dot');
  const label = document.getElementById('va-label');
  const wv    = document.getElementById('va-waveform');
  const pb    = document.getElementById('va-pause-btn');
  const exch  = document.getElementById('va-exchange');
  const youEl = document.getElementById('va-you');
  const youTx = document.getElementById('va-you-text');
  const agEl  = document.getElementById('va-agent');
  const agTx  = document.getElementById('va-agent-text');
  const errEl = document.getElementById('va-error');

  if (dot)   dot.className   = 'voice-status-indicator voice-status-' + st;
  if (label) label.textContent = STATUS_LABELS[st] ?? 'Ready';
  if (wv)    wv.className    = 'va-waveform' + (st === 'paused' ? ' paused' : '');

  if (pb) {
    const paused = st === 'paused';
    pb.innerHTML = paused ? '&#9654; Resume' : '&#9646;&#9646; Pause';
    pb.className = 'voice-pause-btn' + (paused ? ' resume' : '');
    pb.title     = paused ? 'Resume conversation' : 'Pause conversation';
  }

  const hasYou = !!state.voiceLastTranscript;
  const hasAg  = !!state.voiceLastResponse;
  if (youTx)  youTx.textContent  = state.voiceLastTranscript;
  if (agTx)   agTx.textContent   = state.voiceLastResponse;
  if (youEl)  youEl.style.display  = hasYou ? '' : 'none';
  if (agEl)   agEl.style.display   = hasAg  ? '' : 'none';
  if (exch)   exch.style.display   = (hasYou || hasAg) ? '' : 'none';
  if (errEl) {
    errEl.textContent   = state.voiceError;
    errEl.style.display = state.voiceError ? '' : 'none';
  }
}

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function csrf(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
  return h;
}

function setStatus(s: typeof state.voiceStatus) {
  state.voiceStatus = s;
  updateVoiceBar();
}

// ─── Public API ───────────────────────────────────────────────

export async function initVoiceSession(chatId?: string): Promise<boolean> {
  if (state.voiceAgentActive) return true;
  setStatus('processing');
  state.voiceError = '';

  try {
    // Load voice config to determine pipeline mode
    const cfgR = await fetch('/api/voice/config', { credentials: 'include' });
    if (cfgR.ok) {
      const cfgData = await cfgR.json();
      const cfg = (cfgData as any).config;
      state.voiceConfig = cfg ?? null;
      pipelineMode = cfg?.pipelineMode ?? 'chained';
    }

    const r = await fetch('/api/voice/sessions', {
      method: 'POST',
      headers: csrf(),
      credentials: 'include',
      body: JSON.stringify({ chatId: chatId ?? state.currentChatId ?? undefined }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      state.voiceError = (body as any).error ?? `Failed to start session (${r.status})`;
      setStatus('idle');
      return false;
    }
    const data = await r.json();
    state.voiceSessionId = data.sessionId;
    state.voiceLastTranscript = '';
    state.voiceLastResponse = '';
    state.voiceError = '';

    const ok = await openMic();
    if (!ok) { state.voiceSessionId = null; setStatus('idle'); return false; }

    state.voiceAgentActive = true;
    rerender();
    loopActive = true;

    if (pipelineMode === 'realtime') {
      startRealtimeSession();
    } else {
      enterListening();
    }
    return true;
  } catch {
    state.voiceError = 'Failed to connect to voice agent';
    setStatus('idle');
    return false;
  }
}

export async function endVoiceSession(): Promise<void> {
  loopActive = false;
  stopVAD();
  stopRecorder();
  stopPlayback();
  stopRealtimeSession();
  closeMic();

  const sessionId = state.voiceSessionId;
  state.voiceSessionId = null;
  state.voiceAgentActive = false;
  state.voiceRecording = false;
  state.voiceLastTranscript = '';
  state.voiceLastResponse = '';
  state.voiceError = '';
  state.voiceStatus = 'idle';
  state.voiceSettingsOpen = false;
  rerender();

  if (sessionId) {
    const h: Record<string, string> = {};
    if (state.csrfToken) h['X-CSRF-Token'] = state.csrfToken;
    await fetch(`/api/voice/sessions/${sessionId}`, {
      method: 'DELETE', headers: h, credentials: 'include',
    }).catch(() => {});
  }
}

export function togglePause(): void {
  if (!state.voiceAgentActive) return;
  if (state.voiceStatus === 'paused') {
    loopActive = true;
    if (pipelineMode === 'realtime') {
      startRealtimeSession();
    } else {
      enterListening();
    }
  } else {
    loopActive = false;
    stopVAD();
    stopRecorder();
    stopPlayback();
    stopPcmStreaming();
    state.voiceRecording = false;
    setStatus('paused');
  }
}

// ── Voice settings panel ─────────────────────────────────────

export function toggleVoiceSettings(): void {
  state.voiceSettingsOpen = !state.voiceSettingsOpen;
  const panel = document.getElementById('va-settings');
  if (panel) panel.style.display = state.voiceSettingsOpen ? '' : 'none';
  if (state.voiceSettingsOpen) {
    if (state.voiceConfig) {
      renderSettingsPanel(); // config already loaded — paint immediately
    } else {
      void loadVoiceConfig(); // will call renderSettingsPanel() once fetched
    }
  }
}

export async function loadVoiceConfig(): Promise<void> {
  try {
    const r = await fetch('/api/voice/config', { credentials: 'include' });
    if (!r.ok) return;
    const data = await r.json();
    state.voiceConfig = (data as any).config ?? null;
    renderSettingsPanel();  // update the gear panel if open
    rerender();             // update the AI settings dropdown if open
  } catch { /* ignore */ }
}

export async function saveVoiceConfig(patch: Record<string, unknown>): Promise<void> {
  try {
    const h = csrf();
    const r = await fetch('/api/voice/config', {
      method: 'POST',
      headers: h,
      credentials: 'include',
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[voice] saveVoiceConfig failed', r.status, body);
      return;
    }
    const data = await r.json();
    state.voiceConfig = (data as any).config ?? null;
    pipelineMode = state.voiceConfig?.pipelineMode ?? 'chained';
    renderSettingsPanel();
  } catch (err) {
    console.error('[voice] saveVoiceConfig error', err);
  }
}

function renderSettingsPanel(): void {
  const panel = document.getElementById('va-settings');
  if (!panel || !state.voiceSettingsOpen) return;
  const cfg = state.voiceConfig;
  if (!cfg) { panel.innerHTML = '<span style="font-size:11px;color:var(--fg3)">Loading…</span>'; return; }

  const mode = cfg.pipelineMode ?? 'chained';
  const voices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const realtimeModels = ['gpt-realtime-2', 'gpt-4o-mini-realtime-preview'];

  panel.innerHTML = '';

  // Pipeline mode toggle
  const modeRow = document.createElement('div');
  modeRow.className = 'vs-row';
  modeRow.innerHTML = '<span class="vs-label">Pipeline</span>';
  const modeToggle = document.createElement('div');
  modeToggle.className = 'vs-mode-toggle';
  (['chained', 'realtime'] as const).forEach((m) => {
    const btn = document.createElement('button');
    btn.className = 'vs-mode-btn' + (mode === m ? ' active' : '');
    btn.textContent = m === 'chained' ? 'Chained (Whisper+TTS)' : 'Realtime (GPT-4o)';
    btn.title = m === 'chained'
      ? 'Whisper STT → LLM → tts-1 TTS — full control, guardrails, cost tracking'
      : 'OpenAI Realtime API — native speech-to-speech, lowest latency';
    btn.onclick = () => { void saveVoiceConfig({ pipelineMode: m }); };
    modeToggle.appendChild(btn);
  });
  modeRow.appendChild(modeToggle);
  panel.appendChild(modeRow);

  if (mode === 'chained') {
    // TTS voice
    panel.appendChild(makeSelectRow('Voice', 'ttsVoice', cfg.ttsVoice, voices, (v) => saveVoiceConfig({ ttsVoice: v })));
    // TTS model
    panel.appendChild(makeSelectRow('TTS model', 'ttsModel', cfg.ttsModel, ['tts-1', 'tts-1-hd'], (v) => saveVoiceConfig({ ttsModel: v })));
    // Speed
    panel.appendChild(makeSpeedRow(cfg.ttsSpeed));
    // STT language
    panel.appendChild(makeSelectRow('Language', 'sttLanguage', cfg.sttLanguage ?? 'auto',
      ['auto', 'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'zh', 'ko', 'ar', 'hi'],
      (v) => saveVoiceConfig({ sttLanguage: v === 'auto' ? null : v })));
  } else {
    // Realtime model
    panel.appendChild(makeSelectRow('Model', 'realtimeModel', cfg.realtimeModel, realtimeModels, (v) => saveVoiceConfig({ realtimeModel: v })));
    // Voice (realtime uses same names)
    panel.appendChild(makeSelectRow('Voice', 'ttsVoice', cfg.ttsVoice, voices, (v) => saveVoiceConfig({ ttsVoice: v })));
    const note = document.createElement('div');
    note.className = 'vs-note';
    note.textContent = 'Server VAD handles turn detection. Audio is streamed as PCM16 at 24 kHz.';
    panel.appendChild(note);
  }

  if (state.voiceAgentActive) {
    const note = document.createElement('div');
    note.className = 'vs-note';
    note.textContent = 'Changes apply to the next session.';
    panel.appendChild(note);
  }
}

function makeSelectRow(
  label: string,
  _key: string,
  value: string,
  options: string[],
  onChange: (v: string) => Promise<void>,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'vs-row';
  const lbl = document.createElement('span');
  lbl.className = 'vs-label';
  lbl.textContent = label;
  const sel = document.createElement('select');
  sel.className = 'vs-select';
  options.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    opt.selected = o === value;
    sel.appendChild(opt);
  });
  sel.onchange = () => { void onChange(sel.value); };
  row.appendChild(lbl);
  row.appendChild(sel);
  return row;
}

function makeSpeedRow(speed: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'vs-row';
  const lbl = document.createElement('span');
  lbl.className = 'vs-label';
  lbl.textContent = 'Speed';
  const wrap = document.createElement('div');
  wrap.className = 'vs-speed-wrap';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0.25';
  range.max = '2.0';
  range.step = '0.25';
  range.value = String(speed);
  range.className = 'vs-speed-range';
  const val = document.createElement('span');
  val.className = 'vs-speed-val';
  val.textContent = speed.toFixed(2) + '×';
  range.oninput = () => { val.textContent = parseFloat(range.value).toFixed(2) + '×'; };
  range.onchange = () => { void saveVoiceConfig({ ttsSpeed: parseFloat(range.value) }); };
  wrap.appendChild(range);
  wrap.appendChild(val);
  row.appendChild(lbl);
  row.appendChild(wrap);
  return row;
}

// ─── Microphone ───────────────────────────────────────────────

async function openMic(): Promise<boolean> {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const ctx = getCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createMediaStreamSource(micStream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    src.connect(analyser);
    tdData   = new Float32Array(analyser.fftSize);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    return true;
  } catch {
    state.voiceError = 'Microphone access denied';
    return false;
  }
}

function closeMic(): void {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  analyser = null;
  tdData = null;
  freqData = null;
  // If the AudioContext is closed between sessions, the worklet must be re-registered
  if (audioCtx && audioCtx.state === 'closed') {
    audioCtx = null;
    pcmWorkletLoaded = false;
  }
}

// ─── CHAINED MODE ────────────────────────────────────────────

function enterListening(): void {
  aboveThreshold = false;
  speechOnsetMs  = 0;
  silenceOnsetMs = 0;
  state.voiceRecording = false;
  setStatus('listening');
  startVAD();
}

function startVAD(): void {
  stopVAD();
  const tick = () => {
    if (!analyser || !tdData || !freqData) return;
    analyser.getFloatTimeDomainData(tdData as Float32Array<ArrayBuffer>);
    let sq = 0;
    for (let i = 0; i < tdData.length; i++) { const s = tdData[i] ?? 0; sq += s * s; }
    const rms = Math.sqrt(sq / tdData.length);
    analyser.getByteFrequencyData(freqData as Uint8Array<ArrayBuffer>);
    paintWaveform(freqData);
    const now = performance.now();
    const st  = state.voiceStatus;

    if (st === 'listening') {
      if (rms > SPEECH_THRESHOLD) {
        if (!aboveThreshold) { aboveThreshold = true; speechOnsetMs = now; }
        else if (now - speechOnsetMs >= SPEECH_ONSET_MS) { beginCapture(); return; }
      } else { aboveThreshold = false; speechOnsetMs = 0; }
    } else if (st === 'recording') {
      if (rms > SPEECH_THRESHOLD) {
        silenceOnsetMs = 0;
      } else {
        if (!silenceOnsetMs) silenceOnsetMs = now;
        if (now - utteranceStartMs >= MIN_UTTERANCE_MS && now - silenceOnsetMs >= SILENCE_DURATION_MS) {
          void commitAndSend(); return;
        }
      }
    } else if (st === 'playing') {
      if (rms > BARGE_IN_THRESHOLD) {
        if (!aboveThreshold) { aboveThreshold = true; speechOnsetMs = now; }
        else if (now - speechOnsetMs >= BARGE_IN_ONSET_MS) { stopPlayback(); beginCapture(); return; }
      } else { aboveThreshold = false; speechOnsetMs = 0; }
    }
    vadRafId = requestAnimationFrame(tick);
  };
  vadRafId = requestAnimationFrame(tick);
}

function stopVAD(): void {
  if (vadRafId !== null) { cancelAnimationFrame(vadRafId); vadRafId = null; }
}

function beginCapture(): void {
  if (!micStream) return;
  const mime =
    MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
    MediaRecorder.isTypeSupported('audio/webm')             ? 'audio/webm'             :
    MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')  ? 'audio/ogg;codecs=opus'  :
    'audio/mp4';
  recMimeType = mime;
  chunks = [];
  recorder = new MediaRecorder(micStream, { mimeType: mime });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start(100);
  utteranceStartMs = performance.now();
  silenceOnsetMs   = 0;
  aboveThreshold   = true;
  speechOnsetMs    = utteranceStartMs;
  state.voiceRecording = true;
  setStatus('recording');
  startVAD();
}

function stopRecorder(): void {
  if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* no-op */ } }
  chunks = [];
  recorder = null;
}

async function commitAndSend(): Promise<void> {
  if (!recorder || recorder.state === 'inactive') return;
  return new Promise((resolve) => {
    recorder!.onstop = async () => {
      const mime = recMimeType;
      const blob = new Blob(chunks, { type: mime });
      chunks = [];
      recorder = null;
      state.voiceRecording = false;
      setStatus('processing');
      await sendTurn(blob, mime);
      resolve();
    };
    try { recorder!.stop(); } catch { resolve(); }
  });
}

async function sendTurn(blob: Blob, mime: string): Promise<void> {
  if (!state.voiceSessionId) { resumeLoop(); return; }
  let base64: string;
  try { base64 = await blobToBase64(blob); }
  catch { state.voiceError = 'Failed to encode audio'; updateVoiceBar(); resumeLoop(); return; }

  try {
    const r = await fetch(`/api/voice/sessions/${state.voiceSessionId}/turn`, {
      method: 'POST',
      headers: csrf(),
      credentials: 'include',
      body: JSON.stringify({ audio: base64, mimeType: mime }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      state.voiceError = (body as any).error ?? `Turn failed (${r.status})`;
      updateVoiceBar(); resumeLoop(); return;
    }
    const data = await r.json();
    state.voiceLastTranscript = data.transcript || '';
    state.voiceLastResponse   = data.responseText || '';
    state.voiceError = '';
    updateVoiceBar();

    if (data.responseAudio) {
      aboveThreshold = false; speechOnsetMs = 0;
      setStatus('playing');
      startVAD();
      await playAudio(data.responseAudio);
      stopVAD();
    }
    resumeLoop();
  } catch {
    state.voiceError = 'Voice turn failed';
    updateVoiceBar();
    resumeLoop();
  }
}

function resumeLoop(): void {
  if (loopActive && state.voiceAgentActive) enterListening();
  else if (state.voiceAgentActive) setStatus('idle');
}

function stopPlayback(): void {
  if (playbackSrc) { try { playbackSrc.stop(); } catch { /* no-op */ } playbackSrc = null; }
}

async function playAudio(base64: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
      getCtx().decodeAudioData(bytes.buffer as ArrayBuffer, (buf) => {
        const src = getCtx().createBufferSource();
        src.buffer = buf;
        src.connect(getCtx().destination);
        playbackSrc = src;
        src.onended = () => { playbackSrc = null; resolve(); };
        src.start(0);
      }, () => resolve());
    } catch { resolve(); }
  });
}

// ─── REALTIME MODE ────────────────────────────────────────────

function startRealtimeSession(): void {
  if (!state.voiceSessionId || !micStream) return;
  stopRealtimeSession();

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${wsProto}//${location.host}/api/voice/sessions/${state.voiceSessionId}/realtime`;
  realtimeWs = new WebSocket(url);

  pcmPlayer = new Pcm16Player(getCtx());

  realtimeWs.onopen = () => {
    setStatus('listening');
    void startPcmStreaming();
  };

  realtimeWs.onmessage = (ev) => {
    let msg: { type: string; [k: string]: unknown };
    try { msg = JSON.parse(ev.data as string) as typeof msg; }
    catch { return; }

    switch (msg.type) {
      case 'realtime_ready':
        setStatus('listening');
        break;
      case 'speech_started':
        setStatus('recording');
        break;
      case 'speech_stopped':
        setStatus('processing');
        break;
      case 'transcript':
        state.voiceLastTranscript = (msg['text'] as string) ?? '';
        updateVoiceBar();
        break;
      case 'llm_text':
        // Accumulate response text incrementally
        if (state.voiceStatus !== 'playing') setStatus('playing');
        state.voiceLastResponse = (state.voiceLastResponse ?? '') + ((msg['text'] as string) ?? '');
        updateVoiceBar();
        break;
      case 'audio': {
        // Track which item is currently playing (needed for barge-in)
        const incomingItemId = msg['itemId'] as string | undefined;
        if (incomingItemId) realtimeCurrentItemId = incomingItemId;

        if (msg['payload'] && !msg['done']) {
          pcmPlayer?.push(msg['payload'] as string);
          if (state.voiceStatus !== 'playing') setStatus('playing');
        }
        if (msg['done']) {
          realtimeCurrentItemId = null;
          pcmPlayer?.onDone(() => {
            if (loopActive && state.voiceAgentActive) setStatus('listening');
          });
        }
        break;
      }

      // ── Barge-in: server detected user speech while agent was speaking ──
      // The proxy sends this to tell us to stop audio NOW and report playedMs.
      case 'barge_in': {
        const serverItemId = (msg['itemId'] as string) ?? realtimeCurrentItemId ?? '';

        // Flush all queued audio immediately and capture how much was heard
        const playedMs = pcmPlayer?.flush() ?? 0;
        // Create a fresh player for the upcoming agent response
        pcmPlayer = new Pcm16Player(getCtx());
        realtimeCurrentItemId = null;

        // Clear partial response display
        state.voiceLastResponse = '';
        updateVoiceBar();

        // Report exact playback position back to the server so it can send
        // conversation.item.truncate with the right audio_end_ms value.
        if (realtimeWs?.readyState === WebSocket.OPEN) {
          realtimeWs.send(JSON.stringify({
            type: 'barge_in',
            itemId: serverItemId,
            audioPlayedMs: Math.round(playedMs),
          }));
        }

        setStatus('recording');
        break;
      }

      // Server confirmed it sent conversation.item.truncate to OpenAI.
      case 'barge_in_ack':
        // State already updated in the barge_in handler above.
        break;

      case 'turn_complete':
        state.voiceLastResponse = state.voiceLastResponse ?? '';
        updateVoiceBar();
        break;

      case 'error':
        state.voiceError = (msg['message'] as string) ?? 'Realtime error';
        updateVoiceBar();
        if (msg['fallbackToChained']) {
          pipelineMode = 'chained';
          stopRealtimeSession();
          enterListening();
        }
        break;

      case 'session_ended':
        if (state.voiceAgentActive) void endVoiceSession();
        break;
    }
  };

  realtimeWs.onclose = () => {
    stopPcmStreaming();
    pcmPlayer = null;
    if (loopActive && state.voiceAgentActive) {
      // Reconnect after brief pause
      setTimeout(() => { if (loopActive && state.voiceAgentActive) startRealtimeSession(); }, 1000);
    }
  };

  realtimeWs.onerror = () => {
    state.voiceError = 'Realtime connection error';
    updateVoiceBar();
  };

  // Also run VAD loop for waveform only (server handles turn detection)
  startWaveformLoop();
}

function stopRealtimeSession(): void {
  stopPcmStreaming();
  stopWaveformLoop();
  realtimeCurrentItemId = null;
  if (realtimeWs) {
    realtimeWs.onclose = null;
    try { realtimeWs.close(1000, 'session ended'); } catch { /* no-op */ }
    realtimeWs = null;
  }
  pcmPlayer?.flush();
  pcmPlayer = null;
}

// AudioWorklet processor source — loaded once per AudioContext via Blob URL.
// Runs in the audio render thread; posts Float32 channel data to the main thread.
const PCM_WORKLET_NAME = 'gw-pcm-capture';
const PCM_WORKLET_CODE = `
class GwPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor('${PCM_WORKLET_NAME}', GwPcmCaptureProcessor);
`;

async function startPcmStreaming(): Promise<void> {
  if (!micStream || !audioCtx) return;
  stopPcmStreaming();

  // Load the worklet module once per AudioContext instance
  if (!pcmWorkletLoaded) {
    const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    try {
      await audioCtx.audioWorklet.addModule(url);
      pcmWorkletLoaded = true;
    } catch (err) {
      console.error('[voice] AudioWorklet load failed:', err);
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  pcmWorkletNode   = new AudioWorkletNode(audioCtx, PCM_WORKLET_NAME);
  pcmWorkletSource = audioCtx.createMediaStreamSource(micStream);

  pcmWorkletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) return;
    const resampled = resampleFloat32(e.data, audioCtx!.sampleRate, REALTIME_SAMPLE_RATE);
    const pcm16     = float32ToPcm16(resampled);
    realtimeWs.send(JSON.stringify({ type: 'audio', payload: arrayBufferToBase64(pcm16) }));
  };

  // Connect source → worklet only; no connection to destination avoids mic feedback.
  pcmWorkletSource.connect(pcmWorkletNode);
}

function stopPcmStreaming(): void {
  if (pcmWorkletNode)   { try { pcmWorkletNode.disconnect();   } catch { /* ok */ } pcmWorkletNode   = null; }
  if (pcmWorkletSource) { try { pcmWorkletSource.disconnect(); } catch { /* ok */ } pcmWorkletSource = null; }
}

// Waveform-only VAD loop for realtime mode (no turn detection logic)
function startWaveformLoop(): void {
  stopVAD();
  const tick = () => {
    if (!analyser || !freqData) return;
    analyser.getByteFrequencyData(freqData as Uint8Array<ArrayBuffer>);
    paintWaveform(freqData);
    vadRafId = requestAnimationFrame(tick);
  };
  vadRafId = requestAnimationFrame(tick);
}

function stopWaveformLoop(): void { stopVAD(); }

// ─── PCM16 streaming audio player ────────────────────────────
//
// Plays back streamed PCM16/24kHz audio chunks via Web Audio API.
// Exposes flush() for immediate barge-in stoppage and getPlayedMs()
// so the proxy can send an accurate audio_end_ms to OpenAI.

class Pcm16Player {
  private ctx: AudioContext;
  private nextPlayTime = 0;
  private doneCallback: (() => void) | null = null;

  // All currently scheduled (or playing) sources — needed for flush()
  private activeSources: AudioBufferSourceNode[] = [];

  // Playback position tracking for barge-in accuracy
  private startWallMs: number | null = null;   // performance.now() of first push
  private totalScheduledMs = 0;                // sum of all chunk durations queued

  constructor(ctx: AudioContext) { this.ctx = ctx; }

  push(base64: string): void {
    try {
      const binary = atob(base64);
      const pcm16 = new Int16Array(binary.length / 2);
      for (let i = 0; i < pcm16.length; i++) {
        pcm16[i] = (binary.charCodeAt(i * 2) & 0xff) | ((binary.charCodeAt(i * 2 + 1) & 0xff) << 8);
      }
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = (pcm16[i] ?? 0) / 32768;

      const buffer = this.ctx.createBuffer(1, float32.length, REALTIME_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.ctx.destination);

      // Schedule: add 20ms lookahead to avoid under-runs; queue after previous chunk.
      const startAt = Math.max(this.ctx.currentTime + 0.02, this.nextPlayTime);
      src.start(startAt);
      this.nextPlayTime = startAt + buffer.duration;

      // Track wall-clock start for getPlayedMs()
      if (this.startWallMs === null) this.startWallMs = performance.now();
      const chunkMs = (float32.length / REALTIME_SAMPLE_RATE) * 1000;
      this.totalScheduledMs += chunkMs;

      this.activeSources.push(src);
      src.onended = () => {
        const idx = this.activeSources.indexOf(src);
        if (idx >= 0) this.activeSources.splice(idx, 1);
        // Fire done callback when the last source finishes
        if (this.activeSources.length === 0 && this.doneCallback) {
          const cb = this.doneCallback;
          this.doneCallback = null;
          cb();
        }
      };
    } catch { /* ignore decode errors */ }
  }

  /**
   * Returns how many ms of audio the user has actually heard.
   * Uses wall-clock elapsed time clamped to total scheduled duration.
   */
  getPlayedMs(): number {
    if (this.startWallMs === null) return 0;
    const elapsed = performance.now() - this.startWallMs;
    return Math.min(elapsed, this.totalScheduledMs);
  }

  onDone(cb: () => void): void {
    if (this.activeSources.length === 0) { cb(); return; }
    this.doneCallback = cb;
  }

  /**
   * Stop all queued audio immediately (barge-in).
   * Returns the ms that had been played at the moment of flush.
   */
  flush(): number {
    const playedMs = this.getPlayedMs();
    this.doneCallback = null;
    for (const src of this.activeSources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.activeSources = [];
    this.nextPlayTime = 0;
    this.startWallMs = null;
    this.totalScheduledMs = 0;
    return playedMs;
  }

  /** Alias for backward compat */
  stop(): void { this.flush(); }
}

// ─── PCM16 conversion helpers ─────────────────────────────────

function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLen = Math.round(input.length / ratio);
  const output = new Float32Array(outputLen);
  for (let i = 0; i < outputLen; i++) output[i] = input[Math.min(Math.floor(i * ratio), input.length - 1)] ?? 0;
  return output;
}

function float32ToPcm16(float32: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

// ─── Waveform + utilities ─────────────────────────────────────

export const VOICE_BAR_COUNT = WAVEFORM_BARS;

function paintWaveform(freq: Uint8Array): void {
  const bars = document.querySelectorAll<HTMLElement>('.va-wave-bar');
  if (!bars.length) return;
  const n    = bars.length;
  const step = Math.max(1, Math.floor(freq.length / n));
  bars.forEach((bar, i) => {
    const v = freq[Math.min(i * step, freq.length - 1)] ?? 0;
    bar.style.height = Math.max(4, Math.round((v / 255) * 40)) + 'px';
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload  = () => resolve((rd.result as string).split(',')[1] ?? '');
    rd.onerror = reject;
    rd.readAsDataURL(blob);
  });
}
