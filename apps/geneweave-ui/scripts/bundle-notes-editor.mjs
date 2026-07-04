#!/usr/bin/env node
// Bundle @tiptap/* and ProseMirror into a single ESM file served at /ui/notes-editor.bundle.js
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

await build({
  entryPoints: [join(root, 'src', 'notes-editor-bundle-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  outfile: join(root, 'dist', 'ui', 'notes-editor.bundle.js'),
  minify: process.env['NODE_ENV'] === 'production',
  sourcemap: process.env['NODE_ENV'] !== 'production',
  metafile: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env['NODE_ENV'] ?? 'development'),
  },
});

console.log('✓ notes-editor.bundle.js built →', join(root, 'dist', 'ui', 'notes-editor.bundle.js'));
