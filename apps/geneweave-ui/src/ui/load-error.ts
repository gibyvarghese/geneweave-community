/**
 * Recoverable data-load errors (m142 / H15) — replaces silent `catch { console.error }`.
 *
 * When a background load fails (chats, models, tools, the dashboard, connectors…), the app used to swallow it
 * and show a blank/stale screen with no way to recover. This surfaces a small, dismissable banner
 * (`role="alert"`) with a HUMAN, differentiated message + a **Retry** — so the failure is visible and
 * actionable, not silent. Errors are de-duplicated per source so a flapping load can't stack banners.
 */
import { h } from './dom.js';

interface LoadError { what: string; text: string; retry?: () => void }
const _errors = new Map<string, LoadError>();

/** Map a failure to a human, differentiated message (mirrors the chat classifyFailure model). */
function humanMessage(what: string, err: unknown): string {
  const status = (err as { status?: number })?.status;
  const thrown = err instanceof TypeError || (err as { name?: string })?.name === 'TypeError';
  if (thrown) return `Couldn’t load ${what} — check your internet connection.`;
  if (status === 401 || status === 419) return `Your session expired while loading ${what}. Please sign in again.`;
  if (status === 429) return `geneWeave is busy — ${what} couldn’t load. Try again in a moment.`;
  if (typeof status === 'number' && status >= 500) return `Something went wrong on our end loading ${what}.`;
  return `Couldn’t load ${what}. Please try again.`;
}

function rerender(): void {
  const host = ensureHost();
  host.replaceChildren(
    ...[..._errors.values()].map((e) => h('div', { className: 'load-error', role: 'alert' },
      h('span', { className: 'load-error-icon', 'aria-hidden': 'true' }, '⚠'),
      h('span', { className: 'load-error-text' }, e.text),
      ...(e.retry ? [h('button', { type: 'button', className: 'load-error-retry', onClick: () => { dismiss(e.what); e.retry!(); } }, 'Retry')] : []),
      h('button', { type: 'button', className: 'load-error-x', 'aria-label': 'Dismiss', onClick: () => dismiss(e.what) }, '×'),
    )),
  );
  host.style.display = _errors.size ? 'flex' : 'none';
}

function ensureHost(): HTMLElement {
  let host = document.getElementById('gw-load-errors');
  if (!host) {
    host = document.createElement('div');
    host.id = 'gw-load-errors';
    host.className = 'load-error-host';
    document.body.appendChild(host);
  }
  return host;
}

/** Report a failed data load. `what` is a short human noun ("your chats", "the dashboard"). De-duped by `what`. */
export function reportLoadError(what: string, err: unknown, retry?: () => void): void {
  _errors.set(what, { what, text: humanMessage(what, err), ...(retry ? { retry } : {}) });
  rerender();
}

/** Clear the banner for a source (call after a successful (re)load). */
export function dismiss(what: string): void {
  if (_errors.delete(what)) rerender();
}
