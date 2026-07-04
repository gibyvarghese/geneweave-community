// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the weaveNotes capability CONFIGURATION (weaveNotes Phase 0).
 *
 * weaveNotes is configuration-as-data: how the notes AI behaves is not hard-coded, it is a
 * record in the database that an admin edits through the Builder. This module is the SHARED
 * schema for that record — the typed shape, the safe defaults, and a pure validator that
 * clamps/normalises any partial update — so the package, the app, and the admin UI all agree
 * on what a valid weaveNotes config is. (geneWeave stores it in a single-row `weavenotes_settings`
 * table and exposes it as a Builder admin resource.)
 *
 * --- For someone new to this ---
 * Think of these as the assistant's "settings dials" for notes: which theme pages open in,
 * whether the AI must ASK before changing your words, whether it keeps a little history of what
 * changed, and a spending cap so a single AI edit can't run away. Defaults are chosen to be safe
 * and calm; an admin can tune them in the Builder without touching code.
 */

export type NotesTheme = 'pro' | 'creative';

export interface WeaveNotesConfig {
  /** The theme a note opens in by default: clean "pro" or playful "creative". */
  defaultTheme: NotesTheme;
  /** Apply the "colour encodes agency" contract (AI content in mint, human ink coral, etc.). */
  agencyColorEnabled: boolean;
  /** The AI proposes changes as reviewable suggestions instead of writing silently (recommended on). */
  aiSuggestionsRequireApproval: boolean;
  /** Record a small activity log of note create/update/AI-edit events so the AI knows what changed. */
  activityTrackingEnabled: boolean;
  /** How many days of note activity to keep before pruning. */
  activityRetentionDays: number;
  /** Cap the tokens a single AI note edit may spend (cost guard). */
  maxAiTokensPerEdit: number;
  /** Cap how many AI note actions ONE person may run per minute (abuse + runaway-cost guard).
   *  Applies across every /ai/* note endpoint; over the limit returns HTTP 429 + Retry-After. */
  aiRatePerMinPerUser: number;
  /** Route sensitive notes to a local model (provider-ollama/llamacpp) instead of a cloud one. */
  localModelForSensitive: boolean;
  /** Show live collaborator cursors (coloured carets + names) while co-editing (Phase 3). */
  liveCursorsEnabled: boolean;
  /** Show the AI as a live participant ("weaveIntel AI") while it edits a note (Phase 3). */
  aiPresenceEnabled: boolean;
  /** Phase 4: let the AI create node/edge diagrams (flow / mind-map / process / block). */
  diagramsEnabled: boolean;
  /** Phase 4: let the AI draw freehand ink (underline / arrow / sketch / organic outline). */
  inkEnabled: boolean;
  /** Phase 4: let the AI author detailed SVG illustrations (vector art — a heart, a leaf, a logo). */
  illustrationEnabled: boolean;
  /** Phase 4: let the AI GENERATE raster images via an image model (realistic pictures; costs money). */
  imageGenerationEnabled: boolean;
  /** Phase 4: the image model used when image generation is enabled. */
  imageModel: string;
  /** Phase 1 (visual correctness): CHECK an AI diagram against the request with an LLM judge and
   *  redraw if it scores too low (so a diagram actually covers what you asked for). */
  visualVerifyEnabled: boolean;
  /** Accept a diagram when its 0–1 structural score is ≥ this (lower = more lenient). */
  visualVerifyThreshold: number;
  /** How many times to redraw a too-low diagram before keeping the best attempt (gains plateau after ~2). */
  visualVerifyMaxRetries: number;
  /** Phase 1: a vision model LOOKS at a found/AI image and confirms it depicts the subject before inserting. */
  imageVerifyEnabled: boolean;
  /** Accept an image when the vision check's 0–1 confidence is ≥ this (and it is good quality + safe). */
  imageVerifyMinConfidence: number;
  /** Phase 2: "Ask your workspace" answers with VERIFIED character-level citations (each quote is checked
   *  to exist in its source; invented ones are dropped). Off → Ask returns matching sources only. */
  citationsEnabled: boolean;
  /** Phase 2: how many sources the cited answer may draw on (token budget). */
  citationMaxSources: number;
  /** Phase 2: expand a search query (rephrasings + a hypothetical answer / HyDE) so workspace search
   *  finds more relevant notes/chats. Costs one extra small model call + a few embeddings per search. */
  queryExpansionEnabled: boolean;
  /** Phase 2: how many alternative phrasings to generate when query expansion is on (2–4). */
  queryExpansionVariants: number;
  /** Phase 5: let the AI turn a note into flashcards + schedule reviews (SM-2 spaced repetition). */
  flashcardsEnabled: boolean;
  /** Phase 5: cap how many NEW cards a study session introduces per day (active-recall pacing). */
  dailyNewCardLimit: number;
  /** Phase 2: schedule reviews with FSRS (the accurate memory-model scheduler) instead of classic SM-2. */
  fsrsEnabled: boolean;
  /** Phase 2: the recall probability FSRS aims for at review time (0.70–0.97; higher = more reviews). */
  fsrsTargetRetention: number;
  /** Phase 2: the AI can translate a note into another language (saved as a new note). */
  translateEnabled: boolean;
  /** Phase 2: allow database AUTO-FILL to consult the WEB for a value (governance gate; off → only the
   *  row's own + related-row data is used). */
  dbAutofillWebSearch: boolean;
  /** Phase 2: scrub personal data (emails, phones, card/SSN-like numbers) OUT of the outbound web-search
   *  query during auto-fill, so a row's PII never leaves to the search engine. */
  dbAutofillRedactPii: boolean;
  /** Phase 2: embed licence + provenance "Content Credentials" with every AI/web image (where it came
   *  from, or the AI generator + prompt) — embedded in SVG bytes, stored with raster assets. */
  imageProvenanceEnabled: boolean;
  /** Phase 3: allow users to set up SCHEDULED workspace agents (recurring AI note tasks). */
  scheduledAgentsEnabled: boolean;
  /** Phase 3: hard upper bound on a scheduled agent run's token budget (anti-runaway, platform cap). */
  scheduledAgentMaxTokenBudget: number;
  /** Phase 3: how many scheduled agents a single user may define. */
  scheduledAgentMaxPerUser: number;
  /** Phase 3: expose the note vault over MCP so external agents (Claude/ChatGPT) can search/read it. */
  mcpNotesEnabled: boolean;
  /** Phase 3: allow MCP clients to WRITE (create/append) notes; off → the MCP server is read-only. */
  mcpNotesAllowWrites: boolean;
  /** Phase 3: proactively suggest links as you write — turn unlinked mentions + related notes into one-click `[[links]]`. */
  proactiveLinkingEnabled: boolean;
  /** Phase 3: fold spelling variants of an entity ("OpenAI"/"OpenAI, Inc.") into one canonical graph node (disambiguation). */
  entityResolutionEnabled: boolean;
  /** Phase 3: how many notes to embed in one model call during a workspace re-index (batched; anti-N+1). */
  embeddingBatchSize: number;
  /** Phase 4: record a meeting/voice memo → transcribe → structured note with transcript-anchored citations. */
  voiceCaptureEnabled: boolean;
  /** Phase 4: keep the raw audio after transcribing (default OFF — the transcript is stored, audio is discarded). */
  storeAudio: boolean;
  /** Phase 4: force a transcription language (ISO code), or '' to auto-detect. */
  transcriptionLanguage: string;
  /** Phase 4: the speech-to-text model (e.g. 'whisper-1'). */
  transcriptionModel: string;
  /** Phase 4: hard cap on a single recording's length, in seconds (anti-abuse / cost). */
  maxRecordingSeconds: number;
  /** Phase 5: build a "second brain" — a background job distils durable memories from notes over time. */
  backgroundMemoryEnabled: boolean;
  /** Phase 5: only remember memories at/above this importance (0–1); lower = remember more. */
  memoryImportanceThreshold: number;
  /** Phase 5: max durable memories to keep from a single note. */
  memoryMaxPerNote: number;
  /** Phase 5: how many memories to surface on a proactive recall. */
  memoryRecallCount: number;
  /** Phase 5: recency half-life (days) for temporal recall — older memories fade unless re-seen. */
  memoryDecayHalfLifeDays: number;
  /** Phase 7: let the mobile app work OFFLINE — edit notes with no signal and sync when back online. */
  mobileOfflineEnabled: boolean;
  /** Phase 7: let people DRAW freehand ink on a phone/tablet (synced to the web note untouched). */
  mobileInkEnabled: boolean;
  /** Phase 7: cap how many notes the mobile app keeps cached on-device for offline use. */
  mobileOfflineNoteLimit: number;
  /** Phase 8: let the DESKTOP app work offline — cache notes locally + open to the last note. */
  desktopOfflineEnabled: boolean;
  /** Phase 8: let the global QUICK-CAPTURE hotkey jot a note from anywhere on the desktop. */
  quickCaptureEnabled: boolean;
  /** Phase 8: how many notes the desktop app caches locally for offline use. */
  desktopOfflineNoteLimit: number;
  /** Phase 10: let people EXPORT/download a note (Markdown / HTML / Word / lossless JSON). */
  exportEnabled: boolean;
  /** Phase 10: which export formats are offered (subset of markdown/html/word/json). */
  allowedExportFormats: string[];
  /** Let the AI SOURCE a real, free-to-use image from the web (Openverse/Wikimedia/…) when asked
   *  for a picture — instead of synthesising one. On by default: the default provider needs no key. */
  imageSearchEnabled: boolean;
  /** Which free-image provider to search first: openverse | wikimedia | unsplash | pexels | pixabay. */
  imageSearchProvider: string;
  /** Which licences count as "free to use" (canonical ids: cc0/pdm/by/by-sa/unsplash/pexels/pixabay).
   *  Non-commercial (nc) / no-derivatives (nd) are excluded by default. */
  imageSearchAllowedLicenses: string[];
  /** Show the attribution + licence caption under sourced images (required for CC-BY/BY-SA). */
  imageSearchRequireAttribution: boolean;
  /** The note AI tools the editor agent is allowed to use (subset of the catalog). */
  enabledAiTools: string[];
}

