/**
 * markdown.ts — a tiny, progressive Markdown tokenizer for streamed assistant
 * text.
 *
 * The full chat pipeline streams partial text, so this parser is deliberately
 * *progressive*: it never throws on unterminated constructs (an open code
 * fence renders as a code block, an unmatched `**` renders literally). It
 * supports only the subset the assistant emits — headings (#/##/###), fenced
 * code blocks, bullet lists (-, *), and inline bold (`**`), italic (`*`/`_`),
 * and inline code (`` ` ``). Everything else is plain text.
 *
 * Pure and framework-agnostic: the native layer maps {@link MarkdownBlock}s and
 * {@link InlineSpan}s onto themed `<Text>` components.
 */

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type MarkdownBlock =
  | { type: 'paragraph'; spans: InlineSpan[] }
  | { type: 'heading'; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { type: 'bullet'; spans: InlineSpan[] }
  | { type: 'code'; text: string; lang?: string };

/** Parse `source` Markdown into an ordered list of blocks. Never throws. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.split('\n');

  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', spans: parseInline(text) });
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block (progressive: an unterminated fence still renders).
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      const lang = fence[1] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // consume the closing fence (or run off the end — fine)
      blocks.push({ type: 'code', text: body.join('\n'), ...(lang ? { lang } : {}) });
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = (heading[1] ?? '#').length as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, spans: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    // Bullet list item.
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: 'bullet', spans: parseInline(bullet[1] ?? '') });
      i++;
      continue;
    }

    // Blank line ends a paragraph.
    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}

/**
 * Parse inline spans: `**bold**`, `*italic*` / `_italic_`, and `` `code` ``.
 * Unmatched markers render literally (progressive streaming safety).
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buf = '';
  let i = 0;

  const push = (extra: Partial<InlineSpan>): void => {
    if (buf) {
      spans.push({ text: buf, ...extra });
      buf = '';
    }
  };
  const pushPlain = (): void => push({});

  while (i < text.length) {
    // Inline code — highest precedence, no nested formatting.
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        pushPlain();
        spans.push({ text: text.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    // Bold (**).
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i) {
        pushPlain();
        // Inner content may itself contain italic; keep it simple — bold only.
        spans.push({ text: text.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }

    // Italic (* or _).
    const marker = text[i];
    if ((marker === '*' || marker === '_') && !text.startsWith('**', i)) {
      const end = text.indexOf(marker, i + 1);
      if (end > i && end !== i + 1) {
        pushPlain();
        spans.push({ text: text.slice(i + 1, end), italic: true });
        i = end + 1;
        continue;
      }
    }

    buf += text[i];
    i++;
  }
  pushPlain();
  return spans.length > 0 ? spans : [{ text: '' }];
}
