// Global UI state object
import type { User, Chat, Message, Model, ChatSettings } from './types.js';

/** Merged action-feed entry combining tasks, reminders, and proposed agenda items. */
export interface ActionFeedItem {
  id: string;
  type: 'approval' | 'task' | 'reminder' | 'agenda';
  title: string;
  sub: string;
  urgency: 'overdue' | 'due-soon' | 'proposed' | 'normal';
  /** For approvals: route to tool-approval-ui. For others: agenda or reminder link. */
  conversationId?: string;
  dueAt?: string;
  categoryColor?: string;
}

/** Agenda item from /api/me/agenda */
export interface AgendaItem {
  id: string;
  user_id: string;
  title: string;
  kind: string;
  category_id: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: number;
  location: string | null;
  description: string | null;
  status: string;
  sensitivity: string;
  amount: string | null;
  currency: string | null;
  created_at: string;
  updated_at: string;
}

/** Agenda category */
export interface AgendaCategory {
  id: string;
  name: string;
  color: string;
  icon: string;
  template_key: string | null;
}

/** Note list item (no doc_json — fetched separately on open) */
export interface NoteListItem {
  id: string;
  owner_user_id: string;
  title: string;
  icon: string | null;
  parent_note_id: string | null;
  sensitivity: string;
  is_template: number;
  template_key: string | null;
  favorite: number;
  created_at: string;
  updated_at: string;
  /** weaveNotes Phase 6: archive/trash timestamp (NULL = active). Present on list rows. */
  archived_at?: string | null;
  /** weaveNotes Phase 6: gallery metadata, only on the /templates response (joined from the package). */
  key?: string | null;
  category?: string;
  description?: string;
}

/** Full note with document content */
export interface NoteDoc extends NoteListItem {
  doc_json: string;
  cover: string | null;
}

