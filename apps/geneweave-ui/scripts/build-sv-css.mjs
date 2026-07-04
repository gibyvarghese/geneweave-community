/**
 * Extracts the sv-* CSS block from styles.ts and writes dist/ui/sv.css.
 * Called as part of the build so dist/ui/sv.css is always in sync with styles.ts.
 * The file is served at /ui/sv.css and loaded via <link> injection by sv-css.ts,
 * bypassing the STYLES_CSP_HASH requirement on the server's embedded <style> tag.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const src = readFileSync(join(root, 'src', 'ui', 'styles.ts'), 'utf8');

// Extract :root vars block
const rootStart = src.indexOf(':root{');
const rootEnd = src.indexOf('}', rootStart) + 1;
const rootBlock = src.slice(rootStart, rootEnd);

// Extract dark-theme vars block
const darkStart = src.indexOf("html[data-theme='dark']{");
const darkEnd = src.indexOf('}', darkStart) + 1;
const darkBlock = src.slice(darkStart, darkEnd);

// Extract entire sv-* CSS block (from .sv-page to end of keyframes)
const svStart = src.indexOf('.sv-page{');
const svEnd = src.indexOf('@keyframes sv-fadein') +
  '@keyframes sv-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}'.length;
const svBlock = src.slice(svStart, svEnd);

const output = [
  '/* sv.css — SV feature styles, injected via <link> to bypass STYLES_CSP_HASH */',
  rootBlock,
  darkBlock,
  '.sv-hidden{display:none!important}',
  svBlock,
].join('\n');

mkdirSync(join(root, 'dist', 'ui'), { recursive: true });
writeFileSync(join(root, 'dist', 'ui', 'sv.css'), output);
console.log(`✓ sv.css built → ${join(root, 'dist', 'ui', 'sv.css')} (${output.length} bytes)`);
