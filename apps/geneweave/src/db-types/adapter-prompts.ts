import type { ModelPricingRow } from './routing.js';
import type { PromptRow, PromptFrameworkRow, PromptFragmentRow, PromptContractRow, PromptStrategyRow, PromptVersionRow, PromptExperimentRow, PromptEvalDatasetRow, PromptEvalRunRow, PromptOptimizerRow, PromptOptimizationRunRow } from './prompts.js';

export interface IPromptStore {
  // Model Pricing
  createModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void>;
  getModelPricing(id: string): Promise<ModelPricingRow | null>;
  listModelPricing(): Promise<ModelPricingRow[]>;
  updateModelPricing(id: string, fields: Partial<Omit<ModelPricingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteModelPricing(id: string): Promise<void>;
  upsertModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void>;

  // Prompts
  createPrompt(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPrompt(id: string): Promise<PromptRow | null>;
  getPromptByKey(key: string): Promise<PromptRow | null>;
  getPromptByName(name: string): Promise<PromptRow | null>;
  listPrompts(): Promise<PromptRow[]>;
  updatePrompt(id: string, fields: Partial<Omit<PromptRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePrompt(id: string): Promise<void>;
  /**
   * Tenancy Realm: insert a prompt row INCLUDING its realm columns (createPrompt omits them and always
   * defaults to the global realm). Used to persist a tenant's copy-on-write fork of a global prompt.
   */
  insertRealmPromptRow(row: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void>;
  /** Tenancy Realm Phase 2: which built-in prompts are in_sync / customized / stale / diverged vs the shipped defaults. */
  promptDriftReport(): Promise<import('../realm-prompt-drift.js').PromptDriftReport>;
  /** Tenancy Realm Phase 2: take the shipped version for a customized/diverged built-in (re-baseline to in_sync). */
  resyncPromptToPackage(promptId: string): Promise<{ ok: boolean; reason?: string }>;
  // ── Tenancy Realm Phase 3: per-tenant state overlay (disable/reprioritise/pin a built-in, no fork) ──
  setRealmState(family: string, logicalKey: string, tenantId: string, patch: Partial<import('@weaveintel/realm').RealmStateOverlay>): Promise<import('@weaveintel/realm').RealmStateRecord>;
  clearRealmState(family: string, logicalKey: string, tenantId: string): Promise<void>;
  listRealmStates(family: string, tenantId: string): Promise<import('@weaveintel/realm').RealmStateRecord[]>;
  resolveRealmStates(family: string, tenantId: string | null, logicalKeys: readonly string[]): Promise<Map<string, import('@weaveintel/realm').ResolvedState>>;
  /**
   * Tenancy Realm (D14): for each logical key this tenant has pinned to a PUBLISHED version, the
   * historical payload to serve instead of the current global default. Keys with no pin — or a pin to a
   * version that was never published — are absent. Null tenant → empty (globals are never pinned).
   */
  resolveRealmPinnedVersions(family: string, tenantId: string | null, logicalKeys: readonly string[]): Promise<Map<string, import('../realm-pinned-version.js').PinnedContent>>;
  // ── Tenancy Realm Phase 4: real tenant-tree resolution + share down the tree + promote a fork up ──
  /** The tenant's real lineage (root → self) so parent-shared forks + parent overlays resolve at depth. */
  realmContext(tenantId: string | null): Promise<import('@weaveintel/realm').RealmContext>;
  /** Preview who a share of this fork would reach (inheriting / shadowed / out-of-scope). */
  promptShareBlastRadius(promptId: string, shareMode: import('@weaveintel/realm').ShareMode): Promise<import('@weaveintel/realm').BlastRadius | { error: string }>;
  /** Flip a tenant fork's share mode (private | children | subtree). */
  setPromptShareMode(promptId: string, shareMode: import('@weaveintel/realm').ShareMode): Promise<{ ok: boolean; reason?: string }>;
  /** Promote a tenant fork to the shared global default (ProposeToRealm approve). */
  promotePromptToGlobal(promptId: string): Promise<{ ok: boolean; reason?: string; logicalKey?: string }>;

  // ── Tenancy Realm Section D: write-path & governance (family-agnostic over the realm registry) ──
  /** Promote a fork in ANY realm family onto its global default, re-baselining + recording a version. */
  promoteRealmFork(family: string, forkId: string): Promise<import('../realm-governance.js').PromoteResult>;
  /** D12: a tenant admin proposes their fork become the global default. Lands `pending`; nothing changes yet. */
  proposeRealmFork(family: string, forkId: string, opts?: { proposedBy?: string | null; note?: string | null }): Promise<import('../realm-governance.js').ProposeResult>;
  /** D12: the review queue (default `pending`), newest first. */
  listRealmProposals(opts?: { status?: import('../realm-governance.js').ProposalStatus; family?: string }): Promise<import('../realm-governance.js').RealmProposalRow[]>;
  /** D12: platform-admin approval — promotes the fork, then closes the proposal. */
  approveRealmProposal(proposalId: string, opts?: { reviewer?: string | null; reviewNote?: string | null }): Promise<import('../realm-governance.js').ReviewResult>;
  /** D12: platform-admin rejection — closes the proposal, changes nothing. */
  rejectRealmProposal(proposalId: string, opts?: { reviewer?: string | null; reviewNote?: string | null }): Promise<import('../realm-governance.js').ReviewResult>;
  /** D15: retire a global default — it keeps resolving, but can no longer be freshly customized. */
  deprecateRealmRecord(family: string, id: string, opts?: { note?: string | null; supersededById?: string | null }): Promise<import('../realm-governance.js').DeprecateResult>;
  /** D15: bring a deprecated global default back into service. */
  undeprecateRealmRecord(family: string, id: string): Promise<import('../realm-governance.js').DeprecateResult>;
  /** D17: does this tenant already SEE a record under `logicalKey`? Then it may only Customize it. */
  checkRealmKeyCollision(family: string, logicalKey: string, tenantId: string | null): Promise<import('../realm-governance.js').KeyCollision>;
  /** D16: move a tenant (and its subtree) under a new parent; returns the before/after + affected subtree. */
  reparentTenant(tenantId: string, newParentTenantId: string | null): Promise<import('../realm-governance.js').ReparentDiff>;

  // Prompt Versions
  createPromptVersion(v: Omit<PromptVersionRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptVersion(id: string): Promise<PromptVersionRow | null>;
  listPromptVersions(promptId?: string): Promise<PromptVersionRow[]>;
  updatePromptVersion(id: string, fields: Partial<Omit<PromptVersionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptVersion(id: string): Promise<void>;

  // Prompt Experiments
  createPromptExperiment(e: Omit<PromptExperimentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptExperiment(id: string): Promise<PromptExperimentRow | null>;
  listPromptExperiments(promptId?: string): Promise<PromptExperimentRow[]>;
  updatePromptExperiment(id: string, fields: Partial<Omit<PromptExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptExperiment(id: string): Promise<void>;

  // Prompt Eval Datasets
  createPromptEvalDataset(d: Omit<PromptEvalDatasetRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptEvalDataset(id: string): Promise<PromptEvalDatasetRow | null>;
  listPromptEvalDatasets(promptId?: string): Promise<PromptEvalDatasetRow[]>;
  updatePromptEvalDataset(id: string, fields: Partial<Omit<PromptEvalDatasetRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptEvalDataset(id: string): Promise<void>;

  // Prompt Eval Runs
  createPromptEvalRun(r: Omit<PromptEvalRunRow, 'created_at'>): Promise<void>;
  getPromptEvalRun(id: string): Promise<PromptEvalRunRow | null>;
  listPromptEvalRuns(datasetId?: string): Promise<PromptEvalRunRow[]>;
  deletePromptEvalRun(id: string): Promise<void>;

  // Prompt Optimizers
  createPromptOptimizer(o: Omit<PromptOptimizerRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptOptimizer(id: string): Promise<PromptOptimizerRow | null>;
  getPromptOptimizerByKey(key: string): Promise<PromptOptimizerRow | null>;
  listPromptOptimizers(): Promise<PromptOptimizerRow[]>;
  updatePromptOptimizer(id: string, fields: Partial<Omit<PromptOptimizerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptOptimizer(id: string): Promise<void>;

  // Prompt Optimization Runs
  createPromptOptimizationRun(r: Omit<PromptOptimizationRunRow, 'created_at'>): Promise<void>;
  getPromptOptimizationRun(id: string): Promise<PromptOptimizationRunRow | null>;
  listPromptOptimizationRuns(promptId?: string): Promise<PromptOptimizationRunRow[]>;
  deletePromptOptimizationRun(id: string): Promise<void>;

  // Prompt Frameworks
  createPromptFramework(f: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptFramework(id: string): Promise<PromptFrameworkRow | null>;
  getPromptFrameworkByKey(key: string): Promise<PromptFrameworkRow | null>;
  listPromptFrameworks(): Promise<PromptFrameworkRow[]>;
  updatePromptFramework(id: string, fields: Partial<Omit<PromptFrameworkRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptFramework(id: string): Promise<void>;
  /** Tenancy Realm (m159) — insert a fully-formed realm framework row (a tenant fork), realm columns included. */
  insertRealmPromptFrameworkRow(f: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>): Promise<void>;
  /** Tenancy Realm (m159) — the effective framework set for a tenant (forks + shared ancestors + globals, nearest-owner-wins, canonical key restored). Null tenant = globals only. */
  resolveTenantEffectivePromptFrameworks(tenantId: string | null): Promise<PromptFrameworkRow[]>;

  // Prompt Fragments
  createPromptFragment(f: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptFragment(id: string): Promise<PromptFragmentRow | null>;
  getPromptFragmentByKey(key: string): Promise<PromptFragmentRow | null>;
  listPromptFragments(): Promise<PromptFragmentRow[]>;
  updatePromptFragment(id: string, fields: Partial<Omit<PromptFragmentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptFragment(id: string): Promise<void>;
  /** Tenancy Realm (D13): insert a fragment row carrying explicit realm columns (a tenant's fork). */
  insertRealmPromptFragmentRow(f: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>): Promise<void>;
  /** Tenancy Realm (D13): the fragments a tenant effectively sees, nearest-owner-wins, canonical key restored. */
  resolveTenantEffectivePromptFragments(tenantId: string | null): Promise<PromptFragmentRow[]>;

  // Prompt Contracts
  createPromptContract(c: Omit<PromptContractRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptContract(id: string): Promise<PromptContractRow | null>;
  getPromptContractByKey(key: string): Promise<PromptContractRow | null>;
  listPromptContracts(): Promise<PromptContractRow[]>;
  updatePromptContract(id: string, fields: Partial<Omit<PromptContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptContract(id: string): Promise<void>;
  /** Tenancy Realm (m159) — insert a fully-formed realm contract row (a tenant fork), realm columns included. */
  insertRealmPromptContractRow(c: Omit<PromptContractRow, 'created_at' | 'updated_at'>): Promise<void>;
  /** Tenancy Realm (m159) — the effective contract set for a tenant (forks + shared ancestors + globals, nearest-owner-wins, canonical key restored). Null tenant = globals only. */
  resolveTenantEffectivePromptContracts(tenantId: string | null): Promise<PromptContractRow[]>;

  // Prompt Strategies
  createPromptStrategy(s: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptStrategy(id: string): Promise<PromptStrategyRow | null>;
  getPromptStrategyByKey(key: string): Promise<PromptStrategyRow | null>;
  listPromptStrategies(): Promise<PromptStrategyRow[]>;
  updatePromptStrategy(id: string, fields: Partial<Omit<PromptStrategyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptStrategy(id: string): Promise<void>;
  /** Tenancy Realm (m159) — insert a fully-formed realm strategy row (a tenant fork), realm columns included. */
  insertRealmPromptStrategyRow(s: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>): Promise<void>;
  /** Tenancy Realm (m159) — the effective strategy set for a tenant (forks + shared ancestors + globals, nearest-owner-wins, canonical key restored). Null tenant = globals only. */
  resolveTenantEffectivePromptStrategies(tenantId: string | null): Promise<PromptStrategyRow[]>;
}