/** The full set of note AI tools weaveNotes ships (the editor agent's toolbelt). */
export const WEAVENOTES_AI_TOOLS = [
  'create_note', 'note_edit', 'find_related_notes', 'workspace_search',
  'capture_web_page', 'autofill_database', 'read_note_activity',
  // Phase 2 — the AI selection card's colour tools.
  'apply_highlight', 'apply_text_color', 'colorize_semantic',
  // Phase 4 — the AI creative tools (ink + diagrams + illustrations + images).
  'create_diagram', 'draw_ink', 'recolor_ink',
  'create_illustration', 'generate_image', 'create_visual',
  // Source a real, free-to-use image from the web (with attribution).
  'find_image',
  // Phase 5 — AI study: turn a note into flashcards.
  'make_flashcards',
  // Phase 8 — desktop: the AI can see what you have recently worked on.
  'recent_notes',
  // Phase 10 — export: the AI can export/download a note in a chosen format.
  'export_note',
  // Phase 2 — translate a note into another language (saved as a new note).
  'translate_note',
  // Phase 3 — set up / run a scheduled workspace agent (recurring AI note task).
  'manage_scheduled_agent',
] as const;

export const DEFAULT_WEAVENOTES_CONFIG: WeaveNotesConfig = {
  defaultTheme: 'pro',
  agencyColorEnabled: true,
  aiSuggestionsRequireApproval: true,
  activityTrackingEnabled: true,
  activityRetentionDays: 90,
  maxAiTokensPerEdit: 4000,
  aiRatePerMinPerUser: 30, // generous for a human; stops a script/runaway agent from hammering AI endpoints
  localModelForSensitive: false,
  liveCursorsEnabled: true,
  aiPresenceEnabled: true,
  diagramsEnabled: true,
  inkEnabled: true,
  illustrationEnabled: true,
  imageGenerationEnabled: false, // off by default: raster image generation costs money + needs an image model
  imageModel: 'gpt-image-1',
  visualVerifyEnabled: true,
  visualVerifyThreshold: 0.7,
  visualVerifyMaxRetries: 2,
  imageVerifyEnabled: true,
  imageVerifyMinConfidence: 0.7,
  citationsEnabled: true,
  citationMaxSources: 6,
  queryExpansionEnabled: true,
  queryExpansionVariants: 3,
  flashcardsEnabled: true,
  dailyNewCardLimit: 20,
  fsrsEnabled: true,
  fsrsTargetRetention: 0.9,
  translateEnabled: true,
  dbAutofillWebSearch: true,
  dbAutofillRedactPii: true,
  imageProvenanceEnabled: true,
  scheduledAgentsEnabled: true,
  scheduledAgentMaxTokenBudget: 20000,
  scheduledAgentMaxPerUser: 10,
  mcpNotesEnabled: true,
  mcpNotesAllowWrites: true,
  proactiveLinkingEnabled: true,
  entityResolutionEnabled: true,
  embeddingBatchSize: 16,
  voiceCaptureEnabled: true,
  storeAudio: false,
  transcriptionLanguage: '',
  transcriptionModel: 'whisper-1',
  maxRecordingSeconds: 3600,
  backgroundMemoryEnabled: true,
  memoryImportanceThreshold: 0.3,
  memoryMaxPerNote: 8,
  memoryRecallCount: 5,
  memoryDecayHalfLifeDays: 30,
  mobileOfflineEnabled: true,
  mobileInkEnabled: true,
  mobileOfflineNoteLimit: 200,
  desktopOfflineEnabled: true,
  quickCaptureEnabled: true,
  desktopOfflineNoteLimit: 500,
  exportEnabled: true,
  allowedExportFormats: ['markdown', 'html', 'word', 'json'],
  imageSearchEnabled: true, // on by default: the default provider (Openverse) needs no API key
  imageSearchProvider: 'openverse',
  imageSearchAllowedLicenses: ['cc0', 'pdm', 'by', 'by-sa', 'unsplash', 'pexels', 'pixabay'],
  imageSearchRequireAttribution: true,
  enabledAiTools: [...WEAVENOTES_AI_TOOLS],
};

