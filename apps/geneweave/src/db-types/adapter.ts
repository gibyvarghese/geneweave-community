/** DatabaseAdapter interface and DatabaseConfig — composed from domain sub-interfaces. */

import type { IUserStore } from './adapter-users.js';
import type { IChatStore } from './adapter-chats.js';
import type { IPromptStore } from './adapter-prompts.js';
import type { IRoutingStore } from './adapter-routing.js';
import type { IWorkflowStore } from './adapter-workflows.js';
import type { IToolStore } from './adapter-tools.js';
import type { IAgentStore } from './adapter-agents.js';
import type { ICostStore } from './adapter-cost.js';
import type { IEncryptionStore } from './adapter-encryption.js';
import type { ICapabilityStore } from './adapter-capabilities.js';
import type { IAdminStore } from './adapter-admin.js';
import type { IMemoryStore } from './adapter-memory.js';
import type { IKaggleStore } from './adapter-kaggle.js';
import type { ILiveAgentsStore } from './adapter-live-agents.js';
import type { IMeStore } from './adapter-me.js';
import type { IAgendaNotesStore } from './adapter-agenda-notes.js';
import type { IVoiceStore } from './adapter-voice.js';
import type { ScopesAdapterMethods } from './adapter-scopes.js';

export type { IUserStore } from './adapter-users.js';
export type { IChatStore, ConversationListFilter, ConversationListOptions, ConversationFlags } from './adapter-chats.js';
export type { IPromptStore } from './adapter-prompts.js';
export type { IRoutingStore } from './adapter-routing.js';
export type { IWorkflowStore } from './adapter-workflows.js';
export type { IToolStore } from './adapter-tools.js';
export type { A2ASkillRow } from './tools.js';
export type { IAgentStore } from './adapter-agents.js';
export type { ICostStore } from './adapter-cost.js';
export type { IEncryptionStore } from './adapter-encryption.js';
export type { ICapabilityStore } from './adapter-capabilities.js';
export type { IAdminStore } from './adapter-admin.js';
export type { IMemoryStore } from './adapter-memory.js';
export type { IKaggleStore } from './adapter-kaggle.js';
export type { ILiveAgentsStore } from './adapter-live-agents.js';
export type { IMeStore } from './adapter-me.js';
export type {
  IAgendaNotesStore,
  AgendaCategoryRow, AgendaItemRow, AgendaItemKind, AgendaItemStatus, AgendaItemSensitivity, AgendaListFilter,
  NoteRow, NoteLinkRow, NoteLinkTargetKind, NoteDatabaseRow, NoteDbRowRow, NoteDatabaseSource, NoteDatabaseViewType,
  NoteSensitivity, NoteListFilter,
} from './adapter-agenda-notes.js';
export type { ScopesAdapterMethods, ScopeSkillAssignmentAdminRow, ScopeLiveAgentAssignmentAdminRow } from './adapter-scopes.js';
export type { AgentScopeRow, ScopeCrossPolicyRow, ScopeSkillAssignmentRow, ScopeLiveAgentAssignmentRow, ScopeAccessLogRow } from './scopes.js';
export type {
  ArtifactRow, ArtifactVersionRow, ArtifactSaveInput, ArtifactUpdateInput, ArtifactListFilter,
  LiveArtifactConfigRow, LiveArtifactConfigInput, LiveArtifactConfigUpdate,
} from './artifacts.js';
export type {
  IVoiceStore,
  VoiceConfigRow, VoiceConfigCreate, VoiceConfigUpdate,
  VoiceSessionRow, VoiceSessionCreate, VoiceSessionListFilter,
  VoiceSessionEventRow, VoiceSessionEventCreate, VoiceSessionEventType,
} from './adapter-voice.js';

