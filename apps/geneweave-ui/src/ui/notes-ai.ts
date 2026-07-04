// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 3 — front-end for the AI co-author.
 *
 * --- For someone new to this ---
 * This adds an "AI" toolbar to a note. You can ask the AI to CONTINUE writing,
 * REWRITE the note, SUMMARIZE it, or ANSWER a question — and, crucially, the AI's
 * output does NOT change your note straight away. It appears as a SUGGESTION you can
 * Accept (apply it) or Reject (throw it away). This "track-changes" approach is the
 * safe, mid-2026 way to let an AI edit a document: it never silently rewrites your
 * words. You can also drop in an "AI block" — a paragraph generated from a prompt
 * that remembers the prompt, so you can Refresh it later to regenerate.
 */
import { h } from './dom.js';
import { api } from './api.js';
import { wovenMarkSvg } from './notes-brand.js';
import { noticeDialog, confirmDialog, promptDialog } from "./dialog.js";

export interface NoteAiPanel {
  /** Re-fetch + re-render the pending suggestions list. */
  refresh(): Promise<void>;
  /** Tear down (no live resources today, but symmetric with the co-edit session). */
  close(): void;
}

interface Suggestion { id: string; action: string; status: string; preview: string; before?: string; authorKind: string }

/** A friendly label for what the AI proposed, by action (drives the diff-card header). */
function suggestionLabel(action: string): string {
  if (action === 'create_diagram') return 'AI suggested a diagram';
  if (action === 'draw_ink' || action === 'recolor_ink') return 'AI suggested a drawing';
  if (action === 'create_illustration' || action === 'generate_image') return 'AI suggested an image';
  if (action === 'restructure_note') return 'AI reorganised this note';
  if (action === 'apply_highlight' || action === 'apply_text_color' || action === 'colorize_semantic') return 'AI suggested colour';
  if (action === 'continue' || action === 'ai_block') return 'AI suggested an addition';
  return 'AI suggested an edit';
}

/**
 * Build the AI toolbar + suggestions panel for a note and wire all the actions.
 * `onApplied` is called after a suggestion is accepted / an AI block is inserted or
 * refreshed, so the host can reload the note content into the editor.
 */
