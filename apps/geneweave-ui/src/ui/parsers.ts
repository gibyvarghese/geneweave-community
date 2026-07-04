// Parsing and data formatting utilities

export function parseJsonMaybe(txt: string): any {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

export function parseDelimitedLine(line: string, delim: string = ','): string[] {
  if (!line) return [];
  return line
    .split(delim)
    .map((s) => s.trim())
    .filter((s) => s);
}

export function parseDelimitedTable(text: string, delim: string = ','): { headers: string[]; rows: string[][] } {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseDelimitedLine(lines[0]!, delim);
  const rows = lines.slice(1).map((line) => parseDelimitedLine(line, delim));

  return { headers, rows };
}

export function formatXml(xml: string): string {
  if (!xml) return '';
  try {
    let formatted = '';
    let indent = '';
    xml.replace(/(<[^>]+>)/g, (match: string) => {
      if (match.startsWith('</')) {
        indent = indent.slice(0, -2);
        formatted += indent + match + '\n';
      } else if (match.endsWith('/>')) {
        formatted += indent + match + '\n';
      } else {
        formatted += indent + match + '\n';
        indent += '  ';
      }
      return '';
    });
    return formatted;
  } catch (e) {
    return xml;
  }
}

export function detectCodeLanguage(code: string): string {
  if (!code) return 'text';

  code = code.toLowerCase();

  if (/^<[!?]?html|DOCTYPE|<script|<style/.test(code)) return 'html';
  if (/^<\?xml|<[a-z]+[^>]*>/.test(code)) return 'xml';
  if (/^[\{].*[\}]$|^\[.*\]$|"[\w_-]+"\s*:/.test(code)) return 'json';
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\s/i.test(code)) return 'sql';
  if (code?.startsWith('#!') || /^(def |class |import |from )/.test(code)) return 'python';
  if (/^(function |const |let |var |=>|async |await )/.test(code)) return 'javascript';
  if (/^(pub |fn |impl |match |let )/.test(code)) return 'rust';
  if (/^(func |let |var |import )/.test(code)) return 'swift';
  if (/^(class |interface |public |private )/.test(code)) return 'java';

  return 'text';
}

export function normalizeCodeLanguage(lang: string): string {
  const map: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    java: 'java',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
  };
  return map[lang?.toLowerCase() || ''] || lang || 'text';
}

export function friendlyLanguageName(lang: string): string {
  const names: Record<string, string> = {
    python: 'Python',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    json: 'JSON',
    sql: 'SQL',
    xml: 'XML',
    html: 'HTML',
    css: 'CSS',
    bash: 'Bash',
    rust: 'Rust',
    java: 'Java',
    csharp: 'C#',
    cpp: 'C++',
    c: 'C',
    go: 'Go',
    swift: 'Swift',
    kotlin: 'Kotlin',
    ruby: 'Ruby',
    php: 'PHP',
    yaml: 'YAML',
    markdown: 'Markdown',
    text: 'Text',
  };
  return names[lang?.toLowerCase() || ''] || lang || 'Text';
}

export function looksLikeCode(txt: string): boolean {
  if (!txt || txt.length < 10) return false;
  const indicators = [
    /^[\s]*function\s+/,
    /^[\s]*(const|let|var)\s+/,
    /^[\s]*(class|interface|type)\s+/,
    /^[\s]*(import|from|require)\s+/,
    /^[\s]*(public|private|protected)\s+/,
    /<=|>=|===|!==|=>|\?:|&&|\|\|/,
    /\n[\s]*(if|for|while|switch|try|catch)\s*\(/,
    /^<[a-z!?][\s\S]*>/,
    /::|:=|fn\s+\w+|def\s+\w+/,
  ];
  return indicators.some((re) => re.test(txt));
}
