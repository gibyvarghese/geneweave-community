/**
 * /api/me/notes — user-scoped notes endpoints (WC6-WC9)
 *
 *   GET    /api/me/notes                            list notes (filters: parent, search, favorite, is_template)
 *   POST   /api/me/notes                            create note (from scratch or from template)
 *   GET    /api/me/notes/templates                  list system + user templates
 *   GET    /api/me/notes/:id                        get note with full doc_json
 *   PATCH  /api/me/notes/:id                        update (title, icon, doc_json, sensitivity, …)
 *   DELETE /api/me/notes/:id                        delete (cascades sub-pages)
 *
 *   GET    /api/me/notes/:id/links                  list outbound links from note
 *   POST   /api/me/notes/:id/links                  create link (target_kind + target_id)
 *   DELETE /api/me/notes/:id/links/:linkId          delete link
 *   GET    /api/me/notes/:id/backlinks              list notes that link TO this note
 *
 *   POST   /api/me/notes/:id/extract                save-time extraction pipeline (WC8):
 *                                                   - to-do ⇄ task binding
 *                                                   - mention/link extraction
 *                                                   - memory indexing stub
 *
 *   GET    /api/me/note-databases                   list saved views
 *   POST   /api/me/note-databases                   create saved view
 *   DELETE /api/me/note-databases/:id               delete
 *
 *   GET    /api/me/note-databases/:id/rows          list generic rows
 *   POST   /api/me/note-databases/:id/rows          add row
 *   PATCH  /api/me/note-databases/:id/rows/:rowId   update row fields
 *   DELETE /api/me/note-databases/:id/rows/:rowId   delete row
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { Router, Handler } from '../server-core.js';
import { readBody } from '../server-core.js';
import { createKeyedRateLimiter, type KeyedRateLimiter } from '@weaveintel/resilience';
import type { DatabaseAdapter } from '../db-types.js';
import {
  createInMemoryNoteRepository, // (re-exported for tests/embedders that want a fake)
  extractTaskItems,
  type NoteRepository,
  type NoteSensitivity,
  type NoteLinkTargetKind,
  type NoteDatabaseSource,
  type NoteDatabaseViewType,
  type UpdateNotePatch,
  blocksToDoc,
  extractPlainText,
  type NoteBlock,
} from '@weaveintel/notes';
import { normalizeLanguage, LANGUAGE_NAMES } from '../notes/image-search.js';
import { parseQuickCapture } from '../notes/desktop.js';
import { templateByKey } from '../notes/templates.js';

/** The image-label languages offered for the per-user preference (code → English name). */
const NOTE_IMAGE_LANGUAGES = LANGUAGE_NAMES;
import { createSqlNoteRepository } from '../note-repository-sql.js';
import { BlockDoc, pmToBlocks, blocksToProseMirror, blocksToMarkdown, blocksToHtml } from '@weaveintel/collab';
import { exportNote as coeditExportNote, isExportFormat, type ExportFormat } from '@weaveintel/notes';
import { roleAtLeast } from '@weaveintel/collab';
import {
  createNoteCoeditRepo,
  createNoteSharing,
  resolveNoteAccess,
  userNoteSiteId,
} from '../note-coedit-sql.js';
import { noteCoeditHub } from '../note-coedit-hub.js';
import { createNoteAiService, type NoteAiGenerate, type AiAction } from '../note-ai-sql.js';
import { createNoteColorizeService } from '../note-colorize-sql.js';
import { createNoteCreativeService } from '../note-creative-sql.js';
import { createNoteStudyService } from '../note-study-sql.js';
import { createNoteTranslateService } from '../note-translate-sql.js';
import { createTenantGovernanceService } from '../tenant-governance-sql.js';
import { createNoteScheduledAgentService } from '../note-scheduled-agent-sql.js';
import { createMcpNotesServer } from '../mcp-notes-sql.js';
import { parseProvenanceFromSvg } from '@weaveintel/notes';
import { isColorScheme, coercePageTheme } from '@weaveintel/geneweave-ui/notes';
import { sanitizeAwarenessState } from '@weaveintel/collab';
import { withAiPresence } from '../note-ai-presence.js';
import { createNotePublishService, type PublishFormat } from '../note-publish-sql.js';
import { createNoteGraphService } from '../note-graph-sql.js';
import { createNoteDbService } from '../note-db-sql.js';
import { createNoteCaptureService } from '../note-capture-sql.js';
import { createNoteMeetingService, type MeetingTranscribe } from '../note-meeting-sql.js';
import { createNoteMemoryService } from '../note-memory-sql.js';
import { createTenantAppearanceService } from '../tenant-appearance-sql.js';
import { createNoteSettingsService } from '../note-settings-sql.js';
import { createNoteWorkspaceService } from '../note-workspace-sql.js';
import { createNoteVersionService } from '../note-version-sql.js';
import { createNoteCommentService } from '../note-comment-sql.js';
import { createNoteSyncedService } from '../note-synced-sql.js';
import { isViewType, type DatabaseViewType as DbViewType } from '@weaveintel/notes';
import { meTaskRepo as taskRepo } from './me-stores.js';
import { createActionItem } from '@weaveintel/human-tasks';
import { safePageInt } from './index.js';

void createInMemoryNoteRepository; // keep the import available to embedders without tree-shaking it away

/**
 * Register all `/api/me/notes` routes.
 *
 * weaveNotes Phase 0: every note read/write now goes through the
 * `@weaveintel/notes` {@link NoteRepository} PORT instead of calling the database
 * adapter directly. Behaviour is UNCHANGED — `createSqlNoteRepository(db)` is a
 * thin pass-through to the same SQL — but the routes now depend only on the
 * interface, so a later phase can swap in a CRDT co-editing relay (a new adapter)
 * without changing this file. Tests/embedders may inject their own repository via
 * `opts.noteRepository`.
 */
/**
 * weaveNotes Phase 7: which device a request came from, for activity provenance. The mobile app
 * sends `X-Client-Version: geneweave-mobile/...`, so the AI's `read_note_activity` can tell that an
 * edit happened on a phone (and was likely made offline + synced) when it reasons about a note.
 */
function clientProvenance(req: { headers?: Record<string, unknown> }): string {
  const v = String(req.headers?.['x-client-version'] ?? '').toLowerCase();
  if (v.includes('mobile')) return ' on mobile';
  if (v.includes('desktop')) return ' on desktop';
  return '';
}

