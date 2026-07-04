/**
 * DB adapter — /api/me/ user-scope tables
 */
import type { TemporalReminderRow } from './core.js';

export interface UserRunRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  surface: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRunEventRow {
  id: string;
  run_id: string;
  sequence: number;
  kind: string;
  payload: string;
  created_at: string;
}

/** m94 (Collaboration Phase 1) — a current presence row for a run participant. */
export interface RunPresenceRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  display_name: string;
  presence: string;
  peer_type: string;
  color: string | null;
  cursor_json: string | null;
  last_heartbeat_at: number;
  expires_at: number;
  created_at: string;
}

/** m94 — single-row collaboration config (presence cadence, DB-driven). */
export interface CollaborationConfigRow {
  id: string;
  enabled: number;
  presence_heartbeat_ms: number;
  presence_ttl_ms: number;
  presence_sweep_ms: number;
  max_participants_per_run: number;
  show_agent_presence: number;
  updated_at: string;
}

/** m95 (Collaboration Phase 2) — a shared session over a run. */
export interface SharedSessionRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  owner_id: string;
  status: 'live' | 'ended';
  max_participants: number;
  created_at: number;
  ended_at: number | null;
}

/** m95 — a durable membership row (who may access the run + their role). */
export interface SessionParticipantRow {
  id: string;
  session_id: string;
  tenant_id: string | null;
  user_id: string;
  role: 'owner' | 'collaborator' | 'viewer';
  joined_at: number;
  invited_via_token_id: string | null;
}

/** m95 — an invite-link token (SHA-256 hash stored; plaintext shown once). */
export interface ShareTokenRow {
  id: string;
  session_id: string;
  tenant_id: string | null;
  role: 'owner' | 'collaborator' | 'viewer';
  token_hash: string;
  token_prefix: string;
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

/** m96 (Collaboration Phase 3) — a durable run subscription ("notify me"). */
export interface RunSubscriptionRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  /** JSON array of channel ids, e.g. `["inapp","webhook"]`. */
  channels: string;
  created_at: number;
}

/** m96 — a row in the per-user in-app notification feed (the bell inbox). */
export interface NotificationFeedRow {
  id: string;
  tenant_id: string | null;
  principal_id: string;
  category: string;
  title: string;
  body: string | null;
  deep_link: string | null;
  priority: 'low' | 'normal' | 'high';
  dedupe_key: string | null;
  created_at: number;
  read_at: number | null;
}

/** m96 — a transactional-outbox delivery job (crash-safe at-least-once). */
export interface NotificationOutboxRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  channels: string;          // JSON array
  payload: string;           // JSON NotificationMessage
  idempotency_key: string;   // webhook-id + feed dedupe key
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  lease_until: number | null;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

/** m96 — a registered outbound webhook endpoint (referenced by id, never inline). */
export interface WebhookEndpointRow {
  id: string;
  tenant_id: string | null;
  user_id: string;
  url: string;
  signing_secret: string;
  enabled: number;
  created_at: number;
  revoked_at: number | null;
}

/** m97 (Collaboration Phase 4) — a threaded, part-anchored review comment. */
export interface RunCommentRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  thread_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  body_html: string;
  mentions_json: string;
  anchor_part_id: string;
  anchor_seq: number;
  anchor_range_json: string | null;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
}

/** m97 — a structured human-feedback score (the evals bridge). */
export interface RunAnnotationRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  part_id: string;
  author_id: string;
  name: string;
  data_type: 'numeric' | 'categorical' | 'boolean' | 'text';
  value: number | null;
  string_value: string | null;
  comment: string | null;
  source: 'human' | 'llm_judge' | 'eval_code' | 'api' | 'end_user';
  created_at: number;
}

/** m97 — a public read-only share token (capability URL, hashed at rest). */
export interface RunPublicShareRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  token_hash: string;
  token_prefix: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

/** m98 (Collaboration Phase 5) — a durable unified-handoff record. */
export interface SessionHandoffRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  scope: 'user_to_user' | 'agent_to_human' | 'agent_to_agent';
  from_actor_type: 'user' | 'agent' | 'role';
  from_actor_id: string;
  to_actor_type: 'user' | 'agent' | 'role';
  to_actor_id: string;
  state: string;
  reason: string;
  briefing_json: string | null;
  rejection_reason: string | null;
  hand_back_briefing_json: string | null;
  depth: number;
  parent_handoff_id: string | null;
  reference_task_ids_json: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  expires_at: number | null;
}

/** m98 — one append-only handoff audit event (a single transition). */
export interface HandoffEventRow {
  id: string;
  handoff_id: string;
  at: number;
  actor_id: string;
  from_state: string | null;
  to_state: string;
  note: string | null;
}

/** m99 (Collaboration Phase 7) — a CRDT co-editing document (the canonical replica). */
export interface CoeditDocRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  owner_id: string;
  title: string | null;
  snapshot_json: string;       // full RGA state
  state_vector_json: string;   // max op counter per site
  agent_written: number;       // chars the agent peer has streamed (idempotency)
  created_at: number;
  updated_at: number;
}

/** m99 — one append-only co-edit op (keyed by author site + counter). */
export interface CoeditOpRow {
  id: string;
  doc_id: string;
  op_site: string;
  op_counter: number;
  op_json: string;
  created_at: number;
}

// ── weaveNotes Phase 2 — collaborative NOTE co-editing (m100) ──────────────────

