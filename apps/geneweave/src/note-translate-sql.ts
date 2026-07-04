// SPDX-License-Identifier: MIT
/**
 * geneWeave note TRANSLATE service (weaveNotes Phase 2) — "translate this note into another language".
 *
 * Translating a note well needs more than one LLM call. This service wires the pure, defended helpers
 * in `@weaveintel/notes/translate.ts` to the app:
 *   1. read the note's Markdown (via the Phase 2 co-edit relay);
 *   2. PROTECT the spans that must never change — code, inline code, URLs, [[wiki-links]], @mentions —
 *      by masking them with sentinels, so the model literally cannot break them;
 *   3. SPOTLIGHT the (masked) text as untrusted data and ask the model to translate it only;
 *   4. RESTORE the protected spans and VERIFY the result actually translated (non-empty, not identical,
 *      sentinels + Markdown structure preserved) — a bad/partial run is refused, never persisted;
 *   5. save the translation as a NEW note ("<title> (<Language>)"), leaving the original untouched —
 *      the safe default every leading editor uses for whole-document translation — inheriting the
 *      source's sensitivity, and recording the activity so the AI knows what changed.
 *
 * Owner/collaborator-scoped + tenant-isolated; the agent tool resolves access itself so a prompt-
 * injected agent can't translate (and thereby copy) a note the user can't read.
 */
import {
  resolveLanguage, protectNonTranslatable, restoreProtected,
  buildTranslatePrompt, parseTranslation, verifyTranslation,
  TARGET_LANGUAGES, type Formality,
} from '@weaveintel/prompts';
import { BlockDoc, markdownToBlocks, blocksToProseMirror } from '@weaveintel/collab';
import { newUUIDv7 } from '@weaveintel/core';
import { roleAtLeast } from '@weaveintel/collab';
import { createNoteCoeditRepo, resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { NoteSensitivity } from './db-types/adapter-agenda-notes.js';

type NoteTranslateDb = DatabaseAdapter;

export interface TranslateResult {
  ok: boolean;
  error?: string;
  /** The id of the newly-created translated note (on success). */
  noteId?: string;
  /** The resolved target language name + ISO code + direction. */
  language?: { code: string; name: string; rtl: boolean };
  /** Soft quality warnings from verification (e.g. "headings may have been lost"). */
  warnings?: string[];
}

const MAX_DOC_CHARS = 16_000; // generous cap; very long notes are truncated for a single-pass translate
const MAX_GLOSSARY_TERMS = 40;

/** Build a fresh note's doc_json from translated Markdown (reuses the Phase 1 md→blocks→PM path). */
function markdownToDocJson(userId: string, markdown: string): string {
  try {
    const blocks = BlockDoc.fromBlocks(`u:${userId}`, markdownToBlocks(markdown)).blocks();
    return JSON.stringify(blocksToProseMirror(blocks));
  } catch {
    return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: markdown ? [{ type: 'text', text: markdown.slice(0, 4000) }] : [] }] });
  }
}

