// SPDX-License-Identifier: MIT
/**
 * geneWeave Builder — the GENERIC record-editor renderer (presentational).
 *
 * Drives any admin resource (the Builder is a skin over the whole admin schema), so it takes
 * a tab's field schema + the working form and renders Builder-styled controls, choosing the
 * right treatment per field: a toggle for booleans, a select for option lists, a validated
 * JSON editor, removable chips for CSV arrays, a DARK monospace code editor for the primary
 * prose/markdown field, a mono input for keys/ids/versions, else a plain input/textarea. Non-
 * boolean fields go under a "<RESOURCE>" section; booleans collect under "AVAILABILITY".
 *
 * Dumb module: state + persistence live in builder-view.ts (which reuses the admin save layer).
 */
import { h } from './dom.js';

export interface FieldSchema { key: string; label?: string; type?: string; textarea?: boolean; rows?: number; options?: string[]; save?: string; hint?: string; readOnly?: boolean }
export interface FieldHandlers { get: (key: string) => unknown; set: (key: string, value: unknown) => void }

export type FieldKind = 'toggle' | 'select' | 'json' | 'chips' | 'code' | 'mono' | 'textarea' | 'number' | 'text';

const CONTENT_RE = /content|template|^text$|body|prompt|markdown|instruction|system|preamble|message|description/i;
const JSON_RE = /json|schema|config|variables|spec|payload|metadata|params|mapping/i;
const CSV_RE = /tags|labels|aliases|keywords/i;
const MONO_RE = /(^|_|-)key$|version|^id$|slug|shortcut|model|provider|endpoint|hash/i;

export function fieldKind(f: FieldSchema): FieldKind {
  if (f.save === 'bool' || f.save === 'intBool' || f.type === 'checkbox' || f.type === 'boolean') return 'toggle';
  if (Array.isArray(f.options) && f.options.length) return 'select';
  if (f.save === 'json' || f.save === 'jsonStr' || JSON_RE.test(f.key)) return 'json';
  if (f.save === 'csvArr' || CSV_RE.test(f.key)) return 'chips';
  if (f.textarea) return CONTENT_RE.test(f.key) ? 'code' : 'textarea';
  if (MONO_RE.test(f.key)) return 'mono';
  if (f.type === 'number') return 'number';
  return 'text';
}

export function validateJson(str: string): string | null {
  const s = (str ?? '').trim();
  if (!s) return null;
  try { JSON.parse(s); return null; }
  catch (e) { return `Must be valid JSON — ${(e instanceof Error ? e.message : 'parse error').replace(/^JSON\.parse:\s*/, '').toLowerCase()}`; }
}

export function jsonFieldsInvalid(fields: FieldSchema[], get: (k: string) => unknown): boolean {
  return fields.some((f) => fieldKind(f) === 'json' && !!validateJson(String(get(f.key) ?? '')));
}

function prettify(key: string): string { return key.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()); }
function asBool(v: unknown): boolean { return v === true || v === 1 || v === '1' || v === 'true'; }

function fieldShell(label: string, control: HTMLElement, hint?: HTMLElement | null, headerRight?: HTMLElement | null): HTMLElement {
  return h('div', { className: 'bld-field' },
    h('div', { className: 'bld-field-head' }, h('label', { className: 'bld-label' }, label), headerRight ?? null),
    control, hint ?? null,
  );
}

