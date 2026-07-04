// SPDX-License-Identifier: MIT
/**
 * geneWeave Notes — the left NOTEBOOKS rail (presentational), per the design handoff.
 *
 * The standalone Notes app's primary navigation: the brand lockup (click → back to the rest
 * of geneWeave), a search field with a ⌘K hint, a "NOTEBOOKS" tree of the user's notes (each a
 * doc-icon row; the open note is a mint pill with emerald text), and a "+ New note" footer.
 *
 * Dumb module: it takes the note list + handlers and renders. Secondary creators (templates,
 * capture, databases, ask-workspace) are NOT crammed in here — they live in the centre top-bar
 * "+ Insert" menu, keeping the rail as calm as the design.
 */
import { h } from './dom.js';
import { loadingPlaceholder } from './skeleton.js';
import type { NoteListItem } from './state.js';
import { wovenMarkSvg, wordmarkHtml } from './notes-brand.js';

export interface LeftRailOpts {
  notes: NoteListItem[];
  loading: boolean;
  currentNoteId: string | null;
  search: string;
  onSearch: (q: string) => void;
  onOpenNote: (id: string) => void;
  onToggleFav: (note: NoteListItem) => void;
  onNewNote: () => void;
  onTemplates: () => void;
  onArchived: () => void;
  onHome: () => void;
  /** Re-render the view (used when a notebook folder is expanded/collapsed). */
  onRerender?: () => void;
  /** Create a new sub-note nested under the given note (turns a note into a notebook folder). */
  onNewSubNote?: (parentId: string) => void;
  /** Collapse the notebooks rail (gives the note the full canvas width). */
  onToggleCollapse?: () => void;
}

const DOC_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h12l4 4v12H4z"/><path d="M8 9h6M8 13h8M8 17h5"/></svg>';
const CHEVRON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>';

// Which folders (notes that contain sub-notes) are expanded. Module-scoped so it survives re-renders;
// a folder defaults to open the first time it's seen.
const _expanded = new Set<string>();
const _seenFolders = new Set<string>();

function noteRow(note: NoteListItem, active: boolean, opts: LeftRailOpts, hasChildren: boolean, expanded: boolean, onToggle: () => void): HTMLElement {
  const isFav = note.favorite === 1;
  return h('div', {
    className: `gw-tree-row${active ? ' active' : ''}`,
    onClick: () => opts.onOpenNote(note.id),
  },
    hasChildren
      ? h('button', { className: `gw-tree-caret${expanded ? ' open' : ''}`, title: expanded ? 'Collapse' : 'Expand',
          onClick: (e: Event) => { e.stopPropagation(); onToggle(); }, innerHTML: CHEVRON })
      : h('span', { className: 'gw-tree-caret gw-tree-caret-none' }),
    note.icon && note.icon !== '📄'
      ? h('span', { className: 'gw-tree-emoji' }, note.icon)
      : h('span', { className: 'gw-tree-icon', innerHTML: DOC_ICON }),
    h('span', { className: 'gw-tree-label' }, note.title || 'Untitled'),
    opts.onNewSubNote
      ? h('button', { className: 'gw-tree-add', title: 'Add a note inside',
          onClick: (e: Event) => { e.stopPropagation(); opts.onNewSubNote!(note.id); } }, '+')
      : null,
    h('button', {
      className: `gw-tree-fav${isFav ? ' on' : ''}`,
      title: isFav ? 'Unfavourite' : 'Favourite',
      onClick: (e: Event) => { e.stopPropagation(); opts.onToggleFav(note); },
    }, isFav ? '★' : '☆'),
  );
}

/** Render a note and (if a folder) its nested children, recursively. */
function renderTreeNode(note: NoteListItem, childrenOf: Map<string, NoteListItem[]>, opts: LeftRailOpts, depth: number, out: HTMLElement, rerender: () => void): void {
  const kids = childrenOf.get(note.id) ?? [];
  const hasChildren = kids.length > 0;
  if (hasChildren && !_seenFolders.has(note.id)) { _seenFolders.add(note.id); _expanded.add(note.id); }
  const expanded = _expanded.has(note.id);
  const row = noteRow(note, opts.currentNoteId === note.id, opts, hasChildren, expanded, () => {
    if (_expanded.has(note.id)) _expanded.delete(note.id); else _expanded.add(note.id);
    rerender();
  });
  if (depth > 0) row.classList.add('gw-tree-child');
  out.appendChild(row);
  if (hasChildren && expanded) {
    const nest = h('div', { className: 'gw-tree-nest' });
    for (const k of kids) renderTreeNode(k, childrenOf, opts, depth + 1, nest, rerender);
    out.appendChild(nest);
  }
}