/** m100 — the canonical `BlockDoc` CRDT replica for one co-edited note. */
export interface NoteCoeditDocRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  owner_id: string;
  snapshot_json: string;       // full BlockDoc state (elements + LWW attrs + marks)
  state_vector_json: string;   // max op counter per author site
  created_at: number;
  updated_at: number;
}

/** m100 — one append-only block co-edit op (keyed by author site + counter). */
export interface NoteCoeditOpRow {
  id: string;
  doc_id: string;
  op_site: string;
  op_counter: number;
  op_json: string;
  created_at: number;
}

/** m100 — durable note membership (the owner is implicit; only other people get rows). */
export interface NoteShareRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  owner_id: string;
  user_id: string;
  role: 'collaborator' | 'viewer';
  joined_at: number;
  invited_via_token_id: string | null;
}

/** m100 — a note invite link (256-bit token, SHA-256-hashed at rest). */
export interface NoteShareTokenRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  owner_id: string;
  role: 'collaborator' | 'viewer';
  token_hash: string;
  token_prefix: string;
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

/** m101 — one AI co-author SUGGESTION (track-changes: staged block ops a human accepts/rejects). */
export interface NoteSuggestionRow {
  id: string;
  note_id: string;
  doc_id: string;
  tenant_id: string | null;
  author_kind: 'agent' | 'user';
  author_id: string;
  author_site: string;
  action: 'continue' | 'rewrite' | 'summarize' | 'ask' | 'note_edit' | 'ai_block'
    | 'apply_highlight' | 'apply_text_color' | 'colorize_semantic'
    | 'create_diagram' | 'draw_ink' | 'recolor_ink'
    | 'create_illustration' | 'generate_image' | 'restructure_note' | 'find_image';
  status: 'pending' | 'accepted' | 'rejected';
  ops_json: string;
  preview_text: string;
  /** m115: the ORIGINAL text the suggestion replaces (for the inline old→new diff); '' for appends. */
  before_text?: string;
  anchor_json: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

// ── weaveNotes Phase 5 — notes knowledge graph (m102) ─────────────────────────

/** geneWeave UI rebuild (m135) — per-tenant Appearance / white-label branding. */
export interface TenantAppearanceRow {
  tenant_id: string;
  enabled: number;
  brand_name: string | null;
  logo_svg: string | null;
  color_scheme: string; // system | light | dark
  variant: string;      // pro | creative
  accent: string | null;
  on_accent: string | null;
  corner_style: string; // soft | sharp | round
  font_display: string | null;
  font_body: string | null;
  density: string;      // comfortable | compact
  updated_at: string;
}

/** m137 — per-tenant AI-transparency switches (label / disclosure / content warnings / feedback). */
export interface TenantAiTransparencyRow {
  tenant_id: string;
  show_ai_label: number;
  disclosure_text: string;
  content_warnings: number;
  feedback_enabled: number;
  updated_at: string;
}

/** m138 — one VERIFIED citation on an assistant message (the quote provably exists in source at [start,end)). */
export interface MessageCitationRow {
  id: string;
  message_id: string;
  chat_id: string | null;
  user_id: string;
  tenant_id: string | null;
  n: number;
  source_id: string;
  source_kind: string;
  source_title: string;
  quote: string;
  char_start: number;
  char_end: number;
  created_at: string;
}

/** m138 — per-tenant answer-citations config (enabled / strictness / corpus scope / retrieval breadth). */
export interface TenantChatCitationsRow {
  tenant_id: string;
  enabled: number;
  min_citations: number;
  scope: string;        // 'all' | 'notes' | 'runs'
  max_sources: number;
  updated_at: string;
}

/** m139 — one saved version of an assistant answer (append-only history for a question turn). */
export interface MessageVariantRow {
  id: string;
  group_id: string;       // the active assistant messages.id this variant belongs to
  chat_id: string;
  user_id: string;
  tenant_id: string | null;
  variant_index: number;  // 0-based, oldest first
  content: string;
  model: string | null;
  provider: string | null;
  reason: string | null;  // 'original' | 'regenerate'
  created_at: string;
}

/** m139 — per-tenant regenerate/version config. */
export interface TenantAnswerVersionsRow {
  tenant_id: string;
  enabled: number;
  max_variants: number;
  updated_at: string;
}

/** m140/m141 — per-tenant accessibility defaults (streaming announcements + reduced motion + focus ring). */
export interface TenantAccessibilityRow {
  tenant_id: string;
  announce_mode: string;   // 'summary' | 'live' | 'off'
  reduced_motion: number;
  always_show_focus: number; // m141 — force focus outlines visible even for mouse users
  confirm_destructive: number; // m142 — require the "are you sure?" dialog on destructive actions
  show_skeletons: number;      // m144 — show loading-skeleton placeholders on slow views
  updated_at: string;
}

/** m143 — per-tenant policy for which OPTIONAL areas a standard member (tenant_user) can see. */
export interface TenantRoleAccessRow {
  tenant_id: string;
  member_dashboard: number;
  member_connectors: number;
  member_design: number;
  updated_at: string;
}

/** m145 — per-tenant i18n policy: default UI language + which languages members may pick + assistant localisation. */
export interface TenantLocalesRow {
  tenant_id: string;
  default_locale: string;
  enabled_locales: string;   // JSON array of BCP-47 codes
  assistant_localized: number;
  updated_at: string;
}

/** m145 — an AI-generated (or hand-edited) locale pack: translated UI messages for one language in one workspace. */
export interface TenantUiTranslationRow {
  tenant_id: string;
  locale: string;
  messages_json: string;     // JSON object { key: translated string }
  source: string;            // 'ai' | 'manual'
  key_count: number;
  updated_at: string;
}

/** m146 — per-tenant policy for suggested/starter prompts on the empty chat. */
export interface TenantSuggestedPromptsRow {
  tenant_id: string;
  enabled: number;
  use_recent_notes: number;
  use_recent_chats: number;
  use_ai: number;
  max_curated: number;
  max_personalized: number;
  updated_at: string;
}

/** m146 — a per-user cache of the last AI-generated starter prompts (so the empty chat is instant). */
export interface UserPromptSuggestionsRow {
  user_id: string;
  tenant_id: string | null;
  prompts_json: string;
  generated_at: string;
}

/** m146 — an append-only click on a suggested starter (which one was picked). */
export interface PromptSuggestionEventRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  prompt_id: string;
  title: string | null;
  source: string | null;
  created_at: string;
}

