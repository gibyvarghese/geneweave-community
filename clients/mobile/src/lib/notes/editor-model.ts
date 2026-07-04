/**
 * editor-model.ts — the mobile note editor's block composition (weaveNotes Phase 7).
 *
 * The mobile editor is intentionally simple: a title, a multi-line text body, and a freehand ink
 * canvas. A note may also carry web-authored blocks the phone cannot edit (diagrams, images,
 * callouts). This pure helper splits a note's blocks into those three parts for editing and recomposes
 * them on save — crucially **never dropping** the web-only blocks (they are preserved verbatim and
 * re-appended), so a mobile edit can add ink + text without destroying a teammate's diagram.
 *
 * Pure + unit-tested; the screen is a thin renderer over `splitNoteForEditor` / `composeNote`.
 */
import type { NoteBlock } from '@weaveintel/notes';
import type { InkStroke } from '@weaveintel/notes';

export interface EditorModel {
  /** The editable text body — every text block joined by newlines (one line per block). */
  bodyText: string;
  /** The strokes of the note's ink canvas (empty if none yet). */
  strokes: InkStroke[];
  /** Web-only blocks the phone can't edit, kept verbatim (re-appended on save). */
  preserved: NoteBlock[];
}

const TEXT_TYPES = new Set(['paragraph', 'heading', 'bullet', 'todo']);

/** Split a note's blocks into the editor's body text + ink + preserved web-only blocks. */
export function splitNoteForEditor(blocks: NoteBlock[]): EditorModel {
  const lines: string[] = [];
  let strokes: InkStroke[] = [];
  const preserved: NoteBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') lines.push(b.text);
    else if (b.type === 'bullet') b.items.forEach((i) => lines.push(i));
    else if (b.type === 'todo') b.items.forEach((i) => lines.push(i.text));
    else if (b.type === 'inkCanvas') strokes = strokes.length ? strokes : b.strokes; // first canvas wins
    else preserved.push(b); // unsupported → keep verbatim
  }
  return { bodyText: lines.join('\n'), strokes, preserved };
}

/**
 * Recompose editor parts into a block list for `blocksToDoc`. Order: text paragraphs, then the ink
 * canvas (if any strokes), then the preserved web-only blocks — so nothing the web authored is lost.
 */
export function composeNote(bodyText: string, strokes: InkStroke[], preserved: NoteBlock[]): NoteBlock[] {
  const blocks: NoteBlock[] = bodyText.split('\n').map((line) => ({ type: 'paragraph', text: line }));
  // Ensure at least one (empty) paragraph so a doc is never block-less.
  if (blocks.length === 0) blocks.push({ type: 'paragraph', text: '' });
  if (strokes.length > 0) blocks.push({ type: 'inkCanvas', strokes, author: 'user' });
  return [...blocks, ...preserved];
}

/** A short human label of the preserved web-only blocks (for the "also on this note" hint). */
export function preservedSummary(preserved: NoteBlock[]): string {
  const kinds = preserved.map((b) => (b.type === 'unsupported' ? b.nodeType : b.type));
  const pretty: Record<string, string> = { diagram: 'a diagram', image: 'an image', callout: 'a callout', toggle: 'a toggle', codeBlock: 'a code block', blockquote: 'a quote' };
  return [...new Set(kinds)].map((k) => pretty[k] ?? k).join(', ');
}
