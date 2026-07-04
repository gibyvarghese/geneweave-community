// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 5 — the STUDY (flashcard review) screen.
 *
 * --- For someone new to this ---
 * This is the "quiz yourself" screen. The assistant turns a note into question→answer cards, and
 * here you review the ones that are DUE today: you see the question, try to recall the answer,
 * reveal it, then tap how it went — Again / Hard / Good / Easy. Behind the scenes a spaced-
 * repetition scheduler (FSRS, the accurate memory-model scheduler — or classic SM-2 when an admin
 * turns FSRS off) decides when you'll see each card again — soon if you forgot, much later if it
 * was easy — which is the most effective way to actually remember things. Each button shows the
 * REAL predicted next-review date the scheduler computed for that card.
 *
 * It is a self-contained centre panel (no framework): it fetches the note's deck, walks the due
 * queue, and updates its own DOM as you grade — it never reloads the whole notes view mid-session.
 */
import { h } from './dom.js';
import { api } from './api.js';
import { noticeDialog, confirmDialog } from "./dialog.js";

type Rating = 'again' | 'hard' | 'good' | 'easy';
interface CardView { id: string; front: string; back: string; intervalDays: number; repetitions: number; preview?: Record<Rating, number> }
interface DeckStats { total: number; due: number; fresh: number; learning: number; mature: number }

/** Render the study screen for a note's deck. `onBack` returns to the editor. */
export function renderStudyView(noteId: string, noteTitle: string, onBack: () => void): HTMLElement {
  const root = h('main', { className: 'gw-canvas gw-study' }) as HTMLElement;
  let queue: CardView[] = [];
  let stats: DeckStats | null = null;
  let idx = 0;
  let revealed = false;
  let reviewed = 0;
  let busy = false;

  const human = (days: number): string => days <= 0 ? 'today' : days === 1 ? 'tomorrow' : days < 30 ? `in ${days} days` : days < 365 ? `in ${Math.round(days / 30)} months` : 'in over a year';

  async function load(): Promise<void> {
    busy = true; paint();
    try {
      const res = await api.get(`/api/me/notes/${noteId}/flashcards`);
      const data = await res.json().catch(() => ({})) as { cards?: Array<CardView & { dueAt: number }>; stats?: DeckStats };
      const now = Date.now();
      queue = (data.cards ?? []).filter((c) => (c as { dueAt: number }).dueAt <= now);
      stats = data.stats ?? null;
      idx = 0; revealed = false; reviewed = 0;
    } catch { queue = []; }
    busy = false; paint();
  }

  async function makeCards(): Promise<void> {
    if (busy) return; busy = true; paint();
    try {
      const res = await api.post(`/api/me/notes/${noteId}/flashcards`, { count: 12 });
      if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: string }; void noticeDialog({ message: `Could not make flashcards: ${e.error ?? res.status}` }); }
    } finally { busy = false; await load(); }
  }

  async function grade(rating: 'again' | 'hard' | 'good' | 'easy'): Promise<void> {
    const card = queue[idx]; if (!card || busy) return;
    busy = true;
    try {
      await api.post(`/api/me/flashcards/${card.id}/review`, { rating });
      reviewed += 1;
      // "Again" re-queues the card at the end of this session; others advance.
      if (rating === 'again') queue.push(card);
      idx += 1; revealed = false;
    } catch { /* keep the card */ }
    busy = false; paint();
  }

  function statChip(label: string, n: number): HTMLElement { return h('span', { className: 'gw-study-stat' }, h('b', null, String(n)), ` ${label}`); }

  function paint(): void {
    root.innerHTML = '';
    const header = h('header', { className: 'gw-study-top' },
      h('button', { className: 'notes-back-btn', onClick: onBack }, '← Back to note'),
      h('div', { className: 'gw-study-title' }, `📇 Study · ${noteTitle}`),
      stats ? h('div', { className: 'gw-study-stats' }, statChip('due', stats.due), statChip('total', stats.total), statChip('learning', stats.learning), statChip('mature', stats.mature)) : h('div', null),
    );
    root.appendChild(header);

    const body = h('div', { className: 'gw-study-body' });
    if (busy && queue.length === 0 && !stats) { body.appendChild(h('div', { className: 'gw-study-empty' }, 'Loading…')); }
    else if ((stats?.total ?? 0) === 0) {
      body.appendChild(h('div', { className: 'gw-study-empty' },
        h('div', { className: 'gw-study-empty-icon' }, '📇'),
        h('div', { className: 'gw-study-empty-msg' }, 'No flashcards yet for this note.'),
        h('button', { className: 'gw-btn-emerald gw-study-make', onClick: () => void makeCards() }, busy ? 'Making…' : '✦ Make flashcards'),
      ));
    } else if (idx >= queue.length) {
      body.appendChild(h('div', { className: 'gw-study-empty' },
        h('div', { className: 'gw-study-empty-icon' }, '✅'),
        h('div', { className: 'gw-study-empty-msg' }, reviewed > 0 ? `Reviewed ${reviewed} card${reviewed === 1 ? '' : 's'} — nothing else due. Nice work!` : 'Nothing due right now — come back later.'),
        h('button', { className: 'gw-btn-emerald gw-study-make', onClick: () => void makeCards() }, '✦ Make more flashcards'),
      ));
    } else {
      const card = queue[idx]!;
      const progress = h('div', { className: 'gw-study-progress' }, `Card ${Math.min(idx + 1, queue.length)} of ${queue.length} due`);
      const face = h('div', { className: `gw-study-card${revealed ? ' revealed' : ''}` },
        h('div', { className: 'gw-study-q' }, card.front),
        revealed ? h('div', { className: 'gw-study-divider' }) : null,
        revealed ? h('div', { className: 'gw-study-a' }, card.back) : null,
      );
      body.appendChild(progress);
      body.appendChild(face);
      if (!revealed) {
        body.appendChild(h('button', { className: 'gw-btn-emerald gw-study-reveal', onClick: () => { revealed = true; paint(); } }, 'Show answer'));
      } else {
        // Prefer the scheduler's REAL prediction (card.preview from FSRS); fall back to a heuristic.
        const p = card.preview;
        const again = p ? p.again : 0;
        const hard = p ? p.hard : Math.max(1, Math.round(card.intervalDays * 1.2) || 1);
        const good = p ? p.good : (card.repetitions === 0 ? 1 : card.repetitions === 1 ? 6 : Math.round(card.intervalDays * 2.5));
        const easy = p ? p.easy : (card.repetitions === 0 ? 2 : Math.round(card.intervalDays * 3));
        body.appendChild(h('div', { className: 'gw-study-grades' },
          h('button', { className: 'gw-grade gw-grade-again', onClick: () => void grade('again') }, h('span', null, 'Again'), h('small', null, human(again))),
          h('button', { className: 'gw-grade gw-grade-hard', onClick: () => void grade('hard') }, h('span', null, 'Hard'), h('small', null, human(hard))),
          h('button', { className: 'gw-grade gw-grade-good', onClick: () => void grade('good') }, h('span', null, 'Good'), h('small', null, human(good))),
          h('button', { className: 'gw-grade gw-grade-easy', onClick: () => void grade('easy') }, h('span', null, 'Easy'), h('small', null, human(easy))),
        ));
      }
    }
    root.appendChild(body);
  }

  void load();
  return root;
}
