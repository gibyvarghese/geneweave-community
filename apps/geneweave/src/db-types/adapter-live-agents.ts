import type { LiveMeshDefinitionRow, LiveAgentDefinitionRow, LiveMeshDelegationEdgeRow, LiveHandlerKindRow, LiveAttentionPolicyRow, LiveMeshRow, LiveAgentRow, LiveAgentHandlerBindingRow, LiveAgentToolBindingRow, LiveRunRow, LiveRunStepRow, LiveRunEventRow, ApiLiveRunRow } from './live-agents.js';

export interface ILiveAgentsStore {
  // Mesh definitions
  listLiveMeshDefinitions(opts?: { enabledOnly?: boolean }): Promise<LiveMeshDefinitionRow[]>;
  getLiveMeshDefinition(id: string): Promise<LiveMeshDefinitionRow | null>;
  getLiveMeshDefinitionByKey(meshKey: string): Promise<LiveMeshDefinitionRow | null>;
  createLiveMeshDefinition(row: Omit<LiveMeshDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDefinitionRow>;
  updateLiveMeshDefinition(id: string, patch: Partial<Omit<LiveMeshDefinitionRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveMeshDefinition(id: string): Promise<void>;

  // Agent definitions
  listLiveAgentDefinitions(opts?: { meshDefId?: string; enabledOnly?: boolean }): Promise<LiveAgentDefinitionRow[]>;
  getLiveAgentDefinition(id: string): Promise<LiveAgentDefinitionRow | null>;
  createLiveAgentDefinition(row: Omit<LiveAgentDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveAgentDefinitionRow>;
  updateLiveAgentDefinition(id: string, patch: Partial<Omit<LiveAgentDefinitionRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgentDefinition(id: string): Promise<void>;

  // Delegation edges
  listLiveMeshDelegationEdges(opts?: { meshDefId?: string; enabledOnly?: boolean }): Promise<LiveMeshDelegationEdgeRow[]>;
  getLiveMeshDelegationEdge(id: string): Promise<LiveMeshDelegationEdgeRow | null>;
  createLiveMeshDelegationEdge(row: Omit<LiveMeshDelegationEdgeRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDelegationEdgeRow>;
  updateLiveMeshDelegationEdge(id: string, patch: Partial<Omit<LiveMeshDelegationEdgeRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void>;
  deleteLiveMeshDelegationEdge(id: string): Promise<void>;

  // Handler kinds
  listLiveHandlerKinds(opts?: { enabledOnly?: boolean }): Promise<LiveHandlerKindRow[]>;
  getLiveHandlerKind(id: string): Promise<LiveHandlerKindRow | null>;
  getLiveHandlerKindByKind(kind: string): Promise<LiveHandlerKindRow | null>;
  createLiveHandlerKind(row: Omit<LiveHandlerKindRow, 'created_at' | 'updated_at'>): Promise<LiveHandlerKindRow>;
  updateLiveHandlerKind(id: string, patch: Partial<Omit<LiveHandlerKindRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveHandlerKind(id: string): Promise<void>;

  // Attention policies
  listLiveAttentionPolicies(opts?: { enabledOnly?: boolean }): Promise<LiveAttentionPolicyRow[]>;
  getLiveAttentionPolicy(id: string): Promise<LiveAttentionPolicyRow | null>;
  getLiveAttentionPolicyByKey(key: string): Promise<LiveAttentionPolicyRow | null>;
  createLiveAttentionPolicy(row: Omit<LiveAttentionPolicyRow, 'created_at' | 'updated_at'>): Promise<LiveAttentionPolicyRow>;
  updateLiveAttentionPolicy(id: string, patch: Partial<Omit<LiveAttentionPolicyRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveAttentionPolicy(id: string): Promise<void>;

  // Provisioned meshes
  listLiveMeshes(opts?: { tenantId?: string; meshDefId?: string; status?: string }): Promise<LiveMeshRow[]>;
  getLiveMesh(id: string): Promise<LiveMeshRow | null>;
  createLiveMesh(row: Omit<LiveMeshRow, 'created_at' | 'updated_at'>): Promise<LiveMeshRow>;
  updateLiveMesh(id: string, patch: Partial<Omit<LiveMeshRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveMesh(id: string): Promise<void>;

  // Provisioned agents
  listLiveAgents(opts?: { meshId?: string; status?: string }): Promise<LiveAgentRow[]>;
  getLiveAgent(id: string): Promise<LiveAgentRow | null>;
  createLiveAgent(row: Omit<LiveAgentRow, 'created_at' | 'updated_at'>): Promise<LiveAgentRow>;
  updateLiveAgent(id: string, patch: Partial<Omit<LiveAgentRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgent(id: string): Promise<void>;

  // Handler bindings
  listLiveAgentHandlerBindings(opts?: { agentId?: string; enabledOnly?: boolean }): Promise<LiveAgentHandlerBindingRow[]>;
  getLiveAgentHandlerBinding(id: string): Promise<LiveAgentHandlerBindingRow | null>;
  createLiveAgentHandlerBinding(row: Omit<LiveAgentHandlerBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentHandlerBindingRow>;
  updateLiveAgentHandlerBinding(id: string, patch: Partial<Omit<LiveAgentHandlerBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgentHandlerBinding(id: string): Promise<void>;

  // Tool bindings
  listLiveAgentToolBindings(opts?: { agentId?: string; enabledOnly?: boolean }): Promise<LiveAgentToolBindingRow[]>;
  getLiveAgentToolBinding(id: string): Promise<LiveAgentToolBindingRow | null>;
  createLiveAgentToolBinding(row: Omit<LiveAgentToolBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentToolBindingRow>;
  updateLiveAgentToolBinding(id: string, patch: Partial<Omit<LiveAgentToolBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgentToolBinding(id: string): Promise<void>;

  // Runs
  listLiveRuns(opts?: { meshId?: string; tenantId?: string; status?: string; limit?: number }): Promise<LiveRunRow[]>;
  getLiveRun(id: string): Promise<LiveRunRow | null>;
  createLiveRun(row: Omit<LiveRunRow, 'created_at' | 'updated_at'>): Promise<LiveRunRow>;
  updateLiveRun(id: string, patch: Partial<Omit<LiveRunRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void>;
  deleteLiveRun(id: string): Promise<void>;

  // Run steps
  listLiveRunSteps(opts?: { runId?: string; meshId?: string; agentId?: string }): Promise<LiveRunStepRow[]>;
  getLiveRunStep(id: string): Promise<LiveRunStepRow | null>;
  createLiveRunStep(row: Omit<LiveRunStepRow, 'created_at' | 'updated_at'>): Promise<LiveRunStepRow>;
  updateLiveRunStep(id: string, patch: Partial<Omit<LiveRunStepRow, 'id' | 'run_id' | 'mesh_id' | 'created_at'>>): Promise<void>;
  deleteLiveRunStep(id: string): Promise<void>;

  // Run events
  listLiveRunEvents(opts?: { runId?: string; afterId?: string; limit?: number }): Promise<LiveRunEventRow[]>;
  getLiveRunEvent(id: string): Promise<LiveRunEventRow | null>;
  appendLiveRunEvent(row: Omit<LiveRunEventRow, 'created_at'>): Promise<LiveRunEventRow>;

  // API-initiated runs (no mesh FK — user-scoped, stop_requested survives restarts)
  createApiLiveRun(row: Omit<ApiLiveRunRow, 'created_at' | 'updated_at'>): Promise<ApiLiveRunRow>;
  getApiLiveRun(id: string): Promise<ApiLiveRunRow | null>;
  listUserApiLiveRuns(userId: string, opts?: { status?: string; limit?: number }): Promise<ApiLiveRunRow[]>;
  updateApiLiveRun(id: string, patch: Partial<Omit<ApiLiveRunRow, 'id' | 'user_id' | 'created_at'>>): Promise<void>;
  deleteApiLiveRun(id: string): Promise<void>;
}
