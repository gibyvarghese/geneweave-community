/**
 * Accessible confirm / notice dialogs (m142 / Round 5) — replaces the browser's native alert()/confirm().
 *
 * Native alert()/confirm() are inaccessible to the app's standards: unstyled (breaks the design), not
 * focus-managed, and (confirm) impossible to label a destructive action clearly. This is a proper WAI-ARIA
 * "alertdialog": role + aria-modal + aria-labelledby + aria-describedby, focus moves INTO the dialog, focus is
 * TRAPPED (Tab/Shift+Tab wrap — using @weaveintel/a11y's focus-trap math), Esc / backdrop cancels, and focus
 * RETURNS to the control that opened it. A destructive confirm focuses the SAFE (Cancel) button by default,
 * so an accidental Enter never deletes.
 *
 * NOTE: the focus-trap math is the canonical, unit-tested `@weaveintel/a11y` (focus-trap.ts). The raw-served
 * browser modules can't bare-import a workspace package (only the notes editor is bundled), so the tiny pure
 * bits are mirrored here; the package tests are the spec.
 */
import { h } from './dom.js';

// Mirror of @weaveintel/a11y focus-trap.ts (raw-ESM constraint; package is the spec).
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
function nextTrapIndex(count: number, current: number, shift: boolean): number {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return -1;
  const raw = Number.isFinite(current) ? Math.floor(current) : -1;
  const cur = raw < -1 ? -1 : raw > n - 1 ? n - 1 : raw;
  if (shift) return cur <= 0 ? n - 1 : cur - 1;
  return cur >= n - 1 ? 0 : cur + 1;
}

// m142 — workspace policy: when false, an admin has turned OFF the extra "are you sure?" for destructive
// actions (power-user mode). Default true (confirm). Set from /api/me/accessibility on load.
let _confirmDestructive = true;
export function setConfirmDestructive(on: boolean): void { _confirmDestructive = on; }

let _seq = 0;

interface DialogButton { label: string; value: unknown; danger?: boolean; primary?: boolean; /** resolve with the text field's value instead of the static `value` */ resolvesInput?: boolean }

interface InputSpec { multiline?: boolean; placeholder?: string; defaultValue?: string; required?: boolean; ariaLabel?: string }

function openDialog<T>(opts: { title: string; message?: string; buttons: DialogButton[]; initialFocus: 'primary' | 'safe' | 'input'; cancelValue: T; input?: InputSpec }): Promise<T> {
  return new Promise<T>((resolve) => {
    const trigger = document.activeElement as HTMLElement | null;
    const id = ++_seq;
    const titleId = `gw-dialog-title-${id}`;
    const descId = `gw-dialog-desc-${id}`;
    let done = false;

    // Optional text field (single- or multi-line) — the in-app replacement for the browser's prompt().
    let inputEl: HTMLInputElement | HTMLTextAreaElement | null = null;
    if (opts.input) {
      inputEl = (opts.input.multiline
        ? h('textarea', { className: 'gw-dialog-input', rows: '4', placeholder: opts.input.placeholder ?? '', 'aria-label': opts.input.ariaLabel ?? opts.title })
        : h('input', { className: 'gw-dialog-input', type: 'text', placeholder: opts.input.placeholder ?? '', 'aria-label': opts.input.ariaLabel ?? opts.title })) as HTMLInputElement | HTMLTextAreaElement;
      if (opts.input.defaultValue) inputEl.value = opts.input.defaultValue;
    }

    const finish = (value: T): void => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      try { trigger?.focus(); } catch { /* trigger may be gone */ } // return focus to the opener
      resolve(value);
    };
    const submitInput = (): void => {
      const btn = opts.buttons.find((b) => b.resolvesInput);
      if (!btn) return;
      if (opts.input?.required && !(inputEl?.value ?? '').trim()) return; // don't submit empty when required
      finish(inputEl?.value as unknown as T);
    };

    const btnEls = opts.buttons.map((b) => h('button', {
      type: 'button',
      className: 'gw-dialog-btn' + (b.danger ? ' danger' : b.primary ? ' primary' : ''),
      onClick: () => finish((b.resolvesInput ? (inputEl?.value as unknown) : b.value) as T),
    }, b.label) as HTMLButtonElement);

    // Keep a required-empty primary button disabled until the field has content.
    const syncDisabled = (): void => {
      if (!opts.input?.required) return;
      const empty = !(inputEl?.value ?? '').trim();
      opts.buttons.forEach((b, i) => { if (b.resolvesInput) btnEls[i]!.disabled = empty; });
    };
    if (inputEl) { inputEl.addEventListener('input', syncDisabled); }

    const children = [
      h('div', { className: 'gw-dialog-title', id: titleId }, opts.title),
      opts.message ? h('div', { className: 'gw-dialog-msg', id: descId }, opts.message) : null,
      inputEl,
      h('div', { className: 'gw-dialog-actions' }, ...btnEls),
    ].filter(Boolean);
    const dialog = h('div', {
      className: 'gw-dialog', role: 'alertdialog', 'aria-modal': 'true',
      'aria-labelledby': titleId, ...(opts.message ? { 'aria-describedby': descId } : {}),
    }, ...children) as HTMLElement;

    const overlay = h('div', {
      className: 'gw-dialog-overlay',
      onClick: (e: Event) => { if (e.target === overlay) finish(opts.cancelValue); }, // backdrop cancels
    }, dialog) as HTMLElement;

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); finish(opts.cancelValue); return; }
      // Enter submits the field: single-line on plain Enter; multi-line on Cmd/Ctrl+Enter (plain Enter = newline).
      if (e.key === 'Enter' && inputEl && (e.target === inputEl)) {
        const multiline = !!opts.input?.multiline;
        if ((!multiline && !e.shiftKey) || (multiline && (e.metaKey || e.ctrlKey))) { e.preventDefault(); submitInput(); return; }
      }
      if (e.key !== 'Tab') return;
      // Focus trap — keep Tab / Shift+Tab inside the dialog.
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = nextTrapIndex(items.length, current, e.shiftKey);
      if (next >= 0) { e.preventDefault(); items[next]!.focus(); }
    }

    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    syncDisabled();
    // Move focus into the dialog: the text field, the SAFE button (destructive), else the primary action.
    if (opts.initialFocus === 'input' && inputEl) { inputEl.focus(); (inputEl as HTMLInputElement).select?.(); return; }
    const focusTarget = opts.initialFocus === 'safe'
      ? btnEls.find((_, i) => !opts.buttons[i]!.danger && !opts.buttons[i]!.primary) ?? btnEls[0]!
      : btnEls.find((_, i) => opts.buttons[i]!.primary || opts.buttons[i]!.danger) ?? btnEls[btnEls.length - 1]!;
    focusTarget.focus();
  });
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** A destructive action (delete/revoke): styles the confirm red + focuses Cancel by default. */
  danger?: boolean;
}