function renderControl(f: FieldSchema, hnd: FieldHandlers): HTMLElement {
  const kind = fieldKind(f);
  const label = f.label || prettify(f.key);
  const val = hnd.get(f.key);

  if (kind === 'select') {
    const sel = h('select', { className: 'bld-select', onChange: (e: Event) => hnd.set(f.key, (e.target as HTMLSelectElement).value) },
      ...(f.options ?? []).map((o) => h('option', { value: o, selected: String(val) === String(o) }, o)),
    ) as HTMLSelectElement;
    return fieldShell(label, sel, f.hint ? h('span', { className: 'bld-hint' }, f.hint) : null);
  }
  if (kind === 'json') {
    const err = validateJson(String(val ?? ''));
    const ta = h('textarea', { className: `bld-json${err ? ' invalid' : ''}`, rows: f.rows ?? 4, value: String(val ?? ''), onInput: (e: Event) => hnd.set(f.key, (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
    const fmt = h('button', { className: 'bld-mini-btn bld-mini-emerald', onClick: () => { try { hnd.set(f.key, JSON.stringify(JSON.parse(String(val)), null, 2)); } catch { /* */ } } }, 'Format');
    return fieldShell(label, ta, err ? h('span', { className: 'bld-json-error' }, h('span', { className: 'bld-err-ic' }, '!'), err) : (f.hint ? h('span', { className: 'bld-hint' }, f.hint) : null), fmt);
  }
  if (kind === 'chips') {
    const csv = String(val ?? '');
    const items = csv.split(',').map((s) => s.trim()).filter(Boolean);
    const input = h('input', { className: 'bld-tag-input', type: 'text', placeholder: 'Type to add…',
      onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) { hnd.set(f.key, [...items, v].join(', ')); } } } }) as HTMLInputElement;
    const chips = h('div', { className: 'bld-chips' },
      ...items.map((t, i) => h('span', { className: 'bld-chip' }, t, h('button', { className: 'bld-chip-x', onClick: () => hnd.set(f.key, items.filter((_, j) => j !== i).join(', ')) }, '×'))),
      input,
    );
    return fieldShell(label, chips);
  }
  if (kind === 'code') {
    const text = String(val ?? '');
    const charCount = h('span', { className: 'bld-code-meta' }, `${text.length} chars`) as HTMLElement;
    const ta = h('textarea', { className: 'bld-code-area', rows: f.rows ?? 8, value: text, onInput: (e: Event) => { const v = (e.target as HTMLTextAreaElement).value; hnd.set(f.key, v); charCount.textContent = `${v.length} chars`; } }) as HTMLTextAreaElement;
    const code = h('div', { className: 'bld-code' }, h('div', { className: 'bld-code-bar' }, h('span', { className: 'bld-code-meta' }, 'MARKDOWN'), charCount), ta);
    return fieldShell(label, code, f.hint ? h('span', { className: 'bld-hint' }, f.hint) : null);
  }
  if (kind === 'textarea') {
    const ta = h('textarea', { className: 'bld-textarea', rows: f.rows ?? 3, value: String(val ?? ''), onInput: (e: Event) => hnd.set(f.key, (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
    return fieldShell(label, ta, f.hint ? h('span', { className: 'bld-hint' }, f.hint) : null);
  }
  // mono / number / text → input
  const input = h('input', {
    className: `bld-input${kind === 'mono' ? ' bld-mono' : ''}`, type: kind === 'number' ? 'number' : 'text',
    value: String(val ?? ''), onInput: (e: Event) => hnd.set(f.key, (e.target as HTMLInputElement).value),
  }) as HTMLInputElement;
  const hint = f.hint ? h('span', { className: 'bld-hint' }, f.hint)
    : (kind === 'mono' && /(^|_|-)key$|shortcut/i.test(f.key) ? h('span', { className: 'bld-hint' }, 'Drop this into any instruction by typing ', h('span', { className: 'bld-mono bld-keyhint' }, `{{>${String(val ?? '')}}}`)) : null);
  return fieldShell(label, input, hint);
}

function renderToggleRow(f: FieldSchema, hnd: FieldHandlers): HTMLElement {
  const on = asBool(hnd.get(f.key));
  return h('div', { className: 'bld-avail-card' },
    h('div', { className: 'bld-avail-text' },
      h('span', { className: 'bld-avail-title' }, f.label || prettify(f.key)),
      f.hint ? h('span', { className: 'bld-avail-sub' }, f.hint) : null,
    ),
    h('div', { className: `bld-toggle${on ? ' on' : ''}`, onClick: () => hnd.set(f.key, !on) }, h('span', { className: 'bld-knob' })),
  );
}

/** Render all of a resource's fields, Builder-styled, grouped into a main + availability section. */
export function renderBuilderFields(schema: { fields?: FieldSchema[]; singular?: string }, hnd: FieldHandlers): HTMLElement {
  const fields = (schema.fields ?? []).filter((f) => !f.readOnly && f.key !== 'id');
  const toggles = fields.filter((f) => fieldKind(f) === 'toggle');
  const mains = fields.filter((f) => fieldKind(f) !== 'toggle');
  const mainLabel = (schema.singular ? schema.singular : 'Details').toUpperCase();

  const sections: HTMLElement[] = [];
  if (mains.length) sections.push(h('div', { className: 'bld-section' }, h('div', { className: 'bld-section-label' }, mainLabel), ...mains.map((f) => renderControl(f, hnd))));
  if (toggles.length) sections.push(h('div', { className: 'bld-section' }, h('div', { className: 'bld-section-label' }, 'AVAILABILITY'), ...toggles.map((f) => renderToggleRow(f, hnd))));
  if (!sections.length) sections.push(h('div', { className: 'bld-editor-empty-inline' }, 'This resource has no editable fields.'));
  return h('div', { className: 'bld-form' }, ...sections);
}

/** The sticky bottom action bar (dirty indicator + Cancel + Save). */
export function renderBuilderActionBar(dirty: boolean, saveBlocked: boolean, onSave: () => void, onCancel: () => void): HTMLElement {
  return h('footer', { className: 'bld-actionbar' },
    h('span', { className: `bld-dirty${dirty ? ' on' : ''}` }, h('span', { className: 'bld-dirty-dot' }), dirty ? 'Unsaved changes' : 'All changes saved'),
    h('div', { className: 'bld-actions' },
      h('button', { className: 'bld-btn-ghost', onClick: onCancel }, 'Cancel'),
      h('button', { className: `bld-btn-save${saveBlocked ? ' disabled' : ''}`, onClick: saveBlocked ? () => {} : onSave }, dirty ? 'Save' : 'Saved'),
    ),
  );
}
