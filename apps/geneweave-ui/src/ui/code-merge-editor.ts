// SPDX-License-Identifier: MIT
/**
 * In-app L2 code-conflict merge editor — a runtime wrapper around the bundled `@codemirror/merge` MergeView.
 *
 * The Upgrade Center opens a conflicted file here instead of sending the operator to the `upgrade/v<target>` git
 * branch. Modeled on the merge editors operators expect (VS Code / GitHub): a two-pane split with the incoming
 * release on the left (read-only) and the resolution on the right (editable), per-chunk **accept-incoming**
 * controls, collapsed unchanged regions, a live **unresolved-conflict count**, and **next-conflict navigation**.
 *   • LEFT  (read-only) = REMOTE — the file this release ships (the "incoming" reference);
 *   • RIGHT (editable)  = the base-informed diff3 auto-merge (`mergeCodeFile` output): clean hunks applied,
 *                         only true conflicts carrying `<<<<<<< ======= >>>>>>>` markers to resolve.
 * `revertControls: 'a-to-b'` puts a copy-chunk arrow on each changed hunk so the operator can accept the
 * incoming version without retyping; `collapseUnchanged` keeps the view focused on the conflicts.
 *
 * The heavy CodeMirror deps are served as a single sanctioned browser bundle at `/ui/codemirror-merge.bundle.js`
 * (built by scripts/bundle-codemirror-merge.mjs), dynamic-imported + cached on first use — the Upgrade Center
 * pays nothing for it until a conflict is actually opened.
 */

/** The named exports our bundle entry re-exports (see codemirror-merge-bundle-entry.ts). */
interface CmMergeBundle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MergeView: new (config: any) => { b: EditorViewLike; destroy(): void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  EditorView: { editable: { of(v: boolean): any }; updateListener: { of(fn: (u: { docChanged: boolean }) => void): any }; new (c: any): EditorViewLike };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keymap: { of(binds: any[]): any };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lineNumbers: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  history: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  historyKeymap: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultKeymap: any[];
}
/** The slice of the CodeMirror EditorView API we touch on the editable (right) pane. */
interface EditorViewLike {
  state: { doc: { toString(): string; lines: number; line(n: number): { number: number; from: number; text: string } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatch(spec: any): void;
  focus(): void;
}

let _bundle: CmMergeBundle | null = null;
/** Load + cache the codemirror-merge browser bundle (served by the /ui/* static route). */
async function loadBundle(): Promise<CmMergeBundle> {
  if (_bundle) return _bundle;
  // `as string` keeps the bundler/TS from resolving this runtime URL at build time — a raw browser import.
  const mod = await import('/ui/codemirror-merge.bundle.js' as string);
  _bundle = mod as unknown as CmMergeBundle;
  return _bundle;
}

/** The 1-based line numbers in the editable pane that still open a conflict (`<<<<<<<`). */
function conflictLines(view: EditorViewLike): number[] {
  const out: number[] = [];
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    if (doc.line(n).text.startsWith('<<<<<<<')) out.push(n);
  }
  return out;
}

/** A mounted merge editor. */
export interface CodeMergeEditorHandle {
  /** The current text of the editable (right) pane — the resolution to submit. */
  getResolved(): string;
  /** How many unresolved conflicts (`<<<<<<<` markers) remain in the editable pane. */
  unresolvedCount(): number;
  /** Move the cursor to (and scroll to) the next remaining conflict, cycling to the first. */
  gotoNextConflict(): void;
  /** Remove the editor from the DOM. */
  destroy(): void;
}

/**
 * Mount a split merge editor into `container`.
 * @param opts.container the element to mount into (its contents are replaced).
 * @param opts.remote the REMOTE file text (left, read-only reference).
 * @param opts.merged the base-informed pre-merge text (right, editable — what the operator resolves).
 * @param opts.onChange optional callback fired (with the current unresolved-conflict count) whenever the
 *   editable pane changes — lets the UI live-gate the Apply button + show the remaining count.
 * @returns a handle exposing getResolved / unresolvedCount / gotoNextConflict / destroy.
 */
export async function mountCodeMergeEditor(opts: {
  container: HTMLElement; remote: string; merged: string; onChange?: (unresolved: number) => void;
}): Promise<CodeMergeEditorHandle> {
  const cm = await loadBundle();
  opts.container.textContent = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bExtensions: any[] = [
    cm.history(), cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]), cm.lineNumbers(),
  ];
  if (opts.onChange) {
    const notify = (view: EditorViewLike): void => opts.onChange!(conflictLines(view).length);
    bExtensions.push(cm.EditorView.updateListener.of((u: { docChanged: boolean }) => { if (u.docChanged) notify(view.b); }));
  }
  const view = new cm.MergeView({
    a: { doc: opts.remote, extensions: [cm.EditorView.editable.of(false), cm.lineNumbers()] }, // REMOTE — read-only
    b: { doc: opts.merged, extensions: bExtensions },                                          // editable resolution
    parent: opts.container,
    revertControls: 'a-to-b',                 // per-chunk arrow: accept the incoming (left) version into the edit
    collapseUnchanged: { margin: 3, minSize: 4 }, // focus on the conflicts, not the whole file
    gutter: true,
    highlightChanges: true,
    orientation: 'a-b',
  });
  let cycle = 0; // round-robins gotoNextConflict through the remaining markers
  return {
    getResolved: () => view.b.state.doc.toString(),
    unresolvedCount: () => conflictLines(view.b).length,
    gotoNextConflict: () => {
      const lines = conflictLines(view.b);
      if (lines.length === 0) return;
      const target = view.b.state.doc.line(lines[cycle % lines.length]!);
      cycle++;
      view.b.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
      view.b.focus();
    },
    destroy: () => { try { view.destroy(); } catch { /* already gone */ } opts.container.textContent = ''; },
  };
}
