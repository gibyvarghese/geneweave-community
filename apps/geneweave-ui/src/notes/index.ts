// SPDX-License-Identifier: MIT
/**
 * geneWeave (weaveNotes) — the creative / rendering layer, app-owned.
 *
 * weaveNotes product modules: the "colour encodes agency" contract + the geneWeave palette, the
 * creative marks (page themes / highlighter swatches / callout tones / stickers), and the semantic
 * colour-coding schemes + native diagram model & SVG renderer. They live in the UI package because
 * both the editor (client) and the server (AI generation) use them, and the server already depends
 * on `@weaveintel/geneweave-ui`. Imported by the app as `@weaveintel/geneweave-ui/notes`.
 *
 * (The freehand-ink model + the colour-safety gate stay in `@weaveintel/notes` — they're part of the
 * generic note-document data model — and are re-used here.)
 */
export * from './agency.js';
export * from './colorize.js';
export * from './creative.js';
export * from './diagram.js';
