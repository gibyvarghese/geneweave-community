// SPDX-License-Identifier: MIT
/**
 * geneWeave weaveNotes SETTINGS + ACTIVITY service (weaveNotes Phase 0).
 *
 * Two foundation jobs, both database-backed:
 *   1. Read/update the single global weaveNotes capability config (the `weavenotes_settings`
 *      row), going through the shared `validateWeaveNotesConfig` so a value can never be saved
 *      out of range or with an unknown tool. The Builder edits this row.
 *   2. Record + read the per-note ACTIVITY log so the AI can be given an understanding of what
 *      changed before it acts ("created", "updated", "ai_edit" …). Recording is gated on the
 *      config's `activityTrackingEnabled` flag and is best-effort (never blocks a save).
 *
 * Reuses the pure config schema from `@weaveintel/notes`; everything is owner-scoped.
 */
import { validateWeaveNotesConfig, DEFAULT_WEAVENOTES_CONFIG, type WeaveNotesConfig } from './notes/notes-config.js';
import { newUUIDv7 } from '@weaveintel/core';
import { resolveNoteAccess } from './note-coedit-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { WeaveNotesSettingsRow } from './db-types/adapter-me.js';

type SettingsDb = DatabaseAdapter;

/** Parse a JSON-array column, returning [] for anything malformed (validator re-applies defaults). */
function safeJsonArray(raw: string): string[] {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function rowToConfig(row: WeaveNotesSettingsRow | null): WeaveNotesConfig {
  if (!row) return DEFAULT_WEAVENOTES_CONFIG;
  let tools: unknown = DEFAULT_WEAVENOTES_CONFIG.enabledAiTools;
  try { tools = JSON.parse(row.enabled_ai_tools); } catch { /* default */ }
  return validateWeaveNotesConfig({
    defaultTheme: row.default_theme,
    agencyColorEnabled: row.agency_color_enabled !== 0,
    aiSuggestionsRequireApproval: row.ai_suggestions_require_approval !== 0,
    activityTrackingEnabled: row.activity_tracking_enabled !== 0,
    activityRetentionDays: row.activity_retention_days,
    maxAiTokensPerEdit: row.max_ai_tokens_per_edit,
    ...(typeof row.ai_rate_per_min_per_user === 'number' ? { aiRatePerMinPerUser: row.ai_rate_per_min_per_user } : {}),
    localModelForSensitive: row.local_model_for_sensitive !== 0,
    liveCursorsEnabled: row.live_cursors_enabled !== 0,   // undefined (pre-m107) → enabled
    aiPresenceEnabled: row.ai_presence_enabled !== 0,
    diagramsEnabled: row.diagrams_enabled !== 0,          // undefined (pre-m109) → enabled
    inkEnabled: row.ink_enabled !== 0,
    illustrationEnabled: row.illustration_enabled !== 0,
    imageGenerationEnabled: row.image_generation_enabled === 1, // default OFF (undefined → off)
    ...(typeof row.image_model === 'string' && row.image_model ? { imageModel: row.image_model } : {}),
    visualVerifyEnabled: row.visual_verify_enabled !== 0, // undefined (pre-m121) → enabled
    ...(typeof row.visual_verify_threshold === 'number' ? { visualVerifyThreshold: row.visual_verify_threshold } : {}),
    ...(typeof row.visual_verify_max_retries === 'number' ? { visualVerifyMaxRetries: row.visual_verify_max_retries } : {}),
    imageVerifyEnabled: row.image_verify_enabled !== 0,
    ...(typeof row.image_verify_min_confidence === 'number' ? { imageVerifyMinConfidence: row.image_verify_min_confidence } : {}),
    citationsEnabled: row.citations_enabled !== 0, // undefined (pre-m122) → enabled
    ...(typeof row.citation_max_sources === 'number' ? { citationMaxSources: row.citation_max_sources } : {}),
    queryExpansionEnabled: row.query_expansion_enabled !== 0, // undefined (pre-m125) → on
    ...(typeof row.query_expansion_variants === 'number' ? { queryExpansionVariants: row.query_expansion_variants } : {}),
    fsrsEnabled: row.fsrs_enabled !== 0, // undefined (pre-m123) → FSRS on
    ...(typeof row.fsrs_target_retention === 'number' ? { fsrsTargetRetention: row.fsrs_target_retention } : {}),
    translateEnabled: row.translate_enabled !== 0, // undefined (pre-m124) → enabled
    dbAutofillWebSearch: row.db_autofill_web_search !== 0, // undefined (pre-m126) → on
    dbAutofillRedactPii: row.db_autofill_redact_pii !== 0,
    imageProvenanceEnabled: row.image_provenance_enabled !== 0, // undefined (pre-m128) → on
    scheduledAgentsEnabled: row.scheduled_agents_enabled !== 0, // undefined (pre-m129) → on
    ...(typeof row.scheduled_agent_max_token_budget === 'number' ? { scheduledAgentMaxTokenBudget: row.scheduled_agent_max_token_budget } : {}),
    ...(typeof row.scheduled_agent_max_per_user === 'number' ? { scheduledAgentMaxPerUser: row.scheduled_agent_max_per_user } : {}),
    mcpNotesEnabled: row.mcp_notes_enabled !== 0, // undefined (pre-m130) → on
    mcpNotesAllowWrites: row.mcp_notes_allow_writes !== 0,
    proactiveLinkingEnabled: row.proactive_linking_enabled !== 0, // undefined (pre-m131) → on
    entityResolutionEnabled: row.entity_resolution_enabled !== 0, // undefined (pre-m132) → on
    ...(typeof row.embedding_batch_size === 'number' ? { embeddingBatchSize: row.embedding_batch_size } : {}),
    voiceCaptureEnabled: row.voice_capture_enabled !== 0, // undefined (pre-m133) → on
    storeAudio: row.store_audio === 1, // default OFF (privacy)
    ...(typeof row.transcription_language === 'string' ? { transcriptionLanguage: row.transcription_language } : {}),
    ...(typeof row.transcription_model === 'string' && row.transcription_model ? { transcriptionModel: row.transcription_model } : {}),
    ...(typeof row.max_recording_seconds === 'number' ? { maxRecordingSeconds: row.max_recording_seconds } : {}),
    backgroundMemoryEnabled: row.background_memory_enabled !== 0, // undefined (pre-m134) → on
    ...(typeof row.memory_importance_threshold === 'number' ? { memoryImportanceThreshold: row.memory_importance_threshold } : {}),
    ...(typeof row.memory_max_per_note === 'number' ? { memoryMaxPerNote: row.memory_max_per_note } : {}),
    ...(typeof row.memory_recall_count === 'number' ? { memoryRecallCount: row.memory_recall_count } : {}),
    ...(typeof row.memory_decay_half_life_days === 'number' ? { memoryDecayHalfLifeDays: row.memory_decay_half_life_days } : {}),
    flashcardsEnabled: row.flashcards_enabled !== 0, // undefined (pre-m110) → enabled
    ...(typeof row.daily_new_card_limit === 'number' ? { dailyNewCardLimit: row.daily_new_card_limit } : {}),
    mobileOfflineEnabled: row.mobile_offline_enabled !== 0,  // undefined (pre-m112) → enabled
    mobileInkEnabled: row.mobile_ink_enabled !== 0,
    ...(typeof row.mobile_offline_note_limit === 'number' ? { mobileOfflineNoteLimit: row.mobile_offline_note_limit } : {}),
    desktopOfflineEnabled: row.desktop_offline_enabled !== 0,  // undefined (pre-m113) → enabled
    quickCaptureEnabled: row.quick_capture_enabled !== 0,
    ...(typeof row.desktop_offline_note_limit === 'number' ? { desktopOfflineNoteLimit: row.desktop_offline_note_limit } : {}),
    exportEnabled: row.export_enabled !== 0,  // undefined (pre-m114) → enabled
    ...(row.allowed_export_formats ? { allowedExportFormats: safeJsonArray(row.allowed_export_formats) } : {}),
    imageSearchEnabled: row.image_search_enabled !== 0,  // undefined (pre-m118) → enabled
    ...(typeof row.image_search_provider === 'string' && row.image_search_provider ? { imageSearchProvider: row.image_search_provider } : {}),
    ...(row.image_search_allowed_licenses ? { imageSearchAllowedLicenses: safeJsonArray(row.image_search_allowed_licenses) } : {}),
    imageSearchRequireAttribution: row.image_search_require_attribution !== 0,
    enabledAiTools: tools,
  }).config;
}

export interface NoteActivityView { id: string; action: string; actor: string; summary: string | null; createdAt: string }

export function createNoteSettingsService(db: SettingsDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** The current weaveNotes config (validated; falls back to defaults). */
  async function getConfig(): Promise<WeaveNotesConfig> {
    return rowToConfig(await db.getWeaveNotesSettings());
  }

  /** Validate + persist a (partial) config update. Returns the normalised config + any warnings. */
  async function updateConfig(partial: Partial<Record<keyof WeaveNotesConfig, unknown>>): Promise<{ config: WeaveNotesConfig; warnings: string[] }> {
    const base = await getConfig();
    const { config, warnings } = validateWeaveNotesConfig(partial, base);
    await db.updateWeaveNotesSettings({
      default_theme: config.defaultTheme,
      agency_color_enabled: config.agencyColorEnabled ? 1 : 0,
      ai_suggestions_require_approval: config.aiSuggestionsRequireApproval ? 1 : 0,
      activity_tracking_enabled: config.activityTrackingEnabled ? 1 : 0,
      activity_retention_days: config.activityRetentionDays,
      max_ai_tokens_per_edit: config.maxAiTokensPerEdit,
      ai_rate_per_min_per_user: config.aiRatePerMinPerUser,
      local_model_for_sensitive: config.localModelForSensitive ? 1 : 0,
      live_cursors_enabled: config.liveCursorsEnabled ? 1 : 0,
      ai_presence_enabled: config.aiPresenceEnabled ? 1 : 0,
      diagrams_enabled: config.diagramsEnabled ? 1 : 0,
      ink_enabled: config.inkEnabled ? 1 : 0,
      illustration_enabled: config.illustrationEnabled ? 1 : 0,
      image_generation_enabled: config.imageGenerationEnabled ? 1 : 0,
      image_model: config.imageModel,
      visual_verify_enabled: config.visualVerifyEnabled ? 1 : 0,
      visual_verify_threshold: config.visualVerifyThreshold,
      visual_verify_max_retries: config.visualVerifyMaxRetries,
      image_verify_enabled: config.imageVerifyEnabled ? 1 : 0,
      image_verify_min_confidence: config.imageVerifyMinConfidence,
      citations_enabled: config.citationsEnabled ? 1 : 0,
      citation_max_sources: config.citationMaxSources,
      query_expansion_enabled: config.queryExpansionEnabled ? 1 : 0,
      query_expansion_variants: config.queryExpansionVariants,
      fsrs_enabled: config.fsrsEnabled ? 1 : 0,
      fsrs_target_retention: config.fsrsTargetRetention,
      translate_enabled: config.translateEnabled ? 1 : 0,
      db_autofill_web_search: config.dbAutofillWebSearch ? 1 : 0,
      db_autofill_redact_pii: config.dbAutofillRedactPii ? 1 : 0,
      image_provenance_enabled: config.imageProvenanceEnabled ? 1 : 0,
      scheduled_agents_enabled: config.scheduledAgentsEnabled ? 1 : 0,
      scheduled_agent_max_token_budget: config.scheduledAgentMaxTokenBudget,
      scheduled_agent_max_per_user: config.scheduledAgentMaxPerUser,
      mcp_notes_enabled: config.mcpNotesEnabled ? 1 : 0,
      mcp_notes_allow_writes: config.mcpNotesAllowWrites ? 1 : 0,
      proactive_linking_enabled: config.proactiveLinkingEnabled ? 1 : 0,
      entity_resolution_enabled: config.entityResolutionEnabled ? 1 : 0,
      embedding_batch_size: config.embeddingBatchSize,
      voice_capture_enabled: config.voiceCaptureEnabled ? 1 : 0,
      store_audio: config.storeAudio ? 1 : 0,
      transcription_language: config.transcriptionLanguage,
      transcription_model: config.transcriptionModel,
      max_recording_seconds: config.maxRecordingSeconds,
      background_memory_enabled: config.backgroundMemoryEnabled ? 1 : 0,
      memory_importance_threshold: config.memoryImportanceThreshold,
      memory_max_per_note: config.memoryMaxPerNote,
      memory_recall_count: config.memoryRecallCount,
      memory_decay_half_life_days: config.memoryDecayHalfLifeDays,
      flashcards_enabled: config.flashcardsEnabled ? 1 : 0,
      daily_new_card_limit: config.dailyNewCardLimit,
      mobile_offline_enabled: config.mobileOfflineEnabled ? 1 : 0,
      mobile_ink_enabled: config.mobileInkEnabled ? 1 : 0,
      mobile_offline_note_limit: config.mobileOfflineNoteLimit,
      desktop_offline_enabled: config.desktopOfflineEnabled ? 1 : 0,
      quick_capture_enabled: config.quickCaptureEnabled ? 1 : 0,
      desktop_offline_note_limit: config.desktopOfflineNoteLimit,
      export_enabled: config.exportEnabled ? 1 : 0,
      allowed_export_formats: JSON.stringify(config.allowedExportFormats),
      image_search_enabled: config.imageSearchEnabled ? 1 : 0,
      image_search_provider: config.imageSearchProvider,
      image_search_allowed_licenses: JSON.stringify(config.imageSearchAllowedLicenses),
      image_search_require_attribution: config.imageSearchRequireAttribution ? 1 : 0,
      enabled_ai_tools: JSON.stringify(config.enabledAiTools),
    });
    return { config, warnings };
  }

  /**
   * Record a note-activity event (best-effort; skipped when activity tracking is off). `actor`
   * is 'user' or 'ai' so the AI can tell its own past edits from the human's.
   */
  async function recordActivity(input: { noteId: string; userId: string; tenantId?: string | null; action: string; actor?: 'user' | 'ai'; summary?: string; detail?: unknown }): Promise<void> {
    try {
      const cfg = await getConfig();
      if (!cfg.activityTrackingEnabled) return;
      await db.recordNoteActivity({
        id: newUUIDv7(), note_id: input.noteId, user_id: input.userId, tenant_id: input.tenantId ?? null,
        action: input.action, actor: input.actor ?? 'user',
        summary: input.summary ?? null, detail_json: input.detail != null ? JSON.stringify(input.detail) : null,
        created_at: new Date(now()).toISOString(),
      });
    } catch { /* never block the write that triggered it */ }
  }

  /** Read a note's recent activity (newest first). Owner-scoped. */
  async function readActivity(input: { noteId: string; userId: string; limit?: number }): Promise<NoteActivityView[] | null> {
    const access = await resolveNoteAccess(db, input.noteId, input.userId);
    if (!access) return null;
    return (await db.listNoteActivity(input.noteId, input.limit ?? 20)).map((r) => ({ id: r.id, action: r.action, actor: r.actor, summary: r.summary, createdAt: r.created_at }));
  }

  /** The `read_note_activity` agent-tool entry point: a compact, AI-readable change summary. */
  async function agentReadActivity(args: { userId: string; tenantId?: string | null; noteId: string; limit?: number }): Promise<{ ok: boolean; error?: string; noteId: string; events: NoteActivityView[] }> {
    const events = await readActivity({ noteId: args.noteId, userId: args.userId, ...(args.limit ? { limit: args.limit } : {}) });
    if (events === null) return { ok: false, error: 'note not found or not accessible', noteId: args.noteId, events: [] };
    return { ok: true, noteId: args.noteId, events };
  }

  return { getConfig, updateConfig, recordActivity, readActivity, agentReadActivity };
}

export type NoteSettingsService = ReturnType<typeof createNoteSettingsService>;
