// SPDX-License-Identifier: MIT
/**
 * geneWeave note AI CREATIVE service (weaveNotes Phase 4) — the AI draws ink + diagrams.
 *
 * Phase 2 let the AI colour a note; Phase 3 made it a live participant. Phase 4 lets it CREATE
 * visual content: a colour-coded diagram of a process, or real freehand ink (an underline, an
 * arrow, a circled word). Crucially the output is NATIVE + EDITABLE — the AI emits the SAME
 * stroke/scene data a human's pen or shape tool produces (validated by `@weaveintel/notes`), not
 * a flat picture — so "the AI drew this" and "I drew this" are the same kind of object afterward.
 *
 * Every creation rides the existing rails: it is staged as a track-changes SUGGESTION the human
 * accepts or rejects (mirroring `insertAiBlock` / `colorizeSemantic`), it shows the AI as a live
 * participant while it works (Phase 3), and the rendered SVG is mirrored to an ARTIFACT for export
 * / thumbnails / OCR. Colours come from the pre-validated WCAG-AA palette, so a diagram is always
 * legible.
 */
import { BlockDoc, type BlockOp } from '@weaveintel/collab';
import {
  inkFromPrimitives, strokesToSvg, validateStrokes, recolorStrokes, type InkStroke,
  buildImageProvenance, embedXmpInSvg, type ImageProvenance,
} from '@weaveintel/notes';
import { validateDiagramScene, diagramToSvg, type DiagramScene } from '@weaveintel/geneweave-ui/notes';
// weaveNotes product modules moved app-side (Phase 2f):
import { type WeaveNotesConfig } from './notes/notes-config.js';
import { sanitizeSvg, svgToDataUri } from './notes/svg.js';
import {
  type ImageResult, type LicenseId, DEFAULT_ALLOWED_LICENSES, LICENSE_LABELS, rankImageResults, buildAttribution,
  normalizeLanguage, languageName, applyLanguagePreference,
  buildOpenverseUrl, buildWikimediaUrl, buildUnsplashUrl, buildPexelsUrl, buildPixabayUrl,
  parseOpenverse, parseWikimedia, parseUnsplash, parsePexels, parsePixabay,
} from './notes/image-search.js';
import {
  buildDiagramJudge, parseDiagramVerdict, diagramRegenFeedback, diagramAccept, VERIFY_EARLY_STOP_DELTA,
  buildImageVerify, parseImageVerdict, imageAccept, type DiagramVerdict, type ImageVerdict,
} from './notes/visual-verify.js';
import { makeFence, fenceUntrusted, spotlightPreamble } from '@weaveintel/guardrails/spotlighting';
import { newUUIDv7, weaveContext, hardenedFetch, type ModelRequest } from '@weaveintel/core';
import { roleAtLeast } from '@weaveintel/collab';
import { getOrCreateModel, type ChatEngineConfig } from './chat-runtime.js';
import { createNoteCoeditRepo, resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { isSafePublicUrl } from './note-capture-sql.js';
import { noteCoeditHub } from './note-coedit-hub.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { withAiPresence } from './note-ai-presence.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

type NoteCreativeDb = DatabaseAdapter;

// [PERF][P2] Process-local cache for find_image query derivation (skips an LLM call on a re-clip of
// the same selection). Size-capped + TTL'd so it can't grow unbounded or serve stale results.
const IMAGE_QUERY_TTL_MS = 10 * 60 * 1000;
const IMAGE_QUERY_CACHE_MAX = 300;
const imageQueryCache = new Map<string, { queries: string[]; at: number }>();
function cacheImageQueries(key: string, queries: string[]): void {
  if (imageQueryCache.size >= IMAGE_QUERY_CACHE_MAX) { const oldest = imageQueryCache.keys().next().value; if (oldest !== undefined) imageQueryCache.delete(oldest); }
  imageQueryCache.set(key, { queries, at: Date.now() });
}

/** Generate a raster image from a prompt; returns base64 PNG (no data-uri prefix) or null. */
export type NoteImageGenerate = (opts: { prompt: string; model?: string; size?: string; userId?: string; tenantId?: string | null }) => Promise<string | null>;
/** Phase 1: a MULTIMODAL model call — sends an image (base64) + a text prompt to a vision model and
 *  returns its text reply. Used to verify a found/generated image actually depicts the subject. */
export type NoteVisionVerify = (opts: { system: string; user: string; base64: string; mimeType: string; userId?: string; tenantId?: string | null }) => Promise<string>;

export type VisualKind = 'auto' | 'diagram' | 'ink' | 'illustration' | 'image';

export interface CreativeResult { ok: boolean; error?: string; suggestionId?: string; preview?: string; action?: string; artifactId?: string | null; kind?: string }

function creativeSite(noteId: string, tag: string): string { return `agent:${noteId.slice(0, 8)}:${tag}:${newUUIDv7().slice(0, 8)}`; }

/** Best-effort JSON extraction from a model reply (handles ```json fences + prose). */
function extractJson(raw: string, kind: 'object' | 'array'): unknown {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const open = kind === 'array' ? '[' : '{'; const close = kind === 'array' ? ']' : '}';
  const start = t.indexOf(open); const end = t.lastIndexOf(close);
  if (start === -1 || end <= start) return kind === 'array' ? [] : {};
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return kind === 'array' ? [] : {}; }
}

