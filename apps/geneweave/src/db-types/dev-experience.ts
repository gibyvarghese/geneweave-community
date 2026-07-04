/** Phase 9: Developer Experience row types. */

export interface ScaffoldTemplateRow {
  id: string;
  name: string;
  description: string | null;
  template_type: string;             // 'basic-agent' | 'tool-calling-agent' | 'rag-pipeline' | 'workflow' | 'multi-agent' | 'mcp-server' | 'full-stack'
  files: string | null;              // JSON object { [path]: content }
  dependencies: string | null;       // JSON object { [pkg]: version }
  dev_dependencies: string | null;   // JSON object { [pkg]: version }
  variables: string | null;          // JSON array of variable names
  post_install: string | null;       // shell command to run after scaffold
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface RecipeConfigRow {
  id: string;
  name: string;
  description: string | null;
  recipe_type: string;               // 'workflow' | 'governed' | 'approval' | 'acl-rag' | 'multi-tenant' | 'eval-routed' | 'memory' | 'event-driven' | 'safe-exec'
  model: string | null;
  provider: string | null;
  system_prompt: string | null;
  tools: string | null;              // JSON array
  guardrails: string | null;         // JSON array
  max_steps: number | null;
  options: string | null;            // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WidgetConfigRow {
  id: string;
  name: string;
  description: string | null;
  widget_type: string;               // 'table' | 'chart' | 'form' | 'code' | 'timeline' | 'image'
  default_options: string | null;    // JSON object
  allowed_contexts: string | null;   // JSON array
  max_data_points: number | null;
  refresh_interval_ms: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ValidationRuleRow {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;                 // 'required' | 'range' | 'pattern' | 'custom'
  target: string;                    // 'agent-config' | 'workflow-config' | 'tool-config'
  condition: string | null;          // JSON condition expression
  severity: string;                  // 'error' | 'warning' | 'info'
  message: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}
