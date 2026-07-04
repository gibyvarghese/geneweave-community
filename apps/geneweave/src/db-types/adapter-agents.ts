import type { WorkerAgentRow, SupervisorAgentRow, AgentToolRow, ResolvedSupervisorAgent, AgentStrategySettingsRow } from './agents.js';
import type { WorkflowRunRow, WorkflowCheckpointRow, CapabilityPolicyBindingRow } from './workflows.js';

export interface IAgentStore {
  // Worker agents
  createWorkerAgent(w: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWorkerAgent(id: string): Promise<WorkerAgentRow | null>;
  listWorkerAgents(): Promise<WorkerAgentRow[]>;
  listEnabledWorkerAgents(): Promise<WorkerAgentRow[]>;
  listWorkerAgentsByCategory(category: string): Promise<WorkerAgentRow[]>;
  updateWorkerAgent(id: string, fields: Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWorkerAgent(id: string): Promise<void>;

  // Supervisor agents
  createSupervisorAgent(a: Omit<SupervisorAgentRow, 'created_at' | 'updated_at'>, tools?: Array<{ tool_name: string; allocation?: string }>): Promise<void>;
  getSupervisorAgent(id: string): Promise<SupervisorAgentRow | null>;
  listSupervisorAgents(opts?: { tenantId?: string | null; category?: string; enabledOnly?: boolean }): Promise<SupervisorAgentRow[]>;
  updateSupervisorAgent(id: string, fields: Partial<Omit<SupervisorAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSupervisorAgent(id: string): Promise<void>;
  listAgentTools(agentId: string): Promise<AgentToolRow[]>;
  setAgentTools(agentId: string, tools: Array<{ tool_name: string; allocation?: string }>): Promise<void>;
  resolveSupervisorAgent(opts: { tenantId?: string | null; category?: string; skillId?: string | null }): Promise<ResolvedSupervisorAgent | null>;

  // Workflow runs
  createWorkflowRun(r: Omit<WorkflowRunRow, 'completed_at'>): Promise<void>;
  getWorkflowRun(id: string): Promise<WorkflowRunRow | null>;
  listWorkflowRuns(workflowId?: string): Promise<WorkflowRunRow[]>;
  updateWorkflowRun(id: string, fields: Partial<Omit<WorkflowRunRow, 'id' | 'started_at'>>): Promise<void>;
  deleteWorkflowRun(id: string): Promise<void>;

  // Workflow checkpoints
  createWorkflowCheckpoint(c: Omit<WorkflowCheckpointRow, 'created_at'>): Promise<void>;
  listWorkflowCheckpoints(runId: string): Promise<WorkflowCheckpointRow[]>;
  deleteWorkflowCheckpoints(runId: string): Promise<void>;

  // Capability policy bindings
  createCapabilityPolicyBinding(b: Omit<CapabilityPolicyBindingRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCapabilityPolicyBinding(id: string): Promise<CapabilityPolicyBindingRow | null>;
  listCapabilityPolicyBindings(opts?: { bindingKind?: string; bindingRef?: string; policyKind?: string; enabledOnly?: boolean }): Promise<CapabilityPolicyBindingRow[]>;
  updateCapabilityPolicyBinding(id: string, fields: Partial<Omit<CapabilityPolicyBindingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCapabilityPolicyBinding(id: string): Promise<void>;

  // Agent strategy settings (global / per-tenant defaults)
  getAgentStrategySettings(id: string): Promise<AgentStrategySettingsRow | null>;
  updateAgentStrategySettings(id: string, patch: Partial<Omit<AgentStrategySettingsRow, 'id' | 'updated_at'>>): Promise<void>;
  listAgentStrategySettings(): Promise<AgentStrategySettingsRow[]>;

  // HITL approvals (m64 table; m93 run-scoped). The run path writes a pending
  // row when a gated tool needs approval; resolution records the decision so it
  // is persisted + queryable (survives restart).
  createHitlInterrupt(row: {
    id: string; chat_id: string; run_id?: string | null; agent_name: string; agent_step?: number;
    tool_name: string; tool_args_json?: string; interrupt_type?: string; reason?: string; expires_at?: string | null;
  }): Promise<void>;
  resolveHitlInterrupt(id: string, fields: {
    status: string; decision_action?: string; modified_args_json?: string | null; feedback?: string | null; decided_by?: string | null;
  }): Promise<void>;
  listPendingHitlInterruptsByRun(runId: string): Promise<Array<{ id: string; tool_name: string; status: string; tool_args_json: string }>>;
}
