// API client for backend communication
import { state } from './state.js';
import { confirmDialog } from "./dialog.js";
import { reportLoadError, dismiss as dismissLoadError } from './load-error.js';

// Client gets ADMIN_SCHEMA from window globals (set by server in HTML)
function getAdminSchema(): any {
  return (typeof window !== 'undefined' && (window as any).ADMIN_SCHEMA) || {};
}

function triggerRender() {
  (globalThis as any).render?.();
}

// CSRF token management
function getCsrfToken(): string {
  return state.csrfToken || '';
}

/**
 * weaveNotes Phase 8: detect the Tauri desktop shell so the server can record "on desktop" provenance
 * (the webview injects `window.__TAURI__` / `__TAURI_INTERNALS__`). In a plain browser this is false
 * and no client header is sent — the same web build runs as both the web app and the desktop shell.
 */
function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return !!(w['__TAURI__'] || w['__TAURI_INTERNALS__']);
}

// Generic fetch wrapper with CSRF support
async function fetchWithCsrf(url: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  if (getCsrfToken()) {
    headers.set('X-CSRF-Token', getCsrfToken());
  }
  if (isDesktopShell()) {
    headers.set('X-Client-Version', 'geneweave-desktop/1.0.0');
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  return response;
}

export const api = {
  // GET
  get: async (path: string) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url);
  },

  // POST
  post: async (path: string, body: any = {}) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // PUT
  put: async (path: string, body: any = {}) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  // PATCH
  patch: async (path: string, body: any = {}) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  // DELETE
  del: async (path: string) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url, {
      method: 'DELETE',
    });
  },
};

function parseMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeServerMessage(message: any) {
  const meta = parseMetadata(message?.metadata);
  return {
    ...message,
    metadata: message?.metadata ?? null,
    attachments: Array.isArray(message?.attachments)
      ? message.attachments
      : Array.isArray(meta['attachments'])
        ? meta['attachments']
        : [],
    steps: Array.isArray(message?.steps)
      ? message.steps
      : Array.isArray(meta['steps'])
        ? meta['steps']
        : [],
    evalResult: message?.evalResult ?? meta['eval'] ?? null,
    cognitive: message?.cognitive ?? meta['cognitive'] ?? null,
    guardrail: message?.guardrail ?? meta['guardrail'] ?? null,
    activeSkills: Array.isArray(message?.activeSkills)
      ? message.activeSkills
      : Array.isArray(meta['activeSkills'])
        ? meta['activeSkills']
        : [],
    skillTools: Array.isArray(message?.skillTools)
      ? message.skillTools
      : Array.isArray(meta['skillTools'])
        ? meta['skillTools']
        : [],
    enabledTools: Array.isArray(message?.enabledTools)
      ? message.enabledTools
      : Array.isArray(meta['enabledTools'])
        ? meta['enabledTools']
        : [],
    skillPromptApplied: message?.skillPromptApplied ?? !!meta['skillPromptApplied'],
    mode: message?.mode ?? meta['mode'] ?? null,
    ensembleCandidates: Array.isArray(message?.ensembleCandidates)
      ? message.ensembleCandidates
      : Array.isArray(meta['ensembleCandidates'])
        ? meta['ensembleCandidates']
        : undefined,
    ensembleRationale: message?.ensembleRationale ?? meta['ensembleRationale'] ?? undefined,
    ensembleWinner: message?.ensembleWinner ?? meta['ensembleWinner'] ?? undefined,
  };
}

// Chat operations
export async function loadChats() {
  try {
    const r = await api.get('/chats');
    const data = await r.json();
    state.chats = data.chats || [];
    const hasCurrent = state.currentChatId && state.chats.some((chat: any) => chat.id === state.currentChatId);
    if (!hasCurrent) {
      state.currentChatId = state.chats[0]?.id || null;
      state.messages = [];
    }
    if (state.currentChatId && state.messages.length === 0) {
      const [messagesResp] = await Promise.all([
        api.get(`/chats/${state.currentChatId}/messages`),
        loadChatSettings(state.currentChatId),
      ]);
      const messagesData = await messagesResp.json();
      state.messages = Array.isArray(messagesData.messages)
        ? messagesData.messages.map(normalizeServerMessage)
        : [];
    }
    dismissLoadError('your chats');
    triggerRender();
  } catch (e) {
    console.error('Failed to load chats', e);
    reportLoadError('your chats', e, () => { void loadChats(); }); // H15 — visible + recoverable, not silent
  }
}

export async function selectChat(id: string) {
  state.currentChatId = id;
  triggerRender();
  try {
    const [messagesResp, _settingsResp] = await Promise.all([
      api.get(`/chats/${id}/messages`),
      loadChatSettings(id),
    ]);
    const data = await messagesResp.json();
    state.messages = Array.isArray(data.messages)
      ? data.messages.map(normalizeServerMessage)
      : [];
    dismissLoadError('this conversation');
    triggerRender();
  } catch (e) {
    console.error('Failed to load chat', e);
    reportLoadError('this conversation', e, () => { void selectChat(id); });
  }
}

