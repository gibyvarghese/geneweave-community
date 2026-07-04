import type { ChatRow, MessageRow, MetricRow, EvalRow, UserPreferencesRow, ChatSettingsRow, TraceRow, TemporalTimerRow, TemporalStopwatchRow, TemporalReminderRow, MetricsSummary, ConversationRow } from './core.js';

/** Filter for the user-scoped conversation list (SP2). */
export type ConversationListFilter = 'active' | 'archived' | 'pinned' | 'all';

/** Query options for listUserConversations. */
export interface ConversationListOptions {
  /** Case-insensitive substring matched against title and message content. */
  query?: string;
  /** active (default, excludes archived) | archived | pinned | all. */
  filter?: ConversationListFilter;
  limit?: number;
  offset?: number;
}

/** Mutable flags for setConversationFlags. */
export interface ConversationFlags {
  pinned?: boolean;
  archived?: boolean;
  title?: string;
}

export interface IChatStore {
  // Chats
  createChat(chat: { id: string; userId: string; title: string; model: string; provider: string }): Promise<void>;
  getChat(id: string, userId: string): Promise<ChatRow | null>;
  getChatById(id: string): Promise<ChatRow | null>;
  getUserChats(userId: string): Promise<ChatRow[]>;
  updateChatTitle(id: string, userId: string, title: string): Promise<void>;
  deleteChat(id: string, userId: string): Promise<void>;

  // Conversations (user-scoped list/search + pin/archive — SP2, mobile)
  listUserConversations(userId: string, opts?: ConversationListOptions): Promise<ConversationRow[]>;
  getUserConversation(id: string, userId: string): Promise<ConversationRow | null>;
  setConversationFlags(id: string, userId: string, flags: ConversationFlags): Promise<ConversationRow | null>;


  // Messages
  addMessage(msg: { id: string; chatId: string; role: string; content: string; metadata?: string; tokensUsed?: number; cost?: number; latencyMs?: number }): Promise<void>;
  getMessages(chatId: string): Promise<MessageRow[]>;

  // Metrics
  recordMetric(metric: { id: string; userId: string; chatId?: string; type: string; provider?: string; model?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number; latencyMs?: number; metadata?: string }): Promise<void>;
  getMetrics(userId: string, from?: string, to?: string): Promise<MetricRow[]>;
  getMetricsSummary(userId: string, from?: string, to?: string): Promise<MetricsSummary>;

  // Evals
  recordEval(result: { id: string; userId: string; chatId?: string; evalName: string; score: number; passed: number; failed: number; total: number; details?: string }): Promise<void>;
  getEvals(userId: string, from?: string, to?: string): Promise<EvalRow[]>;

  // User preferences
  getUserPreferences(userId: string): Promise<UserPreferencesRow | null>;
  saveUserPreferences(userId: string, defaultMode: string, theme: string, showProcessCard?: boolean): Promise<void>;
  // m136 — Account settings surface: patch the profile/formatting-preference columns + notification matrix.
  updateUserAccountPrefs(userId: string, patch: Record<string, string | null>): Promise<void>;
  getUserNotificationPrefs(userId: string): Promise<import('./core.js').UserNotificationPrefRow[]>;
  setUserNotificationPref(userId: string, eventKey: string, channels: { in_app?: boolean; email?: boolean; push?: boolean }): Promise<void>;

  // Chat settings
  getChatSettings(chatId: string): Promise<ChatSettingsRow | null>;
  saveChatSettings(settings: {
    chatId: string; mode: string; systemPrompt?: string; timezone?: string;
    enabledTools?: string; redactionEnabled?: boolean; redactionPatterns?: string; workers?: string;
    // W1
    reflectEnabled?: boolean; reflectMaxRevisions?: number; reflectCriteria?: string;
    // W2
    verifyEnabled?: boolean; verifyMinScore?: number; verifyMaxAttempts?: number;
    // W3
    supervisorReplanOnFailure?: boolean; supervisorParallelDelegation?: boolean;
    // W5
    ensembleAgents?: string; ensembleResolver?: string;
    // Reasoning request (m92)
    reasoningEnabled?: boolean; reasoningEffort?: string; reasoningBudgetTokens?: number;
    // HITL approvals (m64 toggles)
    hitlEnabled?: boolean; hitlRequireAll?: boolean; hitlTimeoutMs?: number;
  }): Promise<void>;

  // Traces
  saveTrace(trace: { id: string; userId: string; chatId?: string; messageId?: string; traceId: string; spanId: string; parentSpanId?: string; name: string; startTime: number; endTime?: number; status?: string; attributes?: string; events?: string }): Promise<void>;
  getChatTraces(chatId: string): Promise<TraceRow[]>;
  getUserTraces(userId: string, limit?: number): Promise<TraceRow[]>;

  // Temporal tools
  upsertTemporalTimer(row: { id: string; scopeId: string; label?: string | null; durationMs?: number | null; state: string; createdAt: string; startedAt?: string | null; pausedAt?: string | null; resumedAt?: string | null; stoppedAt?: string | null; elapsedMs: number }): Promise<void>;
  getTemporalTimer(scopeId: string, id: string): Promise<TemporalTimerRow | null>;
  listTemporalTimers(scopeId: string): Promise<TemporalTimerRow[]>;
  upsertTemporalStopwatch(row: { id: string; scopeId: string; label?: string | null; state: string; createdAt: string; startedAt?: string | null; pausedAt?: string | null; resumedAt?: string | null; stoppedAt?: string | null; elapsedMs: number; lapsJson: string }): Promise<void>;
  getTemporalStopwatch(scopeId: string, id: string): Promise<TemporalStopwatchRow | null>;
  listTemporalStopwatches(scopeId: string): Promise<TemporalStopwatchRow[]>;
  upsertTemporalReminder(row: { id: string; scopeId: string; text: string; dueAt: string; timezone: string; status: string; createdAt: string; cancelledAt?: string | null }): Promise<void>;
  getTemporalReminder(scopeId: string, id: string): Promise<TemporalReminderRow | null>;
  listTemporalReminders(scopeId: string): Promise<TemporalReminderRow[]>;

  // Agent activity
  getAgentActivity(userId: string, limit?: number): Promise<Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>>;
}
