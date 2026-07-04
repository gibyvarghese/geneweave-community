// Main geneWeave UI module - orchestrates all UI components
// Imports from modularized ui/ subdirectory

import {
  state,
  getCalendarFocusDate,
  setCalendarFocusDate,
  shiftCalendarMonth,
  toYMD,
  getTodayLabel,
} from './ui/state.js';
import { h } from './ui/dom.js';
import { STYLES } from './ui/styles.js';
import { buildFeedbackControls, buildAiDisclosure, loadAiTransparency, loadChatFeedback } from './ui/answer-feedback.js';
import { isCiteMode, sendCitedMessage, renderCitedAnswer, loadChatCitationsConfig } from './ui/chat-citations.js';
import { buildVersionControls, loadAnswerVersionsConfig } from './ui/answer-versions.js';
import { loadAccessibilityConfig, announceStreamStart, announceStreamDelta, announceStreamDone, announceStreamStopped } from './ui/stream-announce.js';
import { captureFocus, restoreFocus, applyForceFocusRing } from './ui/focus.js';
import { loadWorkspaceAccess } from './ui/workspace-access.js';
import { t, loadI18n } from './ui/i18n.js';
import { buildStarterCards, loadSuggestedPrompts } from './ui/suggested-prompts.js';
import { captureScrollState, restoreScrollState } from './ui/scroll-preserve.js';
import { 
  getUserAvatarUrl, 
  getAgentAvatarUrl,
  scrollMessages,
  toggleAudioRecording,
  queueFiles,
  removePendingAttachment,
  mdToHtml,
  copyResponse,
  emailResponse,
  openInWord
} from './ui/utils.js';
import { 
  api, 
  loadChats, 
  selectChat, 
  createChat, 
  deleteChat,
  normalizeServerMessage,
  loadModels,
  loadActiveRoutingPolicy,
  loadTools,
  loadUserPreferences,
  saveUserPreferences,
  loadAdmin,
  loadDashboard,
  loadChatSettings,
  saveChatSettings
} from './ui/api.js';

import { 
  doLogout,
  renderAuth
} from './ui/auth.js';
import {
  parseMessageMetadata,
  shortText,
  detailText,
  summarizeForDisplay,
  parseJsonMaybe,
  parseDelimitedTable,
  formatXml,
  detectCodeLanguage,
  normalizeCodeLanguage,
  friendlyLanguageName,
  looksLikeCode,
  tableFromJson,
  extractCodePayloadFromJson,
} from './ui/formatting.js';
import {
  normalizeAdminPath,
  slugifyPromptKey,
  ensureWizardFrameworkSections,
  buildFrameworkSectionsFromWizard,
} from './ui/prompt-wizard-utils.js';
import {
  promptWizardRows,
  extractTemplateTokens,
} from './ui/prompt-wizard-derivation.js';
import {
  ensurePromptWizardState,
  resetPromptWizard,
} from './ui/prompt-wizard-state.js';
import {
  hydrateWizardFromPromptRow,
} from './ui/prompt-wizard-hydration.js';
import {
  buildQueuedPromptWizardFragment,
  buildPromptContractCreatePayload,
  buildPromptFragmentCreatePayload,
  buildPromptFrameworkCreatePayload,
  buildPromptStrategyCreatePayload,
  buildPromptWizardPayload,
} from './ui/prompt-wizard-payloads.js';
import {
  insertFragmentMarkerIntoTemplate,
  moveWizardFrameworkSection,
  renderPromptTemplatePreview,
} from './ui/prompt-wizard-ui.js';
import {
  adminBackToList,
  clearAdminEditorState,
  renderAdminView,
  parseAdminHash,
  adminEditRow,
  getAdminSchema,
} from './ui/admin-ui.js';
import {
  openConnectorsView,
  renderConnectorsView,
} from './ui/connectors-ui.js';
import {
  renderActionsWidget,
  renderCalendarWidget,
  renderDashboardView,
  renderProfileDropdown,
  renderWorkspaceNav,
  renderWorkspaceTopCard,
} from './ui/workspace-shell.js';
import { renderCalendarView } from './ui/calendar-view.js';
import { renderNotesView, loadNotesList } from './ui/notes-view.js';
import { renderDesignSystemView } from './ui/design-system-view.js';
import { renderBuilderView } from './ui/builder-view.js';
import { renderAccountView } from './ui/account-view.js';
import { loadActionFeed } from './ui/action-feed.js';
import { loadCalendarItems, loadCalendarCategories } from './ui/agenda-api.js';
import {
  hydrateWizardFromPrompt,
  renderPromptSetupWizard as renderPromptSetupWizardView,
} from './ui/prompt-wizard-view.js';
import { renderAssistantProcess } from './ui/process-ui.js';
import {
  renderChatView as renderChatViewShell,
  renderSettingsDropdown as renderSettingsDropdownView,
} from './ui/chat-view.js';
import { loadVoiceConfig as loadVoiceConfigSettings } from './ui/voice-agent.js';
import type { Message, Chat } from './ui/types.js';
import {
  renderSVSubmitView,
  renderSVLiveView,
  renderSVVerdictView,
} from './features/scientific-validation/ui/index.js';
import { renderKaggleListView, renderKaggleFlowView } from './features/kaggle-competition/ui/index.js';
import { noticeDialog, confirmDialog } from "./ui/dialog.js";


// ============================================================================
// RENDERING FUNCTIONS
// ============================================================================

const dashboardFlowFilters: { mode: string; agent: string; toolQuery: string } = {
  mode: 'all',
  agent: 'all',
  toolQuery: '',
};

function touchChat(chatId: string, titleOverride?: string) {
  const index = state.chats.findIndex((chat: Chat) => chat.id === chatId);
  if (index < 0) return;
  const chat = state.chats[index];
  const updated = {
    ...chat,
    title: titleOverride ?? chat.title,
    updated_at: new Date().toISOString(),
  };
  state.chats.splice(index, 1);
  state.chats.unshift(updated);
}

async function sendMessage(text: string) {
  const content = String(text || '').trim();
  const attachments = (state.pendingAttachments || []).slice();
  if ((!content && !attachments.length) || state.streaming) return;
  if (!state.currentChatId) {
    await createChat();
  }
  const chatId = state.currentChatId;
  if (!chatId) return;

  // m138 — "Cite sources" mode: answer grounded in the user's own workspace with verified [n] citations
  // (a distinct, non-streaming path). Attachments aren't part of a cited answer, so only plain text routes here.
  if (isCiteMode() && content) {
    state.pendingAttachments = [];
    await sendCitedMessage(chatId, content, renderMessages);
    return;
  }

  state.messages.push({
    role: 'user',
    content,
    attachments,
    created_at: new Date().toISOString(),
    metadata: attachments.length ? JSON.stringify({ attachments }) : null,
  });
  state.pendingAttachments = [];
  state.transcriptAtBottom = true; // sending → follow the new reply to the bottom (until the user scrolls up)
  await runAssistantStream(chatId, content, attachments);
}

// The in-flight stream's AbortController, so the user's Stop control can cancel generation.
let _streamAbort: AbortController | null = null;
function stopStreaming() {
  try { _streamAbort?.abort(); } catch { /* already done */ }
}


/**
 * Turn a failed send into a HUMAN, DIFFERENTIATED message + the right recovery — never a raw technical
 * error or a generic catch-all. A content-policy refusal is its own calm state (`refusal`), not a system
 * error. Retryable failures get a "Try again"; an expired session gets "Sign in".
 */
function classifyFailure(opts: { threw?: boolean; status?: number; code?: string; serverMessage?: string }): {
  refusal?: boolean; kind: string; text: string; retryable: boolean; signIn?: boolean;
} {
  const { threw, status, code, serverMessage } = opts;
  if (threw) return { kind: 'network', text: 'Can’t reach geneWeave — check your internet connection and try again.', retryable: true };
  if (status === 401 || status === 419) return { kind: 'auth', text: 'Your session has expired. Please sign in again to continue.', retryable: false, signIn: true };
  if (status === 403 || status === 451 || code === 'content_policy' || code === 'guardrail' || code === 'blocked' || code === 'safety') {
    return { refusal: true, kind: 'refusal', text: serverMessage || 'geneWeave declined this request under its safety policy. You can rephrase and try a different approach.', retryable: false };
  }
  if (status === 429 || code === 'rate_limited') return { kind: 'rate_limit', text: 'geneWeave is busy right now. Wait a few seconds and try again.', retryable: true };
  if (status !== undefined && status >= 500) return { kind: 'server', text: 'Something went wrong on our end. Your message is safe — please try again.', retryable: true };
  if (status === 413 || code === 'too_large') return { kind: 'too_large', text: 'That message (or its attachments) is too large to send.', retryable: false };
  return { kind: 'request', text: serverMessage || 'That request couldn’t be completed. Please try again.', retryable: true };
}

/** Retry the last send: drop the failed/refused assistant reply and re-run the stream for the last user message. */
async function retryLastSend() {
  if (state.streaming || !state.currentChatId) return;
  const last = state.messages[state.messages.length - 1] as any;
  if (last && last.role === 'assistant' && (last.errorKind || last.refusal)) state.messages.pop();
  const lastUser = [...state.messages].reverse().find((m: any) => m.role === 'user') as any;
  if (!lastUser) return;
  await runAssistantStream(state.currentChatId, String(lastUser.content || ''), lastUser.attachments || []);
}

