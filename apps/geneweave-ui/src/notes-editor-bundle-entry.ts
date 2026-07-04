// notes-editor-bundle-entry.ts
// Bundled separately by esbuild into dist/ui/notes-editor.bundle.js.
// Exports everything the dynamic import in notes-editor.ts expects.

export { Editor } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { Placeholder } from '@tiptap/extension-placeholder';
export { BubbleMenu as BubbleMenuExtension } from '@tiptap/extension-bubble-menu';
export { FloatingMenu as FloatingMenuExtension } from '@tiptap/extension-floating-menu';
export { TaskList } from '@tiptap/extension-task-list';
export { TaskItem } from '@tiptap/extension-task-item';
export { Link } from '@tiptap/extension-link';
export { Underline } from '@tiptap/extension-underline';
// Real tables (planner / Cornell / charting layouts).
export { Table } from '@tiptap/extension-table';
export { TableRow } from '@tiptap/extension-table-row';
export { TableHeader } from '@tiptap/extension-table-header';
export { TableCell } from '@tiptap/extension-table-cell';

// weaveNotes Phase 1 — hand-rolled creative marks + nodes (no extra installs). Names
// match the @weaveintel/collab round-trip so creative content survives co-editing.
export {
  Highlight,
  TextColor,
  Callout,
  Toggle,
  ImageBlock,
  Sticker,
  WashiDivider,
  // weaveNotes Phase 4 — native ink + diagram nodes (render via the @weaveintel/notes SVG renderers).
  DiagramNode,
  InkCanvasNode,
} from './notes-creative-extensions.js';
