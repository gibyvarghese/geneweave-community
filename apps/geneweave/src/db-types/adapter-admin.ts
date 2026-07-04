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
}