async function runAssistantStream(chatId: string, content: string, attachments: any[]) {
  state.streaming = true;
  render();
  scrollMessages();

  const modelParts = String(state.selectedModel || '').split(':');
  const body = {
    content,
    stream: true,
    model: modelParts[1] || undefined,
    provider: modelParts[0] || undefined,
    attachments: attachments.length ? attachments : undefined,
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  const startedAtMs = Date.now();
  let assistantMsg: any = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let streamIdleTimedOut = false;
  _streamAbort = new AbortController();

  try {
    const resp = await fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal: _streamAbort.signal,
    });
    if (!resp.ok || !resp.body) {
      // Read the server's structured error (if any) and classify into a human, differentiated message.
      let code: string | undefined; let serverMessage: string | undefined;
      try { const j = await resp.json() as { error?: string; message?: string }; code = j?.error; serverMessage = j?.message; } catch { /* non-JSON body */ }
      const f = classifyFailure({ status: resp.status, code, serverMessage });
      const msg: any = { role: 'assistant', content: '', created_at: new Date().toISOString(), processState: 'error' };
      if (f.refusal) { msg.refusal = true; msg.refusalText = f.text; }
      else { msg.errorKind = f.kind; msg.errorText = f.text; msg.errorRetryable = f.retryable; msg.errorSignIn = f.signIn; }
      state.messages.push(msg);
      return; // handled — the `finally` still runs (clears streaming + re-renders)
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    assistantMsg = {
      role: 'assistant',
      content: '',
      usage: null,
      cost: 0,
      latency_ms: 0,
      created_at: new Date().toISOString(),
      steps: [],
      evalResult: null,
      redaction: null,
      mode: state.chatSettings?.mode || 'direct',
      processState: 'running',
      processExpanded: true,
      processUi: { detailExpanded: Object.create(null) },
      activeSkills: [],
      enabledTools: [],
      skillTools: [],
      skillPromptApplied: false,
    };
    state.messages.push(assistantMsg);
    render();
    scrollMessages();
    // H19 — one accessible live-region announcement that generation started (not a per-token transcript re-read).
    announceStreamStart();

    let buf = '';
    let dataLines: string[] = [];

    const flushEvent = () => {
      if (dataLines.length === 0) {
        return;
      }

      const payload = dataLines.join('\n');
      dataLines = [];

      try {
        const d = JSON.parse(payload);
        if (d.type === 'text') assistantMsg.content += d.text || '';
        else if (d.type === 'reasoning' && d.text) assistantMsg.steps.push({ type: 'thinking', text: d.text });
        else if (d.type === 'step') assistantMsg.steps.push(d.step || d);
        else if (d.type === 'tool_start') assistantMsg.steps.push({ kind: 'tool_start', name: d.name, input: d.input });
        else if (d.type === 'tool_end') {
          const last = assistantMsg.steps[assistantMsg.steps.length - 1];
          if (last && last.kind === 'tool_start') last.result = d.result;
        }
        else if (d.type === 'redaction') assistantMsg.redaction = d;
        else if (d.type === 'eval') assistantMsg.evalResult = d;
        else if (d.type === 'cognitive') assistantMsg.cognitive = d;
        else if (d.type === 'guardrail') assistantMsg.guardrail = d;
        else if (d.type === 'screenshot') {
          if (!assistantMsg.screenshots) assistantMsg.screenshots = [];
          assistantMsg.screenshots.push({ base64: d.base64, format: d.format || 'png' });
        }
        else if (d.type === 'handoff') {
          state.handoffRequest = d;
          render();
        }
        else if (d.type === 'ensemble_result') {
          if (Array.isArray(d.candidates)) assistantMsg.ensembleCandidates = d.candidates;
          if (d.rationale) assistantMsg.ensembleRationale = d.rationale;
          if (d.winner) assistantMsg.ensembleWinner = d.winner;
        }
        else if (d.type === 'done') {
          assistantMsg.usage = d.usage;
          assistantMsg.cost = d.cost;
          assistantMsg.latency_ms = d.latencyMs;
          // m137 — identity + routing snapshot so answer feedback (thumbs/reasons) can target this exact
          // message and, when rated, feed the model's routing quality score.
          if (d.messageId) (assistantMsg as any).id = d.messageId;
          if (d.model) (assistantMsg as any).model = d.model;
          if (d.provider) (assistantMsg as any).provider = d.provider;
          if (d.taskKey) (assistantMsg as any).taskKey = d.taskKey;
          if (d.steps) assistantMsg.steps = d.steps;
          if (d.eval) assistantMsg.evalResult = d.eval;
          if (d.cognitive) assistantMsg.cognitive = d.cognitive;
          assistantMsg.activeSkills = Array.isArray(d.activeSkills) ? d.activeSkills : [];
          assistantMsg.enabledTools = Array.isArray(d.enabledTools) ? d.enabledTools : [];
          assistantMsg.skillTools = Array.isArray(d.skillTools) ? d.skillTools : [];
          assistantMsg.skillPromptApplied = !!d.skillPromptApplied;
          if (d.redaction) assistantMsg.redaction = d.redaction;
          if (d.guardrail) assistantMsg.guardrail = d.guardrail;
          if (Array.isArray(d.ensembleCandidates)) assistantMsg.ensembleCandidates = d.ensembleCandidates;
          if (d.ensembleRationale) assistantMsg.ensembleRationale = d.ensembleRationale;
          if (d.ensembleWinner) assistantMsg.ensembleWinner = d.ensembleWinner;
          // m77 Phase 1: surface artifact refs from the done event into message metadata
          if (Array.isArray(d.artifactRefs) && d.artifactRefs.length) {
            const existingMeta = assistantMsg.metadata
              ? (typeof assistantMsg.metadata === 'string' ? JSON.parse(assistantMsg.metadata) : assistantMsg.metadata)
              : {};
            existingMeta.artifactRefs = d.artifactRefs;
            assistantMsg.metadata = existingMeta;
          }
          assistantMsg.processState = 'completed';
          assistantMsg.processExpanded = false;
          touchChat(chatId, d.title || undefined);
        }
      } catch {
        // Ignore malformed stream chunks.
      }
    };

    let lastChunkAt = Date.now();
    idleTimer = setInterval(() => {
      if (!streamIdleTimedOut && Date.now() - lastChunkAt > 45_000) {
        streamIdleTimedOut = true;
        reader.cancel('idle').catch(() => {});
      }
    }, 5_000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lastChunkAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line === '') {
          flushEvent();
          continue;
        }
        if (line.startsWith(':')) {
          continue;
        }
        if (line.startsWith('event:')) {
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      // H18/H19 — patch ONLY the streaming bubble's text in place per token; do NOT rebuild the transcript.
      // Rebuilding (`renderMessages`) re-adds every message node each token, which (a) makes the `role="log"`
      // region re-announce the whole conversation to a screen reader (spam) and (b) churns layout so controls
      // shift. Instead we mutate one text node; a dedicated live region announces the answer accessibly, and
      // the composer (outside `.messages`) never moves. Full markdown render happens once, at completion.
      patchStreamingBubble(assistantMsg.content);
      announceStreamDelta(assistantMsg.content);
      scrollMessages();
    }

    // Flush trailing event if stream ended without a trailing blank line.
    flushEvent();
  } catch (error: unknown) {
    if ((error as any)?.name === 'AbortError' || _streamAbort?.signal.aborted) {
      // The USER stopped generation — not a failure. Keep whatever partial output arrived; mark it stopped.
      if (assistantMsg) {
        assistantMsg.processState = 'completed';
        assistantMsg.stopped = true;
        assistantMsg.latency_ms = assistantMsg.latency_ms || (Date.now() - startedAtMs);
      }
    } else {
      // A thrown fetch/stream error is a CONNECTION failure (server never reached, or the stream dropped
      // mid-flight). Classify as network and attach a human message + retry — never a raw "Failed to fetch".
      const f = classifyFailure({ threw: true });
      if (assistantMsg) {
        assistantMsg.processState = 'error';
        assistantMsg.errorKind = f.kind; assistantMsg.errorText = f.text; assistantMsg.errorRetryable = f.retryable;
      } else {
        state.messages.push({ role: 'assistant', content: '', created_at: new Date().toISOString(), processState: 'error', errorKind: f.kind, errorText: f.text, errorRetryable: f.retryable } as any);
      }
    }
  } finally {
    _streamAbort = null;
    if (idleTimer !== null) clearInterval(idleTimer);
    if (assistantMsg && assistantMsg.processState === 'running') {
      if (streamIdleTimedOut) {
        // Idle timeout is its own differentiated, retryable failure (not a generic error).
        assistantMsg.processState = 'error';
        assistantMsg.errorKind = 'timeout';
        assistantMsg.errorText = 'No response for 45 seconds — the connection went idle. Please try again.';
        assistantMsg.errorRetryable = true;
      } else {
        assistantMsg.processState = assistantMsg.content ? 'completed' : 'error';
        if (assistantMsg.processState === 'error' && !assistantMsg.errorKind) {
          assistantMsg.errorKind = 'empty'; assistantMsg.errorText = 'No response was returned. Please try again.'; assistantMsg.errorRetryable = true;
        }
        assistantMsg.latency_ms = assistantMsg.latency_ms || (Date.now() - startedAtMs);
      }
    }
    state.streaming = false;
    render();
    scrollMessages();
    // H19 — announce the outcome accessibly, once: the finished answer, or the "stopped" notice.
    if (assistantMsg) {
      if (assistantMsg.stopped) announceStreamStopped(assistantMsg.content || '');
      else if (assistantMsg.content && assistantMsg.processState === 'completed') announceStreamDone(assistantMsg.content);
    }
  }
}

/**
 * H18/H19 — update ONLY the streaming assistant bubble's text in place (no transcript rebuild). Renders plain
 * text while streaming (final markdown/code render happens on completion, in renderMessages). Falls back to a
 * one-off renderMessages() if the bubble hasn't been created yet.
 */
function patchStreamingBubble(text: string): void {
  const el = document.querySelector('.messages [data-streaming-bubble]') as HTMLElement | null;
  if (el) { el.textContent = text; return; }
  renderMessages();
}

function renderProcessDetailView(value: any) {
  const text = detailText(value);
  if (!text) return h('div', { className: 't-b' }, 'No detail data');
  const trimmed = text.trim();

  const bt = String.fromCharCode(96);
  const triple = bt + bt + bt;
  if (trimmed.startsWith(triple)) {
    const fenceLines = trimmed.split(/\r?\n/);
    if (fenceLines.length >= 2 && fenceLines[fenceLines.length - 1] === triple) {
      const lang = fenceLines[0]!.slice(3).trim();
      const body = fenceLines.slice(1, -1).join('\n');
      return renderDetailCode(body, lang || detectCodeLanguage(body), 'code');
    }
  }

  const json = parseJsonMaybe(trimmed);
  if (json != null) {
    const codePayload = extractCodePayloadFromJson(json);
    if (codePayload) return renderDetailCode(codePayload.code, codePayload.language, 'code');
    const table = tableFromJson(json);
    if (table) return renderDetailTable(table.headers, table.rows);
    return renderDetailCode(JSON.stringify(json, null, 2), 'json', 'json');
  }

  const xml = formatXml(trimmed);
  if (xml) return renderDetailCode(xml, 'xml', 'xml');

  const delimited = parseDelimitedTable(trimmed);
  if (delimited) return renderDetailTable(delimited.headers, delimited.rows);

  if (looksLikeCode(trimmed)) return renderDetailCode(trimmed, detectCodeLanguage(trimmed), 'code');

  return h('div', { className: 't-b' }, text);
}

function numericValue(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,%\s,]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isLikelyYear(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 2100;
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$|(?<=\.\d*[1-9])0+$/g, '');
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (isLikelyYear(value)) return String(value);
  const abs = Math.abs(value);
  if (abs < 1000) {
    if (Number.isInteger(value)) return String(value);
    return trimTrailingZeros(value.toFixed(abs < 10 ? 2 : 1));
  }

  const units = ['k', 'M', 'B', 'T'];
  let scaled = abs;
  let unitIndex = -1;
  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const formatted = trimTrailingZeros(scaled.toFixed(decimals));
  return `${value < 0 ? '-' : ''}${formatted}${units[Math.max(unitIndex, 0)]}`;
}

function formatMaybeCompactValue(value: any): string {
  if (value == null) return '';
  if (typeof value === 'number') return formatCompactNumber(value);
  if (typeof value !== 'string') return String(value);

  const trimmed = value.trim();
  const match = trimmed.match(/^([^\d+\-]*)([+\-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([^\d]*)$/);
  if (!match) return value;

  const prefix = match[1] || '';
  const numericPart = match[2] || '';
  const suffix = match[3] || '';
  if (suffix.includes('%')) return value;

  const parsed = numericValue(numericPart);
  if (parsed == null) return value;
  if (Math.abs(parsed) < 1000 || isLikelyYear(parsed)) return prefix + numericPart + suffix;
  return prefix + formatCompactNumber(parsed) + suffix;
}

function formatCurrencyCompact(value: number, digits: number = 4): string {
  if (!Number.isFinite(value)) return '$0';
  if (Math.abs(value) >= 1000) return '$' + formatCompactNumber(value);
  return '$' + Number(value).toFixed(digits);
}

function normalizeTableData(headers: any[], rows: any[]): { headers: string[]; rows: string[][] } | null {
  if (!Array.isArray(headers) || !Array.isArray(rows) || !headers.length || !rows.length) return null;
  const normalizedHeaders = headers.map((hd, idx) => String(hd || ('col_' + (idx + 1))));
  const normalizedRows = rows.map((row) => {
    if (Array.isArray(row)) return row.map((cell) => (cell == null ? '' : String(cell)));
    if (row && typeof row === 'object') return normalizedHeaders.map((hd) => (row[hd] == null ? '' : String(row[hd])));
    return [String(row)];
  }).filter((row) => row.length);
  if (!normalizedRows.length) return null;
  return { headers: normalizedHeaders, rows: normalizedRows };
}

function extractResponseTableData(value: any): { headers: string[]; rows: string[][] } | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      const headers: string[] = [];
      value.forEach((row) => {
        Object.keys(row).forEach((key) => {
          if (!headers.includes(key)) headers.push(key);
        });
      });
      const rows = value.map((row) => headers.map((hd) => {
        const cell = row[hd];
        return cell == null ? '' : (typeof cell === 'string' ? cell : JSON.stringify(cell));
      }));
      return normalizeTableData(headers, rows);
    }
    if (value.every((row) => Array.isArray(row))) {
      return normalizeTableData(value[0]?.map((_, idx) => 'col_' + (idx + 1)) || [], value);
    }
    return null;
  }
  if (typeof value === 'object') {
    if (value.table && typeof value.table === 'object') {
      const fromTable = extractResponseTableData(value.table);
      if (fromTable) return fromTable;
    }
    if (Array.isArray(value.data)) {
      const fromData = extractResponseTableData(value.data);
      if (fromData) return fromData;
    }
    const headers = value.headers || value.columns;
    const rows = value.rows;
    if (Array.isArray(headers) && Array.isArray(rows)) return normalizeTableData(headers, rows);
  }
  return null;
}