/** weaveNotes Phase 5 (m134) — background-memory extraction state per note (content version + memory ids). */
export interface NoteMemoryStateRow {
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  content_hash: string;
  memory_ids_json: string;
  memory_count: number;
  last_extracted_at: string;
}

/** weaveNotes Phase 5 — a note that needs (re)processing for background memory. */
export interface NoteNeedingMemoryRow {
  id: string;
  owner_user_id: string;
  tenant_id: string | null;
  updated_at: string;
}

/** weaveNotes Phase 4 (m133) — one captured meeting/recording: transcript + structured note. */
export interface NoteMeetingRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  title: string;
  source: string;
  language: string | null;
  duration_sec: number;
  segments_json: string;
  summary: string | null;
  action_items_json: string;
  decisions_json: string;
  cited: number;
  cite_total: number;
  audio_retained: number;
  created_at: string;
}

export interface NoteEntityRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  name: string;
  name_key: string;
  type: string;
  created_at: number;
  /** weaveNotes Phase 3 (m132): disambiguation key that folds spelling variants into one entity. */
  canonical_key?: string | null;
  /** weaveNotes Phase 3 (m132): the best display name for the canonical entity. */
  canonical_name?: string | null;
}
export interface NoteRelationRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  subject: string;
  predicate: string;
  object: string;
  created_at: number;
}
export interface NoteEmbeddingRow {
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  dim: number;
  embedding_json: string;
  content_hash: string;
  title: string | null;
  updated_at: number;
}

/** m103 — weaveNotes Phase 8: one embedding per chat RUN output (workspace RAG over runs). */
export interface RunEmbeddingRow {
  run_id: string;
  user_id: string;
  tenant_id: string | null;
  dim: number;
  embedding_json: string;
  content_hash: string;
  title: string | null;
  content: string | null;
  updated_at: number;
}

/** m103 — weaveNotes Phase 8: a per-note version snapshot (history + restore). */
export interface NoteVersionRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  title: string;
  doc_json: string;
  label: string | null;
  reason: string;
  word_count: number;
  created_by: string;
  created_at: number;
}

/** m103 — weaveNotes Phase 8: a threaded, block-anchored review comment on a note. */
export interface NoteCommentRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  thread_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  body_html: string;
  mentions_json: string;
  anchor_block_id: string;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
}

/** m103 — weaveNotes Phase 8: a synced block (transclusion) mirroring another note's block. */
export interface NoteSyncedBlockRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  source_note_id: string;
  source_block_id: string;
  created_at: number;
}