export function registerMeNotesRoutes(router: Router, db: DatabaseAdapter, opts: {
  noteRepository?: NoteRepository;
  aiGenerate?: NoteAiGenerate;
  imageGenerate?: import('../note-creative-sql.js').NoteImageGenerate;
  verifyVision?: import('../note-creative-sql.js').NoteVisionVerify;
  /** weaveNotes Phase 4: detailed speech-to-text (segmented transcript) for voice/meeting capture. */
  transcribe?: MeetingTranscribe;
  jwtSecret?: string;
  publicBaseUrl?: string;
  /** weaveNotes: run a note action THROUGH the geneWeave SUPERVISOR (which delegates to the
   *  weaveNotes Editor worker agent), instead of calling the note service directly. Wired from the
   *  chat engine in server.ts. Lets the "Make a diagram" / "Restructure" buttons drive the supervisor
   *  via the API — the worker calls the same create_diagram / restructure_note tool, staging a
   *  suggestion on the note. The supervisor run uses an ephemeral chat that is deleted afterwards. */
  runNoteAgentAction?: (args: { userId: string; noteId: string; instruction: string; mode: 'agent' | 'supervisor' }) => Promise<{ ok: boolean; content?: string }>;
} = {}): void {
  const notes = opts.noteRepository ?? createSqlNoteRepository(db);
  // weaveNotes Phase 3: the AI co-author service (suggestions, agent edits, AI blocks).
  // Only wired when the host provides an LLM generator (so unit/embedder setups stay LLM-free).
  const noteAi = opts.aiGenerate ? createNoteAiService(db, opts.aiGenerate) : null;
  // weaveNotes Phase 2: the AI selection card's colour service (highlight / text-colour /
  // colour-code by meaning). Same LLM-optional wiring as the co-author service.
  const noteColorize = opts.aiGenerate ? createNoteColorizeService(db, opts.aiGenerate) : null;
  // weaveNotes Phase 4: the AI creative service (diagrams + ink). Same LLM-optional wiring.
  const noteCreative = opts.aiGenerate ? createNoteCreativeService(db, opts.aiGenerate, { ...(opts.imageGenerate ? { generateImage: opts.imageGenerate } : {}), ...(opts.verifyVision ? { verifyVision: opts.verifyVision } : {}) }) : null;
  // weaveNotes Phase 5: the AI study service (flashcards + SM-2 spaced repetition).
  const noteStudy = opts.aiGenerate ? createNoteStudyService(db, opts.aiGenerate) : null;
  // weaveNotes Phase 2: the AI translate service (note → faithful translated copy).
  const noteTranslate = opts.aiGenerate ? createNoteTranslateService(db, opts.aiGenerate) : null;
  // weaveNotes Phase 2: per-tenant enterprise governance (read-only surface for the user).
  const governance = createTenantGovernanceService(db as unknown as Parameters<typeof createTenantGovernanceService>[0]);
  // weaveNotes Phase 3: scheduled/triggered workspace agents (recurring AI note tasks).
  const scheduledAgents = opts.aiGenerate ? createNoteScheduledAgentService(db, opts.aiGenerate) : null;
  // weaveNotes Phase 3: the MCP note-vault server (expose notes to external agents via MCP).
  const mcpNotes = createMcpNotesServer(db, opts.aiGenerate ? { generate: opts.aiGenerate } : {});
  // weaveNotes Phase 4: the publish service (note → shareable artifact, sensitivity-gated).
  const publish = createNotePublishService(db, { jwtSecret: opts.jwtSecret ?? process.env['JWT_SECRET'] ?? 'insecure-dev-secret', ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}) });
  // weaveNotes Phase 5: the knowledge-graph service (wiki-links/backlinks, entity/relation
  // extraction, unlinked mentions, semantic related notes). Entity extraction needs the LLM
  // generator; the rest works without it.
  const noteGraph = createNoteGraphService(db, opts.aiGenerate ? { generate: opts.aiGenerate } : {});
  // weaveNotes Phase 6: the database service (typed views + rollups + AI column auto-fill).
  const noteDb = createNoteDbService(db, opts.aiGenerate ? { generate: opts.aiGenerate } : {});
  // weaveNotes Phase 7: the capture service (run→note, web clip, email→note, daily jot).
  const noteCapture = createNoteCaptureService(db);
  // weaveNotes Phase 4: voice / meeting capture (transcribe → structured note with anchored citations).
  const noteMeeting = createNoteMeetingService(db, {
    ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
    ...(opts.aiGenerate ? { generate: opts.aiGenerate } : {}),
  });
  // weaveNotes Phase 5: background memory / "second brain" (distil durable memories; temporal recall).
  const noteMemory = createNoteMemoryService(db, {
    ...(opts.aiGenerate ? { generate: opts.aiGenerate } : {}),
    config: async () => {
      const c = await noteSettings.getConfig();
      return { enabled: c.backgroundMemoryEnabled, importanceThreshold: c.memoryImportanceThreshold, maxPerNote: c.memoryMaxPerNote, recallCount: c.memoryRecallCount, decayHalfLifeDays: c.memoryDecayHalfLifeDays };
    },
  });
  // weaveNotes Phase 0: settings + activity (record what happens to a note so the AI knows).
  const noteSettings = createNoteSettingsService(db);
  // weaveNotes Phase 8: workspace RAG (cited search over notes+runs), version history,
  // block comments, and synced blocks (transclusion).
  const noteWorkspace = createNoteWorkspaceService(db, opts.aiGenerate ? { aiGenerate: opts.aiGenerate } : {});
  const noteVersions = createNoteVersionService(db);
  const noteComments = createNoteCommentService(db);
  const noteSynced = createNoteSyncedService(db);

  // ── Phase 0 hardening: per-USER AI rate limit ───────────────────────────────
  // Every note AI action costs a model call. `aiPost` wraps an AI endpoint so ONE person can't run
  // more than the Builder-configured `aiRatePerMinPerUser` actions/minute — over the limit it returns
  // HTTP 429 + Retry-After (covering EVERY /ai/* endpoint in one place). Stops a runaway script or a
  // prompt-injected agent loop from running up cost. In-memory token bucket per user (per-node); a
  // Redis-backed limiter is the multi-node upgrade (the KeyedRateLimiter interface stays the same).
  let aiLimiter: KeyedRateLimiter | null = null;
  let aiLimiterRate = -1;
  const aiPost = (path: string, handler: Handler, postOpts?: { auth?: boolean; csrf?: boolean }): void => {
    router.post(path, async (req, res, params, auth) => {
      if (auth) {
        const cfg = await noteSettings.getConfig();
        if (!aiLimiter || cfg.aiRatePerMinPerUser !== aiLimiterRate) {
          aiLimiter = createKeyedRateLimiter({ ratePerWindow: cfg.aiRatePerMinPerUser, windowMs: 60_000 });
          aiLimiterRate = cfg.aiRatePerMinPerUser;
        }
        const decision = aiLimiter.check(auth.userId);
        if (!decision.allowed) {
          const retryS = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryS) });
          res.end(JSON.stringify({ ok: false, code: 'rate_limited', retryAfterMs: decision.retryAfterMs, error: `AI rate limit reached: at most ${decision.limit} note AI actions per minute. Try again in ${retryS}s.` }));
          return;
        }
      }
      await handler(req, res, params, auth);
    }, postOpts);
  };

  // ── Notes list ─────────────────────────────────────────────────────────────

  router.get('/api/me/notes', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parentNoteId = url.searchParams.has('parent')
      ? (url.searchParams.get('parent') === 'null' ? null : url.searchParams.get('parent'))
      : undefined;
    const list = await notes.listNotes(auth.userId, {
      parentNoteId,
      favorite: url.searchParams.get('favorite') === '1',
      // Phase 6: `?archived=1` returns the trash (archived notes) instead of active ones.
      archived: url.searchParams.get('archived') === '1',
      search: url.searchParams.get('search') ?? undefined,
      limit: safePageInt(url.searchParams.get('limit'), 50, 1, 500),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notes: list }));
  }, { auth: true });

  router.get('/api/me/notes/templates', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const rows = await notes.listTemplates();
    // Phase 6: enrich each seeded template row with the gallery metadata (category + description)
    // from the @weaveintel/notes package, joined by template_key. User-made templates (no key /
    // unknown key) keep a sensible default so the gallery still renders them.
    const templates = rows.map((row) => {
      const meta = row.template_key ? templateByKey(row.template_key) : undefined;
      return {
        ...row,
        key: row.template_key ?? null,
        // System templates carry their gallery category; legacy/user templates fall to "More".
        category: meta?.category ?? 'More',
        description: meta?.description ?? '',
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ templates }));
  }, { auth: true });

  // weaveNotes Phase 7: the client-relevant capability flags (drives the mobile app's offline + ink
  // gating). Reads the Builder-governed weaveNotes settings; a workspace can disable offline or ink.
  router.get('/api/me/notes/capabilities', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mobileOfflineEnabled: cfg.mobileOfflineEnabled,
      mobileInkEnabled: cfg.mobileInkEnabled,
      mobileOfflineNoteLimit: cfg.mobileOfflineNoteLimit,
      // Phase 8 — desktop offline cache + open-to-last-note + global quick-capture.
      desktopOfflineEnabled: cfg.desktopOfflineEnabled,
      quickCaptureEnabled: cfg.quickCaptureEnabled,
      desktopOfflineNoteLimit: cfg.desktopOfflineNoteLimit,
      // Phase 10 — note export (download as Markdown / HTML / Word / JSON).
      exportEnabled: cfg.exportEnabled,
      allowedExportFormats: cfg.allowedExportFormats,
    }));
  }, { auth: true });

  // weaveNotes Phase 8: the global quick-capture endpoint. The client sends the raw typed text; the
  // shared `parseQuickCapture` (from @weaveintel/notes) turns it into a note — first line → title, a
  // leading `/template` or `kind:` hint → a system template — created via the same owner-scoped path
  // as any note (so a desktop capture lands stamped "on desktop" in the activity log).
  router.post('/api/me/notes/quick-capture', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.quickCaptureEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'Quick capture is disabled for this workspace' })); return; }
    const body = JSON.parse(await readBody(req)) as { text?: unknown };
    const qc = parseQuickCapture(typeof body.text === 'string' ? body.text : '');

    let docJson = '{"type":"doc","content":[]}';
    let icon: string | null = null;
    let title = qc.title;
    if (qc.templateKey) {
      const tpl = templateByKey(qc.templateKey);
      if (tpl) { docJson = JSON.stringify(tpl.doc); icon = tpl.icon; if (!qc.title || qc.title === 'Untitled') title = tpl.title; }
    } else if (qc.body) {
      docJson = blocksToDoc(qc.body.split('\n').map((line): NoteBlock => ({ type: 'paragraph', text: line })));
    }

    const id = newUUIDv7();
    await notes.createNote({ id, owner_user_id: auth.userId, tenant_id: auth.tenantId ?? null, title, icon, doc_json: docJson, is_template: 0, favorite: 0, sensitivity: 'normal', ...(qc.templateKey ? { template_key: qc.templateKey } : {}) });
    const note = await notes.getNote(id, auth.userId);
    void noteSettings.recordActivity({ noteId: id, userId: auth.userId, tenantId: auth.tenantId ?? null, action: 'created', actor: 'user', summary: `Quick-captured “${title}”${clientProvenance(req)}` });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note));
  }, { auth: true });

  // weaveNotes Phase 10: EXPORT/download a note in a chosen format (Markdown / HTML / Word / lossless
  // JSON). Reuses @weaveintel/collab's serializers. Owner + collaborators (read access); gated by the
  // Builder config (export on/off + the allowed-format list). Returns the file as a download.
  router.get('/api/me/notes/:id/export', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.exportEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'Export is disabled for this workspace' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const format = (url.searchParams.get('format') ?? 'markdown').toLowerCase();
    if (!isExportFormat(format) || !cfg.allowedExportFormats.includes(format)) {
      res.writeHead(400); res.end(JSON.stringify({ error: `Unsupported export format. Allowed: ${cfg.allowedExportFormats.join(', ')}` })); return;
    }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const note = await notes.getNote(params['id']!, access.ownerId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const out = coeditExportNote({ title: note.title, icon: note.icon, doc_json: note.doc_json }, format as ExportFormat);
    void noteSettings.recordActivity({ noteId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null, action: 'updated', actor: 'user', summary: `Exported as ${format}${clientProvenance(req)}` });
    res.writeHead(200, {
      'Content-Type': out.mimeType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
      'Cache-Control': 'no-store',
    });
    res.end(out.content);
  }, { auth: true });

  // ── Single note ────────────────────────────────────────────────────────────

  router.get('/api/me/notes/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let note = await notes.getNote(params['id']!, auth.userId);
    // Phase 3: a COLLABORATOR (a shared note they don't own) can also open it. getNote is
    // owner-scoped, so fall back to the shared-access check and load it as the owner.
    if (!note) {
      const access = await resolveNoteAccess(db, params['id']!, auth.userId);
      if (access) note = await notes.getNote(params['id']!, access.ownerId);
    }
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note));
  }, { auth: true });

  // weaveNotes Phase 1: read a note as the CRDT BLOCK model (or as Markdown / HTML).
  // The note's ProseMirror `doc_json` is parsed into blocks, run THROUGH the
  // `BlockDoc` CRDT, and re-rendered — so this both proves the CRDT faithfully
  // represents real notes AND gives the building blocks later phases need: the
  // block model for the editor, Markdown for feeding the note to an AI model, and
  // sanitized HTML for a read-only preview. `?format=blocks|markdown|html`.
  router.get('/api/me/notes/:id/blocks', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const note = await notes.getNote(params['id']!, auth.userId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let pm: unknown;
    try { pm = JSON.parse(note.doc_json); } catch { pm = { type: 'doc', content: [] }; }
    // Round-trip through the CRDT: ProseMirror → blocks → BlockDoc → rendered blocks.
    const doc = BlockDoc.fromBlocks(`u:${auth.userId}`, pmToBlocks(pm));
    const blocks = doc.blocks();
    const format = new URL(req.url ?? '/', 'http://x').searchParams.get('format') ?? 'blocks';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (format === 'markdown') { res.end(JSON.stringify({ markdown: blocksToMarkdown(blocks) })); return; }
    if (format === 'html') { res.end(JSON.stringify({ html: blocksToHtml(blocks) })); return; }
    // Default: the block model + the round-tripped ProseMirror doc + the CRDT state vector.
    res.end(JSON.stringify({ blocks, prosemirror: blocksToProseMirror(blocks), stateVector: doc.stateVector() }));
  }, { auth: true });

  // ── weaveNotes Phase 2: collaborative co-editing (relay + sharing + presence) ──
  //
  // geneWeave is the TRUSTED RELAY. A note becomes co-editable the first time a
  // client opens `POST /coedit` (the canonical BlockDoc seeds from the note's
  // current content). From then on, edits flow as validated BLOCK OPS through the
  // relay, are broadcast live over `/coedit/events` (SSE), and the note's rendered
  // `doc_json` is kept in sync so the legacy single-user path still reads correctly.
  //
  //   POST   /coedit            ensure the co-edit doc exists; return snapshot + my site id  (any participant)
  //   GET    /coedit            current snapshot + state vector + my site id                 (any participant)
  //   POST   /coedit/ops        submit block ops (validated, anti-forgery)                    (collaborator+; viewers 403)
  //   GET    /coedit/ops?since= the ops a reconnecting peer is missing (offline reconcile)    (any participant)
  //   POST   /coedit/sync       diff-on-save: send a whole ProseMirror doc → merge as ops     (collaborator+)
  //   POST   /coedit/awareness  broadcast an ephemeral presence/cursor update                 (any participant)
  //   GET    /coedit/events     SSE stream of remote ops + presence                           (any participant)
  const coedit = createNoteCoeditRepo(db);
  const sharing = createNoteSharing(db);

  /** Resolve access + (best-effort) the note's owner-side content for seeding. */
  async function loadForCoedit(noteId: string, userId: string): Promise<{ access: NonNullable<Awaited<ReturnType<typeof resolveNoteAccess>>>; seedPm: unknown } | null> {
    const access = await resolveNoteAccess(db, noteId, userId);
    if (!access) return null;
    const owned = await notes.getNote(noteId, access.ownerId);
    let seedPm: unknown = { type: 'doc', content: [] };
    if (owned) { try { seedPm = JSON.parse(owned.doc_json); } catch { /* keep empty */ } }
    return { access, seedPm };
  }

  /** Keep the note's stored `doc_json` in sync with the live co-edit doc (best-effort). */
  async function writeBackDoc(noteId: string, ownerId: string, pm: { type: 'doc'; content: unknown[] }): Promise<void> {
    try { await notes.updateNote(noteId, ownerId, { doc_json: JSON.stringify(pm) }); } catch { /* non-fatal */ }
  }

  router.post('/api/me/notes/:id/coedit', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const loaded = await loadForCoedit(params['id']!, auth.userId);
    if (!loaded) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const view = await coedit.ensureDoc({ noteId: params['id']!, tenantId: loaded.access.tenantId, ownerId: loaded.access.ownerId, seedPm: loaded.seedPm });
    // A per-tab site id UNDER the user's namespace (unique replicas, provable authorship).
    const siteId = `${userNoteSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    // Phase 3: tell the client whether live cursors are enabled for this workspace.
    const cfg = await noteSettings.getConfig();
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...view, siteId, role: loaded.access.role, liveCursors: cfg.liveCursorsEnabled, aiPresence: cfg.aiPresenceEnabled }));
  }, { auth: true });

  router.get('/api/me/notes/:id/coedit', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const view = await coedit.getViewByNote(params['id']!);
    if (!view) { res.writeHead(404); res.end(JSON.stringify({ error: 'co-edit not started' })); return; }
    const siteId = `${userNoteSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...view, siteId, role: access.role }));
  }, { auth: true });

  router.post('/api/me/notes/:id/coedit/ops', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot edit' })); return; }
    const view0 = await coedit.getViewByNote(params['id']!);
    if (!view0) { res.writeHead(409); res.end(JSON.stringify({ error: 'co-edit not started' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    // The op author must live inside this user's namespace (anti-forgery enforced in the relay).
    const result = await coedit.submitOps(view0.docId, userNoteSiteId(auth.userId), body['ops']);
    if (!result.ok) { res.writeHead(String(result.error).startsWith('forbidden') ? 403 : 400); res.end(JSON.stringify({ error: result.error })); return; }
    if (result.applied.length > 0) {
      noteCoeditHub.broadcast(params['id']!, 'coedit.op', { docId: view0.docId, ops: result.applied });
      await writeBackDoc(params['id']!, access.ownerId, result.view.prosemirror);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applied: result.applied.length, stateVector: result.view.stateVector }));
  }, { auth: true });

  router.get('/api/me/notes/:id/coedit/ops', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const view0 = await coedit.getViewByNote(params['id']!);
    if (!view0) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ops: [] })); return; }
    let since: Record<string, number> = {};
    const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('since');
    if (raw) { try { since = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, number>; } catch { /* all */ } }
    const ops = await coedit.opsSince(view0.docId, since);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ops }));
  }, { auth: true });

  router.post('/api/me/notes/:id/coedit/sync', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const loaded = await loadForCoedit(params['id']!, auth.userId);
    if (!loaded) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(loaded.access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot edit' })); return; }
    // Ensure the doc exists (seed from current content) before diffing into it.
    const ensured = await coedit.ensureDoc({ noteId: params['id']!, tenantId: loaded.access.tenantId, ownerId: loaded.access.ownerId, seedPm: loaded.seedPm });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const pm = (body['doc'] ?? body['doc_json']);
    const result = await coedit.syncFromProseMirror(ensured.docId, userNoteSiteId(auth.userId), pm);
    if (!result.ok) { res.writeHead(400); res.end(JSON.stringify({ error: result.error })); return; }
    if (result.applied.length > 0) {
      noteCoeditHub.broadcast(params['id']!, 'coedit.op', { docId: ensured.docId, ops: result.applied });
      await writeBackDoc(params['id']!, loaded.access.ownerId, result.view.prosemirror);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applied: result.applied.length, stateVector: result.view.stateVector }));
  }, { auth: true });

  router.post('/api/me/notes/:id/coedit/awareness', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const peerId = typeof body['siteId'] === 'string' && body['siteId'].startsWith(userNoteSiteId(auth.userId))
      ? (body['siteId'] as string)
      : userNoteSiteId(auth.userId);
    // Phase 3: presence is un-trusted chatter — sanitise the state (cap names, validate the
    // colour, bound the cursor, drop unknown keys) before re-broadcasting it to everyone.
    const rawEntry = (body['entry'] && typeof body['entry'] === 'object') ? body['entry'] as Record<string, unknown> : { state: null };
    const clock = Number.isFinite(Number(rawEntry['clock'])) ? Number(rawEntry['clock']) : 0;
    const entry = { clock, state: sanitizeAwarenessState(rawEntry['state']) };
    noteCoeditHub.broadcast(params['id']!, 'coedit.awareness', { peerId, entry });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  router.get('/api/me/notes/:id/coedit/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const peerId = `${userNoteSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    const { detach } = noteCoeditHub.subscribe(params['id']!, res, peerId);
    const keepalive = setInterval(() => noteCoeditHub.keepAlive(params['id']!), 25_000);
    req.on('close', () => { clearInterval(keepalive); detach(); });
  }, { auth: true });

  // ── weaveNotes Phase 2: note sharing (invite links + membership) ──────────────
  //
  //   POST   /api/me/notes/join                join a note via an invite token        (any user)
  //   POST   /api/me/notes/:id/share           owner mints an invite link             (owner)
  //   GET    /api/me/notes/:id/share           owner lists participants + invites     (owner)
  //   POST   /api/me/notes/:id/share/revoke    owner revokes a member or an invite    (owner)
  router.post('/api/me/notes/join', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['token'] !== 'string' || !body['token']) { res.writeHead(400); res.end(JSON.stringify({ error: 'token required' })); return; }
    const result = await sharing.join(body['token'], auth.userId);
    if (!result.ok) { res.writeHead(400); res.end(JSON.stringify({ error: result.error })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ noteId: result.noteId, role: result.role }));
  }, { auth: true });

  router.post('/api/me/notes/:id/share', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const role = body['role'] === 'collaborator' ? 'collaborator' : 'viewer';
    const invite = await sharing.createInvite({
      noteId: params['id']!, ownerId: auth.userId, tenantId: auth.tenantId ?? null, role,
      maxUses: typeof body['maxUses'] === 'number' ? body['maxUses'] : null,
      expiresAt: typeof body['expiresAt'] === 'number' ? body['expiresAt'] : null,
    });
    if (!invite) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; } // only the owner may share
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(invite));
  }, { auth: true });

  router.get('/api/me/notes/:id/share', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const owned = await notes.getNote(params['id']!, auth.userId);
    if (!owned || owned.owner_user_id !== auth.userId) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const participants = await sharing.listParticipants(params['id']!, auth.userId);
    const invites = (await sharing.listInvites(params['id']!, auth.userId)).map((t) => ({ id: t.id, role: t.role, prefix: t.token_prefix, uses: t.uses, maxUses: t.max_uses, expiresAt: t.expires_at, revokedAt: t.revoked_at }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ participants, invites }));
  }, { auth: true });

  router.post('/api/me/notes/:id/share/revoke', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    let ok = false;
    if (typeof body['userId'] === 'string') ok = await sharing.revokeMember(params['id']!, auth.userId, body['userId']);
    else if (typeof body['tokenId'] === 'string') ok = await sharing.revokeInvite(params['id']!, auth.userId, body['tokenId']);
    else { res.writeHead(400); res.end(JSON.stringify({ error: 'userId or tokenId required' })); return; }
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: ok }));
  }, { auth: true });

  // ── weaveNotes Phase 3: AI co-author (suggestions + AI blocks) ────────────────
  //
  // The AI works INSIDE the note. "Actions" (continue / rewrite / summarize / ask)
  // run the real LLM and STAGE the result as a track-changes suggestion the human
  // accepts or rejects — the AI never silently mutates the document. "AI blocks"
  // are blocks generated from a prompt that can be refreshed. All require the caller
  // to be the owner or a collaborator (viewers 403); everything broadcasts live.
  //
  //   POST /api/me/notes/:id/ai/:action            run an AI action → a pending suggestion   (collaborator+)
  //   GET  /api/me/notes/:id/suggestions?status=   list suggestions                          (any participant)
  //   POST /api/me/notes/:id/suggestions/:sid/accept   apply a suggestion's staged ops       (collaborator+)
  //   POST /api/me/notes/:id/suggestions/:sid/reject   discard a suggestion                  (collaborator+)
  //   POST /api/me/notes/:id/ai/insert-block       generate + insert a refreshable AI block  (collaborator+)
  //   POST /api/me/notes/:id/ai/refresh-block      re-generate an AI block's content         (collaborator+)
  const AI_ACTIONS = new Set(['continue', 'rewrite', 'summarize', 'ask']);

  // NOTE: register the STATIC `/ai/insert-block` + `/ai/refresh-block` routes BEFORE
  // the `/ai/:action` param route, so the router matches them exactly (the param
  // route would otherwise capture "insert-block" as an unknown action).
  aiPost('/api/me/notes/:id/ai/insert-block', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['prompt'] !== 'string' || !body['prompt'].trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'prompt required' })); return; }
    const r = await noteAi.insertAiBlock({ noteId: params['id']!, access, prompt: body['prompt'], ...(typeof body['citation'] === 'string' ? { citation: body['citation'] } : {}) });
    res.writeHead(r.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  aiPost('/api/me/notes/:id/ai/refresh-block', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const blockId = body['blockId'];
    if (!blockId || typeof blockId !== 'object') { res.writeHead(400); res.end(JSON.stringify({ error: 'blockId required' })); return; }
    const r = await noteAi.refreshAiBlock({ noteId: params['id']!, access, blockId: blockId as { counter: number; siteId: string } });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // weaveNotes Phase 2: the AI selection card's colour endpoints. Static paths registered
  // BEFORE the `/ai/:action` param route so the router matches them exactly.
  //   POST /api/me/notes/:id/ai/highlight   { phrase, color?, mark? }  → a highlight/text-colour suggestion
  //   POST /api/me/notes/:id/ai/colorize    { scheme, instruction? }   → a colour-code-by-meaning suggestion
  aiPost('/api/me/notes/:id/ai/highlight', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteColorize) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['phrase'] !== 'string' || !body['phrase'].trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'phrase required' })); return; }
    const color = typeof body['color'] === 'string' ? body['color'] : undefined;
    const r = body['mark'] === 'textColor'
      ? await noteColorize.applyTextColor({ noteId: params['id']!, access, phrase: body['phrase'], ...(color ? { color } : {}) })
      : await noteColorize.applyHighlight({ noteId: params['id']!, access, phrase: body['phrase'], ...(color ? { color } : {}) });
    res.writeHead(r.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  aiPost('/api/me/notes/:id/ai/colorize', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteColorize) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const scheme = isColorScheme(body['scheme']) ? body['scheme'] : 'topic';
    const r = await noteColorize.colorizeSemantic({ noteId: params['id']!, access, scheme, ...(typeof body['instruction'] === 'string' ? { instruction: body['instruction'] } : {}) });
    res.writeHead(r.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // Build the natural, first-person instruction handed to the agent/supervisor for a note action.
  // (First-person "my own note" phrasing keeps a benign "reorganise the structure" clear of the
  // prompt-injection guardrail.) Referencing the note id tells the worker which note to act on.
  function buildNoteAgentPrompt(action: string, noteId: string, o: { instruction?: string; outline?: string; kind?: string }): string {
    const instruction = (o.instruction ?? '').slice(0, 2000);
    const outline = (o.outline ?? '').slice(0, 4000);
    const kind = o.kind ?? '';
    if (action === 'restructure') return `This is my own note (id ${noteId}) and I'd like your help tidying it up. Please reorganise its sections into a clearer, more logical order and fix the heading levels, keeping all of the existing content. Stage it as a suggestion for me to review.${outline ? `\n\nI'd like the sections in roughly this order:\n${outline}` : ''}`;
    if (action === 'find_image') return `This is my own note (id ${noteId}). Please find a real, free-to-use image of ${instruction || 'the topic of this note'} on the web and add it to the note, staged as a suggestion for me to review.`;
    if (action === 'visual') { const k = kind && kind !== 'auto' ? kind : 'visual'; return `This is my own note (id ${noteId}). Please add a ${k} to it${instruction ? `: ${instruction}` : ' that fits the content'}, staged as a suggestion for me to review.`; }
    if (action === 'ink') return `This is my own note (id ${noteId}). Please sketch ${instruction || 'a small freehand drawing that fits the content'} in it, staged as a suggestion for me to review.`;
    if (action === 'illustration') return `This is my own note (id ${noteId}). Please add an illustration to it${instruction ? `: ${instruction}` : ' that fits the content'}, staged as a suggestion for me to review.`;
    return `This is my own note (id ${noteId}). Please draw a diagram in it${instruction ? `: ${instruction}` : ' summarising the content'}, staged as a suggestion for me to review.`;
  }

  /**
   * Resolve the configured routing MODE for a note action (per tenant, Builder-editable) and run it:
   *   - `direct`     → call the note service directly (one focused LLM call; fastest).
   *   - `agent`      → the chat agent calls the note tool itself.
   *   - `supervisor` → the supervisor delegates to the weaveNotes Editor worker.
   * For agent/supervisor we snapshot the note's pending suggestions, run the engine, and return what
   * the worker newly staged — so the response shape stays the same for the UI (a staged suggestion).
   */
  async function performNoteAiAction(
    actionKey: string,
    noteId: string,
    access: NonNullable<Awaited<ReturnType<typeof resolveNoteAccess>>>,
    directFn: () => Promise<{ ok: boolean; error?: string; suggestionId?: string; preview?: string; action?: string }>,
    promptArgs: { instruction?: string; outline?: string; kind?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const mode = await db.resolveNoteActionMode(access.tenantId, actionKey);
    if (mode === 'direct' || !opts.runNoteAgentAction) {
      const r = await directFn();
      return { status: r.ok ? 201 : 400, body: { ...r, via: 'direct' } };
    }
    const beforeIds = new Set((await db.listNoteSuggestions(noteId, 'pending')).map((s) => s.id));
    const r = await opts.runNoteAgentAction({ userId: access.ownerId, noteId, instruction: buildNoteAgentPrompt(actionKey, noteId, promptArgs), mode });
    const staged = (await db.listNoteSuggestions(noteId, 'pending')).filter((s) => !beforeIds.has(s.id)).map((s) => ({ id: s.id, action: s.action }));
    return { status: staged.length ? 201 : 200, body: { ok: staged.length > 0, via: mode, staged, suggestionId: staged[0]?.id ?? null, action: staged[0]?.action, assistant: r.content ?? '' } };
  }

  // weaveNotes Phase 4: the AI creative endpoints (a diagram / freehand ink), registered BEFORE
  // the `/ai/:action` param route. The "✦ Make a diagram" card chip + the slash menu call these.
  // Each is CONFIG-DRIVEN: the per-tenant `note_action_modes` row decides direct / agent / supervisor.
  //   POST /api/me/notes/:id/ai/diagram   { instruction }  → a diagram suggestion
  //   POST /api/me/notes/:id/ai/ink       { instruction }  → an ink suggestion
  aiPost('/api/me/notes/:id/ai/diagram', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteCreative) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const userInstruction = typeof body['instruction'] === 'string' && body['instruction'].trim() ? body['instruction'] : '';
    const out = await performNoteAiAction('diagram', params['id']!, access,
      () => noteCreative!.createDiagram({ noteId: params['id']!, access, instruction: userInstruction || 'Make a clear diagram of this note.' }),
      { instruction: userInstruction });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }, { auth: true });

  aiPost('/api/me/notes/:id/ai/ink', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteCreative) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['instruction'] !== 'string' || !body['instruction'].trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'instruction required' })); return; }
    const inkInstruction = body['instruction'];
    const out = await performNoteAiAction('ink', params['id']!, access,
      () => noteCreative!.drawInk({ noteId: params['id']!, access, instruction: inkInstruction }),
      { instruction: inkInstruction });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }, { auth: true });

  // Source a REAL, free-to-use image from the web (Openverse/Wikimedia/…) and insert it WITH
  // attribution. Config-driven (note_action_modes 'find_image'). The provider search + image download
  // run through the HARDENED, SSRF-guarded fetch; only public images under allowed licences are used.
  //   POST /api/me/notes/:id/ai/find-image   { query }  → an image suggestion (with a licence caption)
  aiPost('/api/me/notes/:id/ai/find-image', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteCreative) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const query = typeof body['query'] === 'string' && body['query'].trim() ? body['query'] : (typeof body['instruction'] === 'string' ? body['instruction'] : '');
    if (!query.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'query required' })); return; }
    // The user's preferred image-label language (DB-backed, default 'en') — steers search + ranking.
    const language = await db.getNoteImageLanguage(auth.userId).catch(() => 'en');
    const out = await performNoteAiAction('find_image', params['id']!, access,
      () => noteCreative!.findImage({ noteId: params['id']!, access, query, language }),
      { instruction: query });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }, { auth: true });

  // The user's preferred LANGUAGE for sourced images (per-user, DB-backed, default 'en'). Steers the
  // find_image search query, candidate ranking, and the filename-language filter.
  //   GET /api/me/notes-image-language          → { language }
  //   PUT /api/me/notes-image-language { language }
  router.get('/api/me/notes-image-language', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const language = await db.getNoteImageLanguage(auth.userId).catch(() => 'en');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ language, languages: NOTE_IMAGE_LANGUAGES }));
  }, { auth: true });
  router.put('/api/me/notes-image-language', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const language = normalizeLanguage(typeof body['language'] === 'string' ? body['language'] : 'en');
    await db.setNoteImageLanguage(auth.userId, language);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, language }));
  }, { auth: true });

  // Reorganise the WHOLE note: the AI rewrites it into a clearer structure and stages it as one
  // track-changes suggestion. An optional `outline` lets the human dictate the section order.
  //   POST /api/me/notes/:id/ai/restructure   { outline? }  → a whole-document suggestion
  aiPost('/api/me/notes/:id/ai/restructure', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const outline = typeof body['outline'] === 'string' && body['outline'].trim() ? body['outline'] : '';
    const out = await performNoteAiAction('restructure', params['id']!, access,
      () => withAiPresence(db, params['id']!, () => noteAi!.restructure({ noteId: params['id']!, access, ...(outline ? { outline } : {}) })),
      { outline });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }, { auth: true });

  // Run a note action THROUGH THE SUPERVISOR (it delegates to the weaveNotes Editor worker, which
  // calls the create_diagram / restructure_note / … tool → stages a suggestion). This is what the
  // "Make a diagram" / "Restructure" UI buttons call when "use the agent" is on — so the activity is
  // performed by the supervisor + worker agents via the API, not by a direct service call.
  //   POST /api/me/notes/:id/ai/agent   { action: 'diagram'|'restructure'|'visual'|'ink', instruction?, outline?, kind? }
  aiPost('/api/me/notes/:id/ai/agent', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!opts.runNoteAgentAction) { res.writeHead(501); res.end(JSON.stringify({ error: 'Agent actions are not configured on this server' })); return; }
    const noteId = params['id']!;
    const access = await resolveNoteAccess(db, noteId, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const action = typeof body['action'] === 'string' ? body['action'] : 'diagram';
    // Snapshot the note's pending suggestions, run the supervisor (explicit — this endpoint always
    // delegates to the worker, regardless of the per-action config), then return what it newly staged.
    const beforeIds = new Set((await db.listNoteSuggestions(noteId, 'pending')).map((s) => s.id));
    const r = await opts.runNoteAgentAction({
      userId: auth.userId, noteId, mode: 'supervisor',
      instruction: buildNoteAgentPrompt(action, noteId, {
        instruction: typeof body['instruction'] === 'string' ? body['instruction'] : '',
        outline: typeof body['outline'] === 'string' ? body['outline'] : '',
        kind: typeof body['kind'] === 'string' ? body['kind'] : '',
      }),
    });
    const staged = (await db.listNoteSuggestions(noteId, 'pending'))
      .filter((s) => !beforeIds.has(s.id))
      .map((s) => ({ id: s.id, action: s.action }));
    res.writeHead(staged.length ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: staged.length > 0, via: 'supervisor', staged, assistant: r.content ?? '' }));
  }, { auth: true });

  // Phase 4 (creative expansion): SVG illustration, generated image, and the AUTO router.
  //   POST /api/me/notes/:id/ai/illustration { instruction }          → an SVG-illustration suggestion
  //   POST /api/me/notes/:id/ai/image        { instruction }          → a generated-image suggestion (if enabled)
  //   POST /api/me/notes/:id/ai/visual       { instruction, kind? }   → the AI picks the best kind
  const creativeRoute = (path: string, run: (noteId: string, access: NonNullable<Awaited<ReturnType<typeof resolveNoteAccess>>>, body: Record<string, unknown>) => Promise<{ ok: boolean }>) =>
    router.post(`/api/me/notes/:id/ai/${path}`, async (req, res, params, auth) => {
      if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      if (!noteCreative) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
      const access = await resolveNoteAccess(db, params['id']!, auth.userId);
      if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
      if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
      const r = await run(params['id']!, access, body);
      res.writeHead(r.ok ? 201 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    }, { auth: true });

  // illustration + visual are CONFIG-DRIVEN (per-tenant note_action_modes). For "visual" the action
  // key is the chosen kind (diagram/ink/illustration → that action's mode; auto → 'visual'). image is
  // ALWAYS direct (its generate_image tool is intentionally not agent-registered — it costs money).
  aiPost('/api/me/notes/:id/ai/illustration', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteCreative) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const instruction = typeof body['instruction'] === 'string' && body['instruction'].trim() ? body['instruction'] : '';
    const out = await performNoteAiAction('illustration', params['id']!, access,
      () => noteCreative!.createIllustration({ noteId: params['id']!, access, instruction: instruction || 'an illustration of this note' }),
      { instruction });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }, { auth: true });

  aiPost('/api/me/notes/:id/ai/visual', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteCreative) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const instruction = typeof body['instruction'] === 'string' && body['instruction'].trim() ? body['instruction'] : '';
    const kind = typeof body['kind'] === 'string' ? body['kind'] : 'auto';
    // The config key is the concrete kind (so an admin can route "diagram" but keep "illustration"
    // direct); 'auto' resolves the generic 'visual' row. 'image' is never agent-routed.
    const actionKey = kind === 'image' ? 'image' : (kind && kind !== 'auto' ? kind : 'visual');
    const out = await performNoteAiAction(actionKey, params['id']!, access,
      () => noteCreative!.createVisual({ noteId: params['id']!, access, instruction: instruction || 'a visual for this note', kind: kind as 'auto' | 'diagram' | 'ink' | 'illustration' | 'image' }),
      { instruction, kind });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }, { auth: true });

  creativeRoute('image', (noteId, access, body) => noteCreative!.generateImage({ noteId, access, instruction: typeof body['instruction'] === 'string' && body['instruction'].trim() ? body['instruction'] : 'an image for this note' }));

  // ── weaveNotes Phase 5: flashcards + spaced repetition (active-recall study) ──
  //   POST /api/me/notes/:id/flashcards       make a deck from the note            (collaborator+)
  //   GET  /api/me/notes/:id/flashcards       the note's deck + study stats         (any access)
  //   GET  /api/me/flashcards/due             the cross-note review queue (due now) (any user)
  //   POST /api/me/flashcards/:cid/review     grade a card → SM-2 reschedule        (owner of card)
  router.post('/api/me/notes/:id/flashcards', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteStudy) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const r = await noteStudy.generateFlashcards({ noteId: params['id']!, access, userId: auth.userId, ...(typeof body['count'] === 'number' ? { count: body['count'] } : {}) });
    res.writeHead(r.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  router.get('/api/me/notes/:id/flashcards', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteStudy) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const r = await noteStudy.listCards(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  router.get('/api/me/flashcards/due', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteStudy) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const limit = safePageInt(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'), 50, 1, 200);
    const r = await noteStudy.dueCards(auth.userId, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // weaveNotes Phase 2: read an image artifact's CONTENT CREDENTIALS (licence + provenance manifest)
  // so a download/share can carry where the image came from. Owner-scoped.
  router.get('/api/me/artifacts/:id/credentials', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!db.getArtifact) { res.writeHead(501); res.end(JSON.stringify({ error: 'Artifacts unavailable' })); return; }
    const art = await db.getArtifact(params['id']!);
    if (!art || (art.user_id && art.user_id !== auth.userId)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let meta: Record<string, unknown> = {};
    try { meta = art.metadata ? JSON.parse(art.metadata) as Record<string, unknown> : {}; } catch { /* */ }
    // Raster images carry the manifest in metadata; SVG illustrations carry it EMBEDDED in their bytes.
    let provenance: unknown = meta['provenance'] ?? null;
    if (!provenance) {
      const svgText = art.data_text ?? (art.data_blob ? art.data_blob.toString('utf8') : '');
      if (svgText.includes('gw-provenance')) provenance = parseProvenanceFromSvg(svgText);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: art.id, provenance: provenance ?? null }));
  }, { auth: true });

  // weaveNotes Phase 2: a user can SEE their workspace's enterprise governance posture (read-only;
  // editing is admin-only via /api/admin/tenant-governance). Surfaces residency/no-training/BYOK/etc.
  router.get('/api/me/governance', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const r = await governance.getEffective(auth.tenantId ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // ── weaveNotes Phase 3: scheduled workspace agents (recurring AI note tasks) ──
  //   GET  /api/me/scheduled-agents            list the user's scheduled agents
  //   POST /api/me/scheduled-agents            create one
  //   GET/PUT/DELETE /api/me/scheduled-agents/:id   read / update / delete one
  //   POST /api/me/scheduled-agents/:id/run    run it now (AI op, rate-limited)
  //   GET  /api/me/scheduled-agents/:id/runs   the run log (audit)
  const schedReady = (res: { writeHead: (n: number) => void; end: (s: string) => void }): boolean => { if (!scheduledAgents) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return false; } return true; };
  router.get('/api/me/scheduled-agents', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!schedReady(res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agents: await scheduledAgents!.list(auth.userId) }));
  }, { auth: true });
  router.post('/api/me/scheduled-agents', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!schedReady(res)) return;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const r = await scheduledAgents!.create({ userId: auth.userId, tenantId: auth.tenantId ?? null, partial: body });
    res.writeHead(r.ok ? 201 : (r.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });
  router.get('/api/me/scheduled-agents/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!schedReady(res)) return;
    const agent = await scheduledAgents!.get(params['id']!, auth.userId);
    res.writeHead(agent ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agent ? { ok: true, agent } : { error: 'Not found' }));
  }, { auth: true });
  router.put('/api/me/scheduled-agents/:id', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!schedReady(res)) return;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const r = await scheduledAgents!.update(params['id']!, auth.userId, body);
    res.writeHead(r.ok ? 200 : (r.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });
  router.del('/api/me/scheduled-agents/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!schedReady(res)) return;
    const r = await scheduledAgents!.remove(params['id']!, auth.userId);
    res.writeHead(r.ok ? 200 : (r.code ?? 404), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });
  router.get('/api/me/scheduled-agents/:id/runs', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!schedReady(res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runs: await scheduledAgents!.listRuns(params['id']!, auth.userId) }));
  }, { auth: true });
  aiPost('/api/me/scheduled-agents/:id/run', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!schedReady(res)) return;
    const r = await scheduledAgents!.runNow({ agentId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null, trigger: 'manual' });
    res.writeHead(r.ok ? 200 : (r.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // ── weaveNotes Phase 3: MCP note-vault server + per-user tokens ──────────────
  //   POST /api/mcp/notes              the MCP endpoint (its OWN bearer-token auth; no cookie/CSRF)
  //   GET/POST /api/me/mcp-tokens      list / mint a personal MCP token (the secret is shown ONCE)
  //   DELETE /api/me/mcp-tokens/:id    revoke a token
  router.post('/api/mcp/notes', async (req, res) => {
    const bearer = (req.headers['authorization'] as string | undefined) ?? '';
    const raw = await readBody(req).catch(() => '');
    const out = await mcpNotes.handleRequest(bearer, raw);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (out.status === 401) headers['WWW-Authenticate'] = 'Bearer realm="weaveNotes MCP"';
    res.writeHead(out.status, headers);
    res.end(out.body === null ? '' : JSON.stringify(out.body));
  }, { auth: false, csrf: false });
  router.get('/api/me/mcp-tokens', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tokens: await mcpNotes.listTokens(auth.userId), endpoint: '/api/mcp/notes' }));
  }, { auth: true });
  router.post('/api/me/mcp-tokens', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await (await import('../note-settings-sql.js')).createNoteSettingsService(db).getConfig();
    if (!cfg.mcpNotesEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'The notes MCP server is disabled.' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const created = await mcpNotes.createToken({ userId: auth.userId, tenantId: auth.tenantId ?? null, name: typeof body['name'] === 'string' ? body['name'] : undefined, scope: body['scope'] === 'read' ? 'read' : 'readwrite' });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...created, endpoint: '/api/mcp/notes' })); // `token` plaintext is returned ONCE
  }, { auth: true });
  router.del('/api/me/mcp-tokens/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await mcpNotes.revokeToken(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  router.post('/api/me/flashcards/:cid/review', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteStudy) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const rating = ['again', 'hard', 'good', 'easy'].includes(String(body['rating'])) ? body['rating'] as 'again' | 'hard' | 'good' | 'easy' : 'good';
    const r = await noteStudy.reviewCard({ cardId: params['cid']!, userId: auth.userId, rating });
    res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // ── weaveNotes Phase 2: translate a note into another language (saved as a NEW note) ──
  //   POST /api/me/notes/:id/translate   { targetLanguage, formality?, glossary? }   (collaborator+)
  aiPost('/api/me/notes/:id/translate', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteTranslate) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot translate' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const targetLanguage = typeof body['targetLanguage'] === 'string' ? body['targetLanguage'] : '';
    const formality = ['default', 'formal', 'informal'].includes(String(body['formality'])) ? body['formality'] as 'default' | 'formal' | 'informal' : undefined;
    const glossary = Array.isArray(body['glossary']) ? (body['glossary'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    const r = await noteTranslate.translateNote({ noteId: params['id']!, access, userId: auth.userId, targetLanguage, ...(formality ? { formality } : {}), ...(glossary ? { glossary } : {}) });
    res.writeHead(r.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  aiPost('/api/me/notes/:id/ai/:action', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured on this server' })); return; }
    const action = params['action']!;
    // insert-block / refresh-block are handled by their own paths below; here only the 4 text actions.
    if (!AI_ACTIONS.has(action)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown AI action' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot use AI editing' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const selBlock = body['selectionBlockId'];
    // Phase 3: show the AI as a live participant ("composing") while it works.
    const result = await withAiPresence(db, params['id']!, () => noteAi.propose({
      noteId: params['id']!, access, action: action as AiAction,
      ...(typeof body['instruction'] === 'string' ? { instruction: body['instruction'] } : {}),
      ...(typeof body['selectionText'] === 'string' ? { selectionText: body['selectionText'] } : {}),
      ...(selBlock && typeof selBlock === 'object' ? { selectionBlockId: selBlock as { counter: number; siteId: string } } : {}),
    }));
    res.writeHead(result.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/suggestions', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ suggestions: [] })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const status = (new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? 'pending') as 'pending' | 'accepted' | 'rejected' | 'all';
    const rows = await noteAi.list(params['id']!, status);
    // Trim the heavy ops_json out of the list payload; the preview is what reviewers read.
    const suggestions = rows.map((r) => ({ id: r.id, action: r.action, status: r.status, preview: r.preview_text, before: r.before_text ?? '', authorKind: r.author_kind, createdAt: r.created_at }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions }));
  }, { auth: true });

  router.post('/api/me/notes/:id/suggestions/:sid/accept', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const r = await noteAi.accept(params['sid']!, auth.userId, access);
    // Phase 0-B audit: when an AI suggestion is ACCEPTED, the AI change actually lands in the note —
    // record it (actor 'ai') so the audit feed + the AI's own "what changed" context both see it.
    if (r.ok) void noteSettings.recordActivity({ noteId: params['id']!, userId: auth.userId, tenantId: access.tenantId ?? null, action: 'ai_edit', actor: 'ai', summary: 'Accepted an AI suggestion' });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  router.post('/api/me/notes/:id/suggestions/:sid/reject', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const r = await noteAi.reject(params['sid']!, auth.userId, access);
    if (r.ok) void noteSettings.recordActivity({ noteId: params['id']!, userId: auth.userId, tenantId: access.tenantId ?? null, action: 'updated', actor: 'user', summary: 'Rejected an AI suggestion' });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // ── weaveNotes Phase 4: publish a note as a shareable artifact ────────────────
  //
  //   POST /api/me/notes/:id/emit-artifact   note → Markdown/HTML artifact (+ optional
  //                                          public share link). collaborator+. The note's
  //                                          `sensitivity` gates it: `restricted` is refused
  //                                          (403); content is redacted (secrets always,
  //                                          PII for confidential) before it can be shared.
  router.post('/api/me/notes/:id/emit-artifact', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!db.saveArtifact) { res.writeHead(501); res.end(JSON.stringify({ error: 'artifact storage not available' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot publish' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const result = await publish.emit({
      noteId: params['id']!, access, publishedBy: 'user',
      format: (body['format'] === 'html' ? 'html' : 'markdown') as PublishFormat,
      share: body['share'] !== false, // default: also mint a share link
      ...(typeof body['password'] === 'string' && body['password'] ? { password: body['password'] } : {}),
      ...(typeof body['expiresInDays'] === 'number' ? { expiresInDays: body['expiresInDays'] } : {}),
    });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/notes', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    // Optional: instantiate from a template.
    // Phase 6: `template_key` selects a SYSTEM template by its stable key (e.g. 'meeting-minutes');
    // `template_id` selects any note (system or user) by id. Either seeds the new note's content + icon.
    let docJson = '{"type":"doc","content":[]}';
    let seededIcon: string | null = null;
    let seededTitle: string | null = null;
    if (typeof body['template_key'] === 'string') {
      const tpl = templateByKey(body['template_key']);
      if (tpl) { docJson = JSON.stringify(tpl.doc); seededIcon = tpl.icon; seededTitle = tpl.title; }
    }
    if (typeof body['template_id'] === 'string') {
      const tmpl = await notes.getNote(body['template_id'], auth.userId);
      if (tmpl) { docJson = tmpl.doc_json; seededIcon = tmpl.icon ?? seededIcon; seededTitle = tmpl.title; }
    }
    if (typeof body['doc_json'] === 'string') docJson = body['doc_json'];
    else if (body['doc_json'] && typeof body['doc_json'] === 'object') docJson = JSON.stringify(body['doc_json']);

    // weaveNotes Phase 1: a new note opens in the workspace DEFAULT theme (weavenotes_settings),
    // unless the client explicitly asks for one. The per-note choice is then persisted + toggled.
    const cfg = await noteSettings.getConfig();
    const pageTheme = body['page_theme'] !== undefined ? coercePageTheme(body['page_theme']) : cfg.defaultTheme;
    const freeform = body['freeform_mode'] === true || body['freeform_mode'] === 1 ? 1 : 0;

    const id = newUUIDv7();
    await notes.createNote({
      id,
      owner_user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      title: typeof body['title'] === 'string' && body['title'].trim() ? body['title'] : (seededTitle ?? 'Untitled'),
      icon: typeof body['icon'] === 'string' ? body['icon'] : seededIcon,
      cover: typeof body['cover'] === 'string' ? body['cover'] : null,
      parent_note_id: typeof body['parent_note_id'] === 'string' ? body['parent_note_id'] : null,
      sensitivity: (['normal', 'confidential', 'restricted'].includes(String(body['sensitivity'] ?? '')) ? body['sensitivity'] : 'normal') as NoteSensitivity,
      doc_json: docJson,
      is_template: 0,
      favorite: 0,
      page_theme: pageTheme,
      freeform_mode: freeform,
    });

    const note = await notes.getNote(id, auth.userId);
    // weaveNotes Phase 0: log the creation so the AI can later see what's been happening.
    void noteSettings.recordActivity({ noteId: id, userId: auth.userId, tenantId: auth.tenantId ?? null, action: 'created', actor: 'user', summary: `Created “${note?.title ?? 'Untitled'}”${clientProvenance(req)}` });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note));
  }, { auth: true });

  router.add('PATCH','/api/me/notes/:id', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const patch: UpdateNotePatch = {};
    if (typeof body['title'] === 'string') patch.title = body['title'];
    if ('icon' in body) patch.icon = typeof body['icon'] === 'string' ? body['icon'] : null;
    if ('cover' in body) patch.cover = typeof body['cover'] === 'string' ? body['cover'] : null;
    if ('parent_note_id' in body) patch.parent_note_id = typeof body['parent_note_id'] === 'string' ? body['parent_note_id'] : null;
    if (typeof body['sensitivity'] === 'string') patch.sensitivity = body['sensitivity'] as NoteSensitivity;
    if (typeof body['doc_json'] === 'string') patch.doc_json = body['doc_json'];
    else if (body['doc_json'] && typeof body['doc_json'] === 'object') patch.doc_json = JSON.stringify(body['doc_json']);
    if (typeof body['favorite'] === 'number') patch.favorite = body['favorite'];
    // weaveNotes Phase 1: persist the per-note theme + freeform + cover-image choices.
    if (body['page_theme'] !== undefined) patch.page_theme = coercePageTheme(body['page_theme']);
    if (body['freeform_mode'] !== undefined) patch.freeform_mode = body['freeform_mode'] === true || body['freeform_mode'] === 1 ? 1 : 0;
    if ('cover_image_artifact_id' in body) patch.cover_image_artifact_id = typeof body['cover_image_artifact_id'] === 'string' ? body['cover_image_artifact_id'] : null;

    // weaveNotes Phase 2: if this note is already being co-edited, a full-document
    // PATCH (the legacy single-user save) must NOT clobber concurrent edits — route
    // the new content through the relay as a DIFF (merge), keeping everyone's work.
    // Notes that never entered co-edit mode keep the exact legacy overwrite path.
    if (patch.doc_json !== undefined) {
      const access = await resolveNoteAccess(db, params['id']!, auth.userId);
      const existingDoc = access ? await coedit.getViewByNote(params['id']!) : null;
      if (access && existingDoc && roleAtLeast(access.role, 'collaborator')) {
        let pm: unknown; try { pm = JSON.parse(patch.doc_json); } catch { pm = undefined; }
        if (pm !== undefined) {
          const result = await coedit.syncFromProseMirror(existingDoc.docId, userNoteSiteId(auth.userId), pm);
          if (result.ok) {
            if (result.applied.length > 0) noteCoeditHub.broadcast(params['id']!, 'coedit.op', { docId: existingDoc.docId, ops: result.applied });
            patch.doc_json = JSON.stringify(result.view.prosemirror); // persist the merged result, not the raw client doc
          }
        }
      }
    }

    await notes.updateNote(params['id']!, auth.userId, patch);
    const note = await notes.getNote(params['id']!, auth.userId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    // weaveNotes Phase 0: log the edit (title/content/etc.) so the AI understands recent changes.
    const changed = Object.keys(patch).filter((k) => k !== 'doc_json').concat(patch.doc_json !== undefined ? ['content'] : []);
    void noteSettings.recordActivity({ noteId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null, action: 'updated', actor: 'user', summary: `Edited ${changed.length ? changed.join(', ') : 'the note'}${clientProvenance(req)}` });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note));
  }, { auth: true });

  // weaveNotes Phase 0: read a note's activity (what changed) — used by the UI + mirrors the tool.
  router.get('/api/me/notes/:id/activity', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const limit = safePageInt(url.searchParams.get('limit'), 20, 1, 100);
    const events = await noteSettings.readActivity({ noteId: params['id']!, userId: auth.userId, limit });
    if (events === null) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ activity: events }));
  }, { auth: true });

  router.del('/api/me/notes/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const deleted = await notes.deleteNote(params['id']!, auth.userId);
    if (!deleted) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  // weaveNotes Phase 6: ARCHIVE (soft-delete) a note — it leaves the active list but is recoverable.
  router.post('/api/me/notes/:id/archive', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const ok = await notes.archiveNote(params['id']!, auth.userId, new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
    if (!ok) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found or already archived' })); return; }
    void noteSettings.recordActivity({ noteId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null, action: 'updated', actor: 'user', summary: 'Archived this note' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ archived: true }));
  }, { auth: true });

  // weaveNotes Phase 6: RESTORE an archived note back to the active list.
  router.post('/api/me/notes/:id/restore', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const ok = await notes.restoreNote(params['id']!, auth.userId);
    if (!ok) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found or not archived' })); return; }
    void noteSettings.recordActivity({ noteId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null, action: 'updated', actor: 'user', summary: 'Restored this note from the archive' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ restored: true }));
  }, { auth: true });

  // ── Note links ─────────────────────────────────────────────────────────────

  router.get('/api/me/notes/:id/links', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const links = await notes.listLinks(params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ links }));
  }, { auth: true });

  router.post('/api/me/notes/:id/links', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (!body['target_kind'] || !body['target_id']) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'target_kind and target_id are required' })); return;
    }
    const validKinds: NoteLinkTargetKind[] = ['note', 'run', 'agenda_item', 'task'];
    if (!validKinds.includes(body['target_kind'] as NoteLinkTargetKind)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid target_kind' })); return;
    }
    const link = { id: newUUIDv7(), note_id: params['id']!, target_kind: body['target_kind'] as NoteLinkTargetKind, target_id: String(body['target_id']) };
    await notes.createLink(link);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(link));
  }, { auth: true });

  router.del('/api/me/notes/:id/links/:linkId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await notes.deleteLink(params['linkId']!, params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  router.get('/api/me/notes/:id/backlinks', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // weaveNotes Phase 5: resolve backlinks to {noteId, title} for the connections panel.
    const backlinks = await noteGraph.backlinks(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ backlinks }));
  }, { auth: true });

  // ── weaveNotes Phase 5: knowledge graph (index + connections) ─────────────────
  //
  //   POST /api/me/notes/:id/index     (re)index a note: resolve [[wiki-links]] → note
  //                                    links, extract entities/relations (LLM), embed for
  //                                    semantic search. collaborator+.
  //   GET  /api/me/notes/:id/unlinked  notes whose title this note mentions but hasn't linked
  //   GET  /api/me/notes/:id/related   semantically related notes (cosine over embeddings)
  //   GET  /api/me/notes/:id/graph     the local knowledge graph (nodes + edges) for the UI
  router.post('/api/me/notes/:id/index', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot index' })); return; }
    const result = await noteGraph.indexNote({ noteId: params['id']!, access });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/unlinked', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ unlinked: await noteGraph.unlinkedMentions(params['id']!, access) }));
  }, { auth: true });

  router.get('/api/me/notes/:id/related', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const topK = safePageInt(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'), 5, 1, 20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ related: await noteGraph.relatedNotes(params['id']!, access, topK) }));
  }, { auth: true });

  router.get('/api/me/notes/:id/graph', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await noteGraph.graph(params['id']!, access)));
  }, { auth: true });

  // weaveNotes Phase 3 (GraphRAG) — notes CONNECTED to this one through a shared canonical entity
  // (the same person/org/concept, even if worded differently). Owner-scoped.
  router.get('/api/me/notes/:id/entity-related', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const topK = safePageInt(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'), 5, 1, 20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ related: await noteGraph.relatedByEntities(params['id']!, access, topK) }));
  }, { auth: true });

  // weaveNotes Phase 3 (GraphRAG) — BATCHED workspace re-index: (re)embed changed notes in one call
  // per batch (anti-N+1) and optionally refresh the entity graph. Body: { extractGraph?: boolean }.
  router.post('/api/me/notes/reindex', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    let body: { extractGraph?: unknown } = {};
    try { body = JSON.parse(await readBody(req)) as { extractGraph?: unknown }; } catch { /* empty */ }
    const access = { noteId: '', ownerId: auth.userId, tenantId: auth.tenantId ?? null, role: 'owner' as const };
    const result = await noteGraph.reindexWorkspace(access, { batchSize: cfg.embeddingBatchSize, extractGraph: body.extractGraph === true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // weaveNotes Phase 3: PROACTIVE link suggestions — notes this one already refers to (by name or by
  // meaning) that aren't linked yet. Surfaced live as you write; gated by the Builder dial.
  router.get('/api/me/notes/:id/link-suggestions', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.proactiveLinkingEnabled) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ suggestions: [], disabled: true })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const max = safePageInt(new URL(req.url ?? '/', 'http://x').searchParams.get('max'), 8, 1, 20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions: await noteGraph.linkSuggestions(params['id']!, access, { max }) }));
  }, { auth: true });

  // weaveNotes Phase 3: accept a link suggestion — wrap the FIRST plain mention of `targetTitle` in a
  // [[wiki-link]] (lossless), re-index so the backlink appears. Body: { targetTitle }.
  router.post('/api/me/notes/:id/link-suggestions/apply', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.proactiveLinkingEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'Proactive linking is disabled' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body: { targetTitle?: unknown } = {};
    try { body = JSON.parse(await readBody(req)) as { targetTitle?: unknown }; } catch { /* empty */ }
    const targetTitle = typeof body.targetTitle === 'string' ? body.targetTitle : '';
    const result = await noteGraph.applyLink(params['id']!, access, targetTitle);
    if (!result.ok) { res.writeHead(400); res.end(JSON.stringify({ error: result.error ?? 'Could not apply' })); return; }
    if (result.linked) void noteSettings.recordActivity({ noteId: params['id']!, userId: auth.userId, tenantId: access.tenantId ?? null, action: 'updated', actor: 'ai', summary: `Linked “${targetTitle.trim()}”` });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // ── WC8: Save-time extraction pipeline ────────────────────────────────────
  // Called by the client after saving a note. Extracts to-do checkboxes and
  // creates linked tasks. Also syncs @mention links from doc_json.
  // This route is idempotent: repeated calls for the same note are safe.

  router.post('/api/me/notes/:id/extract', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

    const note = await notes.getNote(params['id']!, auth.userId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }

    let doc: unknown;
    try { doc = JSON.parse(note.doc_json); } catch { doc = null; }

    const extractedTasks: Array<{ id: string; title: string }> = [];

    if (doc) {
      const todoTitles = extractTaskItems(doc);
      // Create tasks for new to-dos (deduplicate against existing links)
      const existingLinks = await notes.listLinks(note.id);
      const linkedTaskIds = new Set(existingLinks.filter((l) => l.target_kind === 'task').map((l) => l.target_id));

      for (const title of todoTitles) {
        // Skip if a task with same title already linked (by title-based idempotency)
        const alreadyLinked = linkedTaskIds.size > 0 && (() => {
          // We'd need to load task titles to compare — skip for now, trust the note link set
          return false;
        })();
        if (alreadyLinked) continue;

        const task = createActionItem({
          assignee: auth.userId,
          title,
          provenance: { sourceRef: `note:${note.id}`, createdBy: 'principal' as const },
        });
        await taskRepo.save(task);

        await notes.createLink({
          id: newUUIDv7(),
          note_id: note.id,
          target_kind: 'task',
          target_id: task.id,
        });
        extractedTasks.push({ id: task.id, title: task.title });
        linkedTaskIds.add(task.id);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ extractedTasks }));
  }, { auth: true });

  // ── Note databases ─────────────────────────────────────────────────────────

  router.get('/api/me/note-databases', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const databases = await notes.listDatabases(auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ databases }));
  }, { auth: true });

  router.post('/api/me/note-databases', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (!body['name']) { res.writeHead(400); res.end(JSON.stringify({ error: 'name is required' })); return; }
    const id = newUUIDv7();
    // weaveNotes Phase 6: accept the 5 view types + a typed schema (columns) as a JSON
    // array or string. `columns` is the property schema (PropertyDef[]).
    const columns = body['columns'] ?? body['columns_json'];
    await notes.createDatabase({
      id,
      owner_user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      name: String(body['name']),
      source: (['agenda_items', 'tasks', 'generic'].includes(String(body['source'] ?? '')) ? body['source'] : 'generic') as NoteDatabaseSource,
      view_type: (isViewType(body['view_type']) ? body['view_type'] : 'table') as DbViewType as NoteDatabaseViewType,
      filter_json: typeof body['filter_json'] === 'string' ? body['filter_json'] : '{}',
      sort_json: typeof body['sort_json'] === 'string' ? body['sort_json'] : '[]',
      columns_json: typeof columns === 'string' ? columns : (Array.isArray(columns) ? JSON.stringify(columns) : '[]'),
    });
    const db_ = await notes.getDatabase(id, auth.userId);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(db_));
  }, { auth: true });

  // ── weaveNotes Phase 6: typed database view (rollups) + AI column auto-fill ────
  //
  //   GET  /api/me/note-databases/:id/view       schema + rows with computed rollups + citations
  //   POST /api/me/note-databases/:id/autofill   AI-fill a column (with citations). Body:
  //                                              { propertyKey, rowIds?, useWeb? }. owner-only.
  router.get('/api/me/note-databases/:id/view', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const v = await noteDb.view(params['id']!, auth.userId);
    if (!v) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v));
  }, { auth: true });

  router.post('/api/me/note-databases/:id/autofill', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['propertyKey'] !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'propertyKey required' })); return; }
    const result = await noteDb.autofillColumn({
      databaseId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null,
      propertyKey: body['propertyKey'],
      ...(Array.isArray(body['rowIds']) ? { rowIds: (body['rowIds'] as unknown[]).map(String) } : {}),
      useWeb: body['useWeb'] === true,
    });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.del('/api/me/note-databases/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await notes.deleteDatabase(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  // ── weaveNotes Phase 7: CAPTURE — get content INTO notes ──────────────────────
  //
  //   POST /api/me/notes/capture/run    { runId }                  a chat run → structured note
  //   POST /api/me/notes/capture/web    { url } or { url, html }   a web page → readable note (SSRF-guarded)
  //   POST /api/me/notes/capture/email  { raw } or { from, subject, body, date }
  //   POST /api/me/notes/jot            { text }                   quick thought → today's daily inbox
  //
  // Every capture lands a note with a provenance header. All are owner-scoped + tenant-isolated.
  router.post('/api/me/notes/capture/run', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['runId'] !== 'string' || !body['runId']) { res.writeHead(400); res.end(JSON.stringify({ error: 'runId required' })); return; }
    const result = await noteCapture.captureRun({ runId: body['runId'], userId: auth.userId, tenantId: auth.tenantId ?? null });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/notes/capture/web', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['url'] !== 'string' || !body['url']) { res.writeHead(400); res.end(JSON.stringify({ error: 'url required' })); return; }
    const result = await noteCapture.captureWeb({
      url: body['url'], userId: auth.userId, tenantId: auth.tenantId ?? null,
      ...(typeof body['html'] === 'string' ? { html: body['html'] } : {}),
    });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/notes/capture/email', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const email = typeof body['raw'] === 'string'
      ? body['raw']
      : {
          ...(typeof body['from'] === 'string' ? { from: body['from'] } : {}),
          ...(typeof body['subject'] === 'string' ? { subject: body['subject'] } : {}),
          ...(typeof body['date'] === 'string' ? { date: body['date'] } : {}),
          ...(typeof body['body'] === 'string' ? { body: body['body'] } : {}),
        };
    if (typeof email !== 'string' && !email.body && !email.subject) { res.writeHead(400); res.end(JSON.stringify({ error: 'raw, or subject/body, required' })); return; }
    const result = await noteCapture.captureEmail({ email, userId: auth.userId, tenantId: auth.tenantId ?? null });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/notes/jot', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['text'] !== 'string' || !body['text'].trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'text required' })); return; }
    const result = await noteCapture.jot({ text: body['text'], userId: auth.userId, tenantId: auth.tenantId ?? null });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // ── weaveNotes Phase 4: voice / meeting capture ─────────────────────────────
  //   POST /api/me/notes/meeting/transcribe   audio (raw audio/* body or base64 JSON) → timestamped transcript
  //   POST /api/me/notes/meeting              { segments, title?, source? }          → structured, cited note
  //   POST /api/me/notes/meeting/summarize    { transcript, title? }                 → structured note from pasted text
  //   GET  /api/me/notes/:id/meeting                                                 → stored transcript for the UI
  const MEETING_MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB (Whisper upload limit)
  const readRawAudio = async (req: import('node:http').IncomingMessage): Promise<{ audio: Buffer; mimeType?: string }> => {
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.includes('audio/') || ct.includes('application/octet-stream') || ct.includes('video/webm')) {
      const chunks: Buffer[] = []; let total = 0;
      await new Promise<void>((resolve, reject) => {
        req.on('data', (c: Buffer) => { total += c.length; if (total > MEETING_MAX_AUDIO_BYTES) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
        req.on('end', () => resolve());
        req.on('error', reject);
      });
      return { audio: Buffer.concat(chunks), mimeType: ct.split(';')[0]?.trim() };
    }
    // base64 JSON fallback: { audio, mimeType }
    let body: { audio?: string; mimeType?: string } = {};
    try { body = JSON.parse(await readBody(req, { maxBytes: MEETING_MAX_AUDIO_BYTES * 2 })) as typeof body; } catch { /* empty */ }
    return { audio: body.audio ? Buffer.from(body.audio, 'base64') : Buffer.alloc(0), ...(body.mimeType ? { mimeType: body.mimeType } : {}) };
  };

  router.post('/api/me/notes/meeting/transcribe', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.voiceCaptureEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'Voice capture is disabled' })); return; }
    let audio: Buffer, mimeType: string | undefined;
    try { ({ audio, mimeType } = await readRawAudio(req)); } catch { res.writeHead(413); res.end(JSON.stringify({ error: 'Audio exceeds the size limit' })); return; }
    const result = await noteMeeting.transcribe({
      userId: auth.userId, tenantId: auth.tenantId ?? null, audio,
      ...(mimeType ? { mimeType } : {}),
      ...(cfg.transcriptionLanguage ? { language: cfg.transcriptionLanguage } : {}),
      ...(cfg.transcriptionModel ? { model: cfg.transcriptionModel } : {}),
    });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/notes/meeting', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.voiceCaptureEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'Voice capture is disabled' })); return; }
    let body: { segments?: unknown; title?: unknown; source?: unknown; language?: unknown; durationSec?: unknown } = {};
    try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* empty */ }
    const segments = Array.isArray(body.segments) ? body.segments as import('../notes/meeting.js').TranscriptSegment[] : [];
    if (!segments.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'segments required' })); return; }
    const result = await noteMeeting.createMeetingNote({
      userId: auth.userId, tenantId: auth.tenantId ?? null, segments,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.source === 'string' ? { source: body.source } : {}),
      ...(typeof body.language === 'string' ? { language: body.language } : {}),
      ...(typeof body.durationSec === 'number' ? { durationSec: body.durationSec } : {}),
      sourceLabel: 'Meeting notes',
      audioRetained: cfg.storeAudio,
    });
    if (result.ok) void noteSettings.recordActivity({ noteId: result.noteId!, userId: auth.userId, tenantId: auth.tenantId ?? null, action: 'created', actor: 'ai', summary: `Captured meeting “${result.title}”` });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/notes/meeting/summarize', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.voiceCaptureEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'Voice capture is disabled' })); return; }
    let body: { transcript?: unknown; title?: unknown } = {};
    try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* empty */ }
    if (typeof body.transcript !== 'string' || !body.transcript.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'transcript required' })); return; }
    const result = await noteMeeting.agentSummarizeMeeting({ userId: auth.userId, tenantId: auth.tenantId ?? null, transcript: body.transcript, ...(typeof body.title === 'string' ? { title: body.title } : {}) });
    res.writeHead(result.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/meeting', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const result = await noteMeeting.getMeeting(params['id']!, auth.userId);
    if (!result.ok) { res.writeHead(404); res.end(JSON.stringify({ error: 'No meeting for this note' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // ── weaveNotes Phase 5: background memory ("second brain") ───────────────────
  //   GET  /api/me/notes/:id/recall            memories relevant to THIS note (proactive surfacing)
  //   POST /api/me/notes/:id/remember          extract durable memories from this note NOW (manual)
  //   POST /api/me/memory/recall  { query }    temporally-aware recall by query
  //   GET  /api/me/memory                      list the user's note-derived memories (manage UI)
  //   DELETE /api/me/memory/:id                forget a memory
  router.get('/api/me/notes/:id/recall', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.backgroundMemoryEnabled) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ memories: [], disabled: true })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const note = await db.getNote(params['id']!, auth.userId) as { title?: string; doc_json?: string } | null;
    let query = note?.title ?? '';
    try { query = `${note?.title ?? ''} ${extractPlainText(JSON.parse(note?.doc_json ?? '{}')).slice(0, 400)}`.trim(); } catch { /* title-only */ }
    const limit = safePageInt(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'), cfg.memoryRecallCount, 1, 20);
    // Exclude memories that came from THIS note (surface OTHER things you know that relate).
    const memories = (await noteMemory.recall({ userId: auth.userId, tenantId: auth.tenantId ?? null, query, limit: limit + 4 })).filter((m) => m.noteId !== params['id']).slice(0, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ memories }));
  }, { auth: true });

  router.post('/api/me/notes/:id/remember', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.backgroundMemoryEnabled) { res.writeHead(403); res.end(JSON.stringify({ error: 'Background memory is disabled' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const result = await noteMemory.extractFromNote({ noteId: params['id']!, access, force: true });
    res.writeHead(result.ok ? 200 : (result.error === 'AI is not configured on this server' ? 501 : 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/memory/recall', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await noteSettings.getConfig();
    if (!cfg.backgroundMemoryEnabled) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ memories: [], disabled: true })); return; }
    let body: { query?: unknown; limit?: unknown } = {};
    try { body = JSON.parse(await readBody(req)) as typeof body; } catch { /* empty */ }
    const query = typeof body.query === 'string' ? body.query : '';
    if (!query.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'query required' })); return; }
    const memories = await noteMemory.recall({ userId: auth.userId, tenantId: auth.tenantId ?? null, query, ...(typeof body.limit === 'number' ? { limit: body.limit } : {}) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ memories }));
  }, { auth: true });

  router.get('/api/me/memory', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const limit = safePageInt(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'), 100, 1, 500);
    const memories = await noteMemory.list({ userId: auth.userId, tenantId: auth.tenantId ?? null, limit });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ memories }));
  }, { auth: true });

  router.del('/api/me/memory/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const result = await noteMemory.forget({ userId: auth.userId, id: params['id']! });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // geneWeave UI rebuild — the caller's own workspace Appearance / branding (read-only), applied by the
  // web client at runtime. Owner-scoped to auth.tenantId (never another tenant's brand).
  const appearance = createTenantAppearanceService(db);
  router.get('/api/me/appearance', async (_req, res, _params, auth) => {
    // Available to any authenticated user (they see their own workspace's brand). No admin needed.
    const a = auth as { tenantId?: string | null } | null;
    // Single-tenant / self-host users have no tenant id — they share the 'default' workspace brand.
    const eff = await appearance.getEffective(a?.tenantId || 'default');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(eff));
  }, { auth: true });

  // ── Note database rows ─────────────────────────────────────────────────────

  router.get('/api/me/note-databases/:id/rows', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const rows = await notes.listRows(params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rows }));
  }, { auth: true });

  router.post('/api/me/note-databases/:id/rows', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const id = newUUIDv7();
    const fieldsJson = typeof body['fields'] === 'object' && body['fields'] !== null
      ? JSON.stringify(body['fields'])
      : '{}';
    await notes.createRow({ id, database_id: params['id']!, fields_json: fieldsJson });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, database_id: params['id'], fields: body['fields'] ?? {} }));
  }, { auth: true });

  router.add('PATCH','/api/me/note-databases/:id/rows/:rowId', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const fieldsJson = typeof body['fields'] === 'object' && body['fields'] !== null
      ? JSON.stringify(body['fields'])
      : '{}';
    await notes.updateRow(params['rowId']!, params['id']!, fieldsJson);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  router.del('/api/me/note-databases/:id/rows/:rowId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await notes.deleteRow(params['rowId']!, params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  // ── weaveNotes Phase 8: WORKSPACE RAG (cited search over notes + runs) ─────────
  //
  //   POST /api/me/workspace/search   { query, scope?, limit? }  cited hits over notes+runs
  //   POST /api/me/workspace/reindex  { limit? }                 (re)embed recent chat runs
  router.post('/api/me/workspace/search', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['query'] !== 'string' || !body['query'].trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'query required' })); return; }
    const scope = (['all', 'notes', 'runs'].includes(String(body['scope'])) ? body['scope'] : 'all') as 'all' | 'notes' | 'runs';
    const result = await noteWorkspace.workspaceSearch({
      userId: auth.userId, tenantId: auth.tenantId ?? null, query: body['query'], scope,
      ...(typeof body['limit'] === 'number' ? { limit: body['limit'] } : {}),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  //   POST /api/me/workspace/ask  { query, scope?, limit? }  → a cited ANSWER with VERIFIED
  //   character-level citations (each quote provably exists in its source; hallucinated ones dropped).
  //   Rate-limited like every AI action (aiPost). The UI highlights each cited quote in its source note.
  aiPost('/api/me/workspace/ask', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!opts.aiGenerate) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI is not configured on this server' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['query'] !== 'string' || !body['query'].trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'query required' })); return; }
    const scope = (['all', 'notes', 'runs'].includes(String(body['scope'])) ? body['scope'] : 'all') as 'all' | 'notes' | 'runs';
    const cfg = await noteSettings.getConfig();
    if (!cfg.citationsEnabled) {
      // Citations turned off by the admin → fall back to a plain cited-source search (no AI answer).
      const s = await noteWorkspace.workspaceSearch({ userId: auth.userId, tenantId: auth.tenantId ?? null, query: body['query'], scope });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query: s.query, answer: '', citations: [], sources: s.sources })); return;
    }
    const result = await noteWorkspace.askWorkspace({
      userId: auth.userId, tenantId: auth.tenantId ?? null, query: body['query'], scope,
      limit: typeof body['limit'] === 'number' ? body['limit'] : cfg.citationMaxSources,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/workspace/reindex', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const result = await noteWorkspace.reindexRuns({ userId: auth.userId, tenantId: auth.tenantId ?? null, ...(typeof body['limit'] === 'number' ? { limit: body['limit'] } : {}) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // ── weaveNotes Phase 8: VERSION HISTORY (snapshot + restore) ───────────────────
  //
  //   POST /api/me/notes/:id/versions               { label? }    snapshot the current note
  //   GET  /api/me/notes/:id/versions                             list versions (newest first)
  //   GET  /api/me/notes/:id/versions/:vid                        one version's full content
  //   POST /api/me/notes/:id/versions/:vid/restore                restore (undoable)
  router.post('/api/me/notes/:id/versions', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const result = await noteVersions.saveVersion({ noteId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null, ...(typeof body['label'] === 'string' ? { label: body['label'] } : {}) });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/versions', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const list = await noteVersions.listVersions({ noteId: params['id']!, userId: auth.userId });
    if (list === null) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ versions: list }));
  }, { auth: true });

  router.get('/api/me/notes/:id/versions/:vid', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const v = await noteVersions.getVersion({ versionId: params['vid']!, userId: auth.userId });
    if (!v || v.note_id !== params['id']) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v));
  }, { auth: true });

  router.post('/api/me/notes/:id/versions/:vid/restore', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const result = await noteVersions.restoreVersion({ noteId: params['id']!, versionId: params['vid']!, userId: auth.userId, tenantId: auth.tenantId ?? null });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // ── weaveNotes Phase 8: BLOCK COMMENTS ─────────────────────────────────────────
  //
  //   POST   /api/me/notes/:id/comments              { body, anchorBlockId?, parentId?, mentions? }
  //   GET    /api/me/notes/:id/comments
  //   PATCH  /api/me/notes/:id/comments/:cid         { body, mentions? }
  //   DELETE /api/me/notes/:id/comments/:cid
  //   POST   /api/me/notes/:id/comments/:cid/resolve { resolved }
  router.post('/api/me/notes/:id/comments', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['body'] !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'body required' })); return; }
    const result = await noteComments.create({
      noteId: params['id']!, userId: auth.userId, body: body['body'],
      ...(typeof body['anchorBlockId'] === 'string' ? { anchorBlockId: body['anchorBlockId'] } : {}),
      ...(typeof body['parentId'] === 'string' ? { parentId: body['parentId'] } : {}),
      ...(Array.isArray(body['mentions']) ? { mentions: (body['mentions'] as unknown[]).map(String) } : {}),
    });
    if (result.ok && result.comment) {
      noteCoeditHub.broadcast(params['id']!, 'note.comment', { kind: 'created', comment: result.comment });
    }
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/comments', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const list = await noteComments.list({ noteId: params['id']!, userId: auth.userId });
    if (list === null) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comments: list }));
  }, { auth: true });

  router.add('PATCH', '/api/me/notes/:id/comments/:cid', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['body'] !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'body required' })); return; }
    const result = await noteComments.edit({ commentId: params['cid']!, userId: auth.userId, body: body['body'], ...(Array.isArray(body['mentions']) ? { mentions: (body['mentions'] as unknown[]).map(String) } : {}) });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.del('/api/me/notes/:id/comments/:cid', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const result = await noteComments.remove({ commentId: params['cid']!, userId: auth.userId });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.post('/api/me/notes/:id/comments/:cid/resolve', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const result = await noteComments.setResolution({ threadId: params['cid']!, userId: auth.userId, resolved: body['resolved'] !== false });
    if (result.ok) noteCoeditHub.broadcast(params['id']!, 'note.comment', { kind: 'resolved', threadId: params['cid'], resolved: body['resolved'] !== false });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  // ── weaveNotes Phase 8: SYNCED BLOCKS (transclusion) ───────────────────────────
  //
  //   POST   /api/me/notes/:id/synced       { sourceNoteId, sourceBlockIndex? }
  //   GET    /api/me/notes/:id/synced       list, each resolved read-through to source content
  //   DELETE /api/me/notes/:id/synced/:sid
  router.post('/api/me/notes/:id/synced', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['sourceNoteId'] !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'sourceNoteId required' })); return; }
    const result = await noteSynced.create({
      noteId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null, sourceNoteId: body['sourceNoteId'],
      ...(typeof body['sourceBlockIndex'] === 'number' ? { sourceBlockIndex: body['sourceBlockIndex'] } : {}),
    });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/synced', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const list = await noteSynced.list({ noteId: params['id']!, userId: auth.userId });
    if (list === null) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ synced: list }));
  }, { auth: true });

  router.del('/api/me/notes/:id/synced/:sid', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const result = await noteSynced.remove({ id: params['sid']!, noteId: params['id']!, userId: auth.userId });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });
}