function chartSpecFromChartObject(chartObj: any): any {
  if (!chartObj || typeof chartObj !== 'object') return null;
  const type = String(chartObj.type || 'bar').toLowerCase();
  let labels = Array.isArray(chartObj.labels) ? chartObj.labels.map((x: any) => String(x)) : [];
  let values = Array.isArray(chartObj.values) ? chartObj.values.map(numericValue).filter((x: any) => x != null) : [];
  if ((!labels.length || !values.length) && Array.isArray(chartObj.datasets) && chartObj.datasets.length) {
    const ds = chartObj.datasets[0] || {};
    labels = labels.length
      ? labels
      : (Array.isArray(chartObj.labels)
          ? chartObj.labels.map((x: any) => String(x))
          : (Array.isArray(ds.data) ? ds.data.map((_: any, idx: number) => 'item_' + (idx + 1)) : []));
    values = Array.isArray(ds.data) ? ds.data.map(numericValue).filter((x: any) => x != null) : [];
  }
  if (!labels.length || !values.length) return null;
  const len = Math.min(labels.length, values.length, 20);
  return {
    type: type === 'line' ? 'line' : 'bar',
    title: chartObj.title || chartObj.name || 'Chart',
    labels: labels.slice(0, len),
    values: values.slice(0, len),
    unit: chartObj.unit || '',
  };
}

function deriveChartSpecFromTable(tableData: any, hintTitle: string, hintType: string): any {
  if (!tableData) return null;
  const headers = Array.isArray(tableData.headers) ? tableData.headers : [];
  const rows = Array.isArray(tableData.rows) ? tableData.rows : [];
  if (headers.length < 2 || rows.length < 2) return null;

  const title = String(hintTitle || '').trim();
  const lower = title.toLowerCase();
  const preferred: string[] = [];
  if (lower.includes('margin')) preferred.push('margin', '%');
  if (lower.includes('profit')) preferred.push('profit');
  if (lower.includes('revenue') || lower.includes('sales')) preferred.push('revenue', 'sales');
  if (lower.includes('cost') || lower.includes('expense')) preferred.push('cost', 'expense');

  let valueCol = -1;
  const isMostlyNumeric = (colIdx: number) => {
    const numericCount = rows.reduce((acc: number, row: any[]) => acc + (numericValue(row[colIdx]) != null ? 1 : 0), 0);
    return numericCount >= Math.max(2, Math.floor(rows.length * 0.6));
  };

  for (const key of preferred) {
    const idx = headers.findIndex((hd: string) => String(hd || '').toLowerCase().includes(key));
    if (idx > 0 && isMostlyNumeric(idx)) {
      valueCol = idx;
      break;
    }
  }
  if (valueCol < 0) {
    for (let c = 1; c < headers.length; c++) {
      if (isMostlyNumeric(c)) {
        valueCol = c;
        break;
      }
    }
  }
  if (valueCol < 0) return null;

  const points = rows.map((row: any[]) => ({
    label: String(row[0] || ''),
    value: numericValue(row[valueCol]),
  })).filter((point: any) => point.label && point.value != null).slice(0, 20);
  if (points.length < 2) return null;

  return {
    type: String(hintType || '').toLowerCase() === 'line' ? 'line' : 'bar',
    title: title || (headers[valueCol] + ' by ' + headers[0]),
    labels: points.map((p: any) => p.label),
    values: points.map((p: any) => p.value),
    unit: '',
  };
}

function extractResponseChartSpec(value: any, tableData: any): any {
  if (value && typeof value === 'object' && value.chart) {
    const explicit = chartSpecFromChartObject(value.chart);
    if (explicit) return explicit;
  }
  return deriveChartSpecFromTable(tableData, '', 'bar');
}

function extractResponseChartSpecs(value: any, tableData: any): any[] {
  const specs: any[] = [];
  if (value && typeof value === 'object' && value.chart) {
    const chartEntries = Array.isArray(value.chart) ? value.chart : [value.chart];
    chartEntries.forEach((entry: any) => {
      const explicit = chartSpecFromChartObject(entry);
      if (explicit) {
        specs.push(explicit);
        return;
      }
      const fallback = deriveChartSpecFromTable(tableData, entry?.title || entry?.name || '', entry?.type || 'bar');
      if (fallback) specs.push(fallback);
    });
  }
  if (!specs.length) {
    const single = extractResponseChartSpec(value, tableData);
    if (single) specs.push(single);
  }
  return specs;
}

function renderDetailTable(headers: string[], rows: string[][]): HTMLElement {
  return h('div', { className: 'detail-table-wrap' },
    h('table', { className: 'detail-table' },
      h('thead', null,
        h('tr', null,
          ...headers.map((col) => h('th', null, col))
        )
      ),
      h('tbody', null,
        ...rows.map((row) => h('tr', null,
          ...row.map((cell) => h('td', null, formatMaybeCompactValue(cell)))
        ))
      )
    )
  );
}

function renderDetailCode(text: string, language: string, kind: string): HTMLElement {
  const codeText = text || '';
  const lang = normalizeCodeLanguage(language) || detectCodeLanguage(codeText);
  const badge = friendlyLanguageName(lang);
  const copyBtn = h('button', {
    className: 'detail-copy-btn',
    type: 'button',
    title: 'Copy code',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(codeText);
      } catch {
        // no-op
      }
      copyBtn.classList.add('copied');
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = 'Copy';
      }, 1200);
    },
  }, 'Copy');
  return h('div', { className: 'detail-block' },
    h('div', { className: 'detail-block-hdr' },
      h('span', { className: 'detail-lang' }, badge),
      h('div', { className: 'detail-block-actions' },
        h('span', { className: 'detail-kind' }, kind || 'formatted'),
        copyBtn
      )
    ),
    h('pre', { className: 'detail-code' }, codeText)
  );
}

function renderResponseTable(headers: string[], rows: string[][]): HTMLElement {
  return h('div', { className: 'response-table-wrap' },
    h('table', { className: 'response-table' },
      h('thead', null,
        h('tr', null,
          ...headers.map((col) => h('th', null, col))
        )
      ),
      h('tbody', null,
        ...rows.map((row) => h('tr', null,
          ...row.map((cell) => h('td', null, formatMaybeCompactValue(cell)))
        ))
      )
    )
  );
}

function renderResponseChart(spec: any): HTMLElement | null {
  const labels = Array.isArray(spec?.labels) ? spec.labels : [];
  const values = Array.isArray(spec?.values) ? spec.values : [];
  if (!labels.length || !values.length) return null;
  const max = Math.max(...values, 0.0001);
  const unit = spec.unit ? String(spec.unit) : '';
  const title = spec.title || 'Chart';
  if (spec.type === 'line') {
    const width = 560;
    const height = 180;
    const pad = 20;
    const xSpan = Math.max(1, labels.length - 1);
    const points = values.map((v: number, idx: number) => {
      const x = pad + ((width - pad * 2) * idx / xSpan);
      const y = pad + ((height - pad * 2) * (1 - (v / max)));
      return { x, y };
    });
    const path = points.map((p: { x: number; y: number }, idx: number) => (idx === 0 ? 'M' : 'L') + p.x + ' ' + p.y).join(' ');
    return h('div', { className: 'response-chart response-line' },
      h('div', { className: 'response-chart-title' }, title),
      h('svg', { viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none' },
        h('line', { className: 'response-line-axis', x1: String(pad), y1: String(height - pad), x2: String(width - pad), y2: String(height - pad) }),
        h('path', { className: 'response-line-path', d: path }),
        ...points.map((p: { x: number; y: number }) => h('circle', { className: 'response-line-dot', cx: String(p.x), cy: String(p.y), r: '2.5' }))
      ),
      h('div', { className: 'response-line-labels' },
        ...labels.map((label: string) => h('span', null, label))
      )
    );
  }
  return h('div', { className: 'response-chart' },
    h('div', { className: 'response-chart-title' }, title),
    h('div', { className: 'response-bars' },
      ...labels.map((label: string, idx: number) => {
        const value = values[idx];
        const widthPct = Math.max(2, Math.round((value / max) * 100));
        return h('div', { className: 'response-bar-row' },
          h('div', { className: 'response-bar-label', title: label }, label),
          h('div', { className: 'response-bar-track' },
            h('div', { className: 'response-bar-fill', style: 'width:' + widthPct + '%' })
          ),
          h('div', { className: 'response-bar-value' }, formatCompactNumber(value) + unit)
        );
      })
    )
  );
}

function renderAssistantStructuredContent(content: string): HTMLElement | null {
  const text = String(content || '');
  const trimmed = text.trim();
  if (!trimmed) return null;

  const json = parseJsonMaybe(trimmed);
  if (json != null) {
    const codePayload = extractCodePayloadFromJson(json);
    if (codePayload) {
      return h('div', { className: 'response-rich' },
        renderDetailCode(codePayload.code, codePayload.language, 'code')
      );
    }
    const table = extractResponseTableData(json);
    const charts = extractResponseChartSpecs(json, table);
    const note = typeof json.summary === 'string'
      ? json.summary
      : typeof json.message === 'string'
        ? json.message
        : typeof json.description === 'string'
          ? json.description
          : '';
    if (charts.length || table) {
      return h('div', { className: 'response-rich' },
        note ? h('p', { className: 'response-note' }, note) : null,
        ...charts.map((spec) => renderResponseChart(spec)).filter(Boolean) as HTMLElement[],
        table ? renderResponseTable(table.headers, table.rows) : null
      );
    }
  }

  const delimited = parseDelimitedTable(trimmed);
  if (delimited) {
    return h('div', { className: 'response-rich' },
      renderResponseTable(delimited.headers, delimited.rows)
    );
  }
  return null;
}

function extractJsonCodeBlocks(text: string): { blocks: any[]; stripped: string } {
  const bt = String.fromCharCode(96);
  const triple = bt + bt + bt;
  if (typeof text !== 'string' || !text.includes(triple)) return { blocks: [], stripped: text || '' };
  const fenceRe = new RegExp(triple + '([^\\n' + bt + ']*)\\n([\\s\\S]*?)' + triple, 'g');
  const blocks: any[] = [];
  let stripped = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text))) {
    const language = String(match[1] || '').trim().toLowerCase();
    const body = String(match[2] || '').trim();
    const parsed = parseJsonMaybe(body);
    if (parsed == null) continue;
    if (language && language !== 'json' && language !== 'application/json' && language !== 'chart' && language !== 'table') continue;
    blocks.push(parsed);
    stripped += text.slice(lastIndex, match.index);
    lastIndex = fenceRe.lastIndex;
  }
  if (!blocks.length) return { blocks: [], stripped: text };
  stripped += text.slice(lastIndex);
  return { blocks, stripped };
}