export async function createChat() {
  try {
    const parts = String(state.selectedModel || '').split(':');
    const r = await api.post('/chats', {
      model: parts[1] || state.selectedModel,
      provider: parts[0] || '',
    });
    const data = await r.json();
    const chat = data.chat;
    if (chat) {
      state.chats.unshift(chat);
      state.currentChatId = chat.id;
      state.messages = [];
      await loadChatSettings(chat.id);
      if (state.chatSettings && state.defaultMode) {
        state.chatSettings.mode = state.defaultMode;
        await saveChatSettings();
      }
      triggerRender();
    }
  } catch (e) {
    console.error('Failed to create chat', e);
  }
}

export async function deleteChat(id: string) {
  if (!(await confirmDialog({ message: 'Delete this chat? This cannot be undone.', danger: true, confirmLabel: 'Delete chat' }))) return;
  try {
    await api.del(`/chats/${id}`);
    state.chats = state.chats.filter((c: any) => c.id !== id);
    if (state.currentChatId === id) {
      state.currentChatId = state.chats[0]?.id || null;
      state.messages = [];
    }
    triggerRender();
  } catch (e) {
    console.error('Failed to delete chat', e);
  }
}

// Models & tools
export async function loadModels() {
  try {
    const r = await api.get('/models');
    const data = await r.json();
    state.models = data.models || [];
    if (!state.selectedModel && data.defaultModel) {
      state.selectedModel = data.defaultModel;
    }
    dismissLoadError('the model list');
    triggerRender();
  } catch (e) {
    console.error('Failed to load models', e);
    reportLoadError('the model list', e, () => { void loadModels(); });
  }
}

// Active routing policy — when set, server overrides the chat model selection
export async function loadActiveRoutingPolicy() {
  try {
    const r = await api.get('/routing/active');
    if (!r.ok) { state.activeRoutingPolicy = null; return; }
    const data = await r.json();
    const first = Array.isArray(data?.active) && data.active.length > 0 ? data.active[0] : null;
    state.activeRoutingPolicy = first ? { name: first.name, strategy: first.strategy } : null;
    triggerRender();
  } catch {
    state.activeRoutingPolicy = null;
  }
}

export async function loadTools() {
  try {
    const r = await api.get('/tools');
    const data = await r.json();
    state.tools = data.tools || [];
    dismissLoadError('the tool list');
    triggerRender();
  } catch (e) {
    console.error('Failed to load tools', e);
    reportLoadError('the tool list', e, () => { void loadTools(); });
  }
}

// User preferences
export async function loadUserPreferences() {
  try {
    const r = await api.get('/user/preferences');
    const data = await r.json();
    if (data.preferences?.theme) state.theme = data.preferences.theme;
    if (data.preferences?.default_mode) state.defaultMode = data.preferences.default_mode;
    if (data.preferences?.show_process_card !== undefined) {
      state.showProcessCard = !!Number(data.preferences.show_process_card);
    }
    triggerRender();
  } catch (e) {
    console.error('Failed to load preferences', e);
  }
}

export async function saveUserPreferences() {
  try {
    await api.post('/user/preferences', {
      default_mode: state.defaultMode || 'direct',
      theme: state.theme || 'light',
      show_process_card: state.showProcessCard !== false,
    });
  } catch (e) {
    console.error('Failed to save preferences', e);
  }
}

