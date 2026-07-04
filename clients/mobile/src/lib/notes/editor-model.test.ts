/**
 * editor-model.test.ts — Node unit tests for the mobile editor's block composition.
 */
import { describe, it, expect } from 'vitest';
import { splitNoteForEditor, composeNote, preservedSummary } from './editor-model.js';
import { blocksToDoc, docToBlocks, hasInk, type NoteBlock, type InkStroke } from '@weaveintel/notes';

const stroke: InkStroke = { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: '#14201B', width: 3, tool: 'pen', author: 'user' };

describe('editor-model — split / compose', () => {
  it('splits a note into body text + ink + preserved web blocks', () => {
    const blocks: NoteBlock[] = [
      { type: 'heading', level: 1, text: 'Survey' },
      { type: 'paragraph', text: 'North field' },
      { type: 'inkCanvas', strokes: [stroke], author: 'user' },
      { type: 'unsupported', nodeType: 'diagram', raw: { type: 'diagram', attrs: {} } },
    ];
    const m = splitNoteForEditor(blocks);
    expect(m.bodyText).toBe('Survey\nNorth field');
    expect(m.strokes).toHaveLength(1);
    expect(m.preserved).toHaveLength(1);
    expect(preservedSummary(m.preserved)).toBe('a diagram');
  });

  it('composes editor parts back into blocks, keeping ink + preserved content', () => {
    const preserved: NoteBlock[] = [{ type: 'unsupported', nodeType: 'image', raw: { type: 'image', attrs: { src: 'x' } } }];
    const blocks = composeNote('line one\nline two', [stroke], preserved);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'inkCanvas', 'unsupported']);
    expect(hasInk(blocks)).toBe(true);
  });

  it('a mobile edit of a web note keeps the diagram (round-trip through doc_json)', () => {
    const webDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: 'diagram', attrs: { scene: { nodes: [], edges: [] } } },
      ],
    };
    const m = splitNoteForEditor(docToBlocks(JSON.stringify(webDoc)));
    // Phone adds a sentence + an ink sketch.
    const composed = composeNote(`${m.bodyText}\nadded on phone`, [stroke], m.preserved);
    const out = JSON.parse(blocksToDoc(composed)) as { content: Array<{ type: string }> };
    expect(out.content.some((n) => n.type === 'diagram')).toBe(true); // diagram preserved
    expect(out.content.some((n) => n.type === 'inkCanvas')).toBe(true); // ink added
  });

  it('an empty body still composes a valid (non-empty) doc', () => {
    const blocks = composeNote('', [], []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('paragraph');
  });
});
