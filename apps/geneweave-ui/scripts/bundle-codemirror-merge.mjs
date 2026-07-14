#!/usr/bin/env node
// Bundle @codemirror/merge (+ view/state/commands) into a single ESM file served at /ui/codemirror-merge.bundle.js
// Same sanctioned-bundle pattern as bundle-notes-editor.mjs: the admin UI ships tsc ES modules and does not
// bundle npm deps for the browser, except one bundle per heavy editor dep. This one powers the in-app L2
// code-conflict merge view (ui/code-merge-editor.ts dynamic-imports the output).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

await build({
  entryPoints: [join(root, 'src', 'codemirror-merge-bundle-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  outfile: join(root, 'dist', 'ui', 'codemirror-merge.bundle.js'),
  minify: process.env['NODE_ENV'] === 'production',
  sourcemap: process.env['NODE_ENV'] !== 'production',
  metafile: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env['NODE_ENV'] ?? 'development'),
  },
});

console.log('✓ codemirror-merge.bundle.js built →', join(root, 'dist', 'ui', 'codemirror-merge.bundle.js'));
