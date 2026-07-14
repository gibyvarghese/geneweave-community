// SPDX-License-Identifier: MIT
/**
 * Browser bundle entry for the in-app code-conflict merge editor (@codemirror/merge).
 *
 * The admin UI is served as tsc-compiled ES modules and does NOT bundle npm deps for the browser — with one
 * sanctioned exception per heavy editor dep (see notes-editor-bundle-entry.ts / bundle-notes-editor.mjs). This
 * is the second: esbuild bundles `@codemirror/*` into `dist/ui/codemirror-merge.bundle.js`, which the server's
 * generic `/ui/*` static route serves. The runtime (ui/code-merge-editor.ts) dynamic-imports it and reads these
 * named exports off the module object — no window global.
 *
 * Kept minimal on purpose: MergeView (the split accept/edit view) + the smallest editing surface (history +
 * default keymap) so the operator can edit and undo while resolving. No language/syntax packages — a code
 * conflict is resolved by choosing lines, not by IDE features, and every extra package inflates the bundle.
 */
export { MergeView } from '@codemirror/merge';
export { EditorView, keymap, lineNumbers } from '@codemirror/view';
export { EditorState } from '@codemirror/state';
export { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
