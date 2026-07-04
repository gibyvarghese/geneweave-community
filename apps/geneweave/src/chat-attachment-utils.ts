import type { Message } from '@weaveintel/core';
import type { ChatAttachment } from './chat-runtime.js';

export function normalizeAttachments(input: ChatAttachment[] | undefined): ChatAttachment[] {
  if (!Array.isArray(input) || input.length === 0) return [];

  const maxCount = 8;
  const maxBytes = 4 * 1024 * 1024;
  const sanitized: ChatAttachment[] = [];

  for (const item of input.slice(0, maxCount)) {
    if (!item || typeof item !== 'object') continue;
    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    const rawMime = typeof item.mimeType === 'string' ? item.mimeType.trim() : '';
    if (!rawName || !rawMime) continue;

    const normalizedBase64 = typeof item.dataBase64 === 'string'
      ? item.dataBase64.replace(/\s+/g, '')
      : undefined;
    if (normalizedBase64 && !/^[A-Za-z0-9+/=]+$/.test(normalizedBase64)) continue;

    const approximateSize = normalizedBase64
      ? Math.floor((normalizedBase64.length * 3) / 4)
      : (typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0);
    if (approximateSize <= 0 || approximateSize > maxBytes) continue;

    const transcript = typeof item.transcript === 'string' && item.transcript.trim()
      ? item.transcript.trim().slice(0, 12_000)
      : undefined;

    const isAudio = rawMime.toLowerCase().startsWith('audio/');
    sanitized.push({
      name: rawName.replace(/[/\\]/g, '_').replace(/\0/g, '').replace(/\.\./g, '_').slice(0, 180),
      mimeType: rawMime.slice(0, 120),
      size: approximateSize,
      dataBase64: isAudio ? undefined : normalizedBase64,
      transcript,
    });
  }

  return sanitized;
}

export function buildAttachmentContext(attachments: ChatAttachment[], opts?: { maxInlineChars?: number }): string {
  const lines: string[] = [];
  const maxInlineChars = opts?.maxInlineChars ?? 12_000;

  for (const attachment of attachments) {
    lines.push(`- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`);
    if (attachment.transcript) {
      lines.push(`  transcript: ${attachment.transcript.slice(0, maxInlineChars)}`);
      continue;
    }

    const lowerMime = attachment.mimeType.toLowerCase();
    const maybeText =
      lowerMime.startsWith('text/') ||
      lowerMime === 'application/json' ||
      lowerMime === 'application/xml' ||
      lowerMime === 'application/javascript' ||
      lowerMime === 'application/x-javascript' ||
      lowerMime === 'application/csv' ||
      lowerMime.includes('markdown');

    if (maybeText && attachment.dataBase64) {
      try {
        const decoded = Buffer.from(attachment.dataBase64, 'base64').toString('utf8');
        const compact = decoded.replace(/\r\n/g, '\n').trim();
        if (compact) {
          lines.push(`  content:\n${compact.slice(0, maxInlineChars)}`);
        }
      } catch {
        lines.push('  content: [unable to decode text attachment]');
      }
    }
  }

  return lines.join('\n');
}

export function composeUserInput(content: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return content;
  const attachmentContext = buildAttachmentContext(attachments);
  if (!attachmentContext) return content;
  return `${content}\n\n[User attachments]\n${attachmentContext}`;
}

export function hasTabularDataAttachments(attachments: ChatAttachment[]): boolean {
  if (!attachments.length) return false;

  const tabularMimes = new Set([
    'text/csv',
    'application/csv',
    'text/tab-separated-values',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/parquet',
    'application/x-parquet',
  ]);

  return attachments.some((attachment) => {
    const mime = attachment.mimeType.toLowerCase();
    if (tabularMimes.has(mime)) return true;

    const lowerName = attachment.name.toLowerCase();
    return lowerName.endsWith('.csv') ||
      lowerName.endsWith('.tsv') ||
      lowerName.endsWith('.xlsx') ||
      lowerName.endsWith('.xls') ||
      lowerName.endsWith('.parquet');
  });
}

export function patchLatestUserMessage(messages: Message[], content: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') {
      messages[i] = { ...msg, content };
      return true;
    }
  }
  return false;
}
