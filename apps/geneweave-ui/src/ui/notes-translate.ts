// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 2 — the TRANSLATE card.
 *
 * --- For someone new to this ---
 * This is the "say it in another language" panel. You pick a language (and, if you like, how formal
 * it should sound), tap Translate, and the assistant rewrites the whole note in that language — keeping
 * the headings, lists, links and any code exactly as they were — and saves it as a NEW note so your
 * original is never changed. When it's done, the new note opens automatically.
 *
 * A self-contained DOM card (no framework). The server does the real work (and double-checks the
 * translation actually happened before saving), so this stays small.
 */
import { h } from './dom.js';
import { api } from './api.js';

/** The languages offered in the picker (label = native name; value = ISO code the server resolves). */
const LANGUAGES: Array<{ code: string; name: string; native: string }> = [
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'he', name: 'Hebrew', native: 'עברית' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά' },
];

/**
 * Render the translate card for a note. `onTranslated(newNoteId)` is called once the translated copy
 * has been created (so the caller can open it). The card manages its own busy/error state.
 */
export function renderTranslateCard(noteId: string, onTranslated: (newNoteId: string) => void): HTMLElement {
  const root = h('div', { className: 'gw-translate' }) as HTMLElement;
  let lang = 'es';
  let formality: 'default' | 'formal' | 'informal' = 'default';
  let busy = false;
  let error = '';

  async function go(): Promise<void> {
    if (busy) return;
    busy = true; error = ''; paint();
    try {
      const res = await api.post(`/api/me/notes/${noteId}/translate`, { targetLanguage: lang, formality });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; noteId?: string; error?: string; warnings?: string[] };
      if (res.ok && data.ok && data.noteId) {
        onTranslated(data.noteId);
        document.querySelector('.gw-modal-overlay')?.remove();
        return;
      }
      error = data.error ?? `Could not translate (${res.status}).`;
    } catch { error = 'Could not reach the server.'; }
    busy = false; paint();
  }

  function paint(): void {
    root.innerHTML = '';
    const picker = h('select', { className: 'gw-translate-lang', onChange: (e: Event) => { lang = (e.target as HTMLSelectElement).value; } }) as HTMLSelectElement;
    for (const l of LANGUAGES) {
      const opt = h('option', { value: l.code }, `${l.name} · ${l.native}`) as HTMLOptionElement;
      if (l.code === lang) opt.selected = true;
      picker.appendChild(opt);
    }
    const tone = h('select', { className: 'gw-translate-tone', onChange: (e: Event) => { formality = (e.target as HTMLSelectElement).value as typeof formality; } },
      h('option', { value: 'default' }, 'Default tone'),
      h('option', { value: 'formal' }, 'Formal'),
      h('option', { value: 'informal' }, 'Informal'),
    ) as HTMLSelectElement;

    root.appendChild(h('div', { className: 'gw-translate-row' },
      h('label', { className: 'gw-translate-label' }, 'Translate this note into'),
      picker,
    ));
    root.appendChild(h('div', { className: 'gw-translate-row' },
      h('label', { className: 'gw-translate-label' }, 'Tone'),
      tone,
    ));
    root.appendChild(h('p', { className: 'gw-translate-hint' }, 'A new note is created — your original stays exactly as it is. Code, links and layout are preserved.'));
    if (error) root.appendChild(h('p', { className: 'gw-translate-error' }, error));
    root.appendChild(h('button', { className: 'gw-btn-emerald gw-translate-go', disabled: busy, onClick: () => void go() }, busy ? 'Translating…' : '🌍 Translate'));
  }

  paint();
  return root;
}
