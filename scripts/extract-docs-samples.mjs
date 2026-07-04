#!/usr/bin/env node
// Extract every TypeScript code sample from apps/geneweave/src/docs-html.ts into standalone .ts files so
// they can be TYPE-CHECKED (`npm run test:docs-samples`). docs-html.ts is the single source of truth; the
// extracted files are generated (gitignored) and regenerated on every run.
//
// Two accommodations keep the check focused on what matters — that a sample's IMPORTS resolve and the
// framework APIs it uses are real — without inventing fake types:
//   • Builder-chain FRAGMENTS (a snippet shown mid-chain, e.g. `.addStep({...})`) get an `any` receiver so
//     they parse; the option objects are still shape-checked and stray syntax errors still surface.
//   • Illustrative FREE VARIABLES a sample leans on but never defines (e.g. `priceService`, `db`, `engine`)
//     are auto-declared `any` (found by a probe compile), so they don't drown out real errors.
// Genuine problems — a wrong import, a removed export, a bad property — still fail the check.
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcPath = join(root, 'apps/geneweave/src/docs-html.ts');
const outDir = join(root, 'apps/geneweave/docs-samples/.generated');

const source = readFileSync(srcPath, 'utf8');
const sf = ts.createSourceFile(srcPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// Guard: docs-html.ts must itself PARSE cleanly. A stray backtick or `${` in a sample comment silently
// closes the outer template literal and would mis-extract samples — catch it here, not downstream.
if (sf.parseDiagnostics?.length) {
  const d = sf.parseDiagnostics[0];
  const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
  process.stderr.write(`[extract-docs-samples] docs-html.ts has a PARSE error at ${line + 1}:${character + 1} — ` +
    `${ts.flattenDiagnosticMessageText(d.messageText, '\n')}\n(likely an unescaped \` or \${ inside a sample). Fix docs-html.ts first.\n`);
  process.exit(1);
}

function literalText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += '__interp__' + span.literal.text;
    return out;
  }
  return null;
}

const samples = [];
(function walk(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'code') {
    const [langArg, srcArg] = node.arguments;
    if (langArg && ts.isStringLiteral(langArg) && langArg.text === 'typescript' && srcArg) {
      const text = literalText(srcArg);
      if (text != null) samples.push(text);
    }
  }
  ts.forEachChild(node, walk);
})(sf);

/** Index of the first non-blank, non-comment line (or -1). */
function firstMeaningfulLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith('//')) return i;
  }
  return -1;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let n = 0;
for (const raw of samples) {
  n++;
  const id = String(n).padStart(3, '0');
  const lines = raw.replace(/\s+$/, '').split('\n');
  // A builder-chain FRAGMENT is a `.method(...)` shown mid-chain. It appears as a line starting with `.`
  // at a STATEMENT boundary (start of sample, or after a blank line / a `;` / a `}` — never after `)` or
  // an identifier, which are legitimate chain continuations). Turn each such leading `.` into `__chain.`
  // so it parses as a statement; `__chain` is `any`, so the option object is still shape-checked.
  let usedChain = false;
  let prevMeaningful = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { prevMeaningful = ''; continue; }
    const atBoundary = prevMeaningful === '' || /[;}]$/.test(prevMeaningful);
    if (t.startsWith('.') && atBoundary) {
      lines[i] = lines[i].replace(/^(\s*)\./, '$1__chain.');
      usedChain = true;
    }
    if (!t.startsWith('//')) prevMeaningful = t;
  }
  let header = usedChain ? '// (builder-chain fragment — receiver stubbed)\ndeclare const __chain: any;\n' : '';
  let body = lines.join('\n');
  // A top-level `return` means the sample is (or ends with) a function-body snippet ("use in your handler:
  // … return …"). `return` is illegal at module top level, so wrap the post-import portion in an async
  // function. Imports must stay at the top; everything after them goes inside the function body.
  if (/^\s*return[\s;]/m.test(body)) {
    const bl = body.split('\n');
    let lastImport = -1;
    for (let i = 0; i < bl.length; i++) if (/^\s*import[\s{*]/.test(bl[i]) || /^\s*}\s+from\s+['"]/.test(bl[i])) lastImport = i;
    const imports = bl.slice(0, lastImport + 1).join('\n');
    const rest = bl.slice(lastImport + 1).join('\n');
    body = (imports ? imports + '\n' : '') + `async function __demo() {\n${rest}\n}\nvoid __demo;`;
  }
  // Force MODULE scope on every sample (`export {}`). Otherwise a sample with no imports is a global SCRIPT,
  // and its top-level declarations (the `__chain`/placeholder stubs, or a `const db`) would collide with the
  // same names in another script-sample. As modules, each sample's scope is its own.
  writeFileSync(join(outDir, `sample-${id}.ts`), header + body + '\nexport {};\n');
}

// ── Probe compile → PER-FILE auto-declare illustrative free variables so real errors stand out. ─────────
// A sample leans on placeholder vars it never defines (`priceService`, `db`, `engine`). We stub only those,
// and only in the file that needs them (per-file, never global — so a `db` a different sample DECLARES is
// never redeclared). Both TS2304 (bare use) and TS18004 (shorthand `{ db }`) count as "free".
function probeMissingByFile() {
  let out = '';
  try {
    execSync('npx tsc --noEmit -p tsconfig.docs-samples.json', { cwd: root, stdio: 'pipe' });
  } catch (e) {
    out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
  }
  const byFile = new Map();
  const re = /(sample-\d+\.ts)\([^)]*\): error TS(?:2304: Cannot find name|18004: No value exists in scope for the shorthand property) '([^']+)'/g;
  for (const m of out.matchAll(re)) {
    if (!byFile.has(m[1])) byFile.set(m[1], new Set());
    byFile.get(m[1]).add(m[2]);
  }
  return byFile;
}
const byFile = probeMissingByFile();
let stubbed = 0;
for (const [file, names] of byFile) {
  const p = join(outDir, file);
  const body = readFileSync(p, 'utf8');
  // Never stub a name the sample itself declares in some scope (const/let/var/function/class) — that would
  // be a redeclaration. Only genuine placeholders get an ambient `any`.
  const declared = new Set([...body.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  // Also treat every import-bound name as declared (import { a, b as c }, import d, import * as e).
  for (const im of body.matchAll(/import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)|\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})/g)) {
    if (im[1]) declared.add(im[1]);
    if (im[2]) declared.add(im[2]);
    if (im[3]) for (const part of im[3].split(',')) { const nm = part.trim().split(/\s+as\s+/).pop()?.trim(); if (nm) declared.add(nm); }
  }
  // Never stub our own sentinels or names the sample already binds.
  const stubs = [...names].filter((x) => !declared.has(x) && !x.startsWith('__'));
  if (!stubs.length) continue;
  writeFileSync(p, stubs.map((x) => `declare const ${x}: any;`).join('\n') + ' // illustrative placeholders\n' + body);
  stubbed += stubs.length;
}

writeFileSync(join(outDir, '.gitignore'), '*\n');
process.stdout.write(`[extract-docs-samples] ${n} samples → ${outDir}` + (stubbed ? ` (+${stubbed} stubbed free vars in ${byFile.size} files)` : '') + '\n');
