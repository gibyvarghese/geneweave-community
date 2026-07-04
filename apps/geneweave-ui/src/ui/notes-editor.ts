/**
 * notes-editor.ts — Tiptap editor island (WC6)
 *
 * Mounts a Tiptap editor into a provided container div. The module uses a
 * dynamic import of /notes-editor.bundle.js (a separately-bundled ESM file
 * containing @tiptap/core, @tiptap/starter-kit, and extensions). This keeps
 * the main ui-client.js bundle free of ProseMirror's large dependency tree.
 *
 * Features:
 *   • Blocks: paragraph, heading (1-3), bulletList, orderedList, taskList,
 *     blockquote, codeBlock, horizontalRule
 *   • Markdown input shortcuts (e.g. ## → heading, - → bullet)
 *   • Bubble toolbar: Bold / Italic / Strike / Code / Link
 *   • Slash command menu: floating "/ command" trigger for block insertion
 *   • Placeholder text when editor is empty
 *   • Auto-save: debounced 1.5s after last keystroke, calls onSave(doc_json)
 *
 * The bundle is loaded on first mount and cached in _bundle. Subsequent mounts
 * within the same page lifetime reuse the same bundle.
 */

import { promptDialog } from './dialog.js';

// ── Bundle cache ──────────────────────────────────────────────────────────────

type TiptapExtension = { configure?: (opts: Record<string, unknown>) => unknown; [k: string]: unknown };
type TiptapBundle = {
  Editor: new (opts: Record<string, unknown>) => TiptapEditor;
  StarterKit: TiptapExtension;
  Placeholder: TiptapExtension;
  BubbleMenuExtension: TiptapExtension;
  FloatingMenuExtension: TiptapExtension;
  TaskList: TiptapExtension;
  TaskItem: TiptapExtension;
  Link: TiptapExtension;
  Underline: TiptapExtension;
  // weaveNotes Phase 1 creative marks + nodes.
  Highlight: TiptapExtension;
  TextColor: TiptapExtension;
  Callout: TiptapExtension;
  Toggle: TiptapExtension;
  ImageBlock: TiptapExtension;
  Sticker: TiptapExtension;
  WashiDivider: TiptapExtension;
  // weaveNotes Phase 4 creative nodes.
  DiagramNode: TiptapExtension;
  InkCanvasNode: TiptapExtension;
  // Tables (planner / Cornell / charting layouts).
  Table: TiptapExtension;
  TableRow: TiptapExtension;
  TableHeader: TiptapExtension;
  TableCell: TiptapExtension;
};

type TiptapEditor = {
  destroy(): void;
  getJSON(): unknown;
  commands: Record<string, (...args: unknown[]) => unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain(): { focus(): { run(): void; [k: string]: any }; [k: string]: any };
  isDestroyed: boolean;
  on(event: string, handler: (props: Record<string, unknown>) => void): void;
};

let _bundle: TiptapBundle | null = null;

async function loadBundle(): Promise<TiptapBundle> {
  if (_bundle) return _bundle;
  // The bundle is served at /ui/notes-editor.bundle.js — matches the /ui/* static route.
  const mod = await import('/ui/notes-editor.bundle.js' as string);
  _bundle = mod as TiptapBundle;
  return _bundle;
}

// ── Bubble toolbar ────────────────────────────────────────────────────────────

/** The four highlighter swatches (spec §10.2) — kept in sync with @weaveintel/notes HIGHLIGHTER_SWATCHES. */
const HIGHLIGHT_SWATCHES = [
  { key: 'amber', color: '#FAC775' },
  { key: 'pink', color: '#F4C0D1' },
  { key: 'teal', color: '#9FE1CB' },
  { key: 'blue', color: '#B5D4F4' },
];
/** A small palette of accessible text colours (excludes the AI-reserved emerald/mint). */
const TEXT_COLORS = ['#14201B', '#D85A30', '#D98A3D', '#0B7A57', '#3B6FB0', '#8254C8'];

