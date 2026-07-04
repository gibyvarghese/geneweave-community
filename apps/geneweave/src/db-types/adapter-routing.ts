import type { GuardrailRow, GuardrailRevisionRow, RoutingPolicyRow, TaskTypeDefinitionRow, ModelCapabilityScoreRow, TaskTypeTenantOverrideRow, ProviderToolAdapterRow, RoutingDecisionTraceRow, RoutingCapabilitySignalRow, MessageFeedbackRow, RoutingSurfaceItemRow, RoutingExperimentRow } from './routing.js';

export interface IRoutingStore {
  // Guardrails
  createGuardrail(g: Omit<GuardrailRow, 'created_at' | 'updated_at'>): Promise<void>;
  getGuardrail(id: string): Promise<GuardrailRow | null>;
  listGuardrails(): Promise<GuardrailRow[]>;
  updateGuardrail(id: string, fields: Partial<Omit<GuardrailRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteGuardrail(id: string): Promise<void>;

  // Guardrail revisions (W7 — append-only audit trail)
  createGuardrailRevision(r: Omit<GuardrailRevisionRow, 'created_at'> & { created_at?: string }): Promise<void>;
  listGuardrailRevisions(guardrailId: string): Promise<GuardrailRevisionRow[]>;
  /** Returns the latest revision whose created_at <= isoTimestamp, or null if none. */
  getGuardrailRevisionAtTime(guardrailId: string, isoTimestamp: string): Promise<GuardrailRevisionRow | null>;

  // Routing policies
  createRoutingPolicy(r: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getRoutingPolicy(id: string): Promise<RoutingPolicyRow | null>;
  listRoutingPolicies(): Promise<RoutingPolicyRow[]>;
  updateRoutingPolicy(id: string, fields: Partial<Omit<RoutingPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteRoutingPolicy(id: string): Promise<void>;

  // Task types
  listTaskTypes(): Promise<TaskTypeDefinitionRow[]>;
  getTaskType(taskKey: string): Promise<TaskTypeDefinitionRow | null>;
  getTaskTypeById(id: string): Promise<TaskTypeDefinitionRow | null>;
  createTaskType(row: Omit<TaskTypeDefinitionRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateTaskType(id: string, fields: Partial<Omit<TaskTypeDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTaskType(id: string): Promise<void>;

  // Capability scores
  listCapabilityScores(opts?: { taskKey?: string; tenantId?: string | null; modelId?: string; provider?: string }): Promise<ModelCapabilityScoreRow[]>;
  getCapabilityScore(id: string): Promise<ModelCapabilityScoreRow | null>;
  upsertCapabilityScore(row: Omit<ModelCapabilityScoreRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateCapabilityScore(id: string, fields: Partial<Omit<ModelCapabilityScoreRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  /** Atomically disable all capability scores with the given ids (is_active = 0). */
  bulkDisableCapabilityScores(ids: string[]): Promise<void>;
  deleteCapabilityScore(id: string): Promise<void>;

  // Provider tool adapters
  listProviderToolAdapters(): Promise<ProviderToolAdapterRow[]>;
  getProviderToolAdapter(provider: string): Promise<ProviderToolAdapterRow | null>;
  getProviderToolAdapterById(id: string): Promise<ProviderToolAdapterRow | null>;
  createProviderToolAdapter(row: Omit<ProviderToolAdapterRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateProviderToolAdapter(id: string, fields: Partial<Omit<ProviderToolAdapterRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteProviderToolAdapter(id: string): Promise<void>;

  // Tenant overrides
  listTaskTypeTenantOverrides(opts?: { tenantId?: string; taskKey?: string }): Promise<TaskTypeTenantOverrideRow[]>;
  getTaskTypeTenantOverride(id: string): Promise<TaskTypeTenantOverrideRow | null>;
  createTaskTypeTenantOverride(row: Omit<TaskTypeTenantOverrideRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateTaskTypeTenantOverride(id: string, fields: Partial<Omit<TaskTypeTenantOverrideRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTaskTypeTenantOverride(id: string): Promise<void>;

  // Routing decision traces
  insertRoutingDecisionTrace(row: Omit<RoutingDecisionTraceRow, 'decided_at'> & { decided_at?: string }): Promise<void>;
  listRoutingDecisionTraces(opts?: { tenantId?: string; agentId?: string; taskKey?: string; limit?: number; after?: string }): Promise<RoutingDecisionTraceRow[]>;
  getRoutingDecisionTrace(id: string): Promise<RoutingDecisionTraceRow | null>;
  aggregateCostByTask(opts?: { since?: string; until?: string; tenantId?: string }): Promise<Array<{ task_key: string | null; selected_provider: string | null; selected_model_id: string | null; invocation_count: number; total_cost_usd: number; avg_cost_usd: number; last_used: string | null }>>;

  // Feedback loop
  insertRoutingCapabilitySignal(row: Omit<RoutingCapabilitySignalRow, 'created_at'> & { created_at?: string }): Promise<void>;
  listRoutingCapabilitySignals(opts?: { tenantId?: string | null; modelId?: string; provider?: string; taskKey?: string; source?: string; afterIso?: string; beforeIso?: string; limit?: number }): Promise<RoutingCapabilitySignalRow[]>;
  getRoutingCapabilitySignal(id: string): Promise<RoutingCapabilitySignalRow | null>;
  insertMessageFeedback(row: Omit<MessageFeedbackRow, 'created_at'> & { created_at?: string }): Promise<void>;
  listMessageFeedback(opts?: { messageId?: string; chatId?: string; signal?: string; tenantId?: string; userId?: string; limit?: number }): Promise<MessageFeedbackRow[]>;
  getMessageFeedback(id: string): Promise<MessageFeedbackRow | null>;
  insertRoutingSurfaceItem(row: Omit<RoutingSurfaceItemRow, 'created_at' | 'resolved_at'> & { created_at?: string; resolved_at?: string | null }): Promise<void>;
  listRoutingSurfaceItems(opts?: { status?: string; modelId?: string; provider?: string; taskKey?: string; limit?: number }): Promise<RoutingSurfaceItemRow[]>;
  getRoutingSurfaceItem(id: string): Promise<RoutingSurfaceItemRow | null>;
  updateRoutingSurfaceItem(id: string, fields: Partial<Omit<RoutingSurfaceItemRow, 'id' | 'created_at'>>): Promise<void>;

  // A/B Routing Experiments
  createRoutingExperiment(r: Omit<RoutingExperimentRow, 'created_at' | 'updated_at' | 'started_at' | 'ended_at'> & { started_at?: string; ended_at?: string | null }): Promise<void>;
  getRoutingExperiment(id: string): Promise<RoutingExperimentRow | null>;
  listRoutingExperiments(opts?: { status?: string; taskKey?: string; tenantId?: string | null }): Promise<RoutingExperimentRow[]>;
  updateRoutingExperiment(id: string, fields: Partial<Omit<RoutingExperimentRow, 'id' | 'created_at'>>): Promise<void>;
  deleteRoutingExperiment(id: string): Promise<void>;
}
