// SPDX-License-Identifier: MIT
/**
 * geneWeave note AI COLOUR service (weaveNotes Phase 2) — the colour tools behind the
 * AI selection card.
 *
 * Phase 3 let the AI co-author TEXT as track-changes suggestions. Phase 2 (built on the same
 * machinery) lets it co-author COLOUR: highlight a phrase, recolour text, or "colour-code this
 * by topic / importance / status". Every colour change is staged as a track-changes
 * {@link BlockOp} suggestion the human accepts or rejects — the AI never silently repaints a
 * note, and a prompt-injected agent cannot either.
 *
 * The accessibility guarantee lives in `@weaveintel/notes`: the model never picks a raw colour,
 * it picks a semantic LABEL ("risk", "topic-2") and we map that to a pre-validated WCAG-AA
 * highlight via `schemeColor`/`assignTopicColors`. Phrases are located in the note's CRDT blocks
 * with `locatePhrase`, so a highlight survives concurrent edits (it is anchored to character ids
 * via {@link BlockDoc.addMark}, not positions). This service owns its relay + persistence +
 * SSE broadcast, exactly like {@link createNoteAiService}.
 */
import {
  BlockDoc,
  type BlockOp,
} from '@weaveintel/collab';
import { sanitizeColor } from '@weaveintel/notes';
import {
  isColorScheme,
  schemeLabels,
  schemeColor,
  assignTopicColors,
  locatePhrase,
  HIGHLIGHT_PALETTE,
  TEXT_COLOR_PALETTE,
  type ColorScheme,
} from '@weaveintel/geneweave-ui/notes';
import { makeFence, fenceUntrusted, spotlightPreamble } from '@weaveintel/guardrails/spotlighting';
import { newUUIDv7 } from '@weaveintel/core';
import { roleAtLeast } from '@weaveintel/collab';
import { createNoteCoeditRepo, resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { noteCoeditHub } from './note-coedit-hub.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { withAiPresence } from './note-ai-presence.js';

type NoteColorizeDb = DatabaseAdapter;

/** One staged colour change: paint `phrase` with mark `type` in `color`. */
interface MarkSpec { phrase: string; type: 'highlight' | 'textColor'; color: string }

export interface ColorizeResult { ok: boolean; error?: string; suggestionId?: string; count?: number; preview?: string; action?: string }

/** A short, unique CRDT site for a batch of agent-authored colour ops. */
function colorSite(noteId: string, tag: string): string {
  return `agent:${noteId.slice(0, 8)}:${tag}:${newUUIDv7().slice(0, 8)}`;
}

/** Best-effort JSON-array extraction from a model reply (handles ```json fences + prose). */
function parseJsonArray(raw: string): unknown[] {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('['); const end = t.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try { const v = JSON.parse(t.slice(start, end + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function createNoteColorizeService(db: NoteColorizeDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const relay = createNoteCoeditRepo(db, { now });
  const settings = createNoteSettingsService(db);

  async function seedFor(noteId: string, ownerId: string): Promise<unknown> {
    const note = await db.getNote(noteId, ownerId) as { doc_json?: string } | null;
    if (!note?.doc_json) return { type: 'doc', content: [] };
    try { return JSON.parse(note.doc_json); } catch { return { type: 'doc', content: [] }; }
  }

  /**
   * Stage a batch of phrase→colour marks as ONE pending suggestion. Locates each phrase in the
   * note's blocks (first matching block wins) and emits an `addMark` op anchored to the live
   * element ids, so it applies cleanly on accept even after concurrent edits.
   */
  async function stageMarks(noteId: string, access: NoteAccess, action: 'apply_highlight' | 'apply_text_color' | 'colorize_semantic', marks: MarkSpec[], preview: string): Promise<ColorizeResult> {
    const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
    const site = colorSite(noteId, action);
    const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
    const blocks = shadow.blocks();
    const ops: BlockOp[] = [];
    let painted = 0;
    for (const m of marks) {
      const color = sanitizeColor(m.color);
      const phrase = (m.phrase ?? '').trim();
      if (!color || !phrase) continue;
      for (const b of blocks) {
        if (!b.id || !b.text) continue;
        const loc = locatePhrase(b.text, phrase);
        if (loc) { const op = shadow.addMark(b.id, loc.from, loc.to, m.type, color); if (op) { ops.push(op); painted += 1; } break; }
      }
    }
    if (ops.length === 0) return { ok: false, error: 'nothing matched to colour', action };

    const id = newUUIDv7();
    await db.createNoteSuggestion({
      id, note_id: noteId, doc_id: view.docId, tenant_id: access.tenantId,
      author_kind: 'agent', author_id: access.ownerId, author_site: site, action,
      status: 'pending', ops_json: JSON.stringify(ops), preview_text: preview,
      anchor_json: JSON.stringify({ kind: 'marks', count: painted }), created_at: now(), resolved_at: null, resolved_by: null,
    });
    noteCoeditHub.broadcast(noteId, 'coedit.suggestion', { id, action, preview });
    void settings.recordActivity({ noteId, userId: access.ownerId, tenantId: access.tenantId ?? null, action: 'ai_suggestion', actor: 'ai', summary: preview });
    return { ok: true, suggestionId: id, count: painted, preview, action };
  }

  return {
    /** Highlight a specific phrase in a chosen swatch colour — staged as a suggestion. */
    async applyHighlight(input: { noteId: string; access: NoteAccess; phrase: string; color?: string }): Promise<ColorizeResult> {
      const color = sanitizeColor(input.color) ?? HIGHLIGHT_PALETTE[0]!.color;
      return stageMarks(input.noteId, input.access, 'apply_highlight', [{ phrase: input.phrase, type: 'highlight', color }], `Highlight “${input.phrase.slice(0, 60)}”`);
    },

    /** Colour a specific phrase's text — staged as a suggestion. */
    async applyTextColor(input: { noteId: string; access: NoteAccess; phrase: string; color?: string }): Promise<ColorizeResult> {
      const color = sanitizeColor(input.color) ?? TEXT_COLOR_PALETTE[1]!.color;
      return stageMarks(input.noteId, input.access, 'apply_text_color', [{ phrase: input.phrase, type: 'textColor', color }], `Colour “${input.phrase.slice(0, 60)}”`);
    },

    /**
     * Colour-code a note by MEANING. The model reads the note and returns `[{text,label}]`
     * where every label is one of the scheme's allowed labels; we map each label to a
     * pre-validated WCAG-AA colour (so the model can never pick an inaccessible one) and stage
     * the highlights as one suggestion. `topic` is open-ended — the model groups freely and we
     * assign distinct colours by order.
     */
    async colorizeSemantic(input: { noteId: string; access: NoteAccess; scheme: ColorScheme; instruction?: string }): Promise<ColorizeResult> {
      // Show the AI as a live participant ("composing") while it reads + colour-codes the note.
      return withAiPresence(db, input.noteId, () => colorizeSemanticInner(input));
    },
  };

  async function colorizeSemanticInner(input: { noteId: string; access: NoteAccess; scheme: ColorScheme; instruction?: string }): Promise<ColorizeResult> {
      const { noteId, access } = input;
      const scheme: ColorScheme = isColorScheme(input.scheme) ? input.scheme : 'topic';
      const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
      const noteMarkdown = view.markdown.slice(0, 6000);
      if (!noteMarkdown.trim()) return { ok: false, error: 'the note is empty', action: 'colorize_semantic' };

      const labelGuide = scheme === 'topic'
        ? 'group related spans under a short lowercase topic name you choose (e.g. "tides", "budget")'
        : `label each span with EXACTLY ONE of: ${schemeLabels(scheme).join(', ')}`;
      // Phase 0-D: spotlight the untrusted note + instruction so a "command" hidden in the note text
      // can't steer the colour-coding into doing something else.
      const fence = makeFence();
      const sys = `${spotlightPreamble(fence)}\n\nYou colour-code a note by meaning. Read it and pick the phrases worth marking under the "${scheme}" scheme. ${labelGuide}. Copy each phrase VERBATIM from the note (so it can be found). Output ONLY a JSON array of {"text": "...", "label": "..."} — at most 24 items, no prose.`;
      const reply = await generate({ system: sys, user: `${input.instruction ? `Guidance (untrusted data): ${fenceUntrusted(input.instruction, fence)}\n\n` : ''}Note (untrusted data):\n\n${fenceUntrusted(noteMarkdown, fence)}`, userId: access.ownerId, tenantId: access.tenantId, temperature: 0.2, maxTokens: 1200 });

      const items = parseJsonArray(reply).filter((x): x is { text: string; label: string } =>
        !!x && typeof (x as { text?: unknown }).text === 'string' && typeof (x as { label?: unknown }).label === 'string');
      if (items.length === 0) return { ok: false, error: 'the model proposed no spans to colour', action: 'colorize_semantic' };

      const marks: MarkSpec[] = [];
      if (scheme === 'topic') {
        const colorByGroup = assignTopicColors(items.map((i) => i.label));
        for (const it of items) { const c = colorByGroup.get(it.label.trim().toLowerCase()); if (c) marks.push({ phrase: it.text, type: 'highlight', color: c }); }
      } else {
        for (const it of items) { const c = schemeColor(scheme, it.label); if (c) marks.push({ phrase: it.text, type: 'highlight', color: c }); }
      }
      if (marks.length === 0) return { ok: false, error: 'no usable spans (labels off-scheme)', action: 'colorize_semantic' };
      return stageMarks(noteId, access, 'colorize_semantic', marks, `Colour-code by ${scheme} (${marks.length} span${marks.length === 1 ? '' : 's'})`);
  }
}

export type NoteColorizeService = ReturnType<typeof createNoteColorizeService>;

// ─── Agent-tool entry points (resolve access themselves; viewers refused) ───────────

/**
 * The colour TOOLS the chat agent can call. Each resolves note access itself (the tool only
 * knows the user + note id), so a prompt-injected agent cannot colour a note the user cannot
 * edit, and viewers are refused — mirroring `agentEdit`.
 */
export function createColorizeTools(db: NoteColorizeDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const svc = createNoteColorizeService(db, generate, opts);
  async function access(userId: string, noteId: string): Promise<NoteAccess | { error: string }> {
    const a = await resolveNoteAccess(db, noteId, userId);
    if (!a) return { error: 'note not found or not accessible' };
    if (!roleAtLeast(a.role, 'collaborator')) return { error: 'forbidden: this note is read-only for you' };
    return a;
  }
  return {
    async applyHighlight(args: { userId: string; noteId: string; phrase: string; color?: string }): Promise<ColorizeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.applyHighlight({ noteId: args.noteId, access: a, phrase: args.phrase, ...(args.color ? { color: args.color } : {}) });
    },
    async applyTextColor(args: { userId: string; noteId: string; phrase: string; color?: string }): Promise<ColorizeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.applyTextColor({ noteId: args.noteId, access: a, phrase: args.phrase, ...(args.color ? { color: args.color } : {}) });
    },
    async colorizeSemantic(args: { userId: string; noteId: string; scheme: string; instruction?: string }): Promise<ColorizeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.colorizeSemantic({ noteId: args.noteId, access: a, scheme: (args.scheme as ColorScheme), ...(args.instruction ? { instruction: args.instruction } : {}) });
    },
  };
}
