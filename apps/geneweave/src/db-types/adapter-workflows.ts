import type { WorkflowDefRow, WorkflowHandlerKindRow, TriggerRow, TriggerInvocationRow, MeshContractRow } from './workflows.js';

export interface IWorkflowStore {
  // Workflow definitions
  createWorkflowDef(w: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWorkflowDef(id: string): Promise<WorkflowDefRow | null>;
  listWorkflowDefs(): Promise<WorkflowDefRow[]>;
  updateWorkflowDef(id: string, fields: Partial<Omit<WorkflowDefRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWorkflowDef(id: string): Promise<void>;

  // Handler Kinds
  listWorkflowHandlerKinds(): Promise<WorkflowHandlerKindRow[]>;
  getWorkflowHandlerKind(kind: string): Promise<WorkflowHandlerKindRow | null>;
  upsertWorkflowHandlerKind(row: Omit<WorkflowHandlerKindRow, 'created_at' | 'updated_at'>): Promise<void>;

  // Triggers
  listTriggers(opts?: { enabled?: boolean; sourceKind?: string; targetKind?: string }): Promise<TriggerRow[]>;
  getTrigger(id: string): Promise<TriggerRow | null>;
  getTriggerByKey(key: string): Promise<TriggerRow | null>;
  createTrigger(row: Omit<TriggerRow, 'created_at' | 'updated_at'>): Promise<TriggerRow>;
  updateTrigger(id: string, patch: Partial<Omit<TriggerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTrigger(id: string): Promise<void>;
  insertTriggerInvocation(row: Omit<TriggerInvocationRow, 'created_at'>): Promise<void>;
  listTriggerInvocations(opts?: { triggerId?: string; status?: string; limit?: number; offset?: number }): Promise<TriggerInvocationRow[]>;

  // Mesh contracts
  insertMeshContract(row: Omit<MeshContractRow, 'created_at'>): Promise<void>;
  getMeshContract(id: string): Promise<MeshContractRow | null>;
  listMeshContracts(opts?: { kind?: string; meshId?: string; workflowRunId?: string; after?: string; before?: string; limit?: number; offset?: number }): Promise<MeshContractRow[]>;
}