export function createNoteTranslateService(db: NoteTranslateDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const relay = createNoteCoeditRepo(db, { now });
  const settings = createNoteSettingsService(db);

  async function seedFor(noteId: string, ownerId: string): Promise<unknown> {
    const note = await db.getNote(noteId, ownerId) as { doc_json?: string } | null;
    if (!note?.doc_json) return { type: 'doc', content: [] };
    try { return JSON.parse(note.doc_json); } catch { return { type: 'doc', content: [] }; }
  }

  /**
   * Translate a note into `targetLanguage` and save the result as a NEW note owned by the requesting
   * user. Returns the new note id + any soft warnings. Refuses (without persisting) if the model's
   * output fails verification.
   */
  async function translateNote(input: {
    noteId: string; access: NoteAccess; userId: string;
    targetLanguage: string; formality?: Formality; glossary?: string[];
  }): Promise<TranslateResult> {
    const cfg = await settings.getConfig();
    if (!cfg.translateEnabled) return { ok: false, error: 'translation is disabled in weaveNotes settings' };

    const lang = resolveLanguage(input.targetLanguage);
    if (!lang) {
      return { ok: false, error: `unsupported target language "${input.targetLanguage}". Try one of: ${TARGET_LANGUAGES.slice(0, 12).map((l) => l.name).join(', ')}…` };
    }

    const { noteId, access } = input;
    const srcNote = await db.getNote(noteId, access.ownerId) as { title?: string; sensitivity?: NoteSensitivity } | null;
    const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
    const markdown = (view.markdown ?? '').slice(0, MAX_DOC_CHARS);
    if (!markdown.trim()) return { ok: false, error: 'the note is empty' };

    // 1) Protect the non-translatable spans, then 2) translate the masked text.
    const { masked, tokens } = protectNonTranslatable(markdown);
    const glossary = (input.glossary ?? []).slice(0, MAX_GLOSSARY_TERMS);
    const prompt = buildTranslatePrompt(masked, {
      targetLanguage: lang.name,
      ...(input.formality ? { formality: input.formality } : {}),
      ...(glossary.length ? { glossary } : {}),
    });
    const reply = await generate({ system: prompt.system, user: prompt.user, userId: access.ownerId, tenantId: access.tenantId, temperature: 0, maxTokens: 3000 });

    // 3) Restore protected spans + 4) verify before we trust it.
    const translatedMasked = parseTranslation(reply);
    const verdict = verifyTranslation(masked, translatedMasked, { sameLanguageAllowed: false });
    if (!verdict.ok) return { ok: false, error: `translation check failed: ${verdict.reason ?? 'unknown'}`, language: { code: lang.code, name: lang.name, rtl: !!lang.rtl } };
    const translated = restoreProtected(translatedMasked, tokens);

    // 5) Persist as a NEW note, inheriting the source's sensitivity.
    const srcTitle = (srcNote?.title ?? 'Untitled note').trim() || 'Untitled note';
    const newId = newUUIDv7();
    try {
      await db.createNote({
        id: newId, owner_user_id: input.userId, tenant_id: access.tenantId ?? null,
        title: `${srcTitle} (${lang.name})`, doc_json: markdownToDocJson(input.userId, translated),
        is_template: 0, favorite: 0, sensitivity: srcNote?.sensitivity ?? 'normal',
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'failed to save the translated note' };
    }

    // Record the activity on BOTH notes so the AI understands what happened.
    void settings.recordActivity({ noteId, userId: input.userId, tenantId: access.tenantId ?? null, action: 'translated', actor: 'ai', summary: `Translated to ${lang.name}`, detail: { newNoteId: newId, language: lang.code } });
    void settings.recordActivity({ noteId: newId, userId: input.userId, tenantId: access.tenantId ?? null, action: 'created', actor: 'ai', summary: `Translated from "${srcTitle}" into ${lang.name}`, detail: { sourceNoteId: noteId, language: lang.code } });

    return { ok: true, noteId: newId, language: { code: lang.code, name: lang.name, rtl: !!lang.rtl }, warnings: verdict.warnings };
  }

  return { translateNote };
}

export type NoteTranslateService = ReturnType<typeof createNoteTranslateService>;

// ─── Agent-tool entry point (resolves access itself; collaborators+ may translate) ──

/** The `translate_note` tool: translate a note the user can edit into another language. */
export function createTranslateTool(db: NoteTranslateDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const svc = createNoteTranslateService(db, generate, opts);
  return {
    async translateNote(args: { userId: string; noteId: string; targetLanguage: string; formality?: Formality; glossary?: string[] }): Promise<TranslateResult> {
      const access = await resolveNoteAccess(db, args.noteId, args.userId);
      if (!access) return { ok: false, error: 'note not found or not accessible' };
      if (!roleAtLeast(access.role, 'collaborator')) return { ok: false, error: 'forbidden' };
      return svc.translateNote({
        noteId: args.noteId, access, userId: args.userId, targetLanguage: args.targetLanguage,
        ...(args.formality ? { formality: args.formality } : {}),
        ...(args.glossary ? { glossary: args.glossary } : {}),
      });
    },
  };
}