function renderAssistantEmbeddedStructuredContent(content: string): { markdown: string; node: HTMLElement } | null {
  const extracted = extractJsonCodeBlocks(content);
  if (!extracted.blocks.length) return null;
  const sections: HTMLElement[] = [];
  extracted.blocks.forEach((block) => {
    const table = extractResponseTableData(block);
    const chart = extractResponseChartSpec(block, table);
    const note = typeof block?.summary === 'string'
      ? block.summary
      : typeof block?.message === 'string'
        ? block.message
        : typeof block?.description === 'string'
          ? block.description
          : '';
    if (!chart && !table) return;
    const chartEl = chart ? renderResponseChart(chart) : null;
    sections.push(
      h('div', { className: 'response-rich' },
        note ? h('p', { className: 'response-note' }, note) : null,
        chartEl,
        table ? renderResponseTable(table.headers, table.rows) : null
      )
    );
  });
  if (!sections.length) return null;
  return {
    markdown: String(extracted.stripped || '').trim(),
    node: h('div', { className: 'response-rich response-rich-embedded' }, ...sections),
  };
}

function parseMarkdownListValues(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text.split(',').map((part) => part.trim()).filter(Boolean);
}

function parseMarkdownChartSpecs(text: string): any[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const charts: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const typeMatch = lines[i]?.trim().match(/^(?:[-*]\s*)?Type:\s*(bar|line)\b/i);
    if (!typeMatch) continue;
    const type = String(typeMatch[1] || 'bar').toLowerCase();
    let labels: string[] = [];
    let values: number[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      const line = lines[j]?.trim() || '';
      const labelsMatch = line.match(/^(?:[-*]\s*)?Labels:\s*(.+)$/i);
      if (labelsMatch) labels = parseMarkdownListValues(labelsMatch[1] || '');
      const valuesMatch = line.match(/^(?:[-*]\s*)?Values:\s*(.+)$/i);
      if (valuesMatch) values = parseMarkdownListValues(valuesMatch[1] || '').map((v) => numericValue(v) as number).filter((v): v is number => v != null);
    }
    if (labels.length < 2 || values.length < 2) continue;
    const len = Math.min(labels.length, values.length, 20);

    let title = 'Chart';
    for (let p = i - 1; p >= Math.max(0, i - 4); p--) {
      const candidate = lines[p]?.trim() || '';
      if (!candidate) continue;
      if (/^(charts?|summary table)$/i.test(candidate.replace(/:$/, ''))) continue;
      if (/^(?:[-*]\s*)?(type|labels|values):/i.test(candidate)) continue;
      title = candidate
        .replace(/^\d+\.\s*/, '')
        .replace(/^[-*]\s*/, '')
        .replace(/^[#>]+\s*/, '')
        .trim();
      if (title) break;
    }

    charts.push({
      type: type === 'line' ? 'line' : 'bar',
      title: title || 'Chart',
      labels: labels.slice(0, len),
      values: values.slice(0, len),
      unit: '',
    });
  }
  return charts;
}

function renderAssistantMarkdownCharts(content: string): HTMLElement | null {
  const charts = parseMarkdownChartSpecs(content);
  if (!charts.length) return null;
  return h('div', { className: 'response-rich response-rich-embedded' },
    ...(charts.map((spec) => renderResponseChart(spec)).filter(Boolean) as HTMLElement[])
  );
}

function renderAssistantBubble(content: string): { element: HTMLElement; exportHtml: string } {
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const structured = renderAssistantStructuredContent(content);
  if (structured) {
    bubble.appendChild(structured);
  } else {
    const embedded = renderAssistantEmbeddedStructuredContent(content || '');
    if (embedded) {
      const markdown = mdToHtml(embedded.markdown || '');
      if (markdown) bubble.innerHTML = markdown;
      bubble.appendChild(embedded.node);
    } else {
      bubble.innerHTML = mdToHtml(content || '');
      const markdownCharts = renderAssistantMarkdownCharts(content || '');
      if (markdownCharts) bubble.appendChild(markdownCharts);
    }
  }

  return {
    element: bubble,
    exportHtml: bubble.innerHTML,
  };
}

// ── Phase 2-G/H: Type-aware artifact card + preview modal ─────────────────

const SVG_ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ARTIFACT_ICONS: Record<string, string> = {
  text:        `<svg ${SVG_ICON_ATTRS}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`,
  markdown:    `<svg ${SVG_ICON_ATTRS}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  csv:         `<svg ${SVG_ICON_ATTRS}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  json:        `<svg ${SVG_ICON_ATTRS}><path d="M8 3H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"/></svg>`,
  code:        `<svg ${SVG_ICON_ATTRS}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  html:        `<svg ${SVG_ICON_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  pdf:         `<svg ${SVG_ICON_ATTRS}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>`,
  report:      `<svg ${SVG_ICON_ATTRS}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="15" y2="16"/><line x1="9" y1="8" x2="11" y2="8"/></svg>`,
  image:       `<svg ${SVG_ICON_ATTRS}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  svg:         `<svg ${SVG_ICON_ATTRS}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  diagram:     `<svg ${SVG_ICON_ATTRS}><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><line x1="6" y1="9" x2="6" y2="12"/><line x1="18" y1="9" x2="18" y2="12"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="12" y1="12" x2="12" y2="15"/></svg>`,
  mermaid:     `<svg ${SVG_ICON_ATTRS}><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><line x1="6" y1="9" x2="6" y2="12"/><line x1="18" y1="9" x2="18" y2="12"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="12" y1="12" x2="12" y2="15"/></svg>`,
  react:       `<svg ${SVG_ICON_ATTRS}><circle cx="12" cy="12" r="2"/><path d="M12 2C6.5 2 2 6.7 2 12s4.5 10 10 10 10-4.7 10-10S17.5 2 12 2z" stroke-dasharray="2 2"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></svg>`,
  interactive: `<svg ${SVG_ICON_ATTRS}><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><circle cx="15.5" cy="11.5" r="0.8" fill="currentColor"/><circle cx="17.5" cy="13.5" r="0.8" fill="currentColor"/><rect x="2" y="7" width="20" height="13" rx="3"/><path d="M11 2h2"/></svg>`,
  audio:       `<svg ${SVG_ICON_ATTRS}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  video:       `<svg ${SVG_ICON_ATTRS}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
  spreadsheet: `<svg ${SVG_ICON_ATTRS}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  custom:      `<svg ${SVG_ICON_ATTRS}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
};

const PREVIEWABLE_TYPES = new Set(['text', 'markdown', 'json', 'csv', 'code', 'html', 'svg', 'mermaid', 'react', 'interactive', 'image', 'audio', 'video']);

type ArtifactRef = {
  artifactId: string; version: number; name: string; type: string; language?: string;
  streamingStatus?: 'streaming' | 'error' | null; streamingProgress?: number | null;
  isLive?: boolean;
};

async function getCsrfToken(): Promise<string> {
  try {
    const r = await fetch('/api/auth/me');
    if (r.ok) { const d = await r.json() as { csrfToken?: string }; return d.csrfToken ?? ''; }
  } catch { /* ignore */ }
  return '';
}

function showShareDialog(name: string, shareUrl: string, embedCode: string | null): void {
  const overlay = document.createElement('div');
  overlay.className = 'share-dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'share-dialog';
  dialog.addEventListener('click', (e) => e.stopPropagation());

  const title = document.createElement('div');
  title.className = 'share-dialog-title';
  title.textContent = embedCode ? 'Share & Embed' : 'Share Link';
  const sub = document.createElement('div');
  sub.className = 'share-dialog-sub';
  sub.textContent = `"${name}" — anyone with the link can view this artifact`;

  const row = document.createElement('div');
  row.className = 'share-dialog-row';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'share-dialog-url';
  urlInput.value = shareUrl;
  urlInput.readOnly = true;
  urlInput.onclick = () => urlInput.select();
  const copyBtn = document.createElement('button');
  copyBtn.className = 'share-dialog-copy';
  copyBtn.textContent = 'Copy Link';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      copyBtn.textContent = '✓ Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy Link'; copyBtn.classList.remove('copied'); }, 2000);
    }).catch(() => {
      urlInput.select();
      document.execCommand('copy');
    });
  };
  row.appendChild(urlInput);
  row.appendChild(copyBtn);

  const actions = document.createElement('div');
  actions.className = 'share-dialog-actions';

  if (embedCode) {
    const embedLabel = document.createElement('div');
    embedLabel.className = 'share-dialog-sub';
    embedLabel.style.marginTop = '4px';
    embedLabel.textContent = 'Embed code (iframe):';
    const embedTa = document.createElement('textarea');
    embedTa.className = 'share-dialog-embed';
    embedTa.rows = 3;
    embedTa.readOnly = true;
    embedTa.value = embedCode;
    embedTa.onclick = () => embedTa.select();
    const copyEmbedBtn = document.createElement('button');
    copyEmbedBtn.className = 'share-dialog-copy';
    copyEmbedBtn.textContent = 'Copy Embed';
    copyEmbedBtn.onclick = () => {
      navigator.clipboard.writeText(embedCode).then(() => {
        copyEmbedBtn.textContent = '✓ Copied!';
        copyEmbedBtn.classList.add('copied');
        setTimeout(() => { copyEmbedBtn.textContent = 'Copy Embed'; copyEmbedBtn.classList.remove('copied'); }, 2000);
      }).catch(() => { embedTa.select(); document.execCommand('copy'); });
    };
    dialog.appendChild(title);
    dialog.appendChild(sub);
    dialog.appendChild(row);
    dialog.appendChild(embedLabel);
    dialog.appendChild(embedTa);
    const embedRow = document.createElement('div');
    embedRow.className = 'share-dialog-row';
    embedRow.style.marginBottom = '0';
    embedRow.appendChild(copyEmbedBtn);
    dialog.appendChild(embedRow);
  } else {
    dialog.appendChild(title);
    dialog.appendChild(sub);
    dialog.appendChild(row);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'share-dialog-close';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => overlay.remove();
  actions.appendChild(closeBtn);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
  const kh = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', kh); } };
  document.addEventListener('keydown', kh);
}

