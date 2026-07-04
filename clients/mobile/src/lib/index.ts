/**
 * @geneweave/mobile logic layer — the pure, framework-agnostic "brain" of the
 * geneWeave mobile app.
 *
 * Everything exported here is testable in Node with no React / React Native /
 * expo present: env + host normalization, host reachability validation, the
 * secure per-tenant token/host persistence, the biometric-gate decision logic,
 * the auth controller + observable store, deep-link parsing, and theme
 * resolution. The native view layer (`src/native/`) and Expo Router screens
 * (`app/`) are thin consumers of these modules.
 */

/** Schema version of the mobile logic surface. */
export const MOBILE_LIB_SCHEMA_VERSION = 1 as const;

// Config / environment
export {
  readMobileEnv,
  normalizeHost,
  tryNormalizeHost,
  InvalidHostError,
  type MobileEnv,
} from './config/env.js';

// Host validation + production probe
export { validateHost, type HostProbe, type HostValidation } from './auth/host.js';
export { createCatalogHostProbe } from './auth/host-probe.js';

// Secure per-tenant persistence
export {
  tenantNamespace,
  createTenantTokenStore,
  getStoredHost,
  setStoredHost,
  getStoredTenant,
  setStoredTenant,
  getStoredBiometricEnabled,
  setStoredBiometricEnabled,
} from './auth/secure-token-store.js';

// Biometric gate
export {
  BIOMETRIC_RELOCK_MS,
  isGateActive,
  requiresUnlockOnColdStart,
  requiresUnlockOnForeground,
  type BiometricGateState,
} from './auth/biometric-gate.js';

// Auth store + controller
export { createAuthStore, type AuthState, type AuthStore, type AuthListener } from './auth/auth-store.js';
export {
  createAuthController,
  type AuthController,
  type AuthControllerOptions,
  type BiometricAuthenticator,
  type ClientFactory,
} from './auth/auth-controller.js';

// OAuth / social sign-in catalog + parsers
export {
  OAUTH_PROVIDER_IDS,
  type OAuthProviderId,
  oauthProviderLabel,
  isOAuthProviderId,
  parseAuthProviders,
  parseNativeOAuthCallback,
  isNativeOAuthError,
  type NativeOAuthResult,
  type NativeOAuthError,
} from './auth/oauth-providers.js';

// Navigation
export {
  DEEP_LINK_SCHEME,
  parseDeepLink,
  buildDeepLink,
  intentToRoute,
  type RouteIntent,
  type RouteTarget,
} from './navigation/deep-links.js';

// Theme resolution
export {
  resolveThemeName,
  resolveAppTheme,
  type ThemePreference,
  type SystemColorScheme,
  type ResolvedAppTheme,
} from './theme/tenant-theme.js';

// Chat session (M4)
export {
  CHAT_SESSION_SCHEMA_VERSION,
  DETACH_BACKGROUND_MS,
  isTerminalStatus,
  createChatSession,
  emptyChatSessionState,
  type ChatSession,
  type ChatSessionOptions,
  type ChatSessionState,
  type ChatSessionListener,
  type ChatPhase,
  type ChatEntry,
  type UserEntry,
  type AssistantEntry,
  type ChatRunClient,
} from './chat/chat-session.js';
export {
  messagesToEntries,
} from './chat/history.js';
export {
  parseMarkdown,
  parseInline,
  type MarkdownBlock,
  type InlineSpan,
} from './chat/markdown.js';

// SSE frame parsing (shared by the RN XHR stream transport)
export {
  createSseFrameParser,
  type SseFrameParser,
  type SseFrameParserOptions,
} from './net/sse-frames.js';

// Widget render specs (M5) — the pure brain behind the native widget surface.
export {
  buildWidgetSpec,
  WIDGET_RENDER_KINDS,
  SUPPORTED_SCHEMA_VERSION,
  type WidgetInput,
  type WidgetViewSpec,
  type WidgetRenderKind,
  type ActionSpec,
  type FormFieldSpec,
} from './widgets/widget-spec.js';

