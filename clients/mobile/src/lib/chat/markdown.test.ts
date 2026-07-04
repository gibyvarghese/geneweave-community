/**
 * markdown.test.ts — Node unit tests for the progressive Markdown tokenizer.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline } from './markdown.js';

describe('parseInline', () => {
  it('parses bold, italic, and inline code', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c' },
    ]);
    expect(parseInline('go _fast_ now')).toEqual([
      { text: 'go ' },
      { text: 'fast', italic: true },
      { text: ' now' },
    ]);
    expect(parseInline('run `npm test`')).toEqual([
      { text: 'run ' },
      { text: 'npm test', code: true },
    ]);
  });

  it('renders unmatched markers literally (progressive safety)', () => {
    expect(parseInline('a **b')).toEqual([{ text: 'a **b' }]);
    expect(parseInline('half `code')).toEqual([{ text: 'half `code' }]);
  });

  it('never returns an empty array', () => {
    expect(parseInline('')).toEqual([{ text: '' }]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, and bullets', () => {
    const blocks = parseMarkdown('# Title\n\nHello world\n\n- one\n- two');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, spans: [{ text: 'Title' }] },
      { type: 'paragraph', spans: [{ text: 'Hello world' }] },
      { type: 'bullet', spans: [{ text: 'one' }] },
      { type: 'bullet', spans: [{ text: 'two' }] },
    ]);
  });

  it('parses a fenced code block with a language', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n```');
    expect(blocks).toEqual([{ type: 'code', text: 'const x = 1;', lang: 'ts' }]);
  });

  it('renders an unterminated code fence progressively', () => {
    const blocks = parseMarkdown('```\npartial output');
    expect(blocks).toEqual([{ type: 'code', text: 'partial output' }]);
  });

  it('keeps inline formatting inside paragraphs', () => {
    const blocks = parseMarkdown('This is **important** and `inline`.');
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      spans: [
        { text: 'This is ' },
        { text: 'important', bold: true },
        { text: ' and ' },
        { text: 'inline', code: true },
        { text: '.' },
      ],
    });
  });

  it('returns no blocks for empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
