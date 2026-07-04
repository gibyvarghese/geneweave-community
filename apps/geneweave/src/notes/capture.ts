// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — CAPTURE helpers (weaveNotes Phase 7).
 *
 * "Capture" is getting content INTO your notes from the outside world — a chat run,
 * a web page you clipped, an email, a quick thought — and turning each into a tidy,
 * STRUCTURED note rather than a raw dump. The mid-2026 best practice is "capture then
 * process": every clip lands with its PROVENANCE (where it came from + when), so you
 * can review and link it later instead of it becoming a "digital graveyard".
 *
 * This module is the pure, reusable core: it parses an email into structured fields
 * and assembles a note's Markdown with a provenance header. (The web-page extraction
 * itself reuses `@weaveintel/tools-browser`'s `readability()`; the HTTP fetch is done
 * by the app with an SSRF-safe client.) No I/O here — trivially testable.
 *
 * --- For someone new to this ---
 * A "capture" is a saved copy of something you found (a page, an email, an idea).
 * "Provenance" just means a little note of where it came from, like a citation, so
 * future-you knows the source. We always add that header so a clip is never anonymous.
 */

export type CaptureSource = 'run' | 'web' | 'email' | 'jot';

/** Structured email fields (or parse them from a raw message with {@link parseEmail}). */
export interface EmailFields {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  /** Plain-text or simple-HTML body. */
  body?: string;
}

export interface ParsedEmail {
  from?: string;
  subject: string;
  date?: string;
  /** Body as plain text (HTML stripped). */
  bodyText: string;
}

/** Strip HTML tags + decode a few common entities to plain text. */
function htmlToText(s: string): string {
  return s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse an email into structured fields. Accepts either a structured {@link EmailFields}
 * object or a raw RFC822-ish message (headers, blank line, body). HTML bodies are
 * reduced to plain text. The subject defaults to "(no subject)".
 */
export function parseEmail(input: string | EmailFields): ParsedEmail {
  if (typeof input !== 'string') {
    return {
      ...(input.from ? { from: input.from } : {}),
      subject: (input.subject ?? '').trim() || '(no subject)',
      ...(input.date ? { date: input.date } : {}),
      bodyText: htmlToText(input.body ?? ''),
    };
  }
  // Raw message: split headers from body at the first blank line.
  const sep = input.search(/\r?\n\r?\n/);
  const headerBlock = sep >= 0 ? input.slice(0, sep) : input;
  const body = sep >= 0 ? input.slice(sep).trim() : '';
  const header = (name: string): string | undefined => {
    const re = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im');
    const m = headerBlock.match(re);
    return m ? m[1]!.trim() : undefined;
  };
  return {
    ...(header('From') ? { from: header('From')! } : {}),
    subject: header('Subject') ?? '(no subject)',
    ...(header('Date') ? { date: header('Date')! } : {}),
    bodyText: htmlToText(body),
  };
}

const SOURCE_ICON: Record<CaptureSource, string> = { run: '🤖', web: '🌐', email: '✉️', jot: '✏️' };

/**
 * Assemble a captured note's title + Markdown, with a provenance blockquote header so
 * the note always records where it came from. The body is bounded to keep notes sane.
 */
export function buildCaptureNote(input: {
  source: CaptureSource;
  title: string;
  body: string;
  /** Human label for the source (e.g. an author, a sender, "Chat run"). */
  sourceLabel?: string;
  /** A clickable source URL (for web clips). */
  sourceUrl?: string;
  /** ISO date the content is dated (defaults to omitted). */
  capturedAt?: string;
  /** Max body characters kept (default 20000). */
  maxBodyChars?: number;
}): { title: string; markdown: string } {
  const title = (input.title ?? '').trim() || 'Captured note';
  const body = (input.body ?? '').slice(0, input.maxBodyChars ?? 20000).trim();
  const provenanceBits = [
    `${SOURCE_ICON[input.source]} Captured from ${input.sourceLabel ?? input.source}`,
    ...(input.capturedAt ? [input.capturedAt] : []),
  ].join(' · ');
  const lines = [
    `# ${title}`,
    '',
    `> ${provenanceBits}`,
    ...(input.sourceUrl ? [`> Source: [${input.sourceUrl}](${input.sourceUrl})`] : []),
    '',
    body,
  ];
  return { title, markdown: lines.join('\n') };
}

/** The reserved title prefix + per-day title for the daily-jots inbox. */
export function dailyNoteTitle(isoDate: string): string {
  return `Daily Jots — ${isoDate}`;
}
