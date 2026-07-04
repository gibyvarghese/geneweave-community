import type { SemanticMemoryRow, EntityMemoryRow, MemoryExtractionEventRow, WebsiteCredentialRow, SSOLinkedAccountRow, EpisodicMemoryRow, ProceduralMemoryRow, WorkingMemorySnapshotRow, MemorySettingsRow } from './memory.js';

export interface IMemoryStore {
  // Website Credentials
  createWebsiteCredential(c: Omit<WebsiteCredentialRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWebsiteCredential(id: string, userId: string): Promise<WebsiteCredentialRow | null>;
  listWebsiteCredentials(userId: string): Promise<WebsiteCredentialRow[]>;
  listAllActiveWebsiteCredentials(): Promise<WebsiteCredentialRow[]>;
  findWebsiteCredential(userId: string, url: string): Promise<WebsiteCredentialRow | null>;
  updateWebsiteCredential(id: string, userId: string, fields: Partial<Omit<WebsiteCredentialRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWebsiteCredential(id: string, userId: string): Promise<void>;

  // SSO Linked Accounts
  createSSOLinkedAccount(acct: { id: string; user_id: string; identity_provider: string; email?: string; session_encrypted: string; encryption_iv: string }): Promise<void>;
  getSSOLinkedAccount(userId: string, identityProvider: string): Promise<SSOLinkedAccountRow | null>;
  listSSOLinkedAccounts(userId: string): Promise<Array<Omit<SSOLinkedAccountRow, 'session_encrypted' | 'encryption_iv'>>>;
  deleteSSOLinkedAccount(userId: string, identityProvider: string): Promise<void>;

  // Semantic Memory
  saveSemanticMemory(m: { id: string; userId: string; chatId?: string; tenantId?: string; content: string; memoryType?: string; source?: string; embedding?: number[]; metadata?: string }): Promise<void>;
  getSemanticMemoryById(id: string, userId: string): Promise<SemanticMemoryRow | null>;
  searchSemanticMemory(opts: { userId: string; query: string; limit?: number; queryEmbedding?: number[] }): Promise<SemanticMemoryRow[]>;
  listSemanticMemory(userId: string, limit?: number): Promise<SemanticMemoryRow[]>;
  deleteSemanticMemory(id: string, userId: string): Promise<void>;
  clearUserSemanticMemory(userId: string): Promise<void>;
  trimSemanticMemoryForUser(userId: string, maxEntries: number): Promise<void>;
  purgeSemanticMemoryOlderThan(userId: string, cutoffMs: number): Promise<void>;
  listAllSemanticMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<SemanticMemoryRow[]>;

  // Entity Memory
  upsertEntity(e: { userId: string; entityName: string; entityType?: string; facts: Record<string, unknown>; confidence?: number; source?: string; chatId?: string; tenantId?: string }): Promise<void>;
  getEntity(userId: string, entityName: string): Promise<EntityMemoryRow | null>;
  searchEntities(userId: string, query: string): Promise<EntityMemoryRow[]>;
  listEntities(userId: string): Promise<EntityMemoryRow[]>;
  deleteEntity(userId: string, entityName: string): Promise<number>;
  clearUserEntityMemory(userId: string): Promise<void>;
  trimEntityMemoryForUser(userId: string, maxEntries: number): Promise<void>;
  listAllEntityMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<EntityMemoryRow[]>;
  recordMemoryExtractionEvent(e: { id: string; userId: string; chatId?: string; tenantId?: string; selfDisclosure: boolean; regexEntitiesCount: number; llmEntitiesCount: number; mergedEntitiesCount: number; events?: string }): Promise<void>;
  getMemoryExtractionEvent(id: string): Promise<MemoryExtractionEventRow | null>;
  listMemoryExtractionEvents(chatId?: string, limit?: number): Promise<MemoryExtractionEventRow[]>;
  listAllMemoryExtractionEvents(opts: { userId?: string; limit?: number; offset?: number }): Promise<MemoryExtractionEventRow[]>;

  // Episodic Memory
  saveEpisodicMemory(e: { id: string; userId: string; chatId?: string; tenantId?: string; messageRole?: string; content: string; importance?: number; tags?: string[] }): Promise<void>;
  listEpisodicMemory(userId: string, limit?: number): Promise<EpisodicMemoryRow[]>;
  listUnconsolidatedEpisodic(userId: string, limit?: number): Promise<EpisodicMemoryRow[]>;
  markEpisodicConsolidated(ids: string[]): Promise<void>;
  deleteEpisodicMemory(id: string, userId: string): Promise<void>;
  clearUserEpisodicMemory(userId: string): Promise<void>;
  trimEpisodicMemoryForUser(userId: string, maxEntries: number): Promise<void>;
  listAllEpisodicMemory(opts: { userId?: string; limit?: number; offset?: number }): Promise<EpisodicMemoryRow[]>;

  // Procedural Memory
  createProceduralMemory(p: Omit<ProceduralMemoryRow, 'created_at' | 'updated_at'>): Promise<void>;
  getProceduralMemory(id: string): Promise<ProceduralMemoryRow | null>;
  listProceduralMemory(userId: string, status?: string): Promise<ProceduralMemoryRow[]>;
  listAllProceduralMemory(opts: { userId?: string; status?: string; limit?: number; offset?: number }): Promise<ProceduralMemoryRow[]>;
  updateProceduralMemoryStatus(id: string, status: string, appliedAt?: string): Promise<void>;
  deleteProceduralMemory(id: string): Promise<void>;
  listAppliedProcedural(userId: string, agentId?: string): Promise<ProceduralMemoryRow[]>;

  // Working Memory Snapshots
  saveWorkingMemorySnapshot(s: { id: string; userId: string; chatId?: string; agentId?: string; content: Record<string, unknown> }): Promise<void>;
  getLatestWorkingMemory(userId: string, agentId?: string): Promise<WorkingMemorySnapshotRow | null>;
  listWorkingMemorySnapshots(userId: string, limit?: number): Promise<WorkingMemorySnapshotRow[]>;
  listAllWorkingMemorySnapshots(opts: { userId?: string; limit?: number; offset?: number }): Promise<WorkingMemorySnapshotRow[]>;
  deleteWorkingMemorySnapshot(id: string, userId: string): Promise<void>;
  clearUserWorkingMemory(userId: string): Promise<void>;

  // Memory Settings
  getMemorySettings(tenantId?: string): Promise<MemorySettingsRow | null>;
  upsertMemorySettings(s: Omit<MemorySettingsRow, 'updated_at'>): Promise<void>;
  listMemorySettings(): Promise<MemorySettingsRow[]>;
}
