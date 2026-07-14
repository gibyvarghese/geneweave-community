// SPDX-License-Identifier: MIT
/**
 * In-app L2 code-conflict merge editor — a thin runtime wrapper around the bundled `@codemirror/merge` MergeView.
 *
 * The Upgrade Center opens a conflicted file here instead of sending the operator to the `upgrade/v<target>` git
 * branch. It shows a two-pane split:
 *   • LEFT  (read-only) = REMOTE — the file this release ships (the "incoming" reference);
 *   • RIGHT (editable)  = the base-informed diff3 auto-merge (`mergeCodeFile` output): clean hunks already
 *                         applied, only true conflicts carrying `<<<<<<< ======= >>>>>>>` markers to resolve.
 * The operator edits the right pane to remove the markers, then `getResolved()` returns its text — which the
 * caller POSTs to `/admin/upgrade/code/conflict/resolve` (that endpoint refuses any text still carrying markers).
 *
 * The heavy CodeMirror deps are served as a single sanctioned browser bundle at `/ui/codemirror-merge.bundle.js`
 * (built by scripts/bundle-codemirror-merge.mjs), matching how the notes editor bundles TipTap. The bundle is
 * dynamic-imported and cached the first time a conflict is opened, so the Upgrade Center pays nothing for it
 * until it's actually used.
 */

/** The named exports our bundle entry re-exports (see codemirror-merge-bundle-entry.ts). */
interface CmMergeBundle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MergeView: new (config: any) => { b: { state: { doc: { toString(): string } } }; destroy(): void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  EditorView: { editable: { of(v: boolean): any }; lineWrapping: any };
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

let _bundle: CmMergeBundle | null = null;
/** Load + cache the codemirror-merge browser bundle (served by the /ui/* static route). */
async function loadBundle(): Promise<CmMergeBundle> {
  if (_bundle) return _bundle;
  // `as string` keeps the bundler/TS from trying to resolve this runtime URL at build time — it's a raw browser
  // dynamic import of the absolute served path.
  const mod = await import('/ui/codemirror-merge.bundle.js' as string);
  _bundle = mod as unknown as CmMergeBundle;
  return _bundle;
}

/** A mounted merge editor: read the operator's resolution, or tear it down. */
export interface CodeMergeEditorHandle {
  /** The current text of the editable (right) pane — the resolution to submit. */
  getResolved(): string;
  /** Remove the editor from the DOM. */
  destroy(): void;
}

/**
 * Mount a split merge editor into `container`.
 * @param opts.container the element to mount into (its contents are replaced).
 * @param opts.remote the REMOTE file text (left, read-only reference).
 * @param opts.merged the base-informed pre-merge text (right, editable — what the operator resolves).
 * @returns a handle exposing `getResolved()` + `destroy()`.
 */
export async function mountCodeMergeEditor(opts: { container: HTMLElement; remote: string; merged: string }): Promise<CodeMergeEditorHandle> {
  const cm = await loadBundle();
  opts.container.textContent = '';
  const view = new cm.MergeView({
    a: { doc: opts.remote, extensions: [cm.EditorView.editable.of(false), cm.lineNumbers()] },      // REMOTE — read-only
    b: { doc: opts.merged, extensions: [cm.history(), cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap]), cm.lineNumbers()] }, // editable resolution
    parent: opts.container,
  });
  return {
    getResolved: () => view.b.state.doc.toString(),
    destroy: () => { try { view.destroy(); } catch { /* already gone */ } opts.container.textContent = ''; },
  };
}