/** m104 — weaveNotes Phase 0: the single-row capability config (Builder-editable). */
export interface WeaveNotesSettingsRow {
  id: string;
  default_theme: string;
  agency_color_enabled: number;
  ai_suggestions_require_approval: number;
  activity_tracking_enabled: number;
  activity_retention_days: number;
  max_ai_tokens_per_edit: number;
  /** weaveNotes Phase 0 hardening: per-user AI actions/minute cap (m120). Optional for old DBs. */
  ai_rate_per_min_per_user?: number;
  /** weaveNotes Phase 1 visual-correctness verify dials (m121). Optional for old DBs. */
  visual_verify_enabled?: number;
  visual_verify_threshold?: number;
  visual_verify_max_retries?: number;
  image_verify_enabled?: number;
  image_verify_min_confidence?: number;
  /** weaveNotes Phase 2 citation dials (m122). Optional for old DBs. */
  citations_enabled?: number;
  citation_max_sources?: number;
  /** weaveNotes Phase 2 query-expansion dials (m125). Optional for old DBs. */
  query_expansion_enabled?: number;
  query_expansion_variants?: number;
  /** weaveNotes Phase 2 FSRS spaced-repetition dials (m123). Optional for old DBs. */
  fsrs_enabled?: number;
  fsrs_target_retention?: number;
  /** weaveNotes Phase 2 translate-a-note dial (m124). Optional for old DBs. */
  translate_enabled?: number;
  /** weaveNotes Phase 2 database auto-fill dials (m126). Optional for old DBs. */
  db_autofill_web_search?: number;
  db_autofill_redact_pii?: number;
  /** weaveNotes Phase 2 image provenance dial (m128). Optional for old DBs. */
  image_provenance_enabled?: number;
  /** weaveNotes Phase 3 scheduled-agent dials (m129). Optional for old DBs. */
  scheduled_agents_enabled?: number;
  scheduled_agent_max_token_budget?: number;
  scheduled_agent_max_per_user?: number;
  /** weaveNotes Phase 3 MCP vault dials (m130). Optional for old DBs. */
  mcp_notes_enabled?: number;
  mcp_notes_allow_writes?: number;
  /** weaveNotes Phase 3: proactive link suggestions as you write (m131). Optional for old DBs. */
  proactive_linking_enabled?: number;
  /** weaveNotes Phase 3: entity disambiguation + batched embeddings (m132). Optional for old DBs. */
  entity_resolution_enabled?: number;
  embedding_batch_size?: number;
  /** weaveNotes Phase 4: voice / meeting capture (m133). Optional for old DBs. */
  voice_capture_enabled?: number;
  store_audio?: number;
  transcription_language?: string;
  transcription_model?: string;
  max_recording_seconds?: number;
  /** weaveNotes Phase 5: background memory / second brain (m134). Optional for old DBs. */
  background_memory_enabled?: number;
  memory_importance_threshold?: number;
  memory_max_per_note?: number;
  memory_recall_count?: number;
  memory_decay_half_life_days?: number;
  local_model_for_sensitive: number;
  /** weaveNotes Phase 3: show live collaborator cursors (0/1). */
  live_cursors_enabled: number;
  /** weaveNotes Phase 3: show the AI as a live participant while it edits (0/1). */
  ai_presence_enabled: number;
  /** weaveNotes Phase 4 creative modes (0/1) + the image model. */
  diagrams_enabled: number;
  ink_enabled: number;
  illustration_enabled: number;
  image_generation_enabled: number;
  image_model: string;
  /** weaveNotes Phase 5: flashcards + spaced repetition. */
  flashcards_enabled: number;
  daily_new_card_limit: number;
  /** weaveNotes Phase 7: mobile offline editing + ink + how many notes to cache on-device. */
  mobile_offline_enabled: number;
  mobile_ink_enabled: number;
  mobile_offline_note_limit: number;
  /** weaveNotes Phase 8: desktop offline cache + open-to-last-note, quick-capture hotkey, cache cap. */
  desktop_offline_enabled: number;
  quick_capture_enabled: number;
  desktop_offline_note_limit: number;
  /** weaveNotes Phase 10: note export on/off + the allowed formats (JSON array of markdown/html/word/json). */
  export_enabled: number;
  allowed_export_formats: string;
  /** weaveNotes: source a real free-to-use image from the web — enabled / provider / allowed-licences
   *  (JSON array) / require-attribution. Columns are optional (added by m118; may be absent on read). */
  image_search_enabled?: number;
  image_search_provider?: string;
  image_search_allowed_licenses?: string;
  image_search_require_attribution?: number;
  enabled_ai_tools: string;
  updated_at: string;
}

/** m104 — weaveNotes Phase 0: a "what changed" activity log row. */
export interface NoteActivityRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  action: string;
  actor: string;
  summary: string | null;
  detail_json: string | null;
  created_at: string;
}

/** weaveNotes Phase 0-B — filters + keyset cursor for the tenant-scoped admin/compliance audit feed. */
export interface NoteActivityQuery {
  limit?: number;
  action?: string;
  actor?: string;
  userId?: string;
  noteId?: string;
  fromDate?: string;   // ISO; created_at >= fromDate
  toDate?: string;     // ISO; created_at <= toDate
  // Keyset cursor (page strictly OLDER than this row): pass the last row's created_at + id.
  beforeCreatedAt?: string;
  beforeId?: string;
}

/** weaveNotes — per-tenant routing mode for one note AI action (Builder-editable). */
export interface NoteActionModeRow {
  id: string;
  tenant_id: string;   // '' = global default for the action
  action_key: string;  // diagram | ink | illustration | visual | restructure
  mode: string;        // direct | agent | supervisor
  updated_at: string;
}

export interface UserDeviceRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  channel: 'web-push' | 'apns' | 'fcm';
  token: string;
  label: string | null;
  created_at: string;
}

export interface NotificationPrefsRow {
  id: string;
  user_id: string;
  enabled: number;
  categories: string;
  quiet_hours: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModeLabel {
  id: string;
  surface_id: string;
  mode_key: string;
  label: string;
  description: string | null;
  icon: string | null;
  is_default: number;
  sort_order: number;
  enabled: number;
  metadata: string | null;
  created_at: string;
}

export interface StarterPrompt {
  id: string;
  surface_id: string;
  label: string;
  prompt_text: string;
  sort_order: number;
  enabled: number;
  metadata: string | null;
  created_at: string;
}

export interface IMeStore {
  // Runs
  createUserRun(run: Pick<UserRunRow, 'id' | 'user_id' | 'status'> & {
    tenant_id?: string; surface?: string; metadata?: string;
  }): Promise<void>;
  getUserRun(id: string, userId: string): Promise<UserRunRow | null>;
  /** Owner-agnostic run lookup (Phase 3 notification outbox). NOT an access path. */
  getUserRunById(id: string): Promise<UserRunRow | null>;
  listUserRuns(userId: string, filter?: {
    status?: UserRunRow['status']; limit?: number; offset?: number;
  }): Promise<UserRunRow[]>;
  updateUserRunStatus(id: string, userId: string, status: UserRunRow['status']): Promise<void>;

