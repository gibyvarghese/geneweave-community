/** Semantic, entity, episodic, procedural, working, and credential memory row types. */

export interface SemanticMemoryRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  content: string;
  memory_type: string;         // 'semantic' | 'user_fact' | 'preference' | 'summary'
  source: string;              // 'user' | 'assistant'
  embedding: string | null;    // JSON-serialised number[] for cosine similarity search
  metadata: string | null;     // JSON — correction/supersede lineage markers (W9b)
  created_at: string;
  updated_at: string;
}

export interface EntityMemoryRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  entity_name: string;
  entity_type: string;   // 'person' | 'location' | 'organization' | 'preference' | 'topic' | 'general'
  facts: string;         // JSON object of key→value facts
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryExtractionEventRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  self_disclosure: number;
  regex_entities_count: number;
  llm_entities_count: number;
  merged_entities_count: number;
  events: string | null;
  created_at: string;
}

export interface WebsiteCredentialRow {
  id: string;
  user_id: string;
  site_name: string;
  site_url_pattern: string;
  auth_method: string;           // form_fill | cookie | header | oauth
  credentials_encrypted: string; // AES-256-GCM encrypted JSON blob
  encryption_iv: string;
  last_used_at: string | null;
  status: string;                // active | expired | needs_reauth
  created_at: string;
  updated_at: string;
}

export interface SSOLinkedAccountRow {
  id: string;
  user_id: string;
  identity_provider: string;     // google | github | microsoft | apple | facebook
  email: string | null;
  session_encrypted: string;     // AES-256-GCM encrypted SSOPassThroughAuth JSON
  encryption_iv: string;
  status: string;                // active | expired | needs_reauth
  linked_at: string;
  updated_at: string;
}

export interface EpisodicMemoryRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  message_role: string;   // 'user' | 'assistant'
  content: string;
  importance: number;     // 0–1 salience score
  tags: string | null;    // JSON string[]
  consolidated: number;   // 0 = pending consolidation, 1 = done
  created_at: string;
}

export interface ProceduralMemoryRow {
  id: string;
  user_id: string;
  agent_id: string;
  instruction_delta: string;
  proposed_by: string;          // 'consolidation-curator' | 'user-feedback' | 'admin'
  status: string;               // 'proposed' | 'approved' | 'rejected' | 'applied'
  confidence: number;
  human_task_id: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkingMemorySnapshotRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  agent_id: string;
  content: string;    // JSON — the agent's scratch state
  created_at: string;
}

export interface MemorySettingsRow {
  id: string;
  tenant_id: string | null;       // NULL = global default
  enable_semantic: number;
  enable_entity: number;
  enable_episodic: number;
  enable_procedural: number;
  enable_working: number;
  auto_extract_on_turn: number;
  consolidation_enabled: number;
  consolidation_interval_min: number;
  max_episodic_per_user: number;
  max_semantic_per_user: number;
  max_entity_per_user: number;
  updated_at: string;
}