export function wireNoteAi(opts: { noteId: string; toolbarEl: HTMLElement; panelEl: HTMLElement; onApplied: () => void }): NoteAiPanel {
  const { noteId, toolbarEl, panelEl, onApplied } = opts;

  async function runAction(action: 'continue' | 'rewrite' | 'summarize' | 'ask', instruction?: string): Promise<void> {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (instruction) body['instruction'] = instruction;
      const res = await api.post(`/api/me/notes/${noteId}/ai/${action}`, body);
      if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: string }; void noticeDialog({ message: `AI ${action} failed: ${e.error ?? res.status}` }); return; }
      await refresh(); // the new suggestion shows in the panel for review
    } finally { setBusy(false); }
  }

  // Reorganise the WHOLE note. Optionally the user dictates a section outline (one heading per
  // line); otherwise the AI picks the clearest structure. The endpoint routes per the tenant's
  // configured mode for 'restructure' (direct / agent / supervisor — set in the Builder); the result
  // arrives as one track-changes suggestion to review.
  async function restructure(): Promise<void> {
    const outline = await promptDialog({
      title: 'Reorganise this note',
      message: 'Optionally give a section order (one heading per line), or leave blank to let the AI choose the clearest structure.',
      placeholder: 'e.g.\nOverview\nKey decisions\nAction items',
      multiline: true,
      confirmLabel: 'Reorganise',
    });
    if (outline === null) return; // cancelled (blank string = AI chooses)
    setBusy(true);
    statusEl.textContent = 'The notes assistant is reorganising…';
    try {
      const body: Record<string, unknown> = {};
      if (outline.trim()) body['outline'] = outline.trim();
      const res = await api.post(`/api/me/notes/${noteId}/ai/restructure`, body);
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) { void noticeDialog({ message: `Restructure failed: ${data.error ?? 'the assistant did not produce a change'}` }); return; }
      await refresh(); // the reorganised note shows as a suggestion to review
    } finally { setBusy(false); }
  }

  async function insertBlock(): Promise<void> {
    const prompt = await promptDialog({
      title: 'Insert an AI block',
      message: 'Describe what to write. The block remembers this prompt, so you can Refresh it later to regenerate.',
      placeholder: 'e.g. A three-sentence summary of the key risks',
      multiline: true,
      required: true,
      confirmLabel: 'Insert',
    });
    if (!prompt) return;
    setBusy(true);
    try {
      const res = await api.post(`/api/me/notes/${noteId}/ai/insert-block`, { prompt, citation: 'note:self' });
      if (res.ok) onApplied(); else void noticeDialog({ message: 'Could not insert AI block.' });
    } finally { setBusy(false); }
  }

  async function resolve(id: string, decision: 'accept' | 'reject'): Promise<void> {
    setBusy(true);
    try {
      const res = await api.post(`/api/me/notes/${noteId}/suggestions/${id}/${decision}`, {});
      if (res.ok) { if (decision === 'accept') onApplied(); await refresh(); }
      else void noticeDialog({ message: `Could not ${decision} the suggestion.` });
    } finally { setBusy(false); }
  }

  function setBusy(b: boolean): void {
    toolbarEl.querySelectorAll('button').forEach((btn) => { (btn as HTMLButtonElement).disabled = b; });
    statusEl.textContent = b ? 'AI is thinking…' : '';
  }

  const statusEl = h('span', { className: 'notes-ai-status' }) as HTMLElement;

  // The AI toolbar.
  toolbarEl.innerHTML = '';
  toolbarEl.appendChild(
    h('div', { className: 'notes-ai-toolbar' },
      h('span', { className: 'notes-ai-label' }, '✨ AI'),
      h('button', { className: 'notes-ai-btn notes-ai-continue', title: 'Continue writing', onClick: () => void runAction('continue') }, 'Continue'),
      h('button', { className: 'notes-ai-btn notes-ai-rewrite', title: 'Rewrite the note', onClick: () => void runAction('rewrite') }, 'Rewrite'),
      h('button', { className: 'notes-ai-btn notes-ai-summarize', title: 'Summarize the note', onClick: () => void runAction('summarize') }, 'Summarize'),
      h('button', { className: 'notes-ai-btn notes-ai-ask', title: 'Ask the AI a question about this note', onClick: () => { void (async () => { const q = await promptDialog({ title: 'Ask AI about this note', placeholder: 'e.g. What are the open action items?', required: true, confirmLabel: 'Ask' }); if (q) void runAction('ask', q); })(); } }, 'Ask AI'),
      h('button', { className: 'notes-ai-btn notes-ai-restructure', title: 'Reorganise the whole note — reorder sections, fix the structure', onClick: () => void restructure() }, '⇅ Restructure'),
      h('button', { className: 'notes-ai-btn notes-ai-insert', title: 'Insert a refreshable AI block', onClick: () => void insertBlock() }, '＋ AI block'),
      statusEl,
    ),
  );

  /**
   * Render each pending AI suggestion as the design's INLINE track-changes card (GeneWeave
   * Notes.dc.html): a "AI suggested an edit" header, the old text struck-through + the new text on
   * mint, and ✓ Accept / ✕ Reject right in the note — not a plain text list. On a decision the card
   * flips to its resolved state ("AI edit accepted" / "kept yours") before the list refreshes.
   */
  function renderSuggestions(list: Suggestion[]): void {
    panelEl.innerHTML = '';
    if (list.length === 0) { panelEl.style.display = 'none'; return; }
    panelEl.style.display = '';
    for (const s of list) {
      const card = h('div', { className: 'notes-diff', 'data-suggestion': s.id }) as HTMLElement;
      // Header: woven mark + label.
      card.appendChild(h('div', { className: 'notes-diff-head' },
        h('span', { className: 'notes-diff-mark', innerHTML: wovenMarkSvg(13, 'ai') }),
        h('span', { className: 'notes-diff-title' }, suggestionLabel(s.action)),
        s.authorKind === 'agent' ? h('span', { className: 'notes-diff-by' }, 'from the assistant') : null,
      ));
      const bodyEl = h('div', { className: 'notes-diff-body' }) as HTMLElement;
      // Pending state: old (struck-through) when we have it, then new, then the action pills.
      const renderPending = (): void => {
        bodyEl.innerHTML = '';
        if (s.before && s.before.trim()) bodyEl.appendChild(h('div', { className: 'notes-diff-old' }, s.before.slice(0, 1200)));
        bodyEl.appendChild(h('div', { className: 'notes-diff-new' }, s.preview.slice(0, 1200)));
        bodyEl.appendChild(h('div', { className: 'notes-diff-actions' },
          h('button', { className: 'notes-diff-accept', onClick: () => void decide(s, 'accept') }, '✓ Accept'),
          h('button', { className: 'notes-diff-reject', onClick: () => void decide(s, 'reject') }, '✕ Reject'),
        ));
      };
      // Resolved state: the kept text + a small badge, briefly, before the list re-fetches.
      const renderResolved = (decision: 'accept' | 'reject'): void => {
        bodyEl.innerHTML = '';
        const kept = decision === 'accept' ? s.preview : (s.before || s.preview);
        bodyEl.appendChild(h('div', { className: 'notes-diff-resolved' },
          h('span', null, kept.slice(0, 1200)),
          h('span', { className: `notes-diff-badge ${decision === 'accept' ? 'accepted' : 'rejected'}` },
            decision === 'accept' ? 'AI edit accepted' : 'kept yours'),
        ));
      };
      const decide = async (sg: Suggestion, decision: 'accept' | 'reject'): Promise<void> => {
        renderResolved(decision);            // immediate design feedback
        await resolve(sg.id, decision);      // persist + (on accept) apply to the note + refresh
      };
      renderPending();
      card.appendChild(bodyEl);
      panelEl.appendChild(card);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const res = await api.get(`/api/me/notes/${noteId}/suggestions?status=pending`);
      if (!res.ok) { renderSuggestions([]); return; }
      const data = await res.json() as { suggestions: Suggestion[] };
      renderSuggestions(data.suggestions ?? []);
    } catch { renderSuggestions([]); }
  }

  void refresh();
  return { refresh, close() { /* nothing live to release */ } };
}