function buildBubbleToolbar(editor: TiptapEditor): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'notes-bubble-toolbar';

  const addBtn = (label: string, action: () => void, title?: string) => {
    const el = document.createElement('button');
    el.className = 'notes-bubble-btn';
    el.textContent = label;
    if (title) el.title = title;
    el.onmousedown = (e) => { e.preventDefault(); action(); };
    toolbar.appendChild(el);
    return el;
  };

  addBtn('B', () => editor.chain().focus()['toggleBold']?.().run(), 'Bold');
  addBtn('I', () => editor.chain().focus()['toggleItalic']?.().run(), 'Italic');
  addBtn('S̶', () => editor.chain().focus()['toggleStrike']?.().run(), 'Strikethrough');
  addBtn('U', () => editor.chain().focus()['toggleUnderline']?.().run(), 'Underline');
  addBtn('<>', () => editor.chain().focus()['toggleCode']?.().run(), 'Inline code');

  const sep = document.createElement('span'); sep.className = 'notes-bubble-sep'; toolbar.appendChild(sep);

  // Highlighter swatches (multi-colour) + clear.
  for (const sw of HIGHLIGHT_SWATCHES) {
    const el = document.createElement('button');
    el.className = 'notes-bubble-swatch';
    el.title = `Highlight ${sw.key}`;
    el.style.background = sw.color;
    el.onmousedown = (e) => { e.preventDefault(); editor.chain().focus()['toggleHighlight']?.({ color: sw.color }).run(); };
    toolbar.appendChild(el);
  }
  addBtn('⌫', () => editor.chain().focus()['unsetHighlight']?.().run(), 'Clear highlight');

  const sep2 = document.createElement('span'); sep2.className = 'notes-bubble-sep'; toolbar.appendChild(sep2);

  // Text colour: a little "A" that opens a colour row.
  const colorWrap = document.createElement('span');
  colorWrap.className = 'notes-bubble-colorwrap';
  const aBtn = addBtn('A', () => { colorWrap.classList.toggle('open'); }, 'Text colour');
  aBtn.classList.add('notes-bubble-color-a');
  for (const c of TEXT_COLORS) {
    const dot = document.createElement('button');
    dot.className = 'notes-bubble-colordot';
    dot.style.background = c;
    dot.onmousedown = (e) => { e.preventDefault(); editor.chain().focus()['setTextColor']?.(c).run(); colorWrap.classList.remove('open'); };
    colorWrap.appendChild(dot);
  }
  toolbar.appendChild(colorWrap);

  return toolbar;
}