async function showArtifactPreview(ref: ArtifactRef): Promise<void> {
  // Remove any existing modal
  document.getElementById('artifact-preview-overlay')?.remove();

  const icon = ARTIFACT_ICONS[ref.type] ?? '📎';
  const downloadUrl = `/api/artifacts/${ref.artifactId}/download`;

  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';
  overlay.id = 'artifact-preview-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'artifact-preview-dialog';
  dialog.addEventListener('click', (e) => e.stopPropagation());

  const header = document.createElement('div');
  header.className = 'apm-header';
  header.innerHTML = `<span class="apm-icon" aria-hidden="true">${icon}</span><span class="apm-title">${ref.name}</span>`;
  const typeBadge = document.createElement('span');
  typeBadge.className = 'apm-type';
  typeBadge.textContent = ref.language ? `${ref.type} · ${ref.language}` : `${ref.type} · v${ref.version}`;
  header.appendChild(typeBadge);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'apm-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'apm-body';
  body.innerHTML = '<div class="apm-loading">Loading…</div>';

  const footer = document.createElement('div');
  footer.className = 'apm-footer';
  const dlBtn = document.createElement('a');
  dlBtn.className = 'apm-dl-btn';
  dlBtn.href = downloadUrl;
  dlBtn.download = ref.name;
  dlBtn.textContent = 'Download';
  const fsBtn = document.createElement('button');
  fsBtn.className = 'apm-fullscreen-btn';
  fsBtn.title = 'Open in new tab';
  fsBtn.textContent = '⊞ Full';
  fsBtn.onclick = () => window.open(`/api/artifacts/${ref.artifactId}/render`, '_blank');
  const adminLink = document.createElement('a');
  adminLink.className = 'apm-admin-link';
  adminLink.href = `#artifacts/${ref.artifactId}`;
  adminLink.textContent = 'Open in admin →';
  adminLink.onclick = () => overlay.remove();
  footer.appendChild(dlBtn);
  footer.appendChild(fsBtn);

  // Phase 7: Share button
  const shareBtn = document.createElement('button');
  shareBtn.className = 'apm-share-btn';
  shareBtn.title = 'Create a shareable link';
  shareBtn.textContent = '🔗 Share';
  shareBtn.onclick = async () => {
    shareBtn.disabled = true;
    shareBtn.textContent = '🔗 Sharing…';
    try {
      const csrf = await getCsrfToken();
      const r = await fetch(`/api/artifacts/${ref.artifactId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({}),
      });
      if (r.ok) {
        const d = await r.json() as { url?: string };
        if (d.url) showShareDialog(ref.name, d.url, null);
      } else {
        void noticeDialog({ message: `Failed to create share link: ${await r.text()}` });
      }
    } finally {
      shareBtn.disabled = false;
      shareBtn.textContent = '🔗 Share';
    }
  };
  footer.appendChild(shareBtn);

  // Phase 7: Embed Code button
  const embedBtn = document.createElement('button');
  embedBtn.className = 'apm-embed-btn';
  embedBtn.title = 'Get embed code (iframe)';
  embedBtn.textContent = '</> Embed';
  embedBtn.onclick = async () => {
    embedBtn.disabled = true;
    embedBtn.textContent = '</> Loading…';
    try {
      const r = await fetch(`/api/artifacts/${ref.artifactId}/embed-code`);
      if (r.ok) {
        const d = await r.json() as { embedCode?: string; embedUrl?: string };
        if (d.embedCode) {
          const csrf = await getCsrfToken();
          const shareR = await fetch(`/api/artifacts/${ref.artifactId}/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({}),
          });
          const shareUrl = shareR.ok ? ((await shareR.json() as { url?: string }).url ?? d.embedUrl ?? '') : (d.embedUrl ?? '');
          showShareDialog(ref.name, shareUrl, d.embedCode);
        }
      } else {
        void noticeDialog({ message: `Failed to get embed code: ${await r.text()}` });
      }
    } finally {
      embedBtn.disabled = false;
      embedBtn.textContent = '</> Embed';
    }
  };
  footer.appendChild(embedBtn);

  // Phase 6: Refresh button for live artifacts
  let refreshBtn: HTMLButtonElement | null = null;
  if (ref.isLive) {
    refreshBtn = document.createElement('button');
    refreshBtn.className = 'apm-refresh-btn';
    refreshBtn.title = 'Refresh live data';
    refreshBtn.textContent = '⟳ Refresh';
    refreshBtn.onclick = async () => {
      if (!refreshBtn) return;
      refreshBtn.disabled = true;
      refreshBtn.textContent = '⟳ Refreshing…';
      try {
        const csrf = await getCsrfToken();
        const r = await fetch(`/api/artifacts/${ref.artifactId}/refresh`, {
          method: 'POST',
          headers: { 'x-csrf-token': csrf },
        });
        if (r.ok) {
          const iframe2 = body.querySelector('iframe');
          if (iframe2) { iframe2.src = iframe2.src; }
        }
      } finally {
        refreshBtn!.disabled = false;
        refreshBtn!.textContent = '⟳ Refresh';
      }
    };
    footer.appendChild(refreshBtn);

    // Listen for refresh messages from within the iframe toolbar
    const msgHandler = (e: MessageEvent) => {
      if (e.data?.type === 'artifact-refreshed' && e.data?.artifactId === ref.artifactId) {
        const iframe2 = body.querySelector('iframe');
        if (iframe2) { iframe2.src = iframe2.src; }
      }
    };
    window.addEventListener('message', msgHandler);
    overlay.addEventListener('remove', () => window.removeEventListener('message', msgHandler));
  }

  footer.appendChild(adminLink);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);

  // Keyboard close
  const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', keyHandler); } };
  document.addEventListener('keydown', keyHandler);
  overlay.addEventListener('remove', () => document.removeEventListener('keydown', keyHandler));

  // Phase 5: use server-side render endpoint — a single sandboxed iframe
  // for all types. The server generates the correct HTML wrapper per type
  // (Mermaid, React/Babel, highlight.js code, JSON tree, CSV table, etc.)
  // and sets CSP headers. No blob URL memory management needed.
  const renderUrl = `/api/artifacts/${ref.artifactId}/render`;

  const iframe = document.createElement('iframe');
  iframe.src = renderUrl;
  iframe.className = 'apm-render-frame';
  // allow-scripts: needed for CDN-loaded renderers (mermaid, hljs, babel)
  // allow-same-origin: needed for CDN ESM imports to work
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  body.innerHTML = '';
  body.appendChild(iframe);
}

function buildArtifactCards(refs: ArtifactRef[]): HTMLElement {
  const cards = refs.map((ref) => {
    const icon = ARTIFACT_ICONS[ref.type] ?? '📎';
    const downloadUrl = `/api/artifacts/${ref.artifactId}/data`;
    const isStreaming = ref.streamingStatus === 'streaming';
    const isError = ref.streamingStatus === 'error';
    const canPreview = !isStreaming && PREVIEWABLE_TYPES.has(ref.type);

    const nameEl = document.createElement('div');
    nameEl.className = 'ac-name';
    nameEl.textContent = ref.name;

    const metaEl = document.createElement('div');
    metaEl.className = 'ac-meta';
    metaEl.appendChild(document.createTextNode(`${ref.type} · v${ref.version}`));
    if (ref.language) {
      const langBadge = document.createElement('span');
      langBadge.className = 'ac-badge lang';
      langBadge.textContent = ref.language;
      metaEl.appendChild(langBadge);
    }
    if (isStreaming) {
      const streamBadge = document.createElement('span');
      streamBadge.className = 'ac-badge streaming';
      streamBadge.textContent = 'Generating…';
      metaEl.appendChild(streamBadge);
    } else if (isError) {
      const errBadge = document.createElement('span');
      errBadge.className = 'ac-badge';
      errBadge.style.cssText = 'background:rgba(239,68,68,.12);color:#f87171;border-color:rgba(239,68,68,.2)';
      errBadge.textContent = 'Error';
      metaEl.appendChild(errBadge);
    } else {
      if (ref.isLive) {
        const liveBadge = document.createElement('span');
        liveBadge.className = 'ac-badge live';
        liveBadge.textContent = 'Live';
        metaEl.appendChild(liveBadge);
      }
      if (canPreview) {
        const previewBadge = document.createElement('span');
        previewBadge.className = 'ac-badge';
        previewBadge.textContent = 'Preview';
        metaEl.appendChild(previewBadge);
      }
    }

    const bodyEl = document.createElement('div');
    bodyEl.className = 'ac-body';
    bodyEl.appendChild(nameEl);
    bodyEl.appendChild(metaEl);

    const iconEl = document.createElement('div');
    iconEl.className = 'ac-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.innerHTML = isError
      ? `<svg ${SVG_ICON_ATTRS}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
      : icon;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'ac-actions';

    if (canPreview) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'ac-preview';
      previewBtn.innerHTML = `<svg ${SVG_ICON_ATTRS} width="12" height="12"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
      previewBtn.title = 'Preview artifact';
      previewBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        void showArtifactPreview(ref);
      };
      actionsEl.appendChild(previewBtn);
    }

    if (!isStreaming) {
      const dlLink = document.createElement('a');
      dlLink.className = 'ac-dl';
      dlLink.href = downloadUrl;
      dlLink.download = ref.name;
      dlLink.title = 'Download artifact';
      dlLink.innerHTML = `<svg ${SVG_ICON_ATTRS} width="13" height="13"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      dlLink.onclick = (e) => e.stopPropagation();
      actionsEl.appendChild(dlLink);
    }

    const card = document.createElement('div');
    card.className = isStreaming ? 'artifact-card streaming' : 'artifact-card';
    card.title = `${ref.name} (${ref.type}, v${ref.version}) — click to ${canPreview ? 'preview' : 'open in admin'}`;
    card.addEventListener('click', () => {
      if (isStreaming) return; // don't open while generating
      if (canPreview) {
        void showArtifactPreview(ref);
      } else {
        window.location.hash = `#artifacts/${ref.artifactId}`;
      }
    });

    card.appendChild(iconEl);
    card.appendChild(bodyEl);
    card.appendChild(actionsEl);

    // Phase 4: streaming progress bar
    if (isStreaming) {
      const pct = Math.round((ref.streamingProgress ?? 0) * 100);
      const bar = document.createElement('div');
      bar.className = 'ac-stream-bar';
      bar.style.width = `${pct}%`;
      card.appendChild(bar);
    }

    return card;
  });

  const container = document.createElement('div');
  container.className = 'artifact-cards';
  cards.forEach(c => container.appendChild(c));
  return container;
}