// Conversation list logic (M6) — the pure brain behind the Chats tab.
export {
  isActiveRunStatus,
  filterConversations,
  sectionizeConversations,
  buildConversationView,
  applyConversationPatch,
  countConversations,
  formatRelativeTimestamp,
  type ConversationSection,
  type ConversationSectionId,
  type ConversationChip,
  type ConversationQuery,
  type ConversationFlagPatch,
} from './conversations/conversation-list.js';
export { widgetFixtures, type WidgetFixture } from './widgets/widget-fixtures.js';

// Actions tab logic (M7) — the pure brain behind Approvals / Tasks / Reminders.
export {
  isOpenTask,
  isApproval,
  isDueToday,
  buildApprovals,
  buildActionItems,
  buildReminders,
  reminderFireAt,
  reminderIsRecurring,
  reminderLabel,
  reminderIsEnabled,
  countActionsBadge,
  removeTask,
  removeReminder,
  applyReminderReschedule,
  snoozeTargetIso,
  formatDueLabel,
  taskConversationId,
  reminderConversationId,
  type ActionSegment,
  type SnoozeChoice,
} from './actions/action-list.js';

// Profile logic (M8) — the pure brain behind the Profile tree.
export {
  canManageOnWeb,
  buildManageUrl,
  displayName,
  avatarInitials,
  personaLabel,
} from './profile/profile-view.js';

// Memory logic (M8) — the pure brain behind the Memory screens.
export {
  MEMORY_KIND_ORDER,
  MEMORY_CONTENT_MAX,
  CLEAR_ALL_CONFIRM_PHRASE,
  memoryKindLabel,
  memoryKindIcon,
  memoriesForKind,
  countMemories,
  defaultMemoryKind,
  provenanceLabel,
  memoryConversationId,
  memoryIsLocked,
  validateMemoryContent,
  isClearAllConfirmed,
  removeMemoryItem,
  addAuthoredMemory,
  applyCorrection,
  clearAllMemories,
  type MemoryKind,
  type MemoryGroups,
  type MemoryContentValidation,
} from './memory/memory-list.js';

// Settings logic (M8) — notification preferences + quiet hours (tz-encoded).
export {
  NOTIFICATION_CATEGORIES,
  defaultNotificationPreferences,
  normalizeNotificationPreferences,
  isCategoryEnabled,
  toggleCategory,
  encodeQuietHours,
  decodeQuietHours,
  quietHoursLabel,
  isWithinQuietHours,
  shouldSuppressPush,
  type NotificationCategory,
  type QuietHours,
} from './settings/notification-prefs.js';

// Voice dictation logic (M8) — the pure brain behind mic-to-composer.
export {
  VOICE_SESSION_SCHEMA_VERSION,
  emptyVoiceState,
  startVoice,
  voiceGranted,
  voicePartial,
  voiceFinal,
  stopVoice,
  failVoice,
  markVoiceUnsupported,
  resetVoice,
  isVoiceActive,
  voiceTranscript,
  composedText,
  type VoiceStatus,
  type VoiceState,
} from './voice/voice-session.js';

// Notes — offline-first store + sync engine + ink capture (weaveNotes Phase 7, G7).
export {
  createInMemoryNotesStore,
  type LocalNote,
  type PendingOp,
  type OpKind,
  type NotesLocalStore,
} from './notes/note-store.js';
export {
  createNoteOffline,
  editNoteOffline,
  deleteNoteOffline,
  syncNotes,
  noteSyncStatus,
  pendingCount,
  isLocalId,
  type NotesSyncTransport,
  type SyncEnv,
  type SyncResult,
  type SyncStatus,
} from './notes/offline-sync.js';
export {
  PEN_COLORS,
  HIGHLIGHTER_COLOR,
  DEFAULT_PEN,
  HIGHLIGHTER_PEN,
  beginStroke,
  extendStroke,
  endStroke,
  commitStroke,
  undoStroke,
  strokePath,
  type PenSettings,
} from './notes/ink-capture.js';
export {
  splitNoteForEditor,
  composeNote,
  preservedSummary,
  type EditorModel,
} from './notes/editor-model.js';

// Push notification logic (M9) — device token storage + channel resolution.
export {
  PUSH_TOKEN_STORE_KEY,
  getStoredPushToken,
  setStoredPushToken,
  clearStoredPushToken,
  channelForPlatform,
  type PushChannel,
  type PushDevice,
  type PushPermissionStatus,
  type StoredPushToken,
} from './push/push-token.js';