export const state: any = {
  // Auth & user
  user: null as User | null,
  csrfToken: '',
  authMode: 'login',
  authError: '',

  // Current view
  view: 'chat',

  // Chat management
  currentChatId: null as string | null,
  chats: [] as Chat[],
  messages: [] as Message[],
  streaming: false,
  pendingDraft: '',
  pendingAttachments: [] as any[],

  // Models & settings
  models: [] as Model[],
  selectedModel: 'openai:gpt-4o' as string,
  // Active LLM routing policy (when present, the user's model selection is overridden server-side)
  activeRoutingPolicy: null as { name: string; strategy: string } | null,
  tools: [] as any[],
  defaultMode: 'direct',
  chatSettings: null as ChatSettings | null,

  // Theme
  theme: 'dark',

  // Show the agent / tool process card under each assistant turn (user preference)
  showProcessCard: true,

  // UI state
  showProfile: false,
  showNotifications: false,
  showSettings: false,
  recentChatsExpanded: true,
  sidebarCollapsed: false,
  sidebarScrollTop: 0,
  // Set true while render() programmatically restores the sidebar scroll, so the nav's scroll listener
  // doesn't persist the transient/clamped scrollTop that the restore itself triggers (which would degrade
  // the saved position across a render burst). See render() in ui-client.ts.
  suppressSidebarScrollPersist: false,
  // Round 3 — transcript scroll retention/respect during streaming (same pattern as the sidebar).
  transcriptScrollTop: 0,
  transcriptAtBottom: true,
  suppressTranscriptScrollPersist: false,
  // Round 3 — files rejected on upload (with a reason), surfaced to the user instead of silently dropped.
  uploadRejections: [] as Array<{ name: string; reason: string }>,

  // Calendar (widget)
  calendarTab: 'meetings',
  calendarShowAll: false,
  calendarFocusDate: new Date(),

  // Action feed (WC1)
  actionFeed: [] as ActionFeedItem[],
  actionFeedFilter: 'all' as string,
  actionFeedLoading: false,

  // Calendar extended (WC2-WC4)
  calendarItems: [] as AgendaItem[],
  calendarCategories: [] as AgendaCategory[],
  calendarLoading: false,
  calendarView: 'agenda' as string,          // 'agenda' | 'week' | 'month'
  calendarCategoryFilter: null as string | null,
  calendarQuickAdd: '' as string,
  calendarQuickAddLoading: false,

  // Notes (WC6-WC9)
  notesItems: [] as NoteListItem[],
  notesLoading: false,
  notesSearch: '' as string,
  currentNoteId: null as string | null,
  currentNote: null as NoteDoc | null,
  notesView: 'list' as string,               // 'list' | 'editor' | 'templates' | 'databases' | 'archive'
  notesTheme: 'pro' as 'pro' | 'creative',   // design Pro/Creative page theme (Notes editor)
  noteTemplates: [] as NoteListItem[],
  notesArchived: [] as NoteListItem[],        // weaveNotes Phase 6: the archived/trash list
  noteDatabases: [] as any[],
  currentDatabaseId: null as string | null,  // weaveNotes Phase 6: the open database

  // Account settings surface (geneWeave UI rebuild — "GeneWeave Account.dc.html")
  accountSection: 'profile' as string,
  account: null as any,          // the loaded AccountView (profile + preferences + notifications)
  accountDraft: null as any,     // working copy for dirty-tracked Profile/Preferences edits
  accountLoaded: false,
  accountLoading: false,
  accountError: false,
  accountPeople: null as any,    // { people[], canManage }
  accountSaving: false,

  // Admin
  adminTab: 'prompts',
  adminData: {} as Record<string, any[]>,
  adminForm: {} as Record<string, any>,
  adminEditing: null as string | null,
  adminMenuExpanded: false,
  adminGroupExpanded: {} as Record<string, boolean>,

  // Admin list controls (search / sort / group / page)
  adminListCurrentTab: '' as string,
  adminListSearch: '' as string,
  adminListSortCol: null as string | null,
  adminListSortDir: 'asc' as 'asc' | 'desc',
  adminListGroupBy: '' as string,
  adminListPage: 1 as number,
  adminListGroupCollapsed: {} as Record<string, boolean>,

  // Connectors
  connectors: { enterprise: [] as any[], social: [] as any[] },
  connectorsLoading: false,

  // Credentials
  credentials: [] as any[],
  credentialForm: null as any,
  credentialEditing: null as string | null,
  importShow: false,
  importProvider: null,
  importConfig: {} as Record<string, any>,
  importLoading: false,
  importResult: null as any,
  importProviders: [] as any[],

  // SSO & OAuth
  ssoProviders: [] as any[],
  oauthAccounts: [] as any[],

  // Dashboard
  dashboard: null as any,

  // Search
  chatSearchQuery: '',
  chatSearchResults: [] as any[],
  chatSearchLoading: false,
  _chatSearchTimer: null as any,

  // Audio recording (browser SpeechRecognition)
  audioRecording: false,

  // Voice agent session
  voiceAgentActive: false,
  voiceSessionId: null as string | null,
  voiceStatus: 'idle' as 'idle' | 'listening' | 'recording' | 'processing' | 'playing' | 'paused',
  voiceRecording: false,
  voiceLastTranscript: '' as string,
  voiceLastResponse: '' as string,
  voiceError: '' as string,
  // Voice settings panel
  voiceSettingsOpen: false,
  voiceConfig: null as {
    pipelineMode: 'chained' | 'realtime';
    realtimeModel: string;
    ttsVoice: string;
    ttsSpeed: number;
    sttLanguage: string | null;
    ttsModel: string;
    sttModel: string;
  } | null,

  // Handoff
  handoffRequest: null as any,

  // Metadata
  _aboutInfo: null as any,
  _upgradeStatus: null,
  _upgradeMsg: '',

  // Hypothesis Validation
  svView: 'submit' as 'submit' | 'live' | 'verdict',
  svHypothesisId: null as string | null,
  svHypothesis: null as any,
  svVerdict: null as any,
};

// Helper to get calendar focus date
export function getCalendarFocusDate(): Date {
  return state.calendarFocusDate || new Date();
}

export function setCalendarFocusDate(date: Date): void {
  state.calendarFocusDate = new Date(date);
}

export function shiftCalendarMonth(offset?: number): void {
  const d = getCalendarFocusDate();
  const shift = offset || 0;
  state.calendarFocusDate = new Date(d.getFullYear(), d.getMonth() + shift, 1);
}

// Convert date to YYYY-MM-DD
export function toYMD(d: Date | null): string {
  if (!d) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse YYYY-MM-DD to Date
export function fromYMD(ymd: string): Date {
  if (!ymd || ymd.length !== 10) return new Date();
  const parts = ymd.split('-').map(Number) as [number, number, number];
  const [year, month, day] = parts;
  return new Date(year, month - 1, day);
}

// Get today label
export function getTodayLabel(): string {
  const today = new Date();
  return today.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