const _feedbackLoadedChats = new Set<string>();
function renderMessages() {
  const container = document.querySelector('.messages');
  if (!container) return;

  // m137 — hydrate my thumbs state for this chat once (so already-rated answers show as rated).
  const cid = state.currentChatId as string | null;
  if (cid && !_feedbackLoadedChats.has(cid)) {
    _feedbackLoadedChats.add(cid);
    void loadChatFeedback(cid).then(() => { if (state.currentChatId === cid) renderMessages(); });
  }

  container.innerHTML = '';
  
  if (!state.messages.length) {
    const empty = h('div', {className:'empty-chat'},
      h('div',null,t('chat.emptyTitle')),
      h('div',null,t('chat.emptySubtitle'))
    );
    // m146: clickable conversation starters (curated + personalised). Picking one sends it straight away.
    const cards = buildStarterCards((p) => { void sendMessage(p.prompt); });
    if (cards) empty.appendChild(cards);
    container.appendChild(empty);
    return;
  }
  
  state.messages.forEach((m: Message, msgIndex: number) => {
    const isUser = m.role === 'user';
    const isStreamingCurrent = !isUser && state.streaming && msgIndex === state.messages.length - 1;
    const extras: HTMLElement[] = [];

    if (!isUser && (m as any).mode && (m as any).mode !== 'direct') {
      extras.push(h('span', { className: 'mode-badge' }, String((m as any).mode)));
    }

    if (!isUser && state.showProcessCard !== false) {
      const processCard = renderAssistantProcess(m as any, isStreamingCurrent, {
        rerenderMessages: renderMessages,
        renderProcessDetailView,
      });
      if (processCard) extras.push(processCard);
    }

    const meta = parseMessageMetadata((m as any)?.metadata);
    let corner: HTMLElement | null = null;
    if (!isUser) {
      const evalResult = (m as any)?.evalResult || meta?.eval;
      const cognitive = (m as any)?.cognitive || meta?.cognitive;
      const guardrail = (m as any)?.guardrail || meta?.guardrail;
      const indicators: HTMLElement[] = [];
      if (evalResult) {
        const passed = evalResult.passed ?? (evalResult.score >= 1);
        indicators.push(h('div', { className: 'resp-ind ' + (passed ? 'ok' : 'warn'), title: 'Evaluation result' }, passed ? '✓' : '!'));
      }
      if (cognitive) {
        const decision = cognitive.decision || 'allow';
        indicators.push(h('div', { className: 'resp-ind ' + (decision === 'deny' ? 'deny' : decision === 'warn' ? 'warn' : 'ok'), title: 'Cognitive check' }, '◉'));
      }
      if (guardrail) {
        const decision = guardrail.decision || 'allow';
        indicators.push(h('div', { className: 'resp-ind ' + (decision === 'deny' ? 'deny' : decision === 'warn' ? 'warn' : 'ok'), title: 'Guardrail status' }, decision === 'deny' ? '✕' : decision === 'warn' ? '⚠' : '✓'));
      }
      if (indicators.length) corner = h('div', { className: 'resp-corner' }, ...indicators);
    }

    let bubbleEl: HTMLElement;
    let responseExportHtml = '';
    const citedCites = !isUser ? (Array.isArray(meta?.citations) ? meta!.citations : null) : null;
    if (isStreamingCurrent) {
      // H18/H19 — while streaming, render a PLAIN-text bubble we can patch in place per token (no transcript
      // rebuild, no per-token markdown). Marked so patchStreamingBubble() can find it. Final markdown render
      // happens once the stream completes (this branch stops matching, the markdown branch below takes over).
      bubbleEl = h('div', { className: 'bubble' });
      bubbleEl.setAttribute('data-streaming-bubble', '1');
      bubbleEl.textContent = m.content || '';
    } else if (!isUser && (m as any).citing) {
      // m138 — a cited answer is being built (grounded, non-streaming).
      bubbleEl = h('div', { className: 'bubble' }, h('span', { className: 'meta' }, '❝ Searching your workspace…'));
    } else if (!isUser && (meta?.cited) && m.content) {
      // m138 — a settled cited answer: inline [n] chips + verified source cards.
      bubbleEl = h('div', { className: 'bubble' },
        renderCitedAnswer(m.content, citedCites || [], meta!.grounded !== false, meta!.groundingNote));
      responseExportHtml = mdToHtml(m.content);
    } else if (!isUser && m.content) {
      const rendered = renderAssistantBubble(m.content);
      bubbleEl = rendered.element;
      responseExportHtml = rendered.exportHtml;
    } else {
      bubbleEl = h('div', { className: 'bubble' }, m.content || (isStreamingCurrent ? '' : '...'));
    }

    const attachments = Array.isArray((m as any).attachments) ? (m as any).attachments : [];
    let attachmentsEl: HTMLElement | null = null;
    if (attachments.length) {
      attachmentsEl = h('div', { className: 'msg-attachments' },
        ...attachments.map((a: any) =>
          h('div', { className: 'msg-attachment' },
            h('div', { className: 'title' }, a?.name || 'Attachment'),
            h('div', null, `${a?.mimeType || 'file'} • ${Math.max(1, Math.round((Number(a?.size || 0) / 1024)))} KB`)
          )
        )
      );
    }

    let screenshotsEl: HTMLElement | null = null;
    if (!isUser && Array.isArray((m as any).screenshots) && (m as any).screenshots.length) {
      const imgs = (m as any).screenshots.map((s: any) => {
        const img = document.createElement('img');
        img.src = `data:image/${s?.format || 'png'};base64,${s?.base64 || ''}`;
        img.style.cssText = 'max-width:100%;border-radius:8px;margin-top:8px;border:1px solid var(--bg4);cursor:pointer;';
        img.onclick = () => window.open(img.src, '_blank');
        return img;
      });
      screenshotsEl = h('div', { className: 'screenshots' }, ...imgs);
    }

    // Phase 2-G: Artifact cards — type-aware cards with preview support
    let artifactCardsEl: HTMLElement | null = null;
    if (!isUser) {
      const artifactRefs: ArtifactRef[] = Array.isArray(meta?.artifactRefs) ? meta.artifactRefs : [];
      if (artifactRefs.length > 0) {
        artifactCardsEl = buildArtifactCards(artifactRefs);
      }
    }

    const toolbar = !isUser && m.content ? (() => {
      const bar = document.createElement('div');
      bar.className = 'response-toolbar';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'tb-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = () => { void copyResponse(m.content, copyBtn); };

      const emailBtn = document.createElement('button');
      emailBtn.className = 'tb-btn';
      emailBtn.textContent = 'Email';
      emailBtn.onclick = () => { void emailResponse(m.content, 'geneWeave Response'); };

      const wordBtn = document.createElement('button');
      wordBtn.className = 'tb-btn';
      wordBtn.textContent = 'Word';
      wordBtn.onclick = () => { void openInWord(responseExportHtml || mdToHtml(m.content), m.content); };

      bar.appendChild(copyBtn);
      bar.appendChild(emailBtn);
      bar.appendChild(wordBtn);
      // m137 — thumbs up/down + tiered reasons. Only on a settled (non-streaming) answer with an id.
      if (!isStreamingCurrent) {
        const fb = buildFeedbackControls(m, state.currentChatId as string, renderMessages);
        if (fb) bar.appendChild(fb);
        // m139 — Regenerate + version pager (‹ 2/3 ›). Cited answers keep their own sources, so skip them.
        if (!meta?.cited) {
          const ver = buildVersionControls(m, state.currentChatId as string, renderMessages);
          if (ver) bar.appendChild(ver);
        }
      }
      return bar;
    })() : null;

    // m137 — the "AI-generated" disclosure line (EU AI Act Art. 50), per-workspace configurable.
    const disclosureEl = !isUser && m.content && !isStreamingCurrent ? buildAiDisclosure() : null;

    const usage = (m as any).usage;
    const metaBar = !isUser && usage ? h('div', { className: 'meta' },
      h('span', null, `📊 ${formatCompactNumber(Number(usage.totalTokens || 0))} tok`),
      h('span', null, `💰 ${formatCurrencyCompact(Number((m as any).cost || 0), 6)}`),
      h('span', null, `⏱ ${formatMaybeCompactValue((m as any).latency_ms || 0)}ms`)
    ) : null;

    const thinkingIndicator = !isUser && isStreamingCurrent && !m.content
      ? h('div', { className: 'meta' }, 'Thinking...')
      : null;

    // Differentiated failure UI (Round 2): a content-policy REFUSAL is a calm "declined" note; any other
    // failure is a human, kind-specific error with a matching recovery (Try again / Sign in) — never a raw
    // technical string. Rendered only on the message that failed.
    const ma = m as any;
    let failureEl: HTMLElement | null = null;
    if (ma.refusal) {
      failureEl = h('div', { className: 'msg-refusal', role: 'note' },
        h('span', { className: 'msg-refusal-icon', 'aria-hidden': 'true' }, '⊘'),
        h('div', { className: 'msg-refusal-text' }, ma.refusalText || 'geneWeave declined this request.'));
    } else if (ma.errorKind) {
      const actions: HTMLElement[] = [];
      if (ma.errorRetryable) actions.push(h('button', { className: 'msg-retry', type: 'button', onClick: () => { void retryLastSend(); } }, 'Try again'));
      if (ma.errorSignIn) actions.push(h('button', { className: 'msg-retry', type: 'button', onClick: () => { void doLogout(); } }, 'Sign in'));
      failureEl = h('div', { className: `msg-error msg-error-${ma.errorKind}`, role: 'alert' },
        h('span', { className: 'msg-error-icon', 'aria-hidden': 'true' }, '⚠'),
        h('div', { className: 'msg-error-text' }, ma.errorText || 'Something went wrong. Please try again.'),
        actions.length ? h('div', { className: 'msg-error-actions' }, ...actions) : null);
    }

    const body = h('div', { className: 'msg-body' },
      corner,
      ...extras,
      // Don't show the empty "..." placeholder bubble when the message is purely a failure/refusal.
      (ma.errorKind || ma.refusal) && !m.content ? null : bubbleEl,
      failureEl,
      attachmentsEl,
      screenshotsEl,
      artifactCardsEl,
      toolbar,
      disclosureEl,
      metaBar,
      thinkingIndicator
    );

    let avatarEl: HTMLElement;
    if (isUser) {
      const img = document.createElement('img');
      img.src = getUserAvatarUrl();
      img.alt = 'User';
      avatarEl = h('div', { className: 'avatar' }, img);
    } else {
      let agentName = '';
      const steps = Array.isArray((m as any).steps) ? (m as any).steps : [];
      for (const st of steps) {
        if (st?.type === 'delegation' && (st?.worker || st?.name)) {
          agentName = st.worker || st.name;
          break;
        }
        if (st?.type === 'tool_call' && st?.toolCall?.name === 'delegate_to_worker' && st?.toolCall?.arguments?.worker) {
          agentName = st.toolCall.arguments.worker;
          break;
        }
      }
      const aImg = document.createElement('img');
      aImg.src = getAgentAvatarUrl(agentName);
      aImg.alt = agentName || 'Agent';
      avatarEl = h('div', { className: 'avatar' }, aImg);
    }
    
    const msgEl = h('div', {className:'msg ' + (isUser ? 'user' : 'assistant')},
      avatarEl,
      body
    );
    
    container.appendChild(msgEl);
  });

  // Preserve transcript scroll across this rebuild (`.messages` element persists; only children changed).
  // Follow to the bottom ONLY if the reader is already there; otherwise keep their exact position — so a
  // per-token streaming re-render never yanks a user who scrolled up to read history. (H14/H16.)
  state.suppressTranscriptScrollPersist = true;
  (container as HTMLElement).scrollTop = state.transcriptAtBottom !== false ? container.scrollHeight : (state.transcriptScrollTop || 0);
  requestAnimationFrame(() => { state.suppressTranscriptScrollPersist = false; });
}

function renderChatView() {
  return renderChatViewShell({
    render,
    renderMessages,
    sendMessage,
    stopStreaming,
  });
}

function renderSettingsDropdown() {
  return renderSettingsDropdownView({
    render,
    saveChatSettings,
  });
}

function renderPromptSetupWizard() {
  return renderPromptSetupWizardView(render);
}

function renderPreferencesView() {
  const view = h('div', { className: 'dash-view', style: 'max-width:640px;' },
    h('h2', { style: 'margin-bottom:4px;' }, 'Preferences'),
    h('p', { style: 'font-size:13px;color:var(--fg2);margin:0 0 20px;' },
      state.user?.email ? `Signed in as ${state.user.email}` : 'Account settings')
  );

  // Helper to render a single preference row
  const row = (label: string, hint: string, control: HTMLElement) =>
    h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--bd);',
    },
      h('div', { style: 'min-width:0;flex:1;' },
        h('div', { style: 'font-size:13px;font-weight:600;color:var(--fg);' }, label),
        h('div', { style: 'font-size:12px;color:var(--fg2);margin-top:2px;line-height:1.4;' }, hint)
      ),
      control
    );

  // Theme: compact segmented control
  const themeSegment = h('div', {
    style: 'display:inline-flex;border:1px solid var(--bd);border-radius:6px;overflow:hidden;',
  });
  const themeOption = (value: 'light' | 'dark', label: string) => {
    const active = state.theme === value;
    return h('button', {
      style: `padding:6px 12px;font-size:12px;border:none;cursor:pointer;background:${active ? 'var(--fg)' : 'transparent'};color:${active ? 'var(--bg)' : 'var(--fg2)'};`,
      onClick: () => {
        state.theme = value;
        document.documentElement.setAttribute('data-theme', value);
        saveUserPreferences();
        render();
      },
    }, label);
  };
  themeSegment.appendChild(themeOption('light', 'Light'));
  themeSegment.appendChild(themeOption('dark', 'Dark'));

  // Show process card: simple checkbox
  const showProcess = state.showProcessCard !== false;
  const processToggle = h('input', {
    type: 'checkbox',
    checked: showProcess,
    style: 'transform:scale(1.2);cursor:pointer;',
    onChange: function (this: HTMLInputElement) {
      state.showProcessCard = this.checked;
      saveUserPreferences();
      render();
    },
  });

  const list = h('div', {
    style: 'border-top:1px solid var(--bd);',
  },
    row('Theme', 'Light or dark interface', themeSegment),
    row('Show agent flow in chat', 'Display skill activations, tool calls, and reasoning under assistant replies', processToggle)
  );

  view.appendChild(list);
  return view;
}

