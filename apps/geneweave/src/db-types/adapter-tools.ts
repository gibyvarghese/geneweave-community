import type { ToolCatalogRow, ToolPolicyRow, ToolAuditEventRow, ToolHealthSnapshotRow, EndpointHealthRow, EndpointHealthDelta, ToolHealthSummary, ToolCredentialRow, MCPGatewayClientRow, MCPGatewayRequestOutcome, MCPGatewayRequestLogRow, MCPGatewayActivitySummary, SkillRow, ToolApprovalRequestRow, A2ASkillRow } from './tools.js';

export interface IToolStore {
  // Tool catalog
  createToolConfig(t: Omit<ToolCatalogRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolConfig(id: string): Promise<ToolCatalogRow | null>;
  getToolCatalogByKey(toolKey: string): Promise<ToolCatalogRow | null>;
  listToolConfigs(): Promise<ToolCatalogRow[]>;
  listEnabledToolCatalog(): Promise<ToolCatalogRow[]>;
  updateToolConfig(id: string, fields: Partial<Omit<ToolCatalogRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolConfig(id: string): Promise<void>;

  // Tool policies
  createToolPolicy(p: Omit<ToolPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolPolicy(id: string): Promise<ToolPolicyRow | null>;
  getToolPolicyByKey(key: string): Promise<ToolPolicyRow | null>;
  listToolPolicies(): Promise<ToolPolicyRow[]>;
  updateToolPolicy(id: string, fields: Partial<Omit<ToolPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolPolicy(id: string): Promise<void>;
  checkAndIncrementRateLimit(toolName: string, scopeKey: string, windowStartIso: string, limitPerMinute: number): Promise<boolean>;
  /** M-10: Returns how many calls have been made in the current window bucket. */
  getToolRateLimitCount(toolName: string, scopeKey: string, windowStartIso: string): Promise<number>;

  // Tool audit events
  insertToolAuditEvent(event: Omit<ToolAuditEventRow, 'created_at'>): Promise<void>;
  listToolAuditEvents(filters?: { toolName?: string; chatId?: string; outcome?: string; afterIso?: string; beforeIso?: string; limit?: number; offset?: number }): Promise<ToolAuditEventRow[]>;
  getToolAuditEvent(id: string): Promise<ToolAuditEventRow | null>;

  // Tool health snapshots
  insertToolHealthSnapshot(snapshot: Omit<ToolHealthSnapshotRow, 'created_at'>): Promise<void>;
  listToolHealthSnapshots(toolName: string, limit?: number): Promise<ToolHealthSnapshotRow[]>;
  getToolHealthSummary(sinceIso?: string): Promise<ToolHealthSummary[]>;

  // Endpoint health
  applyEndpointHealthDelta(delta: EndpointHealthDelta): Promise<void>;
  listEndpointHealth(filters?: { circuitState?: string; limit?: number; offset?: number }): Promise<EndpointHealthRow[]>;
  getEndpointHealth(endpoint: string): Promise<EndpointHealthRow | null>;

  // Tool credentials
  createToolCredential(c: Omit<ToolCredentialRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolCredential(id: string): Promise<ToolCredentialRow | null>;
  listToolCredentials(): Promise<ToolCredentialRow[]>;
  listEnabledToolCredentials(): Promise<ToolCredentialRow[]>;
  updateToolCredential(id: string, fields: Partial<Omit<ToolCredentialRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolCredential(id: string): Promise<void>;
  validateToolCredential(id: string): Promise<{ status: 'valid' | 'invalid' | 'unknown'; value: string | null }>;

  // MCP Gateway Clients
  createMCPGatewayClient(c: Omit<MCPGatewayClientRow, 'created_at' | 'updated_at' | 'last_used_at' | 'revoked_at' | 'expires_at' | 'rotated_at'> & Partial<Pick<MCPGatewayClientRow, 'expires_at' | 'rotated_at'>>): Promise<void>;
  getMCPGatewayClient(id: string): Promise<MCPGatewayClientRow | null>;
  getMCPGatewayClientByTokenHash(tokenHash: string): Promise<MCPGatewayClientRow | null>;
  listMCPGatewayClients(): Promise<MCPGatewayClientRow[]>;
  listEnabledMCPGatewayClients(): Promise<MCPGatewayClientRow[]>;
  updateMCPGatewayClient(id: string, fields: Partial<Omit<MCPGatewayClientRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  touchMCPGatewayClient(id: string): Promise<void>;
  revokeMCPGatewayClient(id: string): Promise<void>;
  deleteMCPGatewayClient(id: string): Promise<void>;
  /** A-9: Rate bucket is keyed on `(tenantId, clientId)` so tenants cannot
   *  consume each other's quota. Pass `null` for `tenantId` on single-tenant
   *  deployments — the implementation treats it as an empty string. */
  checkAndIncrementGatewayRateLimit(tenantId: string | null, clientId: string, windowStartIso: string, limitPerMinute: number): Promise<boolean>;
  insertMCPGatewayRequestLog(row: Omit<MCPGatewayRequestLogRow, 'created_at'>): Promise<void>;
  listMCPGatewayRequestLog(opts: { clientId?: string; outcome?: MCPGatewayRequestOutcome; limit?: number; offset?: number }): Promise<MCPGatewayRequestLogRow[]>;
  summarizeMCPGatewayActivity(opts: { sinceIso: string }): Promise<MCPGatewayActivitySummary[]>;
  listExpiringMCPGatewayClients(windowSeconds: number): Promise<MCPGatewayClientRow[]>;

  // Skills
  createSkill(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSkill(id: string): Promise<SkillRow | null>;
  listSkills(): Promise<SkillRow[]>;
  listEnabledSkills(): Promise<SkillRow[]>;
  updateSkill(id: string, fields: Partial<Omit<SkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSkill(id: string): Promise<void>;

  // Tool approval requests
  createToolApprovalRequest(r: Omit<ToolApprovalRequestRow, 'requested_at'>): Promise<void>;
  getToolApprovalRequest(id: string): Promise<ToolApprovalRequestRow | null>;
  getApprovedToolRequest(toolName: string, chatId: string): Promise<ToolApprovalRequestRow | null>;
  getPendingToolRequest(toolName: string, chatId: string): Promise<ToolApprovalRequestRow | null>;
  listToolApprovalRequests(opts?: { status?: string; chatId?: string; toolName?: string; limit?: number; offset?: number }): Promise<ToolApprovalRequestRow[]>;
  resolveToolApprovalRequest(id: string, fields: { status: string; resolved_by?: string; resolution_note?: string }): Promise<void>;

  // A2A Skills (DB-backed, replaces hardcoded A2A_SKILLS constant)
  createA2ASkill(s: Omit<A2ASkillRow, 'created_at' | 'updated_at'>): Promise<void>;
  getA2ASkill(id: string): Promise<A2ASkillRow | null>;
  listA2ASkills(): Promise<A2ASkillRow[]>;
  listEnabledA2ASkills(): Promise<A2ASkillRow[]>;
  updateA2ASkill(id: string, fields: Partial<Omit<A2ASkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteA2ASkill(id: string): Promise<void>;
}