const TOOL_SET = new Set<string>(WEAVENOTES_AI_TOOLS);
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function asBool(v: unknown, fallback: boolean): boolean {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return fallback;
}

/**
 * Validate + normalise a (possibly partial, possibly hostile) config update against the
 * defaults. Always returns a COMPLETE, safe config (clamped numbers, known theme, known tools)
 * plus a list of human-readable warnings for anything that was corrected — so an admin save can
 * never persist an out-of-range or unknown value, and the UI can show what it fixed.
 */
export function validateWeaveNotesConfig(
  partial: Partial<Record<keyof WeaveNotesConfig, unknown>> | null | undefined,
  base: WeaveNotesConfig = DEFAULT_WEAVENOTES_CONFIG,
): { config: WeaveNotesConfig; warnings: string[] } {
  const p = partial ?? {};
  const warnings: string[] = [];

  const theme: NotesTheme = p.defaultTheme === 'creative' || p.defaultTheme === 'pro' ? p.defaultTheme : base.defaultTheme;
  if (p.defaultTheme !== undefined && theme !== p.defaultTheme) warnings.push(`Unknown theme "${String(p.defaultTheme)}" — kept "${theme}".`);

  const retention = clampInt(p.activityRetentionDays ?? base.activityRetentionDays, 1, 3650, base.activityRetentionDays);
  if (p.activityRetentionDays !== undefined && retention !== Math.trunc(Number(p.activityRetentionDays))) warnings.push(`Activity retention clamped to ${retention} days (1–3650).`);

  const maxTokens = clampInt(p.maxAiTokensPerEdit ?? base.maxAiTokensPerEdit, 256, 200_000, base.maxAiTokensPerEdit);
  if (p.maxAiTokensPerEdit !== undefined && maxTokens !== Math.trunc(Number(p.maxAiTokensPerEdit))) warnings.push(`Max AI tokens per edit clamped to ${maxTokens} (256–200000).`);

  const aiRate = clampInt(p.aiRatePerMinPerUser ?? base.aiRatePerMinPerUser, 1, 100_000, base.aiRatePerMinPerUser);
  if (p.aiRatePerMinPerUser !== undefined && aiRate !== Math.trunc(Number(p.aiRatePerMinPerUser))) warnings.push(`AI rate clamped to ${aiRate} actions/min per user (1–100000).`);

  const clamp01 = (v: unknown, fallback: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback; };
  const verifyThreshold = clamp01(p.visualVerifyThreshold ?? base.visualVerifyThreshold, base.visualVerifyThreshold);
  if (p.visualVerifyThreshold !== undefined && verifyThreshold !== Number(p.visualVerifyThreshold)) warnings.push(`Diagram verify threshold clamped to ${verifyThreshold} (0–1).`);
  const imageMinConf = clamp01(p.imageVerifyMinConfidence ?? base.imageVerifyMinConfidence, base.imageVerifyMinConfidence);
  if (p.imageVerifyMinConfidence !== undefined && imageMinConf !== Number(p.imageVerifyMinConfidence)) warnings.push(`Image verify confidence clamped to ${imageMinConf} (0–1).`);
  const verifyRetries = clampInt(p.visualVerifyMaxRetries ?? base.visualVerifyMaxRetries, 0, 5, base.visualVerifyMaxRetries);
  if (p.visualVerifyMaxRetries !== undefined && verifyRetries !== Math.trunc(Number(p.visualVerifyMaxRetries))) warnings.push(`Diagram verify retries clamped to ${verifyRetries} (0–5).`);
  const citeMax = clampInt(p.citationMaxSources ?? base.citationMaxSources, 1, 12, base.citationMaxSources);
  if (p.citationMaxSources !== undefined && citeMax !== Math.trunc(Number(p.citationMaxSources))) warnings.push(`Citation max sources clamped to ${citeMax} (1–12).`);
  const qeVariants = clampInt(p.queryExpansionVariants ?? base.queryExpansionVariants, 2, 4, base.queryExpansionVariants);
  if (p.queryExpansionVariants !== undefined && qeVariants !== Math.trunc(Number(p.queryExpansionVariants))) warnings.push(`Query expansion variants clamped to ${qeVariants} (2–4).`);
  const targetRet = clamp01(p.fsrsTargetRetention ?? base.fsrsTargetRetention, base.fsrsTargetRetention);
  const targetRetClamped = Math.max(0.7, Math.min(0.97, targetRet)); // FSRS sensible range (Anki's bounds)
  if (p.fsrsTargetRetention !== undefined && targetRetClamped !== Number(p.fsrsTargetRetention)) warnings.push(`FSRS target retention clamped to ${targetRetClamped} (0.70–0.97).`);

  let tools = base.enabledAiTools;
  if (p.enabledAiTools !== undefined) {
    const arr = Array.isArray(p.enabledAiTools) ? p.enabledAiTools.map(String) : [];
    const valid = [...new Set(arr.filter((t) => TOOL_SET.has(t)))];
    const dropped = arr.filter((t) => !TOOL_SET.has(t));
    if (dropped.length) warnings.push(`Ignored unknown tools: ${[...new Set(dropped)].join(', ')}.`);
    tools = valid;
  }

  // Phase 10: the export-format allow-list (subset of the four known formats; defaults if none valid).
  const KNOWN_FORMATS = new Set(['markdown', 'html', 'word', 'json']);
  let formats = base.allowedExportFormats;
  if (p.allowedExportFormats !== undefined) {
    const arr = Array.isArray(p.allowedExportFormats) ? p.allowedExportFormats.map(String) : [];
    const valid = [...new Set(arr.filter((f) => KNOWN_FORMATS.has(f)))];
    const dropped = arr.filter((f) => !KNOWN_FORMATS.has(f));
    if (dropped.length) warnings.push(`Ignored unknown export formats: ${[...new Set(dropped)].join(', ')}.`);
    formats = valid.length ? valid : base.allowedExportFormats;
  }

  // Free-image search: provider (one of the known five) + the "free to use" licence allow-list.
  const KNOWN_PROVIDERS = new Set(['openverse', 'wikimedia', 'unsplash', 'pexels', 'pixabay']);
  const provider = typeof p.imageSearchProvider === 'string' && KNOWN_PROVIDERS.has(p.imageSearchProvider) ? p.imageSearchProvider : base.imageSearchProvider;
  if (p.imageSearchProvider !== undefined && !KNOWN_PROVIDERS.has(String(p.imageSearchProvider))) warnings.push(`Unknown image provider "${p.imageSearchProvider}" — kept ${provider}.`);
  const KNOWN_LICENSES = new Set(['cc0', 'pdm', 'by', 'by-sa', 'by-nc', 'by-nd', 'by-nc-sa', 'by-nc-nd', 'unsplash', 'pexels', 'pixabay']);
  let licenses = base.imageSearchAllowedLicenses;
  if (p.imageSearchAllowedLicenses !== undefined) {
    const arr = Array.isArray(p.imageSearchAllowedLicenses) ? p.imageSearchAllowedLicenses.map(String) : [];
    const valid = [...new Set(arr.filter((l) => KNOWN_LICENSES.has(l)))];
    const dropped = arr.filter((l) => !KNOWN_LICENSES.has(l));
    if (dropped.length) warnings.push(`Ignored unknown licences: ${[...new Set(dropped)].join(', ')}.`);
    licenses = valid.length ? valid : base.imageSearchAllowedLicenses;
  }

  return {
    config: {
      defaultTheme: theme,
      agencyColorEnabled: asBool(p.agencyColorEnabled ?? base.agencyColorEnabled, base.agencyColorEnabled),
      aiSuggestionsRequireApproval: asBool(p.aiSuggestionsRequireApproval ?? base.aiSuggestionsRequireApproval, base.aiSuggestionsRequireApproval),
      activityTrackingEnabled: asBool(p.activityTrackingEnabled ?? base.activityTrackingEnabled, base.activityTrackingEnabled),
      activityRetentionDays: retention,
      maxAiTokensPerEdit: maxTokens,
      aiRatePerMinPerUser: aiRate,
      localModelForSensitive: asBool(p.localModelForSensitive ?? base.localModelForSensitive, base.localModelForSensitive),
      liveCursorsEnabled: asBool(p.liveCursorsEnabled ?? base.liveCursorsEnabled, base.liveCursorsEnabled),
      aiPresenceEnabled: asBool(p.aiPresenceEnabled ?? base.aiPresenceEnabled, base.aiPresenceEnabled),
      diagramsEnabled: asBool(p.diagramsEnabled ?? base.diagramsEnabled, base.diagramsEnabled),
      inkEnabled: asBool(p.inkEnabled ?? base.inkEnabled, base.inkEnabled),
      illustrationEnabled: asBool(p.illustrationEnabled ?? base.illustrationEnabled, base.illustrationEnabled),
      imageGenerationEnabled: asBool(p.imageGenerationEnabled ?? base.imageGenerationEnabled, base.imageGenerationEnabled),
      imageModel: typeof p.imageModel === 'string' && p.imageModel.trim() ? p.imageModel.trim().slice(0, 64) : base.imageModel,
      visualVerifyEnabled: asBool(p.visualVerifyEnabled ?? base.visualVerifyEnabled, base.visualVerifyEnabled),
      visualVerifyThreshold: verifyThreshold,
      visualVerifyMaxRetries: verifyRetries,
      imageVerifyEnabled: asBool(p.imageVerifyEnabled ?? base.imageVerifyEnabled, base.imageVerifyEnabled),
      imageVerifyMinConfidence: imageMinConf,
      citationsEnabled: asBool(p.citationsEnabled ?? base.citationsEnabled, base.citationsEnabled),
      citationMaxSources: citeMax,
      queryExpansionEnabled: asBool(p.queryExpansionEnabled ?? base.queryExpansionEnabled, base.queryExpansionEnabled),
      queryExpansionVariants: qeVariants,
      fsrsEnabled: asBool(p.fsrsEnabled ?? base.fsrsEnabled, base.fsrsEnabled),
      fsrsTargetRetention: targetRetClamped,
      translateEnabled: asBool(p.translateEnabled ?? base.translateEnabled, base.translateEnabled),
      dbAutofillWebSearch: asBool(p.dbAutofillWebSearch ?? base.dbAutofillWebSearch, base.dbAutofillWebSearch),
      dbAutofillRedactPii: asBool(p.dbAutofillRedactPii ?? base.dbAutofillRedactPii, base.dbAutofillRedactPii),
      imageProvenanceEnabled: asBool(p.imageProvenanceEnabled ?? base.imageProvenanceEnabled, base.imageProvenanceEnabled),
      scheduledAgentsEnabled: asBool(p.scheduledAgentsEnabled ?? base.scheduledAgentsEnabled, base.scheduledAgentsEnabled),
      scheduledAgentMaxTokenBudget: clampInt(p.scheduledAgentMaxTokenBudget ?? base.scheduledAgentMaxTokenBudget, 500, 500_000, base.scheduledAgentMaxTokenBudget),
      scheduledAgentMaxPerUser: clampInt(p.scheduledAgentMaxPerUser ?? base.scheduledAgentMaxPerUser, 0, 100, base.scheduledAgentMaxPerUser),
      mcpNotesEnabled: asBool(p.mcpNotesEnabled ?? base.mcpNotesEnabled, base.mcpNotesEnabled),
      mcpNotesAllowWrites: asBool(p.mcpNotesAllowWrites ?? base.mcpNotesAllowWrites, base.mcpNotesAllowWrites),
      proactiveLinkingEnabled: asBool(p.proactiveLinkingEnabled ?? base.proactiveLinkingEnabled, base.proactiveLinkingEnabled),
      entityResolutionEnabled: asBool(p.entityResolutionEnabled ?? base.entityResolutionEnabled, base.entityResolutionEnabled),
      embeddingBatchSize: clampInt(p.embeddingBatchSize ?? base.embeddingBatchSize, 1, 64, base.embeddingBatchSize),
      voiceCaptureEnabled: asBool(p.voiceCaptureEnabled ?? base.voiceCaptureEnabled, base.voiceCaptureEnabled),
      storeAudio: asBool(p.storeAudio ?? base.storeAudio, base.storeAudio),
      transcriptionLanguage: typeof p.transcriptionLanguage === 'string' ? p.transcriptionLanguage.trim().slice(0, 8) : base.transcriptionLanguage,
      transcriptionModel: typeof p.transcriptionModel === 'string' && p.transcriptionModel.trim() ? p.transcriptionModel.trim().slice(0, 64) : base.transcriptionModel,
      maxRecordingSeconds: clampInt(p.maxRecordingSeconds ?? base.maxRecordingSeconds, 30, 21600, base.maxRecordingSeconds),
      backgroundMemoryEnabled: asBool(p.backgroundMemoryEnabled ?? base.backgroundMemoryEnabled, base.backgroundMemoryEnabled),
      memoryImportanceThreshold: (() => { const v = Number(p.memoryImportanceThreshold ?? base.memoryImportanceThreshold); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : base.memoryImportanceThreshold; })(),
      memoryMaxPerNote: clampInt(p.memoryMaxPerNote ?? base.memoryMaxPerNote, 1, 30, base.memoryMaxPerNote),
      memoryRecallCount: clampInt(p.memoryRecallCount ?? base.memoryRecallCount, 1, 20, base.memoryRecallCount),
      memoryDecayHalfLifeDays: clampInt(p.memoryDecayHalfLifeDays ?? base.memoryDecayHalfLifeDays, 1, 3650, base.memoryDecayHalfLifeDays),
      flashcardsEnabled: asBool(p.flashcardsEnabled ?? base.flashcardsEnabled, base.flashcardsEnabled),
      dailyNewCardLimit: clampInt(p.dailyNewCardLimit ?? base.dailyNewCardLimit, 1, 1000, base.dailyNewCardLimit),
      mobileOfflineEnabled: asBool(p.mobileOfflineEnabled ?? base.mobileOfflineEnabled, base.mobileOfflineEnabled),
      mobileInkEnabled: asBool(p.mobileInkEnabled ?? base.mobileInkEnabled, base.mobileInkEnabled),
      mobileOfflineNoteLimit: clampInt(p.mobileOfflineNoteLimit ?? base.mobileOfflineNoteLimit, 10, 5000, base.mobileOfflineNoteLimit),
      desktopOfflineEnabled: asBool(p.desktopOfflineEnabled ?? base.desktopOfflineEnabled, base.desktopOfflineEnabled),
      quickCaptureEnabled: asBool(p.quickCaptureEnabled ?? base.quickCaptureEnabled, base.quickCaptureEnabled),
      desktopOfflineNoteLimit: clampInt(p.desktopOfflineNoteLimit ?? base.desktopOfflineNoteLimit, 10, 10000, base.desktopOfflineNoteLimit),
      exportEnabled: asBool(p.exportEnabled ?? base.exportEnabled, base.exportEnabled),
      allowedExportFormats: formats,
      imageSearchEnabled: asBool(p.imageSearchEnabled ?? base.imageSearchEnabled, base.imageSearchEnabled),
      imageSearchProvider: provider,
      imageSearchAllowedLicenses: licenses,
      imageSearchRequireAttribution: asBool(p.imageSearchRequireAttribution ?? base.imageSearchRequireAttribution, base.imageSearchRequireAttribution),
      enabledAiTools: tools,
    },
    warnings,
  };
}