function renderHomeWorkspace() {
  const settingsAnchor = h('div', { className: 'dropdown-anchor' });
  const settingsBtn = h('button', {
    className: 'nav-btn' + (state.showSettings ? ' active' : ''),
    title: 'AI Settings',
    // H12 — announce this as a popup menu button + its open/closed state; keep a stable focus key so Esc/
    // outside-click can return focus here after the re-render (see the Esc handler in initialize()).
    'aria-haspopup': 'true',
    'aria-expanded': state.showSettings ? 'true' : 'false',
    'aria-label': 'AI settings',
    'data-focus-key': 'chat-settings-trigger',
    style: 'font-size:12px;padding:7px 10px;line-height:1;',
    onClick: async (e: Event) => {
      e.stopPropagation();
      if (!state.chatSettings && state.currentChatId) {
        await loadChatSettings(state.currentChatId);
      }
      if (!state.chatSettings) {
        state.chatSettings = {
          mode: state.defaultMode || 'direct',
          systemPrompt: '',
          timezone: '',
          enabledTools: [],
          redactionEnabled: false,
          redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
          workers: [],
          reflectEnabled: false,
          reflectMaxRevisions: 2,
          verifyEnabled: false,
          verifyMinScore: 0.7,
          verifyMaxAttempts: 3,
          supervisorReplanOnFailure: false,
          supervisorParallelDelegation: false,
          ensembleAgents: [],
          ensembleResolver: 'majority_vote',
        };
      }
      state.showSettings = !state.showSettings;
      // Load voice config so the Voice Pipeline section in settings is populated
      if (state.showSettings && !state.voiceConfig) {
        void loadVoiceConfigSettings();
      }
      render();
    },
  }, '⚙');
  settingsAnchor.appendChild(settingsBtn);

  if (state.showSettings && state.chatSettings) {
    // Remove any stale dropdown from a previous render before creating the fresh one
    document.querySelectorAll('.settings-dd').forEach((el) => el.remove());
    const dd = renderSettingsDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(() => {
      const r = settingsBtn.getBoundingClientRect();
      dd.style.top = (r.bottom + 8) + 'px';
      dd.style.right = (window.innerWidth - r.right) + 'px';
    });
  }

  // Model selection control: hide entirely when a routing policy is active
  // (server overrides selection); otherwise let the user pick a model.
  let modelControl: HTMLElement | null;
  if (state.activeRoutingPolicy) {
    modelControl = null;
  } else {
    const modelSel = h('select', {
      className: 'model-sel',
      onChange: function(this: HTMLSelectElement) {
        state.selectedModel = this.value;
      },
    }) as HTMLSelectElement;
    (state.models || []).forEach((m: any) => {
      const val = `${m.provider}:${m.id}`;
      const opt = h('option', { value: val }, `${m.provider}/${m.id}`) as HTMLOptionElement;
      if (val === state.selectedModel) opt.selected = true;
      modelSel.appendChild(opt);
    });
    modelControl = modelSel;
  }

  const center = h('section', {className:'center-card'},
    h('div', {className:'center-card-hdr'},
      h('div', {className:'agent-strip'},
        h('div', {className:'lead'}, h('img', {src:getAgentAvatarUrl('geneweave-supervisor')}), h('span',null,'geneWeave Agent'))
      ),
      h('div', {style:'display:flex;align-items:center;gap:8px'},
        h('div', {className:'title'}, (state.chats.find((c: Chat) => c.id === state.currentChatId)?.title) || 'Conversation'),
        modelControl,
        settingsAnchor
      )
    ),
    renderChatView()
  );

  const rightRail = h('aside', { className: 'right-rail' },
    renderCalendarWidget(render),
    renderActionsWidget(selectChat, render)
  );

  return h('div', {className:'workspace-home'},
    h('div', { className: 'workspace-body' }, center, rightRail)
  );
}

function renderApp() {
  const wrap = h('div', {className:'app'});
  // weaveNotes (design handoff): the Notes app is a FULL-BLEED 3-column surface — its own
  // notebooks rail is the primary nav (the brand logo returns to the rest of the app), so we
  // skip the global workspace nav + top-card header to match the standalone design exactly.
  if (state.view === 'notes') {
    wrap.classList.add('app-fullbleed');
    wrap.appendChild(renderNotesView(render));
    return wrap;
  }
  // Builder — the full-bleed three-pane "configure the assistant" app (its own nav),
  // recreated from "GeneWeave Builder.dc.html" as a Builder-styled skin over the WHOLE admin.
  if (state.view === 'builder') {
    wrap.classList.add('app-fullbleed');
    wrap.appendChild(renderBuilderView(render, { loadAdmin }));
    return wrap;
  }
  // Account — the full-bleed settings surface (its own 256px nav + sticky Save bar), recreated from
  // "GeneWeave Account.dc.html". `preferences` is kept as an alias so old entry points still land here.
  if (state.view === 'account' || state.view === 'preferences') {
    wrap.classList.add('app-fullbleed');
    wrap.appendChild(renderAccountView(render));
    return wrap;
  }
  wrap.appendChild(renderWorkspaceNav({
    render,
    openConnectorsView: () => { void openConnectorsView(render); },
    loadDashboard,
    loadAdmin,
    clearAdminEditorState,
    selectChat,
    deleteChat,
  }));

  // Responsive adaptive shell: on tablet/mobile the workspace nav is an off-canvas drawer. A backdrop
  // (CSS-hidden on desktop) closes it on tap; a hamburger in the header opens it. 44px hit targets.
  const backdrop = h('div', { className: 'nav-backdrop', 'aria-hidden': 'true', onClick: () => wrap.classList.remove('nav-open') }) as HTMLElement;
  wrap.appendChild(backdrop);
  const hamburger = h('button', {
    className: 'gw-hamburger', type: 'button', 'aria-label': 'Open navigation menu', 'aria-expanded': 'false',
    onClick: () => { const open = wrap.classList.toggle('nav-open'); (hamburger as HTMLElement).setAttribute('aria-expanded', String(open)); },
    innerHTML: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  }) as HTMLElement;

  const main = h('div', {className:'main'});
  main.appendChild(h('div', { className: 'main-header' },
    hamburger,
    renderWorkspaceTopCard({
      render,
      createChat,
      selectChat,
      renderProfileDropdown: () => renderProfileDropdown({ render, doLogout, loadDashboard, loadAdmin }),
    })
  ));
  if (state.view === 'dashboard') {
    main.appendChild(renderDashboardView({
      render,
      loadAdmin,
      formatCompactNumber,
      formatCurrencyCompact,
      formatMaybeCompactValue,
    }));
  } else if (state.view === 'admin') {
    main.appendChild(renderAdminView({
      hydrateWizardFromPrompt,
      renderPromptSetupWizard,
      render,
      loadAdmin,
    }));
  } else if (state.view === 'connectors') {
    main.appendChild(renderConnectorsView(render));
  } else if (state.view === 'preferences') {
    main.appendChild(renderPreferencesView());
  } else if (state.view === 'scientific-validation') {
    const svView = (state as any).svView as string;
    if (svView === 'live') {
      main.appendChild(renderSVLiveView({ render }));
    } else if (svView === 'verdict') {
      main.appendChild(renderSVVerdictView({ render }));
    } else {
      main.appendChild(renderSVSubmitView({ render }));
    }
  } else if (state.view === 'kaggle-competition') {
    const kv = (state as any).kaggleView as string;
    if (kv === 'flow') {
      main.appendChild(renderKaggleFlowView({ render }));
    } else {
      main.appendChild(renderKaggleListView({ render }));
    }
  } else if (state.view === 'calendar') {
    main.appendChild(renderCalendarView(render));
  } else if (state.view === 'notes') {
    main.appendChild(renderNotesView(render));
  } else if (state.view === 'design') {
    main.appendChild(renderDesignSystemView(render));
  } else {
    main.appendChild(renderHomeWorkspace());
  }
  wrap.appendChild(main);
  
  return wrap;
}

const UI_STATE_KEY = 'geneweave.uiState.v1';
let renderVersion = 0;

function restoreUiStateFromStorage() {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as any;
    const allowedViews = new Set(['chat', 'connectors', 'admin', 'dashboard', 'preferences', 'scientific-validation', 'kaggle-competition', 'calendar', 'notes', 'design', 'builder']);

    if (typeof saved?.view === 'string' && allowedViews.has(saved.view)) {
      state.view = saved.view;
    }
    if (typeof saved?.adminTab === 'string') {
      state.adminTab = saved.adminTab;
    }
    if (typeof saved?.currentChatId === 'string' || saved?.currentChatId === null) {
      state.currentChatId = saved.currentChatId;
    }
    if (typeof saved?.adminMenuExpanded === 'boolean') {
      state.adminMenuExpanded = saved.adminMenuExpanded;
    }
    if (typeof saved?.recentChatsExpanded === 'boolean') {
      state.recentChatsExpanded = saved.recentChatsExpanded;
    }
    if (typeof saved?.sidebarCollapsed === 'boolean') {
      state.sidebarCollapsed = saved.sidebarCollapsed;
    }
    if (typeof saved?.svView === 'string' && ['submit', 'live', 'verdict'].includes(saved.svView)) {
      (state as any).svView = saved.svView;
    }
    if (typeof saved?.svHypothesisId === 'string') {
      (state as any).svHypothesisId = saved.svHypothesisId;
    }
    if (typeof saved?.kaggleView === 'string' && ['list', 'flow'].includes(saved.kaggleView)) {
      (state as any).kaggleView = saved.kaggleView;
    }
    if (typeof saved?.kaggleRunId === 'string') {
      (state as any).kaggleRunId = saved.kaggleRunId;
    }
    if (saved?.adminGroupExpanded && typeof saved.adminGroupExpanded === 'object') {
      const next: Record<string, boolean> = {};
      Object.entries(saved.adminGroupExpanded).forEach(([k, v]) => {
        if (typeof v === 'boolean') next[k] = v;
      });
      state.adminGroupExpanded = next;
    }
  } catch {
    // Ignore malformed localStorage state.
  }
}

function persistUiStateToStorage() {
  if (typeof window === 'undefined') return;
  try {
    const payload = {
      view: state.view,
      adminTab: state.adminTab,
      currentChatId: state.currentChatId,
      adminMenuExpanded: !!state.adminMenuExpanded,
      adminGroupExpanded: state.adminGroupExpanded || {},
      recentChatsExpanded: typeof state.recentChatsExpanded === 'boolean' ? state.recentChatsExpanded : true,
      sidebarCollapsed: !!state.sidebarCollapsed,
      svView: (state as any).svView ?? 'submit',
      svHypothesisId: (state as any).svHypothesisId ?? null,
      kaggleView: (state as any).kaggleView ?? 'list',
      kaggleRunId: (state as any).kaggleRunId ?? null,
    };
    window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage write failures.
  }
}