  // Run events
  appendUserRunEvent(event: Pick<UserRunEventRow, 'id' | 'run_id' | 'sequence' | 'kind' | 'payload'>): Promise<void>;
  listUserRunEvents(runId: string, afterSequence?: number): Promise<UserRunEventRow[]>;
  /** Per-run journal purge (backs the core RunJournal port's `purgeRun`). */
  deleteUserRunEvents(runId: string): Promise<number>;
  // ── Presence (m94, Collaboration Phase 1) ─────────────────────────────────
  upsertRunPresence(row: Omit<RunPresenceRow, 'created_at' | 'tenant_id' | 'color' | 'cursor_json'> & { tenant_id?: string | null; color?: string | null; cursor_json?: string | null }): Promise<void>;
  listActiveRunPresence(runId: string, now: number): Promise<RunPresenceRow[]>;
  deleteRunPresence(runId: string, userId: string): Promise<number>;
  deleteExpiredRunPresence(now: number): Promise<Array<{ run_id: string; tenant_id: string | null }>>;
  getCollaborationConfig(): Promise<CollaborationConfigRow | null>;
  // ── Shared sessions + invite links (m95, Collaboration Phase 2) ────────────
  createSharedSession(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; max_participants: number; created_at: number }): Promise<void>;
  getSharedSessionById(id: string): Promise<SharedSessionRow | null>;
  getSharedSessionByRun(runId: string): Promise<SharedSessionRow | null>;
  endSharedSession(id: string, endedAt: number): Promise<void>;
  upsertSessionParticipant(row: { id: string; session_id: string; tenant_id?: string | null; user_id: string; role: string; joined_at: number; invited_via_token_id?: string | null }): Promise<void>;
  getSessionParticipant(sessionId: string, userId: string): Promise<SessionParticipantRow | null>;
  listSessionParticipants(sessionId: string): Promise<SessionParticipantRow[]>;
  deleteSessionParticipant(sessionId: string, userId: string): Promise<number>;
  createShareToken(row: { id: string; session_id: string; tenant_id?: string | null; role: string; token_hash: string; token_prefix: string; max_uses?: number | null; expires_at?: number | null; created_by: string; created_at: number }): Promise<void>;
  getShareTokenByHash(tokenHash: string): Promise<ShareTokenRow | null>;
  incrementShareTokenUses(id: string): Promise<void>;
  revokeShareToken(id: string, revokedAt: number): Promise<void>;
  // ── Durable subscriptions + notifications (m96, Collaboration Phase 3) ──────
  upsertRunSubscription(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; created_at: number }): Promise<RunSubscriptionRow>;
  deleteRunSubscription(runId: string, userId: string): Promise<number>;
  getRunSubscription(runId: string, userId: string): Promise<RunSubscriptionRow | null>;
  listRunSubscribers(runId: string): Promise<RunSubscriptionRow[]>;
  listSubscriptionsForUser(userId: string): Promise<RunSubscriptionRow[]>;
  // Notification feed (in-app inbox)
  appendNotificationFeed(row: NotificationFeedRow): Promise<NotificationFeedRow>;
  listNotificationFeed(tenantId: string, principalId: string, opts?: { limit?: number; unreadOnly?: boolean }): Promise<NotificationFeedRow[]>;
  countUnreadNotificationFeed(tenantId: string, principalId: string): Promise<number>;
  markNotificationFeedRead(tenantId: string, principalId: string, id: string, now: number): Promise<boolean>;
  markAllNotificationFeedRead(tenantId: string, principalId: string, now: number): Promise<number>;
  // Transactional outbox (crash-safe delivery)
  enqueueNotificationOutbox(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; payload: string; idempotency_key: string; next_attempt_at: number; created_at: number }): Promise<boolean>;
  /** Atomically claim up to `limit` due rows (status pending/failed, next_attempt_at<=now), leasing them to `sending` until `leaseUntil`. Also reclaims `sending` rows whose lease expired. */
  claimNotificationOutbox(now: number, leaseUntil: number, limit: number): Promise<NotificationOutboxRow[]>;
  markNotificationOutboxSent(id: string, sentAt: number): Promise<void>;
  rescheduleNotificationOutbox(id: string, nextAttemptAt: number, attempts: number, lastError: string, failed: boolean): Promise<void>;
  /** Run ids that already have an outbox row (so a reconciler doesn't double-enqueue). */
  hasNotificationOutboxForRun(runId: string): Promise<boolean>;
  /** Terminal runs that have at least one subscriber (the reconciler backfill scan). */
  listTerminalRunsWithSubscribers(limit: number): Promise<UserRunRow[]>;
  // ── Run comments + annotations + public share (m97, Collaboration Phase 4) ──
  createRunComment(row: RunCommentRow): Promise<void>;
  getRunComment(id: string): Promise<RunCommentRow | null>;
  listRunComments(runId: string): Promise<RunCommentRow[]>;
  listRunCommentThread(threadId: string): Promise<RunCommentRow[]>;
  updateRunCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void>;
  softDeleteRunComment(id: string, deletedBy: string, deletedAt: number): Promise<void>;
  setRunThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void>;
  createRunAnnotation(row: RunAnnotationRow): Promise<void>;
  getRunAnnotation(id: string): Promise<RunAnnotationRow | null>;
  listRunAnnotations(runId: string): Promise<RunAnnotationRow[]>;
  deleteRunAnnotation(id: string): Promise<number>;
  createRunPublicShare(row: { id: string; run_id: string; tenant_id?: string | null; token_hash: string; token_prefix: string; created_by: string; created_at: number; expires_at?: number | null }): Promise<void>;
  getRunPublicShareByHash(tokenHash: string): Promise<RunPublicShareRow | null>;
  listRunPublicShares(runId: string): Promise<RunPublicShareRow[]>;
  revokeRunPublicShare(id: string, runId: string, revokedAt: number): Promise<number>;
  // ── Unified handoff (m98, Collaboration Phase 5) ────────────────────────────
  insertSessionHandoff(row: SessionHandoffRow): Promise<void>;
  getSessionHandoff(id: string): Promise<SessionHandoffRow | null>;
  updateSessionHandoff(id: string, fields: Partial<Pick<SessionHandoffRow, 'state' | 'rejection_reason' | 'hand_back_briefing_json' | 'updated_at' | 'resolved_at'>>): Promise<void>;
  listSessionHandoffsForRun(runId: string): Promise<SessionHandoffRow[]>;
  listSessionHandoffsForActor(actorId: string): Promise<SessionHandoffRow[]>;
  listDueSessionHandoffs(now: number): Promise<SessionHandoffRow[]>;
  insertHandoffEvent(row: HandoffEventRow): Promise<void>;
  listHandoffEvents(handoffId: string): Promise<HandoffEventRow[]>;
  // ── CRDT co-editing (m99, Collaboration Phase 7) ────────────────────────────
  createCoeditDoc(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; title?: string | null; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean>;
  getCoeditDoc(id: string): Promise<CoeditDocRow | null>;
  getCoeditDocByRun(runId: string): Promise<CoeditDocRow | null>;
  updateCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; agent_written: number; updated_at: number }): Promise<void>;
  appendCoeditOp(row: CoeditOpRow): Promise<boolean>;
  listCoeditOps(docId: string): Promise<CoeditOpRow[]>;
  // ── weaveNotes Phase 2 — collaborative NOTE co-editing (m100) ────────────────
  createNoteCoeditDoc(row: { id: string; note_id: string; tenant_id?: string | null; owner_id: string; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean>;
  getNoteCoeditDoc(id: string): Promise<NoteCoeditDocRow | null>;
  getNoteCoeditDocByNote(noteId: string): Promise<NoteCoeditDocRow | null>;
  updateNoteCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; updated_at: number }): Promise<void>;
  appendNoteCoeditOp(row: NoteCoeditOpRow): Promise<boolean>;
  listNoteCoeditOps(docId: string): Promise<NoteCoeditOpRow[]>;
  // Note sharing (membership + invite tokens)
  getNoteForOwner(noteId: string, ownerId: string): Promise<{ id: string; owner_user_id: string; tenant_id: string | null } | null>;
  getNoteShare(noteId: string, userId: string): Promise<NoteShareRow | null>;
  listNoteShares(noteId: string): Promise<NoteShareRow[]>;
  upsertNoteShare(row: NoteShareRow): Promise<void>;
  deleteNoteShare(noteId: string, userId: string): Promise<number>;
  createNoteShareToken(row: NoteShareTokenRow): Promise<void>;
  getNoteShareTokenByHash(hash: string): Promise<NoteShareTokenRow | null>;
  listNoteShareTokens(noteId: string): Promise<NoteShareTokenRow[]>;
  incrementNoteShareTokenUses(id: string): Promise<void>;
  revokeNoteShareToken(id: string, noteId: string, revokedAt: number): Promise<number>;
  // weaveNotes Phase 3 — AI co-author suggestions (track-changes)
  createNoteSuggestion(row: NoteSuggestionRow): Promise<void>;
  getNoteSuggestion(id: string): Promise<NoteSuggestionRow | null>;
  listNoteSuggestions(noteId: string, status?: 'pending' | 'accepted' | 'rejected'): Promise<NoteSuggestionRow[]>;
  resolveNoteSuggestion(id: string, status: 'accepted' | 'rejected', resolvedAt: number, resolvedBy: string): Promise<number>;
  // weaveNotes Phase 5 — notes knowledge graph (entities / relations / embeddings)
  replaceNoteEntities(noteId: string, rows: NoteEntityRow[]): Promise<void>;
  listNoteEntities(noteId: string): Promise<NoteEntityRow[]>;
  // weaveNotes Phase 3 (m132) — all of a user's entities (for cross-note graph / shared-entity retrieval). tenant_id null-safe.
  listUserNoteEntities(userId: string, tenantId?: string | null): Promise<NoteEntityRow[]>;
  // geneWeave UI rebuild (m135) — per-tenant Appearance / branding.
  getTenantAppearance(tenantId: string): Promise<TenantAppearanceRow | null>;
  upsertTenantAppearance(row: TenantAppearanceRow): Promise<void>;
  listTenantAppearance(): Promise<TenantAppearanceRow[]>;
  // m137 — per-tenant AI transparency (answer feedback itself reuses the routing message_feedback store).
  getTenantAiTransparency(tenantId: string): Promise<TenantAiTransparencyRow | null>;
  upsertTenantAiTransparency(row: TenantAiTransparencyRow): Promise<void>;
  listTenantAiTransparency(): Promise<TenantAiTransparencyRow[]>;
  // ↑ getMessageFeedback(id) etc. for the raw store live in the routing adapter (IRoutingStore).
  // m138 — answer citations in chat (verified [n] sources per assistant message) + per-tenant config.
  insertMessageCitations(rows: MessageCitationRow[]): Promise<void>;
  listMessageCitations(messageId: string): Promise<MessageCitationRow[]>;
  getTenantChatCitations(tenantId: string): Promise<TenantChatCitationsRow | null>;
  upsertTenantChatCitations(row: TenantChatCitationsRow): Promise<void>;
  listTenantChatCitations(): Promise<TenantChatCitationsRow[]>;
  // m139 — regenerate with version history: append-only variant store + active-content mirror + config.
  insertMessageVariants(rows: MessageVariantRow[]): Promise<void>;
  listMessageVariants(groupId: string): Promise<MessageVariantRow[]>;
  updateMessageContent(messageId: string, content: string, metadata: string | null): Promise<void>;
  getTenantAnswerVersions(tenantId: string): Promise<TenantAnswerVersionsRow | null>;
  upsertTenantAnswerVersions(row: TenantAnswerVersionsRow): Promise<void>;
  listTenantAnswerVersions(): Promise<TenantAnswerVersionsRow[]>;
  // m140 — per-tenant accessibility defaults (streaming announcements + reduced motion).
  getTenantAccessibility(tenantId: string): Promise<TenantAccessibilityRow | null>;
  upsertTenantAccessibility(row: TenantAccessibilityRow): Promise<void>;
  listTenantAccessibility(): Promise<TenantAccessibilityRow[]>;
  // m143 — per-tenant role-access policy (member-visible optional areas).
  getTenantRoleAccess(tenantId: string): Promise<TenantRoleAccessRow | null>;
  upsertTenantRoleAccess(row: TenantRoleAccessRow): Promise<void>;
  listTenantRoleAccess(): Promise<TenantRoleAccessRow[]>;
  // m145 — per-tenant i18n policy + AI-generated locale packs.
  getTenantLocales(tenantId: string): Promise<TenantLocalesRow | null>;
  upsertTenantLocales(row: TenantLocalesRow): Promise<void>;
  listTenantLocales(): Promise<TenantLocalesRow[]>;
  getTenantUiTranslation(tenantId: string, locale: string): Promise<TenantUiTranslationRow | null>;
  listTenantUiTranslations(tenantId: string): Promise<TenantUiTranslationRow[]>;
  upsertTenantUiTranslation(row: TenantUiTranslationRow): Promise<void>;
  // m146 — suggested/starter prompts: per-tenant policy + per-user AI cache + click log.
  getTenantSuggestedPrompts(tenantId: string): Promise<TenantSuggestedPromptsRow | null>;
  upsertTenantSuggestedPrompts(row: TenantSuggestedPromptsRow): Promise<void>;
  listTenantSuggestedPrompts(): Promise<TenantSuggestedPromptsRow[]>;
  getUserPromptSuggestions(userId: string): Promise<UserPromptSuggestionsRow | null>;
  upsertUserPromptSuggestions(row: UserPromptSuggestionsRow): Promise<void>;
  insertPromptSuggestionEvent(row: PromptSuggestionEventRow): Promise<void>;
  // weaveNotes Phase 5 (m134) — background-memory extraction state.
  getNoteMemoryState(noteId: string, userId: string): Promise<NoteMemoryStateRow | null>;
  upsertNoteMemoryState(row: NoteMemoryStateRow): Promise<void>;
  listNotesNeedingMemoryExtraction(limit: number): Promise<NoteNeedingMemoryRow[]>;
  // weaveNotes Phase 4 (m133) — captured meetings (transcript + structured note). Owner-scoped.
  createNoteMeeting(row: NoteMeetingRow): Promise<void>;
  getNoteMeetingByNote(noteId: string, userId: string): Promise<NoteMeetingRow | null>;
  listUserNoteMeetings(userId: string, tenantId?: string | null): Promise<NoteMeetingRow[]>;
  replaceNoteRelations(noteId: string, rows: NoteRelationRow[]): Promise<void>;
  listNoteRelations(noteId: string): Promise<NoteRelationRow[]>;
  upsertNoteEmbedding(row: NoteEmbeddingRow): Promise<void>;
  // tenantId is null-safe (`tenant_id IS ?`): pass it (incl. null) to gate by tenant; omit (undefined) only for internal callers that have already scoped by note/user.
  getNoteEmbedding(noteId: string, tenantId?: string | null): Promise<NoteEmbeddingRow | null>;
  listUserNoteEmbeddings(userId: string, tenantId?: string | null): Promise<NoteEmbeddingRow[]>;
  // weaveNotes Phase 8 — workspace RAG (run output embeddings)
  upsertRunEmbedding(row: RunEmbeddingRow): Promise<void>;
  getRunEmbedding(runId: string, tenantId?: string | null): Promise<RunEmbeddingRow | null>;
  listUserRunEmbeddings(userId: string, tenantId?: string | null): Promise<RunEmbeddingRow[]>;
  // weaveNotes Phase 8 — per-note version history
  createNoteVersion(row: NoteVersionRow): Promise<void>;
  listNoteVersions(noteId: string): Promise<NoteVersionRow[]>;
  getNoteVersion(id: string): Promise<NoteVersionRow | null>;
  // weaveNotes Phase 8 — block comments on notes
  createNoteComment(row: NoteCommentRow): Promise<void>;
  getNoteComment(id: string): Promise<NoteCommentRow | null>;
  listNoteComments(noteId: string): Promise<NoteCommentRow[]>;
  listNoteCommentThread(threadId: string): Promise<NoteCommentRow[]>;
  updateNoteCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void>;
  softDeleteNoteComment(id: string, deletedBy: string, deletedAt: number): Promise<void>;
  setNoteThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void>;
  // weaveNotes Phase 8 — synced blocks (transclusion)
  createNoteSyncedBlock(row: NoteSyncedBlockRow): Promise<void>;
  getNoteSyncedBlock(id: string): Promise<NoteSyncedBlockRow | null>;
  listNoteSyncedBlocks(noteId: string): Promise<NoteSyncedBlockRow[]>;
  deleteNoteSyncedBlock(id: string, noteId: string): Promise<void>;
  // weaveNotes Phase 0 — capability config + activity log
  getWeaveNotesSettings(): Promise<WeaveNotesSettingsRow | null>;
  updateWeaveNotesSettings(fields: Partial<Omit<WeaveNotesSettingsRow, 'id'>>): Promise<void>;
  // weaveNotes — per-tenant routing mode for each note AI action (direct | agent | supervisor)
  resolveNoteActionMode(tenantId: string | null, actionKey: string): Promise<'direct' | 'agent' | 'supervisor'>;
  // weaveNotes — per-USER preferred language for sourced images (default 'en').
  getNoteImageLanguage(userId: string): Promise<string>;
  setNoteImageLanguage(userId: string, language: string): Promise<void>;
  listNoteActionModes(): Promise<NoteActionModeRow[]>;
  getNoteActionMode(id: string): Promise<NoteActionModeRow | null>;
  createNoteActionMode(row: { id: string; tenant_id: string; action_key: string; mode: string }): Promise<void>;
  updateNoteActionMode(id: string, fields: Partial<Pick<NoteActionModeRow, 'tenant_id' | 'action_key' | 'mode'>>): Promise<void>;
  deleteNoteActionMode(id: string): Promise<void>;
  recordNoteActivity(row: NoteActivityRow): Promise<void>;
  listNoteActivity(noteId: string, limit?: number): Promise<NoteActivityRow[]>;
  // Phase 0-B — tenant-scoped audit feed (keyset-paginated, filterable) + retention pruning.
  listTenantNoteActivity(tenantId: string | null, opts?: NoteActivityQuery): Promise<Array<NoteActivityRow & { note_title?: string | null }>>;
  pruneNoteActivity(beforeIso: string): Promise<number>;
  // Registered outbound webhook endpoints
  createWebhookEndpoint(row: { id: string; tenant_id?: string | null; user_id: string; url: string; signing_secret: string; created_at: number }): Promise<void>;
  listWebhookEndpoints(userId: string): Promise<WebhookEndpointRow[]>;
  revokeWebhookEndpoint(id: string, userId: string, revokedAt: number): Promise<number>;
  /**
   * Prune the run-event journal (Client Phase 0). Removes events for terminal
   * runs older than `olderThanHours`, and trims any run whose event count
   * exceeds `maxEventsPerRun` to its most recent `maxEventsPerRun` rows.
   * Returns the number of rows deleted. Driven by `run_stream_config`.
   */
  pruneUserRunEvents(opts: { olderThanHours: number; maxEventsPerRun: number }): Promise<number>;

  // Devices
  registerDevice(device: Pick<UserDeviceRow, 'id' | 'user_id' | 'channel' | 'token'> & {
    tenant_id?: string; label?: string;
  }): Promise<void>;
  removeDevice(userId: string, token: string): Promise<void>;
  getDeviceById(deviceId: string): Promise<UserDeviceRow | null>;
  listDevices(userId: string): Promise<UserDeviceRow[]>;

  // Notification preferences
  getNotificationPrefs(userId: string): Promise<NotificationPrefsRow | null>;
  upsertNotificationPrefs(userId: string, prefs: {
    id: string; enabled?: boolean; categories?: string[]; quiet_hours?: string | null; timezone?: string | null;
  }): Promise<void>;

  // Catalog support
  listModeLabels(surfaceId: string): Promise<ModeLabel[]>;
  listStarterPrompts(surfaceId: string): Promise<StarterPrompt[]>;

  // Catalog administration (operator CRUD; include disabled rows)
  adminListModeLabels(surfaceId?: string): Promise<ModeLabel[]>;
  getModeLabel(id: string): Promise<ModeLabel | null>;
  createModeLabel(row: Pick<ModeLabel, 'id' | 'surface_id' | 'mode_key' | 'label'> & {
    description?: string | null; icon?: string | null; is_default?: number; sort_order?: number; enabled?: number; metadata?: string | null;
  }): Promise<void>;
  updateModeLabel(id: string, patch: Partial<Pick<ModeLabel,
    'label' | 'mode_key' | 'description' | 'icon' | 'is_default' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void>;
  deleteModeLabel(id: string): Promise<void>;

  adminListStarterPrompts(surfaceId?: string): Promise<StarterPrompt[]>;
  getStarterPrompt(id: string): Promise<StarterPrompt | null>;
  createStarterPrompt(row: Pick<StarterPrompt, 'id' | 'surface_id' | 'label' | 'prompt_text'> & {
    sort_order?: number; enabled?: number; metadata?: string | null;
  }): Promise<void>;
  updateStarterPrompt(id: string, patch: Partial<Pick<StarterPrompt,
    'label' | 'prompt_text' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void>;
  deleteStarterPrompt(id: string): Promise<void>;

  // Temporal reminders — cross-chat user view (Actions tab)
  listTemporalRemindersByUserId(userId: string): Promise<TemporalReminderRow[]>;
  deleteTemporalReminderById(reminderId: string, userId: string): Promise<boolean>;
}