// ── Slash command menu ────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { label: '# Heading 1', icon: 'H1', action: (editor: TiptapEditor) => { editor.chain().focus()['setHeading']?.({ level: 1 }).run(); } },
  { label: '## Heading 2', icon: 'H2', action: (editor: TiptapEditor) => { editor.chain().focus()['setHeading']?.({ level: 2 }).run(); } },
  { label: '### Heading 3', icon: 'H3', action: (editor: TiptapEditor) => { editor.chain().focus()['setHeading']?.({ level: 3 }).run(); } },
  { label: '• Bullet list', icon: '•', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleBulletList']?.().run(); } },
  { label: '1. Ordered list', icon: '1.', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleOrderedList']?.().run(); } },
  { label: '☐ To-do list', icon: '☐', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleTaskList']?.().run(); } },
  { label: '" Blockquote', icon: '"', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleBlockquote']?.().run(); } },
  { label: '``` Code block', icon: '<>', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleCodeBlock']?.().run(); } },
  { label: '── Divider', icon: '──', action: (editor: TiptapEditor) => { editor.chain().focus()['setHorizontalRule']?.().run(); } },
  // weaveNotes Phase 1 creative blocks.
  { label: 'Callout — note', icon: '📝', action: (editor: TiptapEditor) => { editor.chain().focus()['setCallout']?.({ tone: 'note' }).run(); } },
  { label: 'Callout — tip', icon: '💡', action: (editor: TiptapEditor) => { editor.chain().focus()['setCallout']?.({ tone: 'tip' }).run(); } },
  { label: 'Callout — warning', icon: '⚠️', action: (editor: TiptapEditor) => { editor.chain().focus()['setCallout']?.({ tone: 'warning' }).run(); } },
  { label: 'Toggle list', icon: '▸', action: (editor: TiptapEditor) => { editor.chain().focus()['setToggle']?.({ summary: 'Details' }).run(); } },
  { label: 'Table', icon: '▦', action: (editor: TiptapEditor) => { editor.chain().focus()['insertTable']?.({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
  { label: 'Image embed', icon: '🖼', action: (editor: TiptapEditor) => { void (async () => { const src = await promptDialog({ title: 'Embed an image', message: 'Paste an image URL (https:// or data:image).', placeholder: 'https://…', required: true, confirmLabel: 'Embed' }); if (src) editor.chain().focus()['setImage']?.({ src, alt: '' }).run(); })(); } },
  { label: 'Sticker ✨', icon: '✨', action: (editor: TiptapEditor) => { editor.chain().focus()['setSticker']?.({ emoji: '✨' }).run(); } },
  { label: 'Washi divider', icon: '🎀', action: (editor: TiptapEditor) => { editor.chain().focus()['setWashiDivider']?.({ pattern: 'tape' }).run(); } },
  // weaveNotes Phase 4 creative blocks.
  { label: 'Ink canvas', icon: '✏️', action: (editor: TiptapEditor) => { editor.chain().focus()['setInkCanvas']?.({ strokes: [], author: 'user' }).run(); } },
  { label: 'Diagram', icon: '🔗', action: (editor: TiptapEditor) => { editor.chain().focus()['setDiagram']?.({ scene: { kind: 'flow', nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'Next' }], edges: [{ from: 'a', to: 'b' }] }, kind: 'flow' }).run(); } },
];

function buildSlashMenu(editor: TiptapEditor, query: string, onClose: () => void): HTMLElement {
  const lower = query.toLowerCase();
  const filtered = lower
    ? SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(lower))
    : SLASH_COMMANDS;

  const menu = document.createElement('div');
  menu.className = 'notes-slash-menu';

  for (const cmd of filtered.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'notes-slash-item';
    item.innerHTML = `<span class="notes-slash-icon">${cmd.icon}</span><span>${cmd.label}</span>`;
    item.onmousedown = (e) => {
      e.preventDefault();
      cmd.action(editor);
      onClose();
    };
    menu.appendChild(item);
  }

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-slash-empty';
    empty.textContent = 'No commands found';
    menu.appendChild(empty);
  }

  return menu;
}

// ── Mount ─────────────────────────────────────────────────────────────────────

export interface EditorInstance {
  destroy(): void;
  getJSON(): unknown;
  /**
   * Run a TipTap command by name against the editor, re-focusing first so the stored selection is
   * restored (a toolbar button steals DOM focus; `.focus()` puts the caret/selection back before the
   * command applies). Powers the main formatting tool strip. e.g. cmd('toggleBold'), cmd('setHeading', {level:2}).
   */
  cmd(name: string, arg?: unknown): void;
  /** weaveNotes Phase 3: the local caret/selection as ProseMirror positions (for live cursors). */
  getSelection(): { anchor: number; head: number; empty: boolean } | null;
  /** weaveNotes Phase 3: screen coordinates of a ProseMirror position (to draw a remote caret). */
  coordsAtPos(pos: number): { left: number; top: number; bottom: number } | null;
  /** weaveNotes Phase 3: the document size, to clamp a remote position that moved. */
  docSize(): number;
}

export async function mountNotesEditor(opts: {
  container: HTMLElement;
  initialDocJson: string;
  onSave: (docJson: string) => Promise<void>;
  placeholder?: string;
  readOnly?: boolean;
  /** weaveNotes Phase 3: called whenever the local selection/caret moves (for cursor broadcast). */
  onSelectionChange?: () => void;
  /** Called on EVERY local doc change (before the debounced save) so the host can mark an edit as
   *  pending — e.g. so a remote-echo reload doesn't clobber an unsaved edit that didn't focus the
   *  editor (a diagram/ink toolbar button). */
  onLocalEdit?: () => void;
}): Promise<EditorInstance> {
  const { container, initialDocJson, onSave, placeholder = 'Start writing… type / for commands', readOnly = false } = opts;

  let doc: unknown;
  try { doc = JSON.parse(initialDocJson); } catch { doc = { type: 'doc', content: [] }; }

  const bundle = await loadBundle();

  // Containers
  const editorEl = document.createElement('div');
  editorEl.className = 'notes-editor-content';
  container.appendChild(editorEl);

  // Bubble menu container
  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'notes-bubble-wrapper';
  bubbleEl.style.display = 'none';
  container.appendChild(bubbleEl);

  // Slash menu state
  let slashMenu: HTMLElement | null = null;
  let slashQuery = '';

  function closeSlashMenu() {
    slashMenu?.remove();
    slashMenu = null;
    slashQuery = '';
  }

  // Auto-save debounce
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave(editorInstance: TiptapEditor) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const json = JSON.stringify(editorInstance.getJSON());
      try { await onSave(json); } catch (e) { console.warn('[notes-editor] auto-save failed', e); }
    }, 1500);
  }

  const editor = new bundle.Editor({
    element: editorEl,
    editable: !readOnly,
    content: doc,
    extensions: [
      bundle.StarterKit,
      bundle.TaskList,
      bundle.TaskItem,
      bundle.Underline,
      bundle.Link,
      // weaveNotes Phase 1 creative marks + nodes.
      bundle.Highlight,
      bundle.TextColor,
      bundle.Callout,
      bundle.Toggle,
      bundle.ImageBlock,
      bundle.Sticker,
      bundle.WashiDivider,
      // weaveNotes Phase 4 creative nodes.
      bundle.DiagramNode,
      bundle.InkCanvasNode,
      // Tables (planner / Cornell / charting layouts) — resizable, with header cells.
      bundle.Table?.configure?.({ resizable: true, HTMLAttributes: { class: 'gw-table' } }) ?? bundle.Table,
      bundle.TableRow,
      bundle.TableHeader,
      bundle.TableCell,
      bundle.Placeholder?.configure?.({ placeholder }) ?? bundle.Placeholder,
    ].filter(Boolean),
    onUpdate: ({ editor: ed }: { editor: TiptapEditor }) => {
      opts.onLocalEdit?.(); // mark an edit as pending immediately (the save is debounced 1.5s)
      scheduleSave(ed);
    },
    onSelectionUpdate: ({ editor: ed }: { editor: TiptapEditor }) => {
      // Show bubble toolbar when text is selected
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && !readOnly) {
        bubbleEl.style.display = 'block';
        bubbleEl.innerHTML = '';
        bubbleEl.appendChild(buildBubbleToolbar(ed));
      } else {
        bubbleEl.style.display = 'none';
      }
      // Phase 3: tell the host the caret moved (it broadcasts the live cursor).
      opts.onSelectionChange?.();
    },
  });

  // Slash command: detect "/" at start of line
  editorEl.addEventListener('keyup', (e) => {
    if (readOnly) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const text = selection.anchorNode?.textContent ?? '';
    const offset = selection.anchorOffset;
    const lineText = text.slice(0, offset);

    if (lineText.endsWith('/') || (slashMenu && lineText.includes('/'))) {
      const slashIdx = lineText.lastIndexOf('/');
      slashQuery = lineText.slice(slashIdx + 1);

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      if (slashMenu) {
        slashMenu.remove();
      }
      slashMenu = buildSlashMenu(editor, slashQuery, () => {
        closeSlashMenu();
        // Delete the /command text from the editor
        if (editor && !editor.isDestroyed) {
          editor.commands['deleteRange']?.({ from: (editor as any).state.selection.from - slashQuery.length - 1, to: (editor as any).state.selection.from });
        }
      });
      slashMenu.style.position = 'fixed';
      slashMenu.style.top = `${rect.bottom + window.scrollY + 4}px`;
      slashMenu.style.left = `${rect.left}px`;
      document.body.appendChild(slashMenu);
    } else if (e.key === 'Escape' || !lineText.includes('/')) {
      closeSlashMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (slashMenu && !slashMenu.contains(e.target as Node)) closeSlashMenu();
  }, { once: false });

  // Reach into the ProseMirror view/state for live-cursor read-out (Phase 3).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pm = editor as any;
  return {
    destroy() {
      if (saveTimer) clearTimeout(saveTimer);
      closeSlashMenu();
      editor.destroy();
    },
    cmd(name: string, arg?: unknown) {
      try {
        const c = editor.chain().focus() as Record<string, (a?: unknown) => { run: () => void }>;
        const fn = c[name];
        if (typeof fn === 'function') fn.call(c, arg).run();
      } catch { /* command unavailable / editor not ready */ }
    },
    getJSON() {
      return editor.getJSON();
    },
    getSelection() {
      try {
        const sel = pm.state?.selection;
        if (!sel) return null;
        return { anchor: Number(sel.from), head: Number(sel.to), empty: !!sel.empty };
      } catch { return null; }
    },
    coordsAtPos(pos: number) {
      try {
        const size = pm.state?.doc?.content?.size ?? 0;
        const p = Math.max(0, Math.min(pos, size));
        const c = pm.view?.coordsAtPos(p);
        return c ? { left: c.left, top: c.top, bottom: c.bottom } : null;
      } catch { return null; }
    },
    docSize() {
      try { return Number(pm.state?.doc?.content?.size ?? 0); } catch { return 0; }
    },
  };
}
