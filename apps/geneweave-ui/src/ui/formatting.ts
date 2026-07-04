export function parseMessageMetadata(raw: any): any {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function shortText(value: any, maxLen?: number): string {
  if (value == null) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (raw.length <= (maxLen || 280)) return raw;
  return raw.slice(0, maxLen || 280) + '...';
}

export function detailText(value: any): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function summarizeForDisplay(value: any, maxLen?: number): string {
  const raw = detailText(value);
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= (maxLen || 180)) return compact;
  return compact.slice(0, maxLen || 180) + '...';
}

export function parseJsonMaybe(text: string): any {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_e) {
    return null;
  }
}

export function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseDelimitedTable(text: string): { headers: string[]; rows: string[][] } | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const delimiters = [',', '\t', '|'];
  for (const delimiter of delimiters) {
    const parsed = lines.slice(0, Math.min(lines.length, 40)).map((line) => parseDelimitedLine(line, delimiter));
    const width = parsed[0]?.length || 0;
    if (width < 2) continue;
    if (!parsed.every((row) => row.length === width)) continue;
    const headers = parsed[0]!.map((h, idx) => h || ('col_' + (idx + 1)));
    const rows = parsed.slice(1);
    if (rows.length < 1) continue;
    return { headers, rows };
  }
  return null;
}

export function formatXml(xmlText: string): string | null {
  if (typeof xmlText !== 'string') return null;
  const trimmed = xmlText.trim();
  if (!/^<([A-Za-z_][\w:.-]*)(\s|>)/.test(trimmed)) return null;
  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(trimmed, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length) return null;
    const raw = new XMLSerializer().serializeToString(parsed).replace(/>(\s*)</g, '><');
    const lines = raw.replace(/(>)(<)(\/?)/g, '$1\n$2$3').split('\n');
    let pad = 0;
    return lines.map((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return '';
      if (/^<\//.test(trimmedLine)) pad = Math.max(0, pad - 1);
      const out = '  '.repeat(pad) + trimmedLine;
      if (/^<[^!?/][^>]*[^/]?>$/.test(trimmedLine)) pad++;
      return out;
    }).filter(Boolean).join('\n');
  } catch (_e) {
    return null;
  }
}

export function detectCodeLanguage(text: string): string {
  const t = String(text || '');
  if (/(^|\n)\s*(SELECT|INSERT|UPDATE|DELETE)\s+/i.test(t)) return 'sql';
  if (/(^|\n)\s*(function|const|let|class|import|export)\b/.test(t) || /=>/.test(t)) return 'javascript';
  if (/(^|\n)\s*(def |class |import |from |if __name__ ==)/.test(t)) return 'python';
  if (/(^|\n)\s*(<\/?[A-Za-z_][\w:.-]*|<\?xml)/.test(t)) return 'xml';
  return 'text';
}

export function normalizeCodeLanguage(language: string): string {
  const lang = String(language || '').trim().toLowerCase();
  if (!lang) return '';
  if (lang === 'py') return 'python';
  if (lang === 'js') return 'javascript';
  if (lang === 'ts') return 'typescript';
  if (lang === 'yml') return 'yaml';
  return lang;
}

export function friendlyLanguageName(language: string): string {
  const lang = normalizeCodeLanguage(language) || 'text';
  if (lang === 'python') return 'Python';
  if (lang === 'javascript') return 'JavaScript';
  if (lang === 'typescript') return 'TypeScript';
  if (lang === 'sql') return 'SQL';
  if (lang === 'json') return 'JSON';
  if (lang === 'xml') return 'XML';
  if (lang === 'yaml') return 'YAML';
  if (lang === 'bash' || lang === 'shell') return 'Shell';
  return lang.toUpperCase();
}

export function looksLikeCode(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.split(/\r?\n/).length < 2) return false;
  let score = 0;
  if (/[{};]/.test(trimmed)) score++;
  if (/(^|\n)\s*(function|const|let|class|import|export|def|return|if|for|while)\b/.test(trimmed)) score++;
  if (/=>|<\/?[A-Za-z]/.test(trimmed)) score++;
  return score >= 2;
}

export function tableFromJson(value: any): { headers: string[]; rows: string[][] } | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return null;
  const headers: string[] = [];
  value.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!headers.includes(key)) headers.push(key);
    });
  });
  if (headers.length < 2) return null;
  const rows = value.map((row) => headers.map((key) => {
    const v = row[key];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }));
  return { headers, rows };
}

export function extractCodePayloadFromJson(value: any): { code: string; language: string } | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const language = normalizeCodeLanguage(value.language || value.lang || value.syntax || value.format);
  const candidates = ['code', 'source', 'script', 'program', 'content', 'text', 'body', 'query'];
  for (const key of candidates) {
    const candidate = value[key];
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (language || looksLikeCode(trimmed) || detectCodeLanguage(trimmed) !== 'text') {
      return {
        code: candidate,
        language: language || detectCodeLanguage(trimmed),
      };
    }
  }
  return null;
}