/**
 * Accessible replacement for `confirm()`. Returns a Promise<boolean>. For a `danger` (destructive) action the
 * workspace may require or waive the extra confirmation (m142 confirm_destructive); when waived, resolves true
 * immediately (power-user mode) — non-destructive confirms always ask.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (opts.danger && !_confirmDestructive) return Promise.resolve(true);
  return openDialog<boolean>({
    title: opts.title ?? (opts.danger ? 'Please confirm' : 'Confirm'),
    message: opts.message,
    initialFocus: opts.danger ? 'safe' : 'primary',
    cancelValue: false,
    buttons: [
      { label: opts.cancelLabel ?? 'Cancel', value: false },
      { label: opts.confirmLabel ?? (opts.danger ? 'Delete' : 'OK'), value: true, danger: opts.danger, primary: !opts.danger },
    ],
  });
}

/** Accessible replacement for `alert()`. Returns a Promise<void> (safe to fire-and-forget with `void`). */
export function noticeDialog(opts: { title?: string; message: string; okLabel?: string }): Promise<void> {
  return openDialog<void>({
    title: opts.title ?? 'Notice',
    message: opts.message,
    initialFocus: 'primary',
    cancelValue: undefined,
    buttons: [{ label: opts.okLabel ?? 'OK', value: undefined, primary: true }],
  });
}

export interface PromptOptions {
  title: string;
  /** Optional helper text under the title. */
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Multi-line text area (e.g. an outline). Plain Enter adds a newline; Cmd/Ctrl+Enter submits. */
  multiline?: boolean;
  /** When true, the submit button stays disabled until the field is non-empty. */
  required?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * Accessible replacement for the browser's `prompt()` — an in-app modal (the same styled dialog as
 * confirm/notice) with a text field, focus-trapped, Esc/backdrop cancels, focus returns to the opener.
 * Resolves with the entered string (may be '' when not `required`), or `null` if the user cancels.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return openDialog<string | null>({
    title: opts.title,
    ...(opts.message ? { message: opts.message } : {}),
    initialFocus: 'input',
    cancelValue: null,
    input: {
      ...(opts.multiline ? { multiline: true } : {}),
      ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
      ...(opts.defaultValue ? { defaultValue: opts.defaultValue } : {}),
      ...(opts.required ? { required: true } : {}),
      ariaLabel: opts.title,
    },
    buttons: [
      { label: opts.cancelLabel ?? 'Cancel', value: null },
      { label: opts.confirmLabel ?? 'OK', value: null, primary: true, resolvesInput: true },
    ],
  });
}