// Global render function
function render() {
  persistUiStateToStorage();
  document.querySelectorAll('body > .dropdown').forEach((el) => el.remove());
  const root = document.getElementById('root');
  if (!root) return;
  // Preserve the sidebar scroll across the full-DOM re-render. A single user action (e.g. selecting a
  // chat) can trigger SEVERAL renders in quick succession; an intermediate render sees a DOM whose scroll
  // was just reset to 0 by `innerHTML = ''`. Reading that 0 and overwriting the persisted position would
  // lose the user's place — so take the MAX of the live DOM scroll and the value kept current by the nav's
  // scroll listener (state.sidebarScrollTop). This makes scroll-retention robust to render bursts.
  const navBeforeRender = root.querySelector('.workspace-nav-scroll') as HTMLElement | null;
  const domScroll = navBeforeRender ? navBeforeRender.scrollTop : 0;
  const previousSidebarScrollTop = Math.max(domScroll, state.sidebarScrollTop || 0);
  state.sidebarScrollTop = previousSidebarScrollTop;
  const thisRenderVersion = ++renderVersion;
  // H13 — capture keyboard focus (+ text caret) BEFORE the full-DOM rebuild wipes it, so a keyboard/
  // screen-reader user isn't dumped to the top of the page after every action. Restored below.
  const savedFocus = captureFocus();
  // H14 — snapshot every [data-scroll-key] scroll container (notes list, admin tables, dashboard) before the
  // wipe, so they don't jump to the top on re-render. Restored in the double-rAF below.
  if (state.user) captureScrollState(root); // only the app branch has scroll containers + a restore pass

  if (!state.user) {
    root.innerHTML = '';
    root.appendChild(renderAuth());
    restoreFocus(savedFocus, root);
  } else {
    root.innerHTML = '';
    root.appendChild(renderApp());
    restoreFocus(savedFocus, root);
    // Double-rAF: first frame inserts DOM, second frame has computed layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (thisRenderVersion !== renderVersion) return;
        // H14 — restore every generic [data-scroll-key] container (notes list, admin tables, dashboard).
        restoreScrollState(root);
        // Restore the chat transcript scroll: pin to the bottom only if the user was already there
        // (so a streaming response keeps following), otherwise restore their exact position (so scrolling
        // up to read history is never yanked back down). Round 3 / H14 — same pattern as the sidebar.
        const msgsEl = root.querySelector('.messages') as HTMLElement | null;
        if (msgsEl) {
          state.suppressTranscriptScrollPersist = true;
          msgsEl.scrollTop = state.transcriptAtBottom !== false ? msgsEl.scrollHeight : (state.transcriptScrollTop || 0);
          requestAnimationFrame(() => { state.suppressTranscriptScrollPersist = false; });
        }
        const navScrollEl = root.querySelector('.workspace-nav-scroll') as HTMLElement | null;
        if (!navScrollEl) return;
        // Suppress scroll-listener persistence while we restore, so the restore's own (possibly clamped)
        // scroll event can't degrade the saved position. Cleared on the next frame.
        state.suppressSidebarScrollPersist = true;
        navScrollEl.scrollTop = previousSidebarScrollTop;
        const activeSubTab = navScrollEl.querySelector('.admin-subtab.active') as HTMLElement | null;
        if (activeSubTab) {
          // Keep the active tab visible while preserving current sidebar position as much as possible.
          const containerRect = navScrollEl.getBoundingClientRect();
          const elRect = activeSubTab.getBoundingClientRect();
          if (elRect.top < containerRect.top) {
            navScrollEl.scrollTop += elRect.top - containerRect.top - 12;
          } else if (elRect.bottom > containerRect.bottom) {
            navScrollEl.scrollTop += elRect.bottom - containerRect.bottom + 12;
          }
        }
        // Do NOT re-persist state.sidebarScrollTop from this readback: during a render burst (e.g. the chat
        // list is momentarily empty while selectChat reloads), the target scroll clamps to a small value,
        // and persisting that clamped 0 would lose the user's place forever. The nav's own scroll listener
        // keeps state.sidebarScrollTop authoritative for real user scrolls, so a later render restores it.
        requestAnimationFrame(() => { state.suppressSidebarScrollPersist = false; });
      });
    });
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * geneWeave UI rebuild — apply this workspace's per-tenant Appearance / branding at runtime. Fetches the
 * caller's own resolved (accessibility-safe) brand and applies it as CSS custom properties + data-*
 * attributes, so the whole app re-brands with no flash. AI-agency colours (mint/emerald) are never
 * re-branded. Best-effort — a workspace with no branding just keeps the defaults.
 */
async function applyTenantAppearance(): Promise<void> {
  try {
    const res = await api.get('/api/me/appearance');
    if (!res || !(res as Response).ok) return;
    const a = await (res as Response).json() as {
      enabled?: boolean; colorScheme?: string; variant?: string; density?: string;
      brandName?: string | null; logoSvg?: string | null;
      vars?: { light?: Record<string, string>; dark?: Record<string, string> };
    };
    if (!a || a.enabled === false) return;
    const rootEl = document.documentElement;
    // Colour scheme — 'system' respects the OS; else force light/dark.
    let scheme = a.colorScheme || 'system';
    if (scheme === 'system') scheme = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
    if (scheme === 'dark' || scheme === 'light') { rootEl.setAttribute('data-theme', scheme); (state as { theme?: string }).theme = scheme; }
    // Pro / Creative default look.
    if (a.variant === 'creative') rootEl.setAttribute('data-variant', 'creative'); else rootEl.removeAttribute('data-variant');
    // Density.
    rootEl.setAttribute('data-density', a.density || 'comfortable');
    // Brand variables for the active scheme (legacy --accent etc. the shipped stylesheet consumes).
    const vars = (scheme === 'dark' ? a.vars?.dark : a.vars?.light) || {};
    for (const [k, v] of Object.entries(vars)) { if (/^--[\w-]+$/.test(k)) rootEl.style.setProperty(k, String(v).replace(/[;{}<>]/g, '')); }
    // Brand name + logo — exposed for the shell wordmark to pick up.
    if (a.brandName) (window as unknown as Record<string, unknown>)['__gwBrandName'] = a.brandName;
    if (a.logoSvg) (window as unknown as Record<string, unknown>)['__gwBrandLogo'] = a.logoSvg;
  } catch { /* keep defaults */ }
}

export function initialize() {
  // Responsive shell: Escape closes the mobile nav / rail drawers (keyboard accessibility).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Light-dismiss the global-state overlays (profile / notifications / settings) on Esc, and return
    // focus to whichever trigger opened them (WCAG 2.4.3 focus order / 2.1.2 no keyboard trap).
    if (state.showProfile || state.showNotifications || state.showSettings) {
      // H12 — return focus to the trigger that opened the overlay (profile avatar or the AI-settings button).
      const returnSel = state.showProfile ? '.profile-avatar' : state.showSettings ? '[data-focus-key="chat-settings-trigger"]' : null;
      const returnTo = returnSel ? document.querySelector<HTMLElement>(returnSel) : null;
      state.showProfile = false; state.showNotifications = false; state.showSettings = false;
      render();
      returnTo?.focus();
      return;
    }
    document.querySelector('.app')?.classList.remove('nav-open', 'rail-open');
  });
  document.addEventListener('click', () => {
    if (state.showSettings || state.showProfile || state.showNotifications) {
      state.showSettings = false;
      state.showProfile = false;
      state.showNotifications = false;
      render();
    }
  });

  // Check authentication and load data
  (async () => {
    try {
      restoreUiStateFromStorage();

      // Apply admin deep-link hash before rendering (e.g. #admin/prompts/42)
      const adminHashTarget = parseAdminHash();
      if (adminHashTarget) {
        state.view = 'admin';
        state.adminTab = adminHashTarget.tab;
        state.adminMenuExpanded = true;
      }

      const r = await api.get('/auth/check');
      if (r && typeof r === 'object' && 'ok' in r && (r as Response).ok) {
        const d = await (r as Response).json() as any;
        if (d.authenticated) {
        state.user = d.user;
        state.csrfToken = d.csrfToken;
        // geneWeave UI rebuild: apply this workspace's per-tenant branding before first render (no flash).
        await applyTenantAppearance();
        // m137: load this workspace's AI-transparency config (AI-generated label + whether feedback is on).
        await loadAiTransparency();
        // m138: load the answer-citations config (whether the composer offers "Cite sources").
        await loadChatCitationsConfig();
        // m139: load the answer-versions config (whether answers offer Regenerate + a version pager).
        await loadAnswerVersionsConfig();
        // m140: load accessibility defaults (screen-reader announce mode + reduced motion).
        await loadAccessibilityConfig();
        // m143: load which UI areas this user may see (RBAC surface parity) before the first render.
        await loadWorkspaceAccess();
        // m145: load the interface-language message pack for this reader (their saved language, else the
        // workspace default) before the first render, so the UI renders already-translated (no flash).
        await loadI18n();
        // m146: load the empty-chat conversation starters (curated + personalised) so they're ready to show.
        await loadSuggestedPrompts();
        // weaveNotes Phase 8 (desktop): wire the global quick-capture shortcut (⌘/Ctrl+Shift+K, or the
        // Tauri OS-global hotkey). Capturing jumps into the new note. Wired once per session.
        try {
          const { wireQuickCapture } = await import('./ui/notes-quick-capture.js');
          wireQuickCapture(async (noteId: string) => {
            state.view = 'notes';
            (state as { notesView?: string }).notesView = 'editor';
            const { loadNote } = await import('./ui/notes-view.js');
            await loadNote(noteId);
            render();
          });
        } catch { /* non-fatal */ }
        // weaveNotes Phase 2: if we arrived via a note share link, redeem it and
        // jump straight into that note's collaborative editor.
        try {
          const { maybeJoinNoteFromUrl } = await import('./ui/notes-coedit.js');
          const joinedNoteId = await maybeJoinNoteFromUrl();
          if (joinedNoteId) {
            state.view = 'notes';
            (state as { notesView?: string }).notesView = 'editor';
            const { loadNote } = await import('./ui/notes-view.js');
            await loadNote(joinedNoteId);
          }
        } catch { /* non-fatal */ }
        await loadChats();
        await Promise.all([loadModels(), loadActiveRoutingPolicy(), loadTools(), loadUserPreferences()]);
        // Load action feed + calendar data eagerly (they populate the right rail widgets)
        void loadActionFeed();
        void loadCalendarCategories();
        void loadCalendarItems();

        if (state.view === 'dashboard') {
          await loadDashboard();
        } else if (state.view === 'calendar') {
          await loadCalendarItems();
        } else if (state.view === 'notes') {
          await loadNotesList();
          // weaveNotes Phase 8 (desktop): launch straight into the note you last had open.
          if (!state.currentNoteId && (state as { notesView?: string }).notesView !== 'editor') {
            try { const { openLastNote } = await import('./ui/notes-view.js'); await openLastNote(render); } catch { /* */ }
          }
        } else if (state.view === 'connectors') {
          await openConnectorsView(render);
        } else if (state.view === 'admin') {
          await loadAdmin();
          // If URL had a record deep-link, open that record after data is loaded
          if (adminHashTarget?.id) {
            const tabRows = (state.adminData?.[adminHashTarget.tab] || []) as any[];
            const targetRow = tabRows.find((r: any) =>
              String(r?.id ?? '') === String(adminHashTarget.id) ||
              String(r?.[getAdminSchema(adminHashTarget.tab)?.cols?.[0]] ?? '') === String(adminHashTarget.id)
            );
            if (targetRow) {
              adminEditRow(adminHashTarget.tab, targetRow, hydrateWizardFromPrompt, render);
            }
          }
        }
        }
      }
      render();
    } catch (e) {
      console.error('Initialization failed:', e);
      render();
    }
  })();
}

// Make functions globally available
(globalThis as any).render = render;
(globalThis as any).sendMessage = sendMessage;
(globalThis as any).stopStreaming = stopStreaming;
(globalThis as any).renderMessages = renderMessages;
(globalThis as any).createChat = createChat;
(globalThis as any).selectChat = selectChat;
(globalThis as any).doLogout = doLogout;
(globalThis as any).initialize = initialize;
(globalThis as any).state = state;
(globalThis as any).loadI18n = loadI18n;
(globalThis as any).loadSuggestedPrompts = loadSuggestedPrompts;