export interface DatabaseAdapter extends
  IUserStore,
  IChatStore,
  IPromptStore,
  IRoutingStore,
  IWorkflowStore,
  IToolStore,
  IAgentStore,
  ICostStore,
  IEncryptionStore,
  ICapabilityStore,
  IAdminStore,
  IMemoryStore,
  IKaggleStore,
  ILiveAgentsStore,
  IMeStore,
  IAgendaNotesStore,
  IVoiceStore,
  ScopesAdapterMethods {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // ── Artifact storage (m77) ────────────────────────────────────────────────
  saveArtifact?(input: import('./artifacts.js').ArtifactSaveInput): Promise<import('./artifacts.js').ArtifactRow>;
  getArtifact?(id: string): Promise<import('./artifacts.js').ArtifactRow | null>;
  updateArtifact?(id: string, patch: import('./artifacts.js').ArtifactUpdateInput, changelog?: string): Promise<import('./artifacts.js').ArtifactRow>;
  listArtifacts?(filter?: import('./artifacts.js').ArtifactListFilter): Promise<import('./artifacts.js').ArtifactRow[]>;
  deleteArtifact?(id: string): Promise<void>;
  getArtifactVersions?(artifactId: string): Promise<import('./artifacts.js').ArtifactVersionRow[]>;
  getArtifactVersion?(artifactId: string, version: number): Promise<import('./artifacts.js').ArtifactVersionRow | null>;
  expireArtifacts?(): Promise<number>;

  // ── Live artifact configs (m80 / Phase 6) ────────────────────────────────
  getLiveArtifactConfig?(artifactId: string): Promise<import('./artifacts.js').LiveArtifactConfigRow | null>;
  saveLiveArtifactConfig?(input: import('./artifacts.js').LiveArtifactConfigInput): Promise<import('./artifacts.js').LiveArtifactConfigRow>;
  updateLiveArtifactConfig?(artifactId: string, patch: import('./artifacts.js').LiveArtifactConfigUpdate): Promise<import('./artifacts.js').LiveArtifactConfigRow>;
  deleteLiveArtifactConfig?(artifactId: string): Promise<void>;
  touchLiveArtifactRefresh?(artifactId: string): Promise<void>;

  // ── Scheduled note agents (m129 / Phase 3) ───────────────────────────────
  createScheduledNoteAgent(row: import('./scheduled-agents.js').ScheduledNoteAgentRow): Promise<void>;
  listScheduledNoteAgents(userId: string): Promise<import('./scheduled-agents.js').ScheduledNoteAgentRow[]>;
  getScheduledNoteAgent(id: string, userId: string): Promise<import('./scheduled-agents.js').ScheduledNoteAgentRow | null>;
  countScheduledNoteAgents(userId: string): Promise<number>;
  updateScheduledNoteAgent(id: string, userId: string, fields: Partial<import('./scheduled-agents.js').ScheduledNoteAgentRow>): Promise<void>;
  deleteScheduledNoteAgent(id: string, userId: string): Promise<void>;
  listDueScheduledNoteAgents(nowMs: number, limit?: number): Promise<import('./scheduled-agents.js').ScheduledNoteAgentRow[]>;
  createScheduledNoteAgentRun(row: import('./scheduled-agents.js').ScheduledNoteAgentRunRow): Promise<void>;
  updateScheduledNoteAgentRun(id: string, fields: Partial<import('./scheduled-agents.js').ScheduledNoteAgentRunRow>): Promise<void>;
  listScheduledNoteAgentRuns(agentId: string, userId: string, limit?: number): Promise<import('./scheduled-agents.js').ScheduledNoteAgentRunRow[]>;

  // ── Per-user MCP tokens (m130 / Phase 3) ─────────────────────────────────
  createUserMcpToken(row: import('./mcp-notes.js').UserMcpTokenRow): Promise<void>;
  listUserMcpTokens(userId: string): Promise<import('./mcp-notes.js').UserMcpTokenRow[]>;
  getUserMcpTokenByHash(tokenHash: string): Promise<import('./mcp-notes.js').UserMcpTokenRow | null>;
  revokeUserMcpToken(id: string, userId: string): Promise<void>;
  touchUserMcpToken(id: string): Promise<void>;
}

export interface DatabaseConfig {
  type: 'sqlite' | 'custom';
  /** SQLite file path (default: './geneweave.db') */
  path?: string;
  /** Provide your own adapter for Postgres, MySQL, Mongo, etc. */
  adapter?: DatabaseAdapter;
}