export function renderLeftRail(opts: LeftRailOpts): HTMLElement {
  const rerender = opts.onRerender ?? (() => { /* no-op */ });
  const favs = opts.notes.filter((n) => n.favorite);

  // Build the notebook TREE from parent_note_id: top-level notes are notebooks/folders, sub-notes nest
  // underneath (expandable). Notes whose parent isn't in the list are treated as top-level (no orphans lost).
  const ids = new Set(opts.notes.map((n) => n.id));
  const childrenOf = new Map<string, NoteListItem[]>();
  const roots: NoteListItem[] = [];
  for (const n of opts.notes) {
    const parent = n.parent_note_id && ids.has(n.parent_note_id) ? n.parent_note_id : null;
    if (parent) { (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(n); }
    else roots.push(n);
  }

  const searchInput = h('input', {
    className: 'gw-search-input', type: 'text', placeholder: 'Search notes',
    value: opts.search,
    onInput: (e: Event) => opts.onSearch((e.target as HTMLInputElement).value),
  }) as HTMLInputElement;

  return h('div', { className: 'gw-leftrail' },
    // brand (click → back to the rest of geneWeave) + a collapse control (« → hides the rail)
    h('div', { className: 'gw-leftrail-head' },
      h('button', { className: 'gw-brand', title: 'Back to geneWeave', onClick: opts.onHome },
        h('span', { className: 'gw-brand-mark', innerHTML: wovenMarkSvg(24, 'duo') }),
        h('span', { className: 'gw-brand-word', innerHTML: wordmarkHtml() }),
      ),
      opts.onToggleCollapse
        ? h('button', { className: 'gw-rail-collapse', type: 'button', title: 'Collapse sidebar', 'aria-label': 'Collapse sidebar',
            onClick: (e: Event) => { e.stopPropagation(); opts.onToggleCollapse!(); } }, '«')
        : null,
    ),
    // search
    h('div', { className: 'gw-search' },
      h('span', { className: 'gw-search-ic', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>' }),
      searchInput,
      h('span', { className: 'gw-kbd' }, '⌘K'),
    ),
    // tree
    (() => {
      const tree = h('div', { className: 'gw-tree gw-scroll', 'data-scroll-key': 'notes-list' });
      if (opts.loading) tree.appendChild(loadingPlaceholder('list', 'Loading your notes…'));
      if (favs.length > 0) {
        tree.appendChild(h('div', { className: 'gw-tree-label-row' }, 'FAVOURITES'));
        // Favourites are shown flat (a shortcut list), regardless of where they sit in the tree.
        for (const n of favs) tree.appendChild(noteRow(n, opts.currentNoteId === n.id, opts, false, false, () => {}));
      }
      tree.appendChild(h('div', { className: 'gw-tree-label-row' }, 'NOTEBOOKS'));
      for (const root of roots) renderTreeNode(root, childrenOf, opts, 0, tree, rerender);
      if (!opts.loading && opts.notes.length === 0) {
        tree.appendChild(h('div', { className: 'gw-tree-empty' }, 'No notes yet — start one below.'));
      }
      return tree;
    })(),
    // footer: + New note (with templates + archived affordances)
    h('button', { className: 'gw-newnote', onClick: opts.onNewNote },
      h('span', { className: 'gw-newnote-plus' }, '+'),
      h('span', null, 'New note'),
      h('span', { className: 'gw-newnote-tmpl', title: 'Start from a template', onClick: (e: Event) => { e.stopPropagation(); opts.onTemplates(); } }, 'templates'),
    ),
    h('button', { className: 'gw-newnote-archived', title: 'View + restore archived notes', onClick: opts.onArchived },
      h('span', { className: 'gw-newnote-archived-ic', innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>' }),
      h('span', null, 'Archived'),
    ),
  );
}