export function createNoteCreativeService(db: NoteCreativeDb, generate: NoteAiGenerate, opts: { now?: () => number; generateImage?: NoteImageGenerate; verifyVision?: NoteVisionVerify } = {}) {
  const now = opts.now ?? (() => Date.now());
  const relay = createNoteCoeditRepo(db, { now });
  const settings = createNoteSettingsService(db);
  const cfg = (): Promise<WeaveNotesConfig> => settings.getConfig();

  async function seedFor(noteId: string, ownerId: string): Promise<unknown> {
    const note = await db.getNote(noteId, ownerId) as { doc_json?: string } | null;
    if (!note?.doc_json) return { type: 'doc', content: [] };
    try { return JSON.parse(note.doc_json); } catch { return { type: 'doc', content: [] }; }
  }

  /** Mirror a rendered SVG to an artifact (for export / thumbnail / OCR). Best-effort. */
  async function mirrorArtifact(noteId: string, access: NoteAccess, kind: string, name: string, svg: string, meta: Record<string, unknown>): Promise<string | null> {
    if (!db.saveArtifact) return null;
    try {
      const art = await db.saveArtifact({
        name, type: kind, mimeType: 'image/svg+xml', data: svg, scope: 'user',
        userId: access.ownerId, ...(access.tenantId ? { tenantId: access.tenantId } : {}),
        tags: ['note', 'creative', kind], metadata: { source: 'note', noteId, kind, ...meta },
      });
      return art.id;
    } catch { return null; }
  }

  type CreativeAction = 'create_diagram' | 'draw_ink' | 'create_illustration' | 'generate_image' | 'find_image';

  /**
   * Ask the model WHERE a new block belongs, so a diagram/drawing/image is placed next to the most
   * related content instead of always at the end. Returns the block id to insert AFTER, or null (=end).
   * One cheap, focused call over the note's OUTLINE (it never sees raw block ids, only an index).
   */
  async function pickAnchorAfter(blocks: ReturnType<BlockDoc['blocks']>, description: string, access: NoteAccess): Promise<unknown | null> {
    const items = blocks.map((b, i) => ({ i, b })).filter(({ b }) => (b.text && b.text.trim()) || b.type.startsWith('heading'));
    if (items.length < 2) return null; // nothing meaningful to anchor to → end
    const outline = items.map(({ i, b }) => `${i}: [${b.type}] ${(b.text || '').replace(/\s+/g, ' ').slice(0, 70)}`).join('\n');
    try {
      const reply = await generate({
        system: 'You place new content in a note. Reply with ONLY a single number (an index from the outline) or the word END — nothing else.',
        user: `Note outline (index: [type] "text"):\n${outline}\n\nWe are inserting: ${description}\nAfter which numbered line should it go so it sits with the most related content? Reply ONLY the number, or END for the very end.`,
        userId: access.ownerId, tenantId: access.tenantId, temperature: 0, maxTokens: 6,
      });
      if (/end/i.test(reply)) return null;
      const m = reply.match(/\d+/);
      if (!m) return null;
      const idx = parseInt(m[0], 10);
      return (idx >= 0 && idx < blocks.length) ? blocks[idx]!.id : null;
    } catch { return null; }
  }

  /** Insert a new creative atom as a STAGED suggestion; mirror its SVG (or use a pre-saved artifact).
   *  `placeDescription` (when given) lets the AI choose WHERE to insert it instead of appending. */
  async function stageInsert(noteId: string, access: NoteAccess, action: CreativeAction, blockType: 'diagram' | 'inkCanvas' | 'image', attrs: Record<string, unknown>, preview: string, mirror: { svg?: string; artifactId?: string | null } = {}, placeDescription?: string): Promise<CreativeResult> {
    const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
    const site = creativeSite(noteId, action);
    const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
    const blocks = shadow.blocks();
    let after = blocks.length ? blocks[blocks.length - 1]!.id : null;
    if (placeDescription) { const anchored = await pickAnchorAfter(blocks, placeDescription, access); if (anchored) after = anchored as typeof after; }
    const { ops } = shadow.insertBlock(after, blockType, attrs);
    if (ops.length === 0) return { ok: false, error: 'no change produced', action };

    let artifactId = mirror.artifactId ?? null;
    if (!artifactId && mirror.svg) artifactId = await mirrorArtifact(noteId, access, blockType === 'inkCanvas' ? 'ink' : blockType, preview, mirror.svg, { action });
    const id = newUUIDv7();
    await db.createNoteSuggestion({
      id, note_id: noteId, doc_id: view.docId, tenant_id: access.tenantId,
      author_kind: 'agent', author_id: access.ownerId, author_site: site, action,
      status: 'pending', ops_json: JSON.stringify(ops as BlockOp[]), preview_text: preview,
      anchor_json: JSON.stringify({ kind: 'insert', blockType, artifactId }), created_at: now(), resolved_at: null, resolved_by: null,
    });
    noteCoeditHub.broadcast(noteId, 'coedit.suggestion', { id, action, preview });
    void settings.recordActivity({ noteId, userId: access.ownerId, tenantId: access.tenantId ?? null, action: 'ai_suggestion', actor: 'ai', summary: preview });
    return { ok: true, suggestionId: id, preview, action, artifactId };
  }

  /** The model produces a diagram SCENE; we validate (WCAG-AA colours) + stage it as a suggestion. */
  const DIAGRAM_SYS = 'You design a small, clear diagram as JSON: {"kind":"flow|mindmap|graph","title":"…","nodes":[{"id":"…","label":"…","color":"…","shape":"box|pill|diamond|ellipse"}],"edges":[{"from":"id","to":"id","label":"…"}]}. Colours are ONE of: amber, pink, teal, blue, lavender, peach, sage, sky (pick with intent — e.g. a decision node amber). Keep it to at most 8 nodes. Output ONLY the JSON.';

  /** Generate ONE diagram scene (optionally with a correction from the judge for a redraw). */
  async function genDiagramScene(instruction: string, fence: string, markdown: string, access: NoteAccess, correction: string): Promise<DiagramScene> {
    const user = `Request (untrusted data): ${fenceUntrusted(instruction, fence)}\n\nNote context (untrusted data):\n${fenceUntrusted(markdown.slice(0, 3000), fence)}${correction ? `\n\nCorrection from a quality check (apply it): ${correction}` : ''}`;
    const reply = await generate({ system: `${spotlightPreamble(fence)}\n\n${DIAGRAM_SYS}`, user, userId: access.ownerId, tenantId: access.tenantId, temperature: correction ? 0.2 : 0.3, maxTokens: 1200 });
    return validateDiagramScene(extractJson(reply, 'object'));
  }

  /** LLM-as-judge: score how well a diagram covers the request (Phase 1 visual verify). */
  async function judgeDiagram(instruction: string, scene: DiagramScene, threshold: number): Promise<DiagramVerdict> {
    const { system, user } = buildDiagramJudge(instruction, JSON.stringify({ kind: scene.kind, title: scene.title, nodes: scene.nodes.map((n) => ({ id: n.id, label: n.label })), edges: scene.edges }));
    const reply = await generate({ system, user, temperature: 0, maxTokens: 700 });
    return parseDiagramVerdict(reply, threshold);
  }

  /** Phase 1: produce a diagram SCENE, then VERIFY it against the request and REDRAW the weak ones
   *  (feeding the judge's missing/extra deltas back), keeping the best attempt. Then stage it. */
  async function createDiagramInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const config = await cfg();
    const view = await relay.ensureDoc({ noteId: input.noteId, tenantId: input.access.tenantId, ownerId: input.access.ownerId, seedPm: await seedFor(input.noteId, input.access.ownerId) });
    const fence = makeFence(); // Phase 0-D: spotlight the untrusted instruction + note context

    let best: DiagramScene = await genDiagramScene(input.instruction, fence, view.markdown, input.access, '');
    if (best.nodes.length === 0) return { ok: false, error: 'the model produced no diagram', action: 'create_diagram' };

    let bestVerdict: DiagramVerdict | null = null;
    if (config.visualVerifyEnabled) {
      const threshold = config.visualVerifyThreshold;
      let verdict = await judgeDiagram(input.instruction, best, threshold);
      bestVerdict = verdict;
      noteCoeditHub.broadcast(input.noteId, 'coedit.ai.progress', { action: 'create_diagram', stage: 'verifying', score: verdict.overall });
      for (let attempt = 1; attempt <= config.visualVerifyMaxRetries && !diagramAccept(verdict, threshold); attempt++) {
        noteCoeditHub.broadcast(input.noteId, 'coedit.ai.progress', { action: 'create_diagram', stage: 'redrawing', attempt, score: verdict.overall });
        const redraw = await genDiagramScene(input.instruction, fence, view.markdown, input.access, diagramRegenFeedback(verdict));
        if (redraw.nodes.length === 0) break; // model abstained (e.g. an anatomy request is not a diagram)
        const v2 = await judgeDiagram(input.instruction, redraw, threshold);
        if (v2.overall > bestVerdict.overall) { best = redraw; bestVerdict = v2; } // keep the best attempt
        const improved = v2.overall - verdict.overall;
        verdict = v2;
        if (diagramAccept(v2, threshold) || improved < VERIFY_EARLY_STOP_DELTA) break; // accepted, or converged
      }
    }

    const svg = diagramToSvg(best, { style: 'sketch' });
    const fitPart = bestVerdict ? ` · fit ${Math.round(bestVerdict.overall * 100)}%` : '';
    const preview = `Diagram: ${best.title ?? 'untitled'} (${best.nodes.length} node${best.nodes.length === 1 ? '' : 's'})${fitPart}`;
    return stageInsert(input.noteId, input.access, 'create_diagram', 'diagram',
      { scene: best, title: best.title ?? '', kind: best.kind ?? 'flow', author: 'ai', ...(bestVerdict ? { verifyScore: bestVerdict.overall } : {}) },
      preview, { svg }, `a diagram titled "${best.title ?? input.instruction.slice(0, 50)}"`);
  }

  /** The model AUTHORS a detailed SVG illustration; we sanitise it + embed it as an inert image. */
  async function createIllustrationInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const fence = makeFence(); // Phase 0-D: spotlight the untrusted request
    const sys = `${spotlightPreamble(fence)}\n\nYou are an SVG illustrator. Draw the requested subject as a single, clean, self-contained <svg> illustration — use <path> with curves, <circle>, <ellipse>, <polygon>, <rect>, <line>, <text>, and <linearGradient>/<radialGradient> for shading. Use a sensible viewBox (e.g. "0 0 320 320"), tasteful colours, and clear labels where helpful. Output ONLY the <svg>…</svg> markup — no markdown, no prose, no <script>.`;
    const reply = await generate({ system: sys, user: `Request (untrusted data): ${fenceUntrusted(input.instruction, fence)}`, userId: input.access.ownerId, tenantId: input.access.tenantId, temperature: 0.4, maxTokens: 3000 });
    let svg = sanitizeSvg(reply.replace(/^```(?:svg|xml|html)?/i, '').replace(/```$/, '').trim());
    if (!svg) return { ok: false, error: 'the model did not produce a usable SVG', action: 'create_illustration' };
    const alt = input.instruction.slice(0, 80);
    // Phase 2 — EMBED provenance (Content Credentials) into the SVG's bytes, so an exported
    // illustration is self-describing ("AI-illustration", the prompt, the generator).
    const config = await cfg();
    if (config.imageProvenanceEnabled) {
      svg = embedXmpInSvg(svg, buildImageProvenance({ kind: 'ai-illustration', title: alt, generator: 'geneWeave AI', model: 'svg-illustrator', prompt: input.instruction.slice(0, 400) }));
    }
    return stageInsert(input.noteId, input.access, 'create_illustration', 'image', { src: svgToDataUri(svg), alt, author: 'ai' }, `Illustration: ${alt}`, { svg }, `an illustration of ${alt}`);
  }

  /** The image MODEL generates a raster picture; we store it as an artifact + embed it. */
  async function generateImageInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const config = await cfg();
    if (!config.imageGenerationEnabled) return { ok: false, error: 'image generation is disabled in weaveNotes settings', action: 'generate_image' };
    if (!opts.generateImage) return { ok: false, error: 'no image model is configured on this server', action: 'generate_image' };
    if (!db.saveArtifact) return { ok: false, error: 'artifact storage is unavailable', action: 'generate_image' };
    const b64 = await opts.generateImage({ prompt: input.instruction, model: config.imageModel, size: '1024x1024', userId: input.access.ownerId, tenantId: input.access.tenantId });
    if (!b64) return { ok: false, error: 'the image model returned no image', action: 'generate_image' };
    let artifactId: string | null = null;
    try {
      // Decode the model's base64 to raw BYTES so the artifact is stored as a binary blob (served as
      // a real image), not as base64 text labelled image/png (which renders broken).
      // Phase 2 — store the AI-generation provenance (Content Credentials) WITH the asset.
      const provenance: ImageProvenance | undefined = config.imageProvenanceEnabled
        ? buildImageProvenance({ kind: 'ai-generated', title: input.instruction.slice(0, 80), generator: 'geneWeave AI', model: config.imageModel, prompt: input.instruction.slice(0, 400) })
        : undefined;
      const art = await db.saveArtifact({ name: input.instruction.slice(0, 80) || 'image', type: 'image', mimeType: 'image/png', data: Buffer.from(b64, 'base64'), scope: 'user', userId: input.access.ownerId, ...(input.access.tenantId ? { tenantId: input.access.tenantId } : {}), tags: ['note', 'creative', 'image'], metadata: { source: 'note', noteId: input.noteId, kind: 'image', model: config.imageModel, ...(provenance ? { provenance } : {}) } });
      artifactId = art.id;
    } catch { return { ok: false, error: 'could not store the generated image', action: 'generate_image' }; }
    const alt = input.instruction.slice(0, 80);
    return stageInsert(input.noteId, input.access, 'generate_image', 'image', { src: `/api/artifacts/${artifactId}/data`, alt, author: 'ai' }, `Image: ${alt}`, { artifactId }, `an image of ${alt}`);
  }

  // ── Free-to-use IMAGE SEARCH ─────────────────────────────────────────────────────────────────
  // Search a free-image provider through the HARDENED (SSRF-guarded) fetch, then download the chosen
  // image — again through the hardened fetch — store it as an artifact, and insert it WITH attribution.

  /** Hardened JSON GET for a provider's search API (SSRF guard + HTTPS + timeout + size cap). */
  async function searchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
    const res = await hardenedFetch(url, { headers: { 'User-Agent': 'weaveintel-notes/1.0', ...(headers ?? {}) } }, { errorTag: 'note-image-search', timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 });
    if (!res.ok) throw new Error(`provider returned ${res.status}`);
    return res.json();
  }

  /** Query ONE provider → normalised results. Keyed providers return [] when no key is configured. */
  async function searchOne(provider: string, query: string): Promise<ImageResult[]> {
    switch (provider) {
      case 'openverse': return parseOpenverse(await searchJson(buildOpenverseUrl(query)));
      case 'wikimedia': return parseWikimedia(await searchJson(buildWikimediaUrl(query)));
      case 'unsplash': { const k = process.env['UNSPLASH_ACCESS_KEY']; return k ? parseUnsplash(await searchJson(buildUnsplashUrl(query), { Authorization: `Client-ID ${k}` })) : []; }
      case 'pexels': { const k = process.env['PEXELS_API_KEY']; return k ? parsePexels(await searchJson(buildPexelsUrl(query), { Authorization: k })) : []; }
      case 'pixabay': { const k = process.env['PIXABAY_API_KEY']; return k ? parsePixabay(await searchJson(buildPixabayUrl(query, k))) : []; }
      default: return [];
    }
  }

  /** Search the configured provider; if it yields no allowed result, fall back to the no-key ones. */
  async function searchProviders(provider: string, query: string, allowed: LicenseId[]): Promise<ImageResult[]> {
    let primary: ImageResult[] = [];
    try { primary = await searchOne(provider, query); } catch { primary = []; }
    if (rankImageResults(primary, allowed).length > 0) return primary;
    for (const fb of ['openverse', 'wikimedia']) {
      if (fb === provider) continue;
      try { const r = await searchOne(fb, query); if (rankImageResults(r, allowed).length > 0) return r; } catch { /* try next */ }
    }
    return primary;
  }

  /** Download the chosen image through the hardened fetch; validate it is really an image, capped.
   *  Returns the raw BYTES (a Buffer → stored as a binary artifact blob, not base64 text). */
  async function downloadImage(url: string): Promise<{ bytes: Buffer; mime: string }> {
    if (!isSafePublicUrl(url)) throw new Error('unsafe image URL'); // defence-in-depth (hardenedFetch also blocks)
    const res = await hardenedFetch(url, { headers: { 'User-Agent': 'weaveintel-notes/1.0' } }, { errorTag: 'note-image-fetch', timeoutMs: 20000, maxBytes: 12 * 1024 * 1024 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!mime.startsWith('image/')) throw new Error(`not an image (${mime || 'unknown type'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('empty image');
    return { bytes: buf, mime };
  }

  /** Turn the user's text (a short request OR a long selection) + the note context into 1–3 SHORT,
   *  focused image-search queries — best first. Summarises a long selection into search terms and
   *  offers a couple of variants to try, so we don't just search the raw paragraph. */
  async function deriveImageQueries(rawText: string, docContext: string, language: string): Promise<string[]> {
    const text = rawText.trim().slice(0, 4000);
    const fallback = text.split(/\s+/).slice(0, 8).join(' ').slice(0, 80) || text.slice(0, 80);
    const lang = languageName(language);
    // [PERF] Cache the query-derivation LLM call by (text+context+language) — a repeated find_image on
    // the same selection skips this round-trip entirely (TTL + size-capped, process-local).
    const ck = `${language} ${text.slice(0, 240)} ${docContext.slice(0, 240)}`;
    const cached = imageQueryCache.get(ck);
    if (cached && cached.at > Date.now() - IMAGE_QUERY_TTL_MS) return cached.queries;
    try {
      const reply = await generate({
        system: `You turn a request for a picture (which may be a long passage the user selected) into SHORT web image-search queries IN ${lang}. Output ONLY a JSON array of 1-3 strings, BEST first, each 2-6 plain ${lang} words, concrete and visual — no punctuation, no quotes, no commentary.`,
        user: `The user wants an image (with any labels in ${lang}) related to this text:\n"""${text}"""\n\nNote context (for disambiguation):\n${docContext.slice(0, 1500)}\n\nGive 1-3 short ${lang} image-search queries.`,
        temperature: 0.3, maxTokens: 120,
      });
      const arr = extractJson(reply, 'array');
      const queries = Array.isArray(arr) ? [...new Set(arr.map((s) => String(s).trim().replace(/^["']|["']$/g, '')).filter((s) => s.length > 1).slice(0, 3))] : [];
      if (queries.length) { cacheImageQueries(ck, queries); return queries; }
    } catch { /* fall through to the heuristic */ }
    return [fallback];
  }

  /** Order the candidate images BEST-first by how well they fit the request + the note context. The
   *  model sees each candidate's title / creator / licence / provider — a context-aware pick over a
   *  few options, not "whatever came first". Returns indices into `candidates`. */
  async function rankCandidatesByContext(candidates: ImageResult[], want: string, docContext: string, language: string): Promise<number[]> {
    const natural = candidates.map((_, i) => i);
    if (candidates.length <= 1) return natural;
    const lang = languageName(language);
    const list = candidates.map((c, i) => `${i}: "${(c.title || 'untitled').slice(0, 80)}" — ${LICENSE_LABELS[c.license]} via ${c.provider}${c.creator ? ` by ${String(c.creator).slice(0, 40)}` : ''}`).join('\n');
    try {
      const reply = await generate({
        system: `You pick the most suitable image for a note. Reply with ONLY a JSON array of the candidate numbers, BEST match first. Judge by how well each title fits what is wanted AND the note context — prefer clear, accurate, on-topic, appropriate images. Strongly PREFER images whose labels/text are in ${lang}, and deprioritise any clearly in another language. List the strong candidates (you may omit obviously irrelevant ones).`,
        user: `Wanted: an image (with labels in ${lang}) of "${want.slice(0, 200)}".\nNote context:\n${docContext.slice(0, 1200)}\n\nCandidates:\n${list}\n\nOrder them best-first (numbers only).`,
        temperature: 0, maxTokens: 120,
      });
      const arr = extractJson(reply, 'array');
      const order = Array.isArray(arr) ? arr.map((n) => parseInt(String(n), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < candidates.length) : [];
      const seen = new Set(order);
      for (const i of natural) if (!seen.has(i)) order.push(i); // keep any the model dropped, as fallbacks
      if (order.length) return order;
    } catch { /* fall through to natural order */ }
    return natural;
  }

  /** Source a REAL, free-to-use image from the web (with attribution) and stage it as a suggestion.
   *  Goes through a few tries to identify the RIGHT image: it summarises the request into focused
   *  queries, gathers several candidates across them, lets the model pick the best by the document
   *  context, then downloads in that order (falling through on a dead/blocked URL). */
  async function findImageInner(input: { noteId: string; access: NoteAccess; query: string; language?: string }): Promise<CreativeResult> {
    const config = await cfg();
    if (!config.imageSearchEnabled) return { ok: false, error: 'web image search is disabled in weaveNotes settings', action: 'find_image' };
    if (!db.saveArtifact) return { ok: false, error: 'artifact storage is unavailable', action: 'find_image' };
    const rawText = input.query.trim();
    if (!rawText) return { ok: false, error: 'no search query', action: 'find_image' };
    const allowed = (config.imageSearchAllowedLicenses?.length ? config.imageSearchAllowedLicenses : DEFAULT_ALLOWED_LICENSES) as LicenseId[];
    const language = normalizeLanguage(input.language); // the user's preferred image-label language (default 'en')

    // The note's text — used to summarise the request AND to judge which candidate fits the document.
    const view = await relay.ensureDoc({ noteId: input.noteId, tenantId: input.access.tenantId, ownerId: input.access.ownerId, seedPm: await seedFor(input.noteId, input.access.ownerId) });
    const docContext = view.markdown ?? '';

    // 1) Focused queries (summarise a long selection + a couple of variants), written in the language.
    const queries = await deriveImageQueries(rawText, docContext, language);

    // 2) Gather candidates across the queries (dedupe by URL; only allowed "free to use" licences).
    let candidates: ImageResult[] = [];
    for (const q of queries) {
      let res: ImageResult[] = [];
      try { res = await searchProviders(config.imageSearchProvider, q, allowed); } catch { /* try next query */ }
      for (const r of rankImageResults(res, allowed)) { if (!candidates.some((c) => c.url === r.url)) candidates.push(r); }
      if (candidates.length >= 12) break;
    }
    if (candidates.length === 0) return { ok: false, error: `no free-to-use image found for "${queries[0]}"`, action: 'find_image' };

    // Sink clearly-other-language titles (e.g. a "…-fr.svg" diagram) below same/neutral-language ones.
    candidates = applyLanguagePreference(candidates, language);

    // 3) Context-aware ranking: the model orders the candidates by fit to the request, note + language.
    const order = await rankCandidatesByContext(candidates, rawText.slice(0, 200), docContext, language);

    // 4) Download in rank order — a few tries — and (Phase 1) VISION-VERIFY each: a vision model
    //    LOOKS at the image and confirms it actually depicts the subject (good quality + safe) before
    //    we use it. Reject + try the next candidate otherwise. Better NO image than a WRONG image.
    const wantVerify = config.imageVerifyEnabled && !!opts.verifyVision;
    const subject = (queries[0] ?? rawText).slice(0, 200);
    let pick: ImageResult | null = null; let payload: { bytes: Buffer; mime: string } | null = null; let lastErr = ''; let verdict: ImageVerdict | null = null;
    let rejected = 0;
    for (const idx of order.slice(0, 5)) {
      const cand = candidates[idx]; if (!cand) continue;
      let p: { bytes: Buffer; mime: string };
      try { p = await downloadImage(cand.url); } catch (e) { lastErr = e instanceof Error ? e.message : 'error'; continue; }
      if (!wantVerify) { pick = cand; payload = p; break; }
      noteCoeditHub.broadcast(input.noteId, 'coedit.ai.progress', { action: 'find_image', stage: 'checking_image' });
      try {
        const { system, user } = buildImageVerify(subject);
        const reply = await opts.verifyVision!({ system, user, base64: p.bytes.toString('base64'), mimeType: p.mime, userId: input.access.ownerId, tenantId: input.access.tenantId });
        const v = parseImageVerdict(reply);
        if (imageAccept(v, config.imageVerifyMinConfidence)) { pick = cand; payload = p; verdict = v; break; }
        rejected++; lastErr = `vision check: ${v.reason || 'did not clearly depict the subject'}`;
      } catch {
        // A flaky/unavailable verify must not block the feature — accept the download if the check itself errors.
        pick = cand; payload = p; break;
      }
    }
    if (!pick || !payload) {
      const why = wantVerify && rejected > 0 ? `no free-to-use image clearly depicted "${subject}" (checked ${rejected})` : `could not fetch a usable image: ${lastErr || 'no candidate worked'}`;
      return { ok: false, error: why, action: 'find_image' };
    }

    const attribution = buildAttribution(pick);
    // Phase 2 — a full licence/provenance manifest (Content Credentials) stored WITH the asset.
    const provenance: ImageProvenance | undefined = config.imageProvenanceEnabled
      ? buildImageProvenance({ kind: 'web', title: pick.title || (queries[0] ?? rawText).slice(0, 80), license: LICENSE_LABELS[pick.license] ?? pick.license, licenseUrl: pick.licenseUrl, author: pick.creator, sourceUrl: pick.sourceUrl, provider: pick.provider, attribution, ...(verdict ? { verified: true, verifyConfidence: verdict.confidence } : {}) })
      : undefined;
    let artifactId: string | null = null;
    try {
      const art = await db.saveArtifact({
        name: (pick.title || queries[0] || rawText).slice(0, 80), type: 'image', mimeType: payload.mime, data: payload.bytes, scope: 'user',
        userId: input.access.ownerId, ...(input.access.tenantId ? { tenantId: input.access.tenantId } : {}),
        tags: ['note', 'image', 'web'],
        metadata: { source: 'note', noteId: input.noteId, kind: 'find_image', provider: pick.provider, license: pick.license, sourceUrl: pick.sourceUrl ?? '', query: queries[0] ?? '', candidates: candidates.length, ...(provenance ? { provenance } : {}) },
      });
      artifactId = art.id;
    } catch { return { ok: false, error: 'could not store the sourced image', action: 'find_image' }; }

    const alt = (queries[0] ?? rawText).slice(0, 80);
    const verifyNote = verdict ? ` · verified ${Math.round(verdict.confidence * 100)}%` : '';
    return stageInsert(
      input.noteId, input.access, 'find_image', 'image',
      { src: `/api/artifacts/${artifactId}/data`, alt, caption: config.imageSearchRequireAttribution ? attribution : '', href: pick.sourceUrl ?? pick.licenseUrl ?? '', license: pick.license, author: 'ai', ...(verdict ? { verifyConfidence: verdict.confidence } : {}) },
      `Image: ${attribution}${verifyNote}`, { artifactId }, `an image of ${alt.slice(0, 50)}`,
    );
  }

  /** Heuristically pick the best visual KIND for a free-text request (when kind = 'auto'). */
  function classifyVisual(instruction: string): Exclude<VisualKind, 'auto'> {
    const t = instruction.toLowerCase();
    if (/\b(photo|photograph|realistic|render|painting|watercolou?r|3d|portrait|landscape)\b/.test(t)) return 'image';
    if (/\b(illustrat|drawing of|picture of|sketch of|icon|logo|anatom|diagram of the|cross.section|figure of)\b/.test(t)) return 'illustration';
    if (/\b(flow|flowchart|process|pipeline|mind.?map|org chart|architecture|sequence|block diagram|graph|tree|steps?)\b/.test(t)) return 'diagram';
    if (/\b(underline|arrow|circle|box|highlight|annotat|mark|scribble|doodle|ink)\b/.test(t)) return 'ink';
    return 'illustration'; // a generic "draw X" → a vector illustration (no cost, always available)
  }

  /** The model produces ink PRIMITIVES; we turn them into real editable strokes + stage them. */
  async function drawInkInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const sys = 'You draw simple hand ink. Output ONLY a JSON array of primitives, each ONE of: {"kind":"underline","x1":N,"x2":N,"y":N}, {"kind":"line","x1":N,"y1":N,"x2":N,"y2":N}, {"kind":"arrow","x1":N,"y1":N,"x2":N,"y2":N}, {"kind":"box","x":N,"y":N,"w":N,"h":N}, {"kind":"circle","cx":N,"cy":N,"r":N}, {"kind":"check","x":N,"y":N}. Add a "color" hex (e.g. "#3B6FB0" for blue). The canvas is about 320 wide by 140 tall. Keep it minimal — 1 to 4 primitives.';
    const reply = await generate({ system: sys, user: input.instruction, userId: input.access.ownerId, tenantId: input.access.tenantId, temperature: 0.3, maxTokens: 600 });
    const strokes: InkStroke[] = inkFromPrimitives(extractJson(reply, 'array'));
    if (strokes.length === 0) return { ok: false, error: 'the model produced no strokes', action: 'draw_ink' };
    const svg = strokesToSvg(strokes);
    return stageInsert(input.noteId, input.access, 'draw_ink', 'inkCanvas', { strokes, author: 'ai' }, `Ink: ${input.instruction.slice(0, 48)}`, { svg }, `a sketch: ${input.instruction.slice(0, 50)}`);
  }

  return {
    createDiagram(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => createDiagramInner(input));
    },
    drawInk(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => drawInkInner(input));
    },
    createIllustration(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => createIllustrationInner(input));
    },
    generateImage(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => generateImageInner(input));
    },
    /** Source a real, free-to-use image from the web (with attribution) and stage it as a suggestion. */
    findImage(input: { noteId: string; access: NoteAccess; query: string; language?: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => findImageInner(input));
    },
    /** The unified router: pick (or honour) the visual kind, gate by config, dispatch. */
    async createVisual(input: { noteId: string; access: NoteAccess; instruction: string; kind?: VisualKind }): Promise<CreativeResult> {
      const config = await cfg();
      let kind: Exclude<VisualKind, 'auto'> = (input.kind && input.kind !== 'auto') ? input.kind : classifyVisual(input.instruction);
      // Honour the per-workspace toggles; degrade gracefully to an always-available mode.
      const enabled: Record<Exclude<VisualKind, 'auto'>, boolean> = {
        diagram: config.diagramsEnabled, ink: config.inkEnabled, illustration: config.illustrationEnabled,
        image: config.imageGenerationEnabled && !!opts.generateImage,
      };
      if (!enabled[kind]) kind = enabled.illustration ? 'illustration' : enabled.diagram ? 'diagram' : enabled.ink ? 'ink' : kind;
      if (!enabled[kind]) return { ok: false, error: 'no visual modes are enabled in weaveNotes settings', action: 'create_visual' };
      const dispatch = { diagram: createDiagramInner, ink: drawInkInner, illustration: createIllustrationInner, image: generateImageInner }[kind];
      const r = await withAiPresence(db, input.noteId, () => dispatch(input));
      return { ...r, kind };
    },
    /** Recolour the strokes of an existing inkCanvas block — staged as a suggestion (edit). */
    async recolorInk(input: { noteId: string; access: NoteAccess; color: string }): Promise<CreativeResult> {
      const view = await relay.ensureDoc({ noteId: input.noteId, tenantId: input.access.tenantId, ownerId: input.access.ownerId, seedPm: await seedFor(input.noteId, input.access.ownerId) });
      const site = creativeSite(input.noteId, 'recolor_ink');
      const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
      const inkBlock = shadow.blocks().find((b) => b.type === 'inkCanvas');
      if (!inkBlock || !inkBlock.id) return { ok: false, error: 'no ink to recolour', action: 'recolor_ink' };
      const strokes = recolorStrokes(validateStrokes((inkBlock.attrs as { strokes?: unknown }).strokes), input.color);
      const op = shadow.setBlockAttr(inkBlock.id, 'strokes', strokes);
      if (!op) return { ok: false, error: 'no change', action: 'recolor_ink' };
      const id = newUUIDv7();
      await db.createNoteSuggestion({
        id, note_id: input.noteId, doc_id: view.docId, tenant_id: input.access.tenantId,
        author_kind: 'agent', author_id: input.access.ownerId, author_site: site, action: 'recolor_ink',
        status: 'pending', ops_json: JSON.stringify([op]), preview_text: `Recolour the ink`, anchor_json: JSON.stringify({ kind: 'recolor' }), created_at: now(), resolved_at: null, resolved_by: null,
      });
      noteCoeditHub.broadcast(input.noteId, 'coedit.suggestion', { id, action: 'recolor_ink', preview: 'Recolour the ink' });
      return { ok: true, suggestionId: id, action: 'recolor_ink' };
    },
  };
}

export type NoteCreativeService = ReturnType<typeof createNoteCreativeService>;

/**
 * Build a raster-image generator backed by the OpenAI image model (gpt-image-1 by default).
 * Returns `null` images when no OpenAI key is configured, so image generation simply stays
 * unavailable rather than erroring (it is also gated by the `image_generation_enabled` setting).
 */
export function createModelImageGenerator(modelConfig: ChatEngineConfig): NoteImageGenerate {
  return async ({ prompt, model, size, userId, tenantId }) => {
    const openaiCfg = modelConfig.providers['openai'];
    const apiKey = openaiCfg?.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) return null;
    try {
      const mod = await import('@weaveintel/provider-openai') as unknown as {
        weaveOpenAIImageModel: (id: string, opts: { apiKey?: string; baseUrl?: string }) => { generateImage: (ctx: unknown, req: { prompt: string; size?: string; quality?: string }) => Promise<{ images?: ReadonlyArray<{ base64?: string; url?: string }> }> };
      };
      const imgModel = mod.weaveOpenAIImageModel(model ?? 'gpt-image-1', { apiKey, ...(openaiCfg?.baseUrl ? { baseUrl: openaiCfg.baseUrl } : {}) });
      const ctx = weaveContext({ userId, tenantId: tenantId ?? undefined, runtime: modelConfig.runtime });
      const res = await imgModel.generateImage(ctx, { prompt, ...(size ? { size } : {}) });
      // The provider returns base64 in `images[0].base64` (NOT `.image`). generateImageInner expects base64.
      return res.images?.[0]?.base64 ?? null;
    } catch { return null; }
  };
}

/**
 * Phase 1: a MULTIMODAL verifier — sends an image (base64) + a text question to the default chat model
 * (gpt-4o-mini class models are vision-capable) and returns the reply. Used to verify that a found
 * image actually depicts the requested subject. Throws on model error so the caller can decide to
 * accept-on-failure rather than block the feature.
 */
export function createModelVisionVerifier(modelConfig: ChatEngineConfig): NoteVisionVerify {
  return async ({ system, user, base64, mimeType, userId, tenantId }) => {
    const provider = modelConfig.defaultProvider;
    const model = await getOrCreateModel(provider, modelConfig.defaultModel, modelConfig.providers[provider] ?? {});
    const ctx = weaveContext({ userId, tenantId: tenantId ?? undefined, runtime: modelConfig.runtime });
    const request: ModelRequest = {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'text', text: user },
          { type: 'image', base64, mimeType }, // the providers map this → OpenAI image_url / Anthropic image block
        ] },
      ],
      maxTokens: 500,
      temperature: 0,
    };
    const res = await model.generate(ctx, request);
    return typeof res.content === 'string' ? res.content : '';
  };
}

// ─── Agent-tool entry points (resolve access themselves; viewers refused) ───────────

/** The creative TOOLS the chat agent can call. Each resolves note access itself (no escalation). */
export function createCreativeTools(db: NoteCreativeDb, generate: NoteAiGenerate, opts: { now?: () => number; generateImage?: NoteImageGenerate; verifyVision?: NoteVisionVerify } = {}) {
  const svc = createNoteCreativeService(db, generate, opts);
  async function access(userId: string, noteId: string): Promise<NoteAccess | { error: string }> {
    const a = await resolveNoteAccess(db, noteId, userId);
    if (!a) return { error: 'note not found or not accessible' };
    if (!roleAtLeast(a.role, 'collaborator')) return { error: 'forbidden: this note is read-only for you' };
    return a;
  }
  return {
    async createDiagram(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.createDiagram({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
    async drawInk(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.drawInk({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
    async createIllustration(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.createIllustration({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
    async generateImage(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.generateImage({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
    async createVisual(args: { userId: string; noteId: string; instruction: string; kind?: VisualKind }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.createVisual({ noteId: args.noteId, access: a, instruction: args.instruction, ...(args.kind ? { kind: args.kind } : {}) });
    },
    async findImage(args: { userId: string; noteId: string; query: string; language?: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      // Default to the user's preferred image-label language (DB-backed; default 'en') when not given.
      const language = args.language ?? await db.getNoteImageLanguage(args.userId).catch(() => 'en');
      return svc.findImage({ noteId: args.noteId, access: a, query: args.query, language });
    },
  };
}