// Chat-specific settings
export async function loadChatSettings(chatId: string) {
  if (!chatId) {
    state.chatSettings = null;
    triggerRender();
    return;
  }
  try {
    const r = await api.get(`/chats/${chatId}/settings`);
    const data = await r.json();
    const settings = data.settings;
    state.chatSettings = settings
      ? {
          mode: settings.mode || 'direct',
          systemPrompt: settings.system_prompt || '',
          timezone: settings.timezone || '',
          enabledTools: settings.enabled_tools ? JSON.parse(settings.enabled_tools) : [],
          redactionEnabled: !!settings.redaction_enabled,
          redactionPatterns: settings.redaction_patterns ? JSON.parse(settings.redaction_patterns) : ['email', 'phone', 'ssn', 'credit_card'],
          workers: settings.workers ? JSON.parse(settings.workers) : [],
          reflectEnabled: !!settings.reflect_enabled,
          reflectMaxRevisions: settings.reflect_max_revisions ?? 2,
          verifyEnabled: !!settings.verify_enabled,
          verifyMinScore: settings.verify_min_score ?? 0.7,
          verifyMaxAttempts: settings.verify_max_attempts ?? 3,
          supervisorReplanOnFailure: !!settings.supervisor_replan_on_failure,
          supervisorParallelDelegation: !!settings.supervisor_parallel_delegation,
          ensembleAgents: settings.ensemble_agents ? JSON.parse(settings.ensemble_agents) : [],
          ensembleResolver: settings.ensemble_resolver || 'majority_vote',
        }
      : {
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
    triggerRender();
  } catch (e) {
    console.error('Failed to load chat settings', e);
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
    triggerRender();
  }
}

export async function saveChatSettings() {
  if (!state.currentChatId || !state.chatSettings) return;
  try {
    await api.post(`/chats/${state.currentChatId}/settings`, state.chatSettings);
    if (state.chatSettings.mode && state.chatSettings.mode !== state.defaultMode) {
      state.defaultMode = state.chatSettings.mode;
      await api.post('/user/preferences', {
        default_mode: state.chatSettings.mode,
        theme: state.theme,
        show_process_card: state.showProcessCard !== false,
      });
    }
  } catch (e) {
    console.error('Failed to save chat settings', e);
  }
}

// Dashboard
export async function loadDashboard() {
  state.view = 'dashboard';
  try {
    const [overview, costs, performance, evals, traces, activity] = await Promise.all([
      api.get('/dashboard/overview').then((r) => r.json()),
      api.get('/dashboard/costs').then((r) => r.json()),
      api.get('/dashboard/performance').then((r) => r.json()),
      api.get('/dashboard/evals').then((r) => r.json()),
      api.get('/dashboard/traces?limit=50').then((r) => (r.ok ? r.json() : { traces: [] })).catch(() => ({ traces: [] })),
      api.get('/dashboard/agent-activity?limit=50').then((r) => (r.ok ? r.json() : { activity: [] })).catch(() => ({ activity: [] })),
    ]);
    state.dashboard = {
      overview,
      costs,
      performance,
      evals,
      traces: traces.traces || [],
      agentActivity: activity.activity || [],
    };
    triggerRender();
  } catch (e) {
    state.dashboard = null;
    console.error('Failed to load dashboard', e);
    triggerRender();
  }
}

export async function loadDashboardData() {
  try {
    const r = await api.get('/dashboard/data');
    const data = await r.json();
    if (state.dashboard) {
      state.dashboard.data = data;
    }
  } catch (e) {
    console.error('Failed to load dashboard data', e);
  }
}

// Admin
export async function loadAdmin() {
  try {
    const adminSchema = getAdminSchema();
    const keys = Object.keys(adminSchema);
    const promises = keys.map((k: string) => {
      const s = (adminSchema as any)[k];
      const path = String(s.apiPath || '').replace(/^\/+/, '').replace(/^api\//, '');
      return api
        .get('/' + path)
        .then((r: any) => r.json())
        .catch(() => {
          const d: any = {};
          d[s.listKey] = [];
          return d;
        });
    });
    const results = await Promise.all(promises);
    const data: any = {};
    keys.forEach((k: string, i: number) => {
      const s = (adminSchema as any)[k];
      data[k] = results[i][s.listKey] || [];
    });
    state.adminData = data;
    if (!state.adminTab || !(state.adminTab in state.adminData)) {
      state.adminTab = keys[0] || 'prompts';
    }
    triggerRender();
  } catch (e) {
    console.error('Failed to load admin data', e);
  }
}

// Connectors
export async function loadConnectors() {
  state.view = 'connectors';
  state.connectorsLoading = true;
  try {
    const r = await api.get('/connectors');
    const data = await r.json();
    state.connectors = { enterprise: data.enterprise || [], social: data.social || [] };
  } catch (e) {
    state.connectors = { enterprise: [], social: [] };
  }
  state.connectorsLoading = false;
  triggerRender();
}

// Credentials
export async function loadCredentials() {
  try {
    const r = await api.get('/credentials');
    const data = await r.json();
    state.credentials = data.credentials || [];
    triggerRender();
  } catch (e) {
    state.credentials = [];
  }
}

// SSO
export async function loadSSOProviders() {
  try {
    const r = await api.get('/sso/providers');
    const data = await r.json();
    state.ssoProviders = data.providers || [];
    triggerRender();
  } catch (e) {
    state.ssoProviders = [];
  }
}

// OAuth accounts
export async function loadOAuthAccounts() {
  try {
    const r = await api.get('/oauth/accounts');
    const data = await r.json();
    state.oauthAccounts = data.accounts || [];
    triggerRender();
  } catch (e) {
    state.oauthAccounts = [];
  }
}

// Password providers
export async function loadPasswordProviders() {
  try {
    const r = await api.get('/password-providers');
    state.importProviders = await r.json();
    triggerRender();
  } catch (e) {
    state.importProviders = [];
  }
}
