import type { HumanTaskPolicyRow, TaskContractRow, CachePolicyRow, CacheSettingsRow, CacheMetricsDelta, CacheMetricsSummary, SemanticCacheConfigRow, RunStreamConfigRow, AgentPlanCacheConfigRow, CacheInvalidationRuleRow, ToolCachePolicyRow, IdentityRuleRow, MemoryGovernanceRow, MemoryExtractionRuleRow, SearchProviderRow, HttpEndpointRow, SocialAccountRow, EnterpriseConnectorRow, ReplayScenarioRow, TriggerDefinitionRow, TenantConfigRow, SandboxPolicyRow, ExtractionPipelineRow, ArtifactPolicyRow, ReliabilityPolicyRow, CollaborationSessionRow, ComplianceRuleRow, GraphConfigRow, PluginConfigRow } from './admin.js';
import type { ScaffoldTemplateRow, RecipeConfigRow, WidgetConfigRow, ValidationRuleRow } from './dev-experience.js';

export interface IAdminStore {
  // Human Task Policies
  createHumanTaskPolicy(p: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getHumanTaskPolicy(id: string): Promise<HumanTaskPolicyRow | null>;
  listHumanTaskPolicies(): Promise<HumanTaskPolicyRow[]>;
  updateHumanTaskPolicy(id: string, fields: Partial<Omit<HumanTaskPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteHumanTaskPolicy(id: string): Promise<void>;

  // Task Contracts
  createTaskContract(c: Omit<TaskContractRow, 'created_at' | 'updated_at'>): Promise<void>;
  getTaskContract(id: string): Promise<TaskContractRow | null>;
  listTaskContracts(): Promise<TaskContractRow[]>;
  updateTaskContract(id: string, fields: Partial<Omit<TaskContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTaskContract(id: string): Promise<void>;

  // Cache Policies
  createCachePolicy(p: Omit<CachePolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCachePolicy(id: string): Promise<CachePolicyRow | null>;
  listCachePolicies(): Promise<CachePolicyRow[]>;
  updateCachePolicy(id: string, fields: Partial<Omit<CachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCachePolicy(id: string): Promise<void>;

  // Cache Settings (single global row, Phase 1 multi-tier topology)
  getCacheSettings(): Promise<CacheSettingsRow | null>;
  updateCacheSettings(fields: Partial<Omit<CacheSettingsRow, 'id' | 'updated_at'>>): Promise<void>;

  // Cache Metrics (Phase 3 observability rollup)
  recordCacheMetrics(delta: CacheMetricsDelta): Promise<void>;
  getCacheMetrics(limit?: number): Promise<CacheMetricsSummary>;

  // Semantic Cache Config (Phase 4 single global row)
  getSemanticCacheConfig(): Promise<SemanticCacheConfigRow | null>;
  updateSemanticCacheConfig(fields: Partial<Omit<SemanticCacheConfigRow, 'id' | 'updated_at'>>): Promise<void>;

  // Run Stream Config (Client Phase 0 single global row)
  getRunStreamConfig(): Promise<RunStreamConfigRow | null>;
  updateRunStreamConfig(fields: Partial<Omit<RunStreamConfigRow, 'id' | 'updated_at'>>): Promise<void>;

  // Agent Plan Cache Config (Phase 8 single global row)
  getAgentPlanCacheConfig(): Promise<AgentPlanCacheConfigRow | null>;
  updateAgentPlanCacheConfig(fields: Partial<Omit<AgentPlanCacheConfigRow, 'id' | 'updated_at'>>): Promise<void>;

  // Cache Invalidation Rules (Phase 5 event-driven engine)
  createCacheInvalidationRule(r: Omit<CacheInvalidationRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCacheInvalidationRule(id: string): Promise<CacheInvalidationRuleRow | null>;
  listCacheInvalidationRules(): Promise<CacheInvalidationRuleRow[]>;
  updateCacheInvalidationRule(id: string, fields: Partial<Omit<CacheInvalidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCacheInvalidationRule(id: string): Promise<void>;

  // Tool Cache Policies (Phase 6 opt-in tool-result caching)
  createToolCachePolicy(r: Omit<ToolCachePolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolCachePolicy(id: string): Promise<ToolCachePolicyRow | null>;
  listToolCachePolicies(): Promise<ToolCachePolicyRow[]>;
  updateToolCachePolicy(id: string, fields: Partial<Omit<ToolCachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolCachePolicy(id: string): Promise<void>;

  // Identity Rules
  createIdentityRule(r: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getIdentityRule(id: string): Promise<IdentityRuleRow | null>;
  listIdentityRules(): Promise<IdentityRuleRow[]>;
  updateIdentityRule(id: string, fields: Partial<Omit<IdentityRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteIdentityRule(id: string): Promise<void>;

  // Memory Governance
  createMemoryGovernance(g: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>): Promise<void>;
  getMemoryGovernance(id: string): Promise<MemoryGovernanceRow | null>;
  listMemoryGovernance(): Promise<MemoryGovernanceRow[]>;
  updateMemoryGovernance(id: string, fields: Partial<Omit<MemoryGovernanceRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteMemoryGovernance(id: string): Promise<void>;

  // Memory Extraction Rules
  createMemoryExtractionRule(r: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getMemoryExtractionRule(id: string): Promise<MemoryExtractionRuleRow | null>;
  listMemoryExtractionRules(ruleType?: string): Promise<MemoryExtractionRuleRow[]>;
  updateMemoryExtractionRule(id: string, fields: Partial<Omit<MemoryExtractionRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteMemoryExtractionRule(id: string): Promise<void>;

  // Search Providers
  createSearchProvider(p: Omit<SearchProviderRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSearchProvider(id: string): Promise<SearchProviderRow | null>;
  listSearchProviders(): Promise<SearchProviderRow[]>;
  updateSearchProvider(id: string, fields: Partial<Omit<SearchProviderRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSearchProvider(id: string): Promise<void>;

  // HTTP Endpoints
  createHttpEndpoint(e: Omit<HttpEndpointRow, 'created_at' | 'updated_at'>): Promise<void>;
  getHttpEndpoint(id: string): Promise<HttpEndpointRow | null>;
  listHttpEndpoints(): Promise<HttpEndpointRow[]>;
  updateHttpEndpoint(id: string, fields: Partial<Omit<HttpEndpointRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteHttpEndpoint(id: string): Promise<void>;

  // Social Accounts
  createSocialAccount(a: Omit<SocialAccountRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSocialAccount(id: string): Promise<SocialAccountRow | null>;
  listSocialAccounts(): Promise<SocialAccountRow[]>;
  updateSocialAccount(id: string, fields: Partial<Omit<SocialAccountRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSocialAccount(id: string): Promise<void>;

  // Enterprise Connectors
  createEnterpriseConnector(c: Omit<EnterpriseConnectorRow, 'created_at' | 'updated_at'>): Promise<void>;
  getEnterpriseConnector(id: string): Promise<EnterpriseConnectorRow | null>;
  listEnterpriseConnectors(): Promise<EnterpriseConnectorRow[]>;
  updateEnterpriseConnector(id: string, fields: Partial<Omit<EnterpriseConnectorRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteEnterpriseConnector(id: string): Promise<void>;

  // Tool Registry
  createToolRegistryEntry(t: Omit<import('./tools.js').ToolRegistryRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolRegistryEntry(id: string): Promise<import('./tools.js').ToolRegistryRow | null>;
  listToolRegistry(): Promise<import('./tools.js').ToolRegistryRow[]>;
  updateToolRegistryEntry(id: string, fields: Partial<Omit<import('./tools.js').ToolRegistryRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolRegistryEntry(id: string): Promise<void>;

  // Replay Scenarios
  createReplayScenario(s: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>): Promise<void>;
  getReplayScenario(id: string): Promise<ReplayScenarioRow | null>;
  listReplayScenarios(): Promise<ReplayScenarioRow[]>;
  updateReplayScenario(id: string, fields: Partial<Omit<ReplayScenarioRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteReplayScenario(id: string): Promise<void>;

  // Trigger Definitions
  createTriggerDefinition(t: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>): Promise<void>;
  getTriggerDefinition(id: string): Promise<TriggerDefinitionRow | null>;
  listTriggerDefinitions(): Promise<TriggerDefinitionRow[]>;
  updateTriggerDefinition(id: string, fields: Partial<Omit<TriggerDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTriggerDefinition(id: string): Promise<void>;

  // Tenant Configs
  createTenantConfig(c: Omit<TenantConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getTenantConfig(id: string): Promise<TenantConfigRow | null>;
  /** Returns the platform-level config row (scope='global'). Used by PlatformLimitsResolver. */
  getGlobalTenantConfig(): Promise<TenantConfigRow | null>;
  /** Returns the first enabled config row matching a specific tenant_id (non-global). */
  getTenantConfigForTenant(tenantId: string): Promise<TenantConfigRow | null>;
  listTenantConfigs(): Promise<TenantConfigRow[]>;
  updateTenantConfig(id: string, fields: Partial<Omit<TenantConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTenantConfig(id: string): Promise<void>;

  // Sandbox Policies
  createSandboxPolicy(p: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSandboxPolicy(id: string): Promise<SandboxPolicyRow | null>;
  listSandboxPolicies(): Promise<SandboxPolicyRow[]>;
  updateSandboxPolicy(id: string, fields: Partial<Omit<SandboxPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSandboxPolicy(id: string): Promise<void>;

  // Extraction Pipelines
  createExtractionPipeline(p: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>): Promise<void>;
  getExtractionPipeline(id: string): Promise<ExtractionPipelineRow | null>;
  listExtractionPipelines(): Promise<ExtractionPipelineRow[]>;
  updateExtractionPipeline(id: string, fields: Partial<Omit<ExtractionPipelineRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteExtractionPipeline(id: string): Promise<void>;

  // Artifact Policies
  createArtifactPolicy(p: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getArtifactPolicy(id: string): Promise<ArtifactPolicyRow | null>;
  listArtifactPolicies(): Promise<ArtifactPolicyRow[]>;
  updateArtifactPolicy(id: string, fields: Partial<Omit<ArtifactPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteArtifactPolicy(id: string): Promise<void>;

  // Reliability Policies
  createReliabilityPolicy(p: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getReliabilityPolicy(id: string): Promise<ReliabilityPolicyRow | null>;
  listReliabilityPolicies(): Promise<ReliabilityPolicyRow[]>;
  updateReliabilityPolicy(id: string, fields: Partial<Omit<ReliabilityPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteReliabilityPolicy(id: string): Promise<void>;

  // Collaboration Sessions
  createCollaborationSession(s: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCollaborationSession(id: string): Promise<CollaborationSessionRow | null>;
  listCollaborationSessions(): Promise<CollaborationSessionRow[]>;
  updateCollaborationSession(id: string, fields: Partial<Omit<CollaborationSessionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCollaborationSession(id: string): Promise<void>;

  // Compliance Rules
  createComplianceRule(r: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getComplianceRule(id: string): Promise<ComplianceRuleRow | null>;
  listComplianceRules(): Promise<ComplianceRuleRow[]>;
  updateComplianceRule(id: string, fields: Partial<Omit<ComplianceRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteComplianceRule(id: string): Promise<void>;

  // Graph Configs
  createGraphConfig(g: Omit<GraphConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getGraphConfig(id: string): Promise<GraphConfigRow | null>;
  listGraphConfigs(): Promise<GraphConfigRow[]>;
  updateGraphConfig(id: string, fields: Partial<Omit<GraphConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteGraphConfig(id: string): Promise<void>;

  // Plugin Configs
  createPluginConfig(p: Omit<PluginConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPluginConfig(id: string): Promise<PluginConfigRow | null>;
  listPluginConfigs(): Promise<PluginConfigRow[]>;
  updatePluginConfig(id: string, fields: Partial<Omit<PluginConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePluginConfig(id: string): Promise<void>;

  // Scaffold Templates
  createScaffoldTemplate(t: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>): Promise<void>;
  getScaffoldTemplate(id: string): Promise<ScaffoldTemplateRow | null>;
  listScaffoldTemplates(): Promise<ScaffoldTemplateRow[]>;
  updateScaffoldTemplate(id: string, fields: Partial<Omit<ScaffoldTemplateRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteScaffoldTemplate(id: string): Promise<void>;

  // Recipe Configs
  createRecipeConfig(r: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getRecipeConfig(id: string): Promise<RecipeConfigRow | null>;
  listRecipeConfigs(): Promise<RecipeConfigRow[]>;
  updateRecipeConfig(id: string, fields: Partial<Omit<RecipeConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteRecipeConfig(id: string): Promise<void>;

  // Widget Configs
  createWidgetConfig(w: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWidgetConfig(id: string): Promise<WidgetConfigRow | null>;
  listWidgetConfigs(): Promise<WidgetConfigRow[]>;
  updateWidgetConfig(id: string, fields: Partial<Omit<WidgetConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWidgetConfig(id: string): Promise<void>;

  // Validation Rules
  createValidationRule(r: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getValidationRule(id: string): Promise<ValidationRuleRow | null>;
  listValidationRules(): Promise<ValidationRuleRow[]>;
  updateValidationRule(id: string, fields: Partial<Omit<ValidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteValidationRule(id: string): Promise<void>;

  // Seed data
  seedDefaultData(): Promise<void>;
  /**
   * Registry-wide realm seed reconcile (Upgrade Engine, L4). Publishes this release's shipped defaults for
   * every realm family, adopts changed defaults the operator never touched, keeps customized/diverged
   * rows, and records outcomes to upgrade_details under a persisted upgrade run. Optional so a partial or
   * legacy adapter can omit it; applySeed calls it defensively. Returns the upgrade run's id.
   */
  seedReconcileRealm?(): Promise<{ runId: string }>;
  /** Upgrade Engine — discover + verify + record the latest release (the `check` command). */
  runUpgradeCheck?(config: import('../upgrade-check.js').CheckConfig): Promise<import('../upgrade-check.js').CheckResult>;
  /** Upgrade Engine — the most recent release check, for the admin status view. */
  latestUpgradeReleaseCheck?(): Promise<import('../upgrade-release-store.js').UpgradeReleaseRow | null>;
  /** Upgrade Engine — read-only preflight gates for the latest accepted release (or `{status:'no_release'}`). */
  runUpgradePreflight?(): Promise<import('../upgrade-preflight.js').PreflightResult | { status: 'no_release' }>;
  /** Upgrade Engine — read-only four-layer preview of the latest accepted release (or `{status:'no_release'}`). */
  runUpgradePreview?(): Promise<import('../upgrade-preview.js').UpgradePreview | { status: 'no_release' }>;
  /** Upgrade Engine — APPLY the latest accepted release (L1→L4, snapshot+verify+rollback), or `{status:'no_release'}`. */
  runUpgradeApply?(opts?: { force?: boolean; unresolvedCodePaths?: string[] }): Promise<import('../upgrade-apply.js').ApplyResult | { status: 'no_release' }>;
  /** Upgrade Engine — MANUAL rollback of a run to its retained pre-upgrade snapshot (`rollback --run <id>`). */
  runUpgradeRollback?(runId: string): Promise<import('../upgrade-rollback.js').RollbackResult>;
  /** Upgrade Engine — the review queue (unresolved upgrade_details + tallies). */
  upgradeReviewQueue?(filter?: { family?: string; priority?: string }): Promise<import('../upgrade-review.js').ReviewQueue>;
  /** Upgrade Engine — resolve one review item (keep / adopt / defer). */
  resolveUpgradeReviewItem?(detailId: string, action: 'keep' | 'adopt' | 'defer', opts?: { resolvedBy?: string | null; comment?: string }): Promise<import('../upgrade-review.js').ReviewResult>;
  /** Upgrade Engine — bulk-resolve matching review items (P1 never bulk-resolved). */
  bulkResolveUpgradeReview?(action: 'keep' | 'adopt' | 'defer', filter?: { family?: string; priority?: string }, opts?: { resolvedBy?: string | null }): Promise<import('../upgrade-review.js').BulkReviewResult>;
  /** Upgrade Engine — undo (re-open) a resolved review item. */
  undoUpgradeReviewItem?(detailId: string): Promise<import('../upgrade-review.js').ReviewResult>;
  /** Upgrade Engine — TEST-ONLY: seed a mixed review queue for the Upgrade Center E2E (gated by PLAYWRIGHT_E2E). */
  seedUpgradeReviewFixture?(): Promise<import('../upgrade-review-fixture.js').SeededReviewFixture>;
  /** Upgrade Engine — TEST-ONLY: seed one L2 code conflict for the Code-section E2E (gated by PLAYWRIGHT_E2E). */
  seedCodeConflictFixture?(): Promise<{ runId: string; path: string }>;
  /** Upgrade Engine — the "needs attention" report (drifted + version-lagging records) for a family. */
  upgradeAttention?(family: string, tenantId?: string): Promise<import('../upgrade-attention.js').AttentionReport>;
  /** Upgrade Engine — L2: capture the current source tree as the stored code baseline. */
  captureCodeBaseline?(): Promise<{ digest: string; fileCount: number }>;
  /** Upgrade Engine — L2: read-only `code status` (live tree vs the stored baseline). */
  runCodeStatus?(): Promise<import('../code-baseline-store.js').CodeStatusOutcome>;
  /** Upgrade Engine — L2: scan the code tree and record its changes as L2 review items. */
  runCodeScan?(): Promise<import('../code-baseline-store.js').CodeScanOutcome>;
  /** Upgrade Engine — Automation: apply the active resolution rules across the review queue (P1 never auto-resolved). */
  applyUpgradeResolutionRules?(opts?: { resolvedBy?: string | null; family?: string; priority?: string }): Promise<import('../upgrade-automation.js').ApplyRulesResult>;
  /** Upgrade Engine — Automation: list resolution rules (all global, or `activeOnly` = the applied set). */
  listUpgradeResolutionRules?(opts?: { activeOnly?: boolean }): Promise<import('../upgrade-automation.js').ResolutionRuleRow[]>;
  /** Upgrade Engine — Automation: create a resolution rule. */
  createUpgradeResolutionRule?(input: import('../upgrade-automation.js').ResolutionRuleInput, opts?: { createdBy?: string | null }): Promise<import('../upgrade-automation.js').ResolutionRuleRow>;
  /** Upgrade Engine — Automation: update a resolution rule (returns null if not found). */
  updateUpgradeResolutionRule?(id: string, patch: Partial<import('../upgrade-automation.js').ResolutionRuleInput>): Promise<import('../upgrade-automation.js').ResolutionRuleRow | null>;
  /** Upgrade Engine — Automation: delete a resolution rule (returns true if removed). */
  deleteUpgradeResolutionRule?(id: string): Promise<boolean>;
  /** Upgrade Engine — Automation: list per-family auto-adopt policy overrides. */
  listUpgradeFamilyPolicies?(): Promise<import('../upgrade-automation.js').FamilyPolicyRow[]>;
  /** Upgrade Engine — Automation: set (upsert) a family's auto-adopt policy override. */
  setUpgradeFamilyPolicy?(family: string, policy: 'always' | 'patch_only' | 'never', opts?: { note?: string | null; updatedBy?: string | null }): Promise<import('../upgrade-automation.js').FamilyPolicyRow>;
  /** Upgrade Engine — Propagation: export the resolved decisions as a signed bundle (or `{status:'not_configured'}` if no signing key). */
  exportUpgradeResolutionBundle?(opts?: { runId?: string }): Promise<import('../upgrade-bundle.js').SignedResolutionBundle | { status: 'not_configured' }>;
  /** Upgrade Engine — Propagation: verify + apply a signed resolution bundle (or `{status:'not_configured'}` if no trusted keys). */
  importUpgradeResolutionBundle?(bundle: import('../upgrade-bundle.js').SignedResolutionBundle, opts?: { resolvedBy?: string | null }): Promise<import('../upgrade-bundle.js').ImportBundleResult | { status: 'not_configured' }>;
  /** Upgrade Engine — Hardening: prune the realm_versions log (keeps head-window + live-referenced + pinned versions). */
  pruneRealmVersions?(opts?: { keepPerKey?: number; family?: string; dryRun?: boolean }): Promise<import('../realm-version-prune.js').PruneResult>;
  /** Upgrade Engine — Hardening: read recent local upgrade telemetry (PII-free lifecycle events, newest first). */
  listUpgradeTelemetry?(opts?: { event?: string; limit?: number }): Promise<import('../upgrade-telemetry.js').UpgradeTelemetryRow[]>;
  /** Upgrade Engine — L2 in-app merge: the unresolved code conflicts (family='code') awaiting a merge decision. */
  listCodeConflicts?(): Promise<import('../code-merge.js').CodeConflictItem[]>;
  /** Upgrade Engine — L2 in-app merge: the three text sides + base-informed pre-merge for one conflicted file (git-sourced). */
  getCodeConflictContent?(path: string): Promise<import('../code-merge.js').CodeConflictContent | import('../code-merge.js').CodeConflictUnavailable>;
  /** Upgrade Engine — L2 in-app merge: apply an operator's resolved content (rejects unresolved markers) + mark the review row resolved. */
  resolveCodeConflict?(detailId: string, path: string, resolvedContent: string, opts?: { resolvedBy?: string | null }): Promise<import('../code-merge.js').ResolveCodeConflictResult>;
}
