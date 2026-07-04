// Build step: generate the geneWeave design-token CSS into a plain string module. The geneWeave BRAND
// (palette, `--gw-*` names, agency + Pro/Creative tokens) lives in ../src/brand/geneweave-brand.ts and
// is composed on the brand-neutral @weaveintel/tokens ENGINE (the palette/prefix are INPUT). This runs
// in NODE at build time — the browser-served styles.ts must NOT import a workspace package directly
// (raw-served ESM can't resolve a bare specifier), so we inline the generated CSS as a literal string.
//
// The brand is TypeScript and runs before `tsc`, so we bundle it on the fly with esbuild (the engine is
// bundled in from its built dist) into a temp ESM module, then call it.
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const brandEntry = fileURLToPath(new URL('../src/brand/geneweave-brand.ts', import.meta.url));
const out = fileURLToPath(new URL('../src/ui/tokens.generated.ts', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'gw-brand-'));
const bundled = join(tmp, 'brand.mjs');
await build({ entryPoints: [brandEntry], bundle: true, format: 'esm', platform: 'node', outfile: bundled });
const { geneweaveThemeCss } = await import(pathToFileURL(bundled).href);

const css = geneweaveThemeCss();
const banner = '// AUTO-GENERATED from the geneWeave brand (src/brand/) composed on @weaveintel/tokens by scripts/gen-tokens-css.mjs — do not edit by hand.\n// Run `npm run build` (or `node scripts/gen-tokens-css.mjs`) to regenerate.\n';
writeFileSync(out, `${banner}/* eslint-disable */\nexport const TOKENS_CSS = ${JSON.stringify(css)};\n`);
rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`[gen-tokens-css] wrote ${css.length} bytes of design-token CSS → ${out}\n`);
