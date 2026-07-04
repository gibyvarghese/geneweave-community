/**
 * Database row types for the artifacts + artifact_versions tables (m77).
 */

export interface ArtifactRow {
  id: string;
  name: string;
  type: string;
  mime_type: string;
  data_text: string | null;
  data_blob: Buffer | null;
  size_bytes: number | null;
  version: number;
  session_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  tags: string | null;        // JSON string[]
  metadata: string | null;    // JSON object
  policy_id: string | null;
  scope: string;              // 'session' | 'user'
  /** m79: 'streaming' while generating, 'error' on failure, NULL when complete. */
  streaming_status: string | null;
  /** m79: 0.0–1.0 progress fraction. NULL when not streaming. */
  streaming_progress: number | null;
  /** m81: tenant that owns this artifact; NULL = platform-level or pre-m81 row. */
  tenant_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ArtifactVersionRow {
  id: string;
  artifact_id: string;
  version: number;
  data_text: string | null;
  data_blob: Buffer | null;
  changelog: string | null;
  created_at: string;
}

export interface ArtifactSaveInput {
  name: string;
  type: string;
  mimeType: string;
  data: unknown;
  sizeBytes?: number;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  policyId?: string;
  scope?: 'session' | 'user';
  /** m79: Set to 'streaming' when the artifact is being generated progressively. */
  streamingStatus?: 'streaming' | null;
  /** m79: 0.0–1.0 initial progress fraction. */
  streamingProgress?: number | null;
  /** m81: tenant that owns this artifact; omit to leave NULL. */
  tenantId?: string;
}

export interface ArtifactUpdateInput {
  name?: string;
  type?: string;
  mimeType?: string;
  data?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  policyId?: string;
  scope?: 'session' | 'user';
  /** m79: Explicit streaming_status to write. Use null to clear (mark complete). */
  streamingStatus?: 'streaming' | 'error' | null;
  /** m79: 0.0–1.0 progress fraction. */
  streamingProgress?: number | null;
}

// ─── Live artifact configs (m80) ─────────────────────────────────────────────

export interface LiveArtifactConfigRow {
  id: string;
  artifact_id: string;
  /** Key into mcp_gateway_clients; null = inline refreshFn only */
  mcp_server_key: string | null;
  /** MCP tool name to invoke on refresh */
  refresh_tool: string | null;
  /** JSON-encoded arguments passed to the tool */
  refresh_args: string | null;
  /** 0 = manual only; >0 = auto-refresh interval in seconds */
  refresh_interval_seconds: number;
  /** Deduplicate rapid refreshes: skip tool call if refreshed within this window */
  cache_ttl_seconds: number;
  last_refreshed_at: string | null;
  refresh_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface LiveArtifactConfigInput {
  artifactId: string;
  mcpServerKey?: string;
  refreshTool?: string;
  refreshArgs?: Record<string, unknown>;
  /** 0 = manual only */
  refreshIntervalSeconds?: number;
  /** default 30 */
  cacheTtlSeconds?: number;
}

export interface LiveArtifactConfigUpdate {
  mcpServerKey?: string | null;
  refreshTool?: string | null;
  refreshArgs?: Record<string, unknown> | null;
  refreshIntervalSeconds?: number;
  cacheTtlSeconds?: number;
}

// ─── Tenant artifact settings (m78) ─────────────────────────────────────────

export interface TenantArtifactSettingsRow {
  id: string;
  tenant_id: string;
  allowed_types: string | null;    // JSON string[] | NULL = all types allowed
  max_size_bytes: number | null;
  require_policy: number;          // 0 | 1
  preview_enabled: number;         // 0 | 1
  sandbox_html: number;            // 0 | 1
  emit_enabled: number;            // 0 | 1
  created_at: string;
  updated_at: string | null;
}

export interface ArtifactListFilter {
  type?: string | string[];
  sessionId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  scope?: 'session' | 'user';
  tags?: string[];
  policyId?: string;
  /** m81: filter by tenant. Pass null to match rows with tenant_id IS NULL. */
  tenantId?: string | null;
  limit?: number;
  offset?: number;
}
