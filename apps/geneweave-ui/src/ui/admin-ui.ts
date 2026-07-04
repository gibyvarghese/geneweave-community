import { api } from './api.js';
import { noticeDialog, confirmDialog, promptDialog } from "./dialog.js";
import { h } from './dom.js';
import { state } from './state.js';
import { normalizeAdminPath } from './prompt-wizard-utils.js';
import { resetPromptWizard } from './prompt-wizard-state.js';
import { renderToolSimulationView } from './tool-simulation-ui.js';
import { renderKglCompetitionRunDetail, renderKglRunRowActions } from './kaggle-competition-runs-ui.js';
import { renderCapabilityMatrixView } from './capability-matrix-ui.js';
import { renderRoutingSimulatorView } from './routing-simulator-ui.js';
import { renderToolApprovalView } from './tool-approval-ui.js';
import { renderMCPGatewayClientsView } from './mcp-gateway-clients-ui.js';
import { renderMCPGatewayActivityView } from './mcp-gateway-activity-ui.js';

// ── Fast tooltip (escapes overflow:hidden ancestors) ──────────────────────────
let _fastTipEl: HTMLDivElement | null = null;
function ensureFastTip(): HTMLDivElement {
  if (!_fastTipEl) {
    _fastTipEl = document.createElement('div');
    _fastTipEl.className = 'fast-tip';
    document.body.appendChild(_fastTipEl);
  }
  return _fastTipEl;
}
function showFastTip(anchor: HTMLElement, text: string): void {
  const tip = ensureFastTip();
  tip.textContent = text;
  const r = anchor.getBoundingClientRect();
  tip.style.left = `${r.left}px`;
  tip.style.top = `${r.bottom + 6}px`;
  tip.classList.add('show');
}
function hideFastTip(): void {
  if (_fastTipEl) _fastTipEl.classList.remove('show');
}

// ── Admin deep-link URL helpers ───────────────────────────────────────────────
// Hash format:  #admin/{tab}          → opens the tab's list view
//               #admin/{tab}/{id}     → opens the tab and immediately edits record {id}

export function buildAdminUrl(tab: string, id?: string | number | null): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  const hash = id != null && id !== '' ? `#admin/${tab}/${encodeURIComponent(String(id))}` : `#admin/${tab}`;
  return `${base}${hash}`;
}

export function pushAdminHash(tab: string, id?: string | number | null): void {
  const hash = id != null && id !== '' ? `#admin/${tab}/${encodeURIComponent(String(id))}` : `#admin/${tab}`;
  if (window.location.hash !== hash) {
    history.replaceState(null, '', hash);
  }
}

export function clearAdminHash(): void {
  if (window.location.hash.startsWith('#admin')) {
    history.replaceState(null, '', window.location.pathname);
  }
}

/** Call once at boot. Returns {tab, id} if a deep-link hash was present. */
export function parseAdminHash(): { tab: string; id: string | null } | null {
  const hash = window.location.hash;
  const m = hash.match(/^#admin\/([^/]+)(?:\/(.+))?$/);
  if (!m) return null;
  return { tab: decodeURIComponent(m[1]!), id: m[2] ? decodeURIComponent(m[2]) : null };
}

/** Show a brief "Copied!" toast anchored near the element that triggered it. */
function showCopiedToast(anchorEl: HTMLElement): void {
  const existing = document.getElementById('admin-share-toast');
  existing?.remove();
  const toast = document.createElement('div');
  toast.id = 'admin-share-toast';
  toast.className = 'admin-share-toast';
  toast.textContent = 'Link copied!';
  const rect = anchorEl.getBoundingClientRect();
  toast.style.cssText = `position:fixed;top:${rect.bottom + 6}px;left:${rect.left}px;z-index:9999;`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1800);
}

function getRowSelectionId(row: any, schema: any): string {
  const rawId = row?.id ?? row?.key ?? row?.[schema?.cols?.[0]];
  return rawId == null ? '' : String(rawId);
}

/**
 * Tracked Kaggle competitions get a "▶ Start Live Run" action that POSTs to
 * /api/kaggle/competition-runs. The runner provisions a UUIDv7 mesh per click
 * (see KaggleCompetitionRunner.startRun) so each row can be launched
 * independently. Kept here (vs a generic schema field) until we generalize
 * row actions across more tabs.
 */
async function startKaggleCompetitionRun(
  row: { competition_ref?: string; title?: string; objective?: string; notes?: string } | null | undefined,
  trigger?: HTMLElement,
): Promise<void> {
  const competitionRef = (row?.competition_ref || '').trim();
  if (!competitionRef) {
    void noticeDialog({ message: 'competition_ref is required to start a live agent run.' });
    return;
  }
  try {
    const resp = await api.post('/api/kaggle/competition-runs', {
      competitionRef,
      title: row?.title || competitionRef,
      objective: row?.objective || row?.notes || '',
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      void noticeDialog({ message: `Failed to start run (HTTP ${resp.status}): ${text || resp.statusText}` });
      return;
    }
    const body = await resp.json().catch(() => ({} as any));
    const runId = body?.id ? String(body.id) : '';
    if (trigger) showCopiedToast(trigger);
    if (runId && await confirmDialog({ title: 'Live run started', message: `Run ID: ${runId}. Open the Kaggle Runs admin tab to track progress?`, confirmLabel: 'Open', cancelLabel: 'Not now' })) {
      state.adminTab = 'kaggle-competition-runs';
      state.adminListSearch = runId;
      // Trigger a re-render via hash navigation
      window.location.hash = '#admin/kaggle-competition-runs';
    }
  } catch (err) {
    void noticeDialog({ message: `Failed to start run: ${err instanceof Error ? err.message : String(err)}` });
  }
}

  /** Phase 6: Toggle live artifact config from admin panel. */
  async function configureLiveArtifact(artifactId: string | undefined): Promise<void> {
    if (!artifactId) return;
    // Check if live config already exists
    const check = await fetch(`/api/admin/artifacts/${artifactId}/live-config`);
    if (check.ok) {
      // Already live — offer to remove
      if (!(await confirmDialog({ message: 'This artifact is already configured as Live. Remove the live configuration (make it static)?', danger: true, confirmLabel: 'Make static' }))) return;
      const del = await fetch(`/api/admin/artifacts/${artifactId}/live-config`, { method: 'DELETE' });
      if (del.ok) { void noticeDialog({ message: 'Live configuration removed. The artifact is now static.' }); }
      else { void noticeDialog({ message: `Failed to remove live config: ${await del.text()}` }); }
      return;
    }
    // Not live — ask for config via in-app dialogs.
    const intervalStr = await promptDialog({ title: 'Make artifact live', message: 'Auto-refresh interval in seconds (0 = manual only).', defaultValue: '60', confirmLabel: 'Next' });
    if (intervalStr === null) return; // cancelled
    const interval = parseInt(intervalStr, 10) || 0;
    const ttlStr = await promptDialog({ title: 'Cache TTL', message: 'Cache TTL in seconds (skip refresh if refreshed within this window).', defaultValue: '30', confirmLabel: 'Make live' });
    if (ttlStr === null) return;
    const ttl = parseInt(ttlStr, 10) || 30;
    const res = await fetch(`/api/admin/artifacts/${artifactId}/live-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshIntervalSeconds: interval, cacheTtlSeconds: ttl }),
    });
    if (res.ok) {
      void noticeDialog({ message: `Artifact is now Live!\n\nAuto-refresh: ${interval > 0 ? interval + 's' : 'manual only'}\nCache TTL: ${ttl}s\n\nUse the render-live endpoint to see the refresh toolbar.` });
    } else {
      void noticeDialog({ message: `Failed to configure live artifact: ${await res.text()}` });
    }
  }

  async function getAdminCsrfToken(): Promise<string> {
    try {
      const r = await fetch('/api/auth/me');
      if (r.ok) { const d = await r.json() as { csrfToken?: string }; return d.csrfToken ?? ''; }
    } catch { /* ignore */ }
    return '';
  }

  async function shareArtifact(artifactId: string | undefined): Promise<void> {
    if (!artifactId) return;
    const csrf = await getAdminCsrfToken();
    const r = await fetch(`/api/artifacts/${artifactId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({}),
    });
    if (!r.ok) { void noticeDialog({ message: `Failed to create share link: ${await r.text()}` }); return; }
    const d = await r.json() as { url?: string };
    if (d.url) {
      const url = d.url;
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
      void noticeDialog({ title: 'Share link', message: `Link copied to clipboard:\n\n${url}` });
    }
  }

  async function getArtifactEmbedCode(artifactId: string | undefined): Promise<void> {
    if (!artifactId) return;
    const r = await fetch(`/api/artifacts/${artifactId}/embed-code`);
    if (!r.ok) { void noticeDialog({ message: `Failed to get embed code: ${await r.text()}` }); return; }
    const d = await r.json() as { embedCode?: string };
    if (d.embedCode) {
      if (navigator.clipboard) navigator.clipboard.writeText(d.embedCode).catch(() => {});
      void noticeDialog({ title: 'Embed code', message: `Copied to clipboard — paste this iframe into your page:\n\n${d.embedCode}` });
    }
  }

  function getVisibleCols(tab: string, schemaCols: string[]): string[] {
    const config: Record<string, string[]> = (state as any)._adminColConfig || {};
    const saved = config[tab];
    if (saved && saved.length > 0) return saved.filter((c: string) => schemaCols.includes(c));
    return schemaCols.slice(0, 6);
  }

  function setVisibleCols(tab: string, newCols: string[], render: () => void): void {
    const config: Record<string, string[]> = (state as any)._adminColConfig || {};
    (state as any)._adminColConfig = { ...config, [tab]: newCols };
    render();
  }

function getExportColumns(rows: any[], schema: any): string[] {
  const schemaCols = Array.isArray(schema?.cols) ? schema.cols.map((c: any) => String(c)) : [];
  if (schemaCols.length) return schemaCols;
  const keys = new Set<string>();
  rows.forEach((row) => Object.keys(row || {}).forEach((key) => keys.add(key)));
  return Array.from(keys);
}

function getListableCols(schema: any): string[] {
  const ordered = new Set<string>();
  const schemaCols = Array.isArray(schema?.cols) ? schema.cols : [];
  const fieldKeys = Array.isArray(schema?.fields) ? schema.fields.map((f: any) => f?.key) : [];

  schemaCols.forEach((col: any) => {
    const key = String(col || '').trim();
    if (key) ordered.add(key);
  });
  fieldKeys.forEach((col: any) => {
    const key = String(col || '').trim();
    if (key) ordered.add(key);
  });

  return Array.from(ordered);
}

function toCsvCell(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildCsv(rows: any[], columns: string[]): string {
  const header = columns.map((col) => toCsvCell(col)).join(',');
  const body = rows.map((row) => columns.map((col) => toCsvCell(row?.[col])).join(',')).join('\n');
  return `${header}\n${body}`;
}

function buildXlsx(rows: any[], columns: string[], sheetName: string): ArrayBuffer {
  const XLSX = (globalThis as any).XLSX as any;
  const aoaData: string[][] = [columns, ...rows.map((row) =>
    columns.map((col) => {
      const v = row?.[col];
      return typeof v === 'string' ? v : JSON.stringify(v ?? '');
    })
  )];
  const ws = XLSX.utils.aoa_to_sheet(aoaData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

function downloadTextFile(filename: string, mimeType: string, content: string | ArrayBuffer): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportRows(rows: any[], schema: any, tab: string, format: 'json' | 'csv' | 'excel', scope: 'all' | 'selected' | 'record'): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${tab}-${scope}-${ts}`;
  if (format === 'json') {
    downloadTextFile(`${baseName}.json`, 'application/json', JSON.stringify(rows, null, 2));
    return;
  }
  const columns = getExportColumns(rows, schema);
  if (format === 'csv') {
    const csv = buildCsv(rows, columns);
    downloadTextFile(`${baseName}.csv`, 'text/csv', csv);
    return;
  }
  const xlsx = buildXlsx(rows, columns, tab);
  downloadTextFile(`${baseName}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx);
}

// ── Natural-language search parser ───────────────────────────────────────────
// Supports: AND / OR / NOT (case-insensitive keywords), quoted phrases, parens.
// Plain space-separated terms are implicitly AND-joined for strict matching.
// If strict matching returns no rows, we fallback to natural matching:
// positive terms are OR-matched, and NOT terms are exclusions.
// Examples: "active"  |  "foo and bar"  |  "gpt or claude"  |  "not draft"
//           "active not gpt-4"  |  "(gpt or claude) and active"

type SearchNode =
  | { kind: 'term'; value: string }
  | { kind: 'comparison'; column: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'; value: string }
  | { kind: 'and'; left: SearchNode; right: SearchNode }
  | { kind: 'or'; left: SearchNode; right: SearchNode }
  | { kind: 'not'; operand: SearchNode };

type ComparisonOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

function normalizeKey(s: string): string {
  return String(s || '').toLowerCase().replace(/[_\s-]+/g, '');
}

function parseLiteralToken(tok: string): string {
  if (tok && tok.startsWith('"') && tok.endsWith('"')) {
    try { return String(JSON.parse(tok)); } catch {}
  }
  return tok;
}

function resolveColumnKey(columnExpr: string, cols: string[]): string | null {
  const normalizedExpr = normalizeKey(columnExpr);
  const exact = cols.find((c) => c.toLowerCase() === columnExpr.toLowerCase());
  if (exact) return exact;
  const normalized = cols.find((c) => normalizeKey(c) === normalizedExpr);
  return normalized || null;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === ' ' || input[i] === '\t') { i++; continue; }
    if (input[i] === '(') { tokens.push('('); i++; continue; }
    if (input[i] === ')') { tokens.push(')'); i++; continue; }
    // Quoted phrase
    if (input[i] === '"' || input[i] === "'") {
      const q = input[i++];
      let word = '';
      while (i < input.length && input[i] !== q) word += input[i++];
      i++; // closing quote
      if (word) tokens.push(JSON.stringify(word)); // stringify to mark as literal
      continue;
    }
    // Plain token
    let word = '';
    while (i < input.length && input[i] !== ' ' && input[i] !== '\t' && input[i] !== '(' && input[i] !== ')') {
      word += input[i++];
    }
    if (word) tokens.push(word.toLowerCase());
  }
  return tokens;
}

function parseSearchQuery(raw: string): SearchNode | null {
  const tokens = tokenize(raw.trim());
  if (!tokens.length) return null;
  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }
  function isLogicalBoundary(t: string | undefined) { return t === undefined || t === ')' || t === 'and' || t === 'or'; }

  function parseComparisonAtCurrentPosition(): SearchNode | null {
    const end = (() => {
      let i = pos;
      while (!isLogicalBoundary(tokens[i])) i++;
      return i;
    })();
    const segment = tokens.slice(pos, end);
    if (segment.length < 3) return null;

    const patterns: Array<{ parts: string[]; op: ComparisonOp }> = [
      { parts: ['is', 'not'], op: 'neq' },
      { parts: ['greater', 'than', 'or', 'equal', 'to'], op: 'gte' },
      { parts: ['less', 'than', 'or', 'equal', 'to'], op: 'lte' },
      { parts: ['greater', 'than'], op: 'gt' },
      { parts: ['less', 'than'], op: 'lt' },
      { parts: ['contains'], op: 'contains' },
      { parts: ['is'], op: 'eq' },
      { parts: ['>='], op: 'gte' },
      { parts: ['<='], op: 'lte' },
      { parts: ['>'], op: 'gt' },
      { parts: ['<'], op: 'lt' },
      { parts: ['!='], op: 'neq' },
      { parts: ['='], op: 'eq' },
    ];

    for (let i = 1; i < segment.length - 1; i++) {
      for (const p of patterns) {
        let matched = true;
        for (let j = 0; j < p.parts.length; j++) {
          if (segment[i + j] !== p.parts[j]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;

        const valueStart = i + p.parts.length;
        if (valueStart >= segment.length) continue;
        const colPart = segment.slice(0, i).join(' ').trim();
        const valuePart = segment.slice(valueStart).map(parseLiteralToken).join(' ').trim();
        if (!colPart || !valuePart) continue;

        pos = end;
        return { kind: 'comparison', column: colPart, op: p.op, value: valuePart };
      }
    }
    return null;
  }

  // or-expression
  function parseOr(): SearchNode {
    let left = parseAnd();
    while (peek() === 'or') {
      consume();
      const right = parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  // and-expression (explicit "and" keyword OR implicit adjacency)
  function parseAnd(): SearchNode {
    let left = parseNot();
    while (peek() !== undefined && peek() !== ')' && peek() !== 'or') {
      if (peek() === 'and') consume(); // consume optional "and"
      if (peek() === undefined || peek() === ')' || peek() === 'or') break;
      const right = parseNot();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  function parseNot(): SearchNode {
    if (peek() === 'not') {
      consume();
      return { kind: 'not', operand: parsePrimary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): SearchNode {
    const t = peek();
    if (t === '(') {
      consume();
      const node = parseOr();
      if (peek() === ')') consume();
      return node;
    }

    const comparison = parseComparisonAtCurrentPosition();
    if (comparison) return comparison;

    const tok = consume();
    return { kind: 'term', value: parseLiteralToken(tok ?? '') };
  }

  return parseOr();
}

function evalSearchNode(node: SearchNode, row: any, cols: string[], haystack: string): boolean {
  switch (node.kind) {
    case 'term':   return haystack.includes(node.value.toLowerCase());
    case 'comparison': {
      const key = resolveColumnKey(node.column, cols);
      if (!key) return false;
      const raw = row?.[key];
      const left = String(raw ?? '').toLowerCase().trim();
      const right = String(node.value ?? '').toLowerCase().trim();
      if (node.op === 'contains') return left.includes(right);
      if (node.op === 'eq') return left === right;
      if (node.op === 'neq') return left !== right;

      const leftNum = Number(raw);
      const rightNum = Number(node.value);
      if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) return false;
      if (node.op === 'gt') return leftNum > rightNum;
      if (node.op === 'gte') return leftNum >= rightNum;
      if (node.op === 'lt') return leftNum < rightNum;
      if (node.op === 'lte') return leftNum <= rightNum;
      return false;
    }
    case 'not':    return !evalSearchNode(node.operand, row, cols, haystack);
    case 'and':    return evalSearchNode(node.left, row, cols, haystack) && evalSearchNode(node.right, row, cols, haystack);
    case 'or':     return evalSearchNode(node.left, row, cols, haystack) || evalSearchNode(node.right, row, cols, haystack);
  }
}

function matchesSearch(query: string, row: any, cols: string[]): boolean {
  if (!query.trim()) return true;
  const node = parseSearchQuery(query);
  if (!node) return true;
  const haystack = cols.map((c: string) => String(row?.[c] ?? '')).join(' ').toLowerCase();
  return evalSearchNode(node, row, cols, haystack);
}

function parseNaturalTerms(raw: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  let negateNext = false;
  const tokens = tokenize(raw.trim());
  const ignored = new Set(['and', 'or', 'is', 'contains', '>', '<', '>=', '<=', '=', '!=', 'greater', 'less', 'than', 'equal', 'to']);
  for (const tok of tokens) {
    if (tok === '(' || tok === ')' || ignored.has(tok)) continue;
    if (tok === 'not') {
      negateNext = true;
      continue;
    }
    let term = tok;
    if (term.startsWith('"') && term.endsWith('"')) {
      try { term = JSON.parse(term); } catch { /* keep as-is */ }
    }
    const normalized = String(term || '').toLowerCase().trim();
    if (!normalized) {
      negateNext = false;
      continue;
    }
    if (negateNext) exclude.push(normalized);
    else include.push(normalized);
    negateNext = false;
  }
  return { include, exclude };
}

function matchesNaturalSearch(query: string, row: any, cols: string[]): boolean {
  const { include, exclude } = parseNaturalTerms(query);
  const haystack = cols.map((c: string) => String(row?.[c] ?? '')).join(' ').toLowerCase();
  if (exclude.some((term) => haystack.includes(term))) return false;
  if (!include.length) return true;
  return include.some((term) => haystack.includes(term));
}
// ─────────────────────────────────────────────────────────────────────────────

export function getAdminSchema(tab: string): any {
  return (((typeof window !== 'undefined' && (window as any).ADMIN_SCHEMA) || {}) as any)[tab];
}

export async function adminDeleteRow(tab: string, row: any, render: () => void, loadAdmin: () => Promise<void>) {
  const schema = getAdminSchema(tab);
  if (!schema) return;
  const rowId = row?.id ?? row?.[schema.cols?.[0]];
  if (!rowId) return;
  if (!(await confirmDialog({ message: 'Delete this item? This cannot be undone.', danger: true }))) return;
  try {
    const base = normalizeAdminPath(schema.apiPath);
    await api.del(`${base}/${rowId}`);
    await loadAdmin();
    render();
  } catch (e) {
    console.error('Failed to delete row:', e);
  }
}

export function adminEditRow(
  tab: string,
  row: any,
  hydrateWizardFromPrompt: (promptRow: any) => void,
  render: () => void,
) {
  const schema = getAdminSchema(tab);
  if (!schema) return;

  if (tab === 'prompts') {
    hydrateWizardFromPrompt(row);
    state.adminEditing = row?.id ?? row?.[schema.cols?.[0]] ?? null;
    state.adminForm = { __promptWizard: true };
    pushAdminHash(tab, state.adminEditing);
    render();
    return;
  }

  state.adminEditing = row?.id ?? row?.[schema.cols?.[0]] ?? null;
  pushAdminHash(tab, state.adminEditing);
  const form = { ...row } as Record<string, unknown>;
  (schema.fields || []).forEach((field: any) => {
    if (field.save === 'csvArr' && form[field.key]) {
      try {
        form[field.key] = JSON.parse(String(form[field.key])).join(', ');
      } catch {}
    } else if ((field.textarea || field.save === 'json' || field.save === 'jsonStr') && form[field.key] != null && typeof form[field.key] !== 'string') {
      try {
        form[field.key] = JSON.stringify(form[field.key], null, 2);
      } catch {}
    }
  });
  state.adminForm = form;
  render();
}

export function adminNewRow(tab: string, render: () => void) {
  const schema = getAdminSchema(tab);
  if (!schema) return;

  if (tab === 'prompts') {
    resetPromptWizard(state, 'create');
    state.adminEditing = null;
    state.adminForm = { __promptWizard: true };
    render();
    return;
  }

  const form: Record<string, unknown> = {};
  (schema.fields || []).forEach((field: any) => {
    if (field.default != null) form[field.key] = field.default;
  });
  state.adminEditing = null;
  state.adminForm = form;
  render();
}

export function adminBackToList(tab: string | undefined, render: () => void) {
  if (!tab || tab === 'prompts') {
    state.promptWizard = null;
  }
  state.adminEditing = null;
  state.adminForm = {};
  if (tab) pushAdminHash(tab);
  render();
}

export function clearAdminEditorState() {
  state.adminEditing = null;
  state.adminForm = {};
}

export async function adminSaveRow(tab: string, render: () => void, loadAdmin: () => Promise<void>) {
  const schema = getAdminSchema(tab);
  if (!schema) return;
  const payload: Record<string, unknown> = {};
  const form = (state.adminForm || {}) as Record<string, unknown>;

  (schema.fields || []).forEach((field: any) => {
    let value = form[field.key];
    if (field.save === 'json') {
      try { value = value ? JSON.parse(String(value)) : null; } catch { value = null; }
    } else if (field.save === 'jsonStr') {
      try { value = value ? JSON.stringify(JSON.parse(String(value))) : null; } catch { value = null; }
    } else if (field.save === 'int') {
      value = value ? parseInt(String(value), 10) : (field.default ?? null);
    } else if (field.save === 'float') {
      value = value ? parseFloat(String(value)) : (field.default ?? null);
    } else if (field.save === 'csvArr') {
      value = value ? String(value).split(',').map((entry) => entry.trim()).filter(Boolean) : [];
    } else if (field.save === 'bool') {
      value = (value === undefined || value === null) ? (field.default ?? false) : (value !== false && value !== 'false');
    } else if (field.save === 'intBool') {
      value = value ? 1 : 0;
    } else {
      value = (value != null && value !== '') ? value : (field.default ?? null);
    }
    payload[field.key] = value;
  });

  try {
    const base = normalizeAdminPath(schema.apiPath);
    if (state.adminEditing) {
      await api.put(`${base}/${state.adminEditing}`, payload);
    } else {
      await api.post(base, payload);
    }
    state.adminEditing = null;
    state.adminForm = {};
    await loadAdmin();
    render();
  } catch (e) {
    console.error('Failed to save admin row:', e);
    void noticeDialog({ message: 'Save failed. Please check the values and try again.' });
  }
}

export function renderAdminForm(
  tab: string,
  onSave: (tab: string) => void,
  onCancel: (tab?: string) => void,
  onDelete?: () => void,
): HTMLElement {
  const schema = getAdminSchema(tab);
  if (!schema) return h('div', null);
  const isEdit = !!state.adminEditing;

  const actionBar = h('div', { className: 'admin-form-action-bar' },
    h('span', { className: 'admin-form-title' }, `${isEdit ? 'Edit' : 'New'} ${schema.singular}`),
    h('div', { className: 'admin-form-action-btns' },
      isEdit
        ? h('button', {
            className: 'admin-form-btn admin-form-btn-share',
            title: 'Copy link to this record',
            onClick: (e: MouseEvent) => {
              const url = buildAdminUrl(tab, state.adminEditing);
              navigator.clipboard.writeText(url).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = url;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
              });
              showCopiedToast(e.currentTarget as HTMLElement);
            },
          }, '⤴ Share')
        : null,
      isEdit && !schema.readOnly && onDelete
        ? h('button', { className: 'admin-form-btn admin-form-btn-delete', onClick: onDelete }, 'Delete')
        : null,
      isEdit && tab === 'artifacts'
        ? h('button', {
            className: 'admin-form-btn admin-form-btn-save',
            title: 'Preview artifact in sandboxed iframe (Phase 5)',
            onClick: () => {
              const id = (state.adminForm as any)?.['id'] as string | undefined;
              if (!id) return;
              // Open a centered preview window for the render endpoint
              const w = Math.min(960, window.innerWidth - 80);
              const h2 = Math.min(700, window.innerHeight - 80);
              const left = Math.round((window.innerWidth - w) / 2);
              const top2 = Math.round((window.innerHeight - h2) / 2);
              window.open(
                `/api/admin/artifacts/${id}/render`,
                'artifact-preview',
                `width=${w},height=${h2},left=${left},top=${top2},scrollbars=yes,resizable=yes`,
              );
            },
          }, '👁 Preview')
        : null,
      isEdit && tab === 'artifacts'
        ? h('button', {
            className: 'admin-form-btn',
            title: 'Phase 6: Toggle live data refresh configuration for this artifact',
            onClick: () => {
              const id = (state.adminForm as any)?.['id'] as string | undefined;
              void configureLiveArtifact(id);
            },
          }, '📡 Configure Live')
        : null,
      isEdit && tab === 'artifacts'
        ? h('button', {
            className: 'admin-form-btn',
            title: 'Phase 7: Download artifact file with proper MIME type',
            onClick: () => {
              const id = (state.adminForm as any)?.['id'] as string | undefined;
              if (!id) return;
              const a = document.createElement('a');
              a.href = `/api/artifacts/${id}/download`;
              a.download = '';
              a.click();
            },
          }, '⬇ Download')
        : null,
      isEdit && tab === 'artifacts'
        ? h('button', {
            className: 'admin-form-btn',
            title: 'Phase 7: Create a shareable public link for this artifact',
            onClick: () => {
              const id = (state.adminForm as any)?.['id'] as string | undefined;
              void shareArtifact(id);
            },
          }, '🔗 Share')
        : null,
      isEdit && tab === 'artifacts'
        ? h('button', {
            className: 'admin-form-btn',
            title: 'Phase 7: Get HTML iframe embed code for this artifact',
            onClick: () => {
              const id = (state.adminForm as any)?.['id'] as string | undefined;
              void getArtifactEmbedCode(id);
            },
          }, '</> Embed')
        : null,
      isEdit && tab === 'kaggle-competitions'
        ? h('button', {
            className: 'admin-form-btn admin-form-btn-save',
            'data-testid': 'kaggle-form-start',
            title: 'Provision a fresh mesh and start a live agent run for this competition',
            onClick: (e: MouseEvent) => {
              void startKaggleCompetitionRun(state.adminForm as any, e.currentTarget as HTMLElement);
            },
          }, '▶ Start Live Run')
        : null,
      h('button', { className: 'admin-form-btn', onClick: () => onCancel(tab) }, 'Cancel'),
      schema.readOnly
        ? null
        : h('button', { className: 'admin-form-btn admin-form-btn-save', onClick: () => onSave(tab) }, isEdit ? 'Save' : 'Create'),
    )
  );

  const form = h('div', { className: 'chart-box', style: 'margin-bottom:16px;' }, actionBar);

  (schema.fields || []).forEach((field: any) => {
    const currentVal = (state.adminForm?.[field.key] ?? '') as any;
    const row = h('div', { style: 'margin-bottom:10px;' },
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, field.label)
    );

    if (field.type === 'checkbox') {
      const checkbox = h('input', {
        type: 'checkbox',
        checked: !!currentVal,
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLInputElement).checked };
        },
      }) as HTMLInputElement;
      row.appendChild(checkbox);
    } else if (field.options && Array.isArray(field.options)) {
      const select = h('select', {
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLSelectElement).value };
        },
      }) as HTMLSelectElement;
      field.options.forEach((option: string) => {
        const el = h('option', { value: option }, option) as HTMLOptionElement;
        if (String(currentVal) === String(option)) el.selected = true;
        select.appendChild(el);
      });
      row.appendChild(select);
    } else if (field.textarea) {
      row.appendChild(h('textarea', {
        rows: String(field.rows || 3),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
        value: String(currentVal ?? ''),
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLTextAreaElement).value };
        },
      }));
    } else {
      row.appendChild(h('input', {
        type: field.type === 'number' ? 'number' : 'text',
        value: String(currentVal ?? ''),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLInputElement).value };
        },
      }));
    }

    form.appendChild(row);
  });

  return form;
}

export function renderAdminBreadcrumbs(tab: string, schema: any, onBack: (tab?: string) => void): HTMLElement {
  const listLabel = schema ? `${schema.singular}s` : 'Records';
  const actionLabel = state.adminEditing ? 'Edit' : 'New';
  return h('nav', { className: 'admin-breadcrumbs', 'aria-label': 'Breadcrumb' },
    h('button', {
      className: 'admin-breadcrumb-back',
      title: `Back to ${listLabel}`,
      'data-testid': 'admin-breadcrumb-back',
      onClick: () => onBack(tab),
    }, '←'),
    h('ol', { className: 'admin-breadcrumb-list' },
      h('li', { className: 'admin-breadcrumb-item' },
        h('button', {
          className: 'admin-breadcrumb-link',
          'data-testid': 'admin-breadcrumb-list',
          onClick: () => onBack(tab),
        }, listLabel)
      ),
      h('li', { className: 'admin-breadcrumb-item admin-breadcrumb-item-current', 'aria-current': 'page' }, `${actionLabel} ${schema?.singular || 'Record'}`)
    )
  );
}

export function renderAdminView(options: {
  hydrateWizardFromPrompt: (promptRow: any) => void;
  renderPromptSetupWizard: () => HTMLElement;
  render: () => void;
  loadAdmin: () => Promise<void>;
}): HTMLElement {
  const tabs = Object.keys(((typeof window !== 'undefined' && (window as any).ADMIN_SCHEMA) || {}));
  const currentTab = tabs.includes(state.adminTab) ? state.adminTab : tabs[0];
  if (!tabs.includes(state.adminTab) && currentTab) {
    state.adminTab = currentTab;
  }
  const schema = getAdminSchema(currentTab);
  const rows = (state.adminData?.[currentTab] || []) as any[];
  const promptDetailOpen = currentTab === 'prompts' && !!((state.adminForm || {}) as any)['__promptWizard'];
  // Allow editor open for read-only tabs that supply a customRecordView (no
  // form, just a custom detail panel like the Live Competition Runs UI).
  const editorAllowed = !schema?.readOnly || !!schema?.customRecordView;
  const showEditor = editorAllowed && (promptDetailOpen || state.adminEditing !== null || Object.keys(state.adminForm || {}).length > 0);

  // Reset list controls when the active tab changes
  if (state.adminListCurrentTab !== currentTab) {
    state.adminListCurrentTab = currentTab;
    state.adminListSearch = '';
    state.adminListSortCol = null;
    state.adminListSortDir = 'asc';
    state.adminListGroupBy = '';
    state.adminListPage = 1;
    state.adminListGroupCollapsed = {};
    (state as any)._adminExcludeSearch = '';
    (state as any)._adminExcludeCol = '';
    (state as any)._adminSelectedRowIds = [];
    (state as any)._adminSelectionAnchor = null;
  }

  const page = h('div', { className: 'dash-view' },
    h('h2', null, 'Administration'),
    schema ? h('div', { style: 'margin-top:-16px;margin-bottom:16px;color:var(--fg3);font-size:12px;' }, `${schema.singular}s`) : null
  );
  const right = h('div', { className: 'admin-main-panel' });

  if (showEditor) {
    right.appendChild(renderAdminBreadcrumbs(currentTab, schema, (tab) => adminBackToList(tab, options.render)));
    if (currentTab === 'prompts') {
      right.appendChild(options.renderPromptSetupWizard());
    } else if (schema?.customRecordView === 'kaggle-competition-runs') {
      const runId = state.adminEditing != null ? String(state.adminEditing) : null;
      if (runId) {
        right.appendChild(h('div', { className: 'admin-detail-panel' },
          renderKglCompetitionRunDetail({ runId, render: options.render })));
      } else {
        right.appendChild(h('div', { className: 'admin-detail-panel', style: 'padding:16px;color:var(--fg3);' },
          'No run selected.'));
      }
    } else {
      right.appendChild(h('div', { className: 'admin-detail-panel' }, renderAdminForm(
        currentTab,
        (tab) => { void adminSaveRow(tab, options.render, options.loadAdmin); },
        (tab) => adminBackToList(tab, options.render),
        () => { void adminDeleteRow(currentTab, state.adminForm as any, options.render, options.loadAdmin); },
      )));
    }
    page.appendChild(right);
    return page;
  }

  // Custom views (e.g. Tool Simulation step-through UI)
  if (schema?.customView === 'tool-simulation') {
    right.appendChild(renderToolSimulationView({ render: options.render }));
    page.appendChild(right);
    return page;
  }

  if (schema?.customView === 'tool-approval-requests') {
    right.appendChild(renderToolApprovalView({ render: options.render }));
    page.appendChild(right);
    return page;
  }

  if (schema?.customView === 'mcp-gateway-clients') {
    right.appendChild(renderMCPGatewayClientsView({ render: options.render }));
    page.appendChild(right);
    return page;
  }

  if (schema?.customView === 'mcp-gateway-activity') {
    right.appendChild(renderMCPGatewayActivityView({ render: options.render }));
    page.appendChild(right);
    return page;
  }

  if (schema?.customView === 'capability-matrix') {
    right.appendChild(renderCapabilityMatrixView({ render: options.render }));
    page.appendChild(right);
    return page;
  }

  if (schema?.customView === 'routing-simulator') {
    right.appendChild(renderRoutingSimulatorView({ render: options.render }));
    page.appendChild(right);
    return page;
  }

  const searchCols = getListableCols(schema);
  const cols = getVisibleCols(currentTab, searchCols);
  const PAGE_SIZE = 25;
  const searchQuery = ((state.adminListSearch as string) || '').toLowerCase().trim();
  const sortCol: string | null = (state.adminListSortCol as string | null) || null;
  const sortDir: 'asc' | 'desc' = (state.adminListSortDir as 'asc' | 'desc') || 'asc';
  const groupBy: string = (state.adminListGroupBy as string) || '';
  const currentPage: number = (state.adminListPage as number) || 1;
  const groupCollapsed: Record<string, boolean> = (state.adminListGroupCollapsed as Record<string, boolean>) || {};
  const selectedIdSet = new Set<string>(((state as any)._adminSelectedRowIds || []).map((id: any) => String(id)));

  // 1. Filter
  const excludeVal: string = (state as any)._adminExcludeSearch || '';
  const excludeCol: string = (state as any)._adminExcludeCol || '';
  const baseFiltered: any[] = rows.filter((row: any) => {
    if (excludeVal && excludeCol && String(row?.[excludeCol] ?? '') === excludeVal) return false;
    return true;
  });

  let filtered: any[];
  if (!searchQuery) {
    filtered = baseFiltered;
  } else {
    const strictFiltered = baseFiltered.filter((row: any) => matchesSearch(searchQuery, row, searchCols));
    filtered = strictFiltered.length > 0
      ? strictFiltered
      : baseFiltered.filter((row: any) => matchesNaturalSearch(searchQuery, row, searchCols));
  }

  // 2. Sort
  if (sortCol) {
    filtered = [...filtered].sort((a: any, b: any) => {
      const av = String(a?.[sortCol] ?? '');
      const bv = String(b?.[sortCol] ?? '');
      const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  // 3. Paginate flat list
  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pagedRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // 4. Group the current page's rows
  let groupedRows: Array<{ groupKey: string; rows: any[] }> | null = null;
  if (groupBy && cols.includes(groupBy)) {
    const groupMap = new Map<string, any[]>();
    pagedRows.forEach((row: any) => {
      const key = String(row?.[groupBy] ?? '(empty)');
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(row);
    });
    groupedRows = Array.from(groupMap.entries()).map(([groupKey, groupRows]) => ({ groupKey, rows: groupRows }));
  }

  const visibleRowsForSelection = groupedRows
    ? groupedRows.flatMap(({ groupKey, rows: groupRows }) => (groupCollapsed[groupKey] ? [] : groupRows))
    : pagedRows;

  const content = h('div', { className: 'admin-content-grid' });
  const listPanel = h('div', { className: 'table-wrap admin-list-panel' });

  // Panel header row: title + New button
  listPanel.appendChild(
    h('div', { className: 'admin-list-header' },
      h('h3', { style: 'margin:0;' }, schema ? `${schema.singular}s` : 'Records'),
      schema?.readOnly
        ? h('span', { style: 'font-size:12px;color:var(--fg3);' }, 'Read only')
        : h('button', { className: 'nav-btn active', onClick: () => adminNewRow(currentTab, options.render) }, '+ New')
    )
  );

  // Toolbar: search + group-by selector
  const searchInput = h('input', {
    type: 'text',
    className: 'admin-list-search',
    placeholder: 'Search…',
    value: state.adminListSearch || '',
    onInput: (e: Event) => {
      state.adminListSearch = (e.target as HTMLInputElement).value;
      state.adminListPage = 1;
      clearTimeout((state as any)._searchDebounce);
      (state as any)._searchDebounce = setTimeout(() => {
        options.render();
        const newInput = document.querySelector('.admin-list-search') as HTMLInputElement | null;
        if (newInput) {
          newInput.focus();
          const len = newInput.value.length;
          newInput.setSelectionRange(len, len);
        }
      }, 180);
    },
  }) as HTMLInputElement;

  const activeGroupHint = groupBy ? h('span', { className: 'admin-grouped-hint', title: 'Right-click a column header to change' }, `Grouped by: ${groupBy.replace(/_/g, ' ')}`) : null;

  const excludeValActive: string = (state as any)._adminExcludeSearch || '';
  const excludeColActive: string = (state as any)._adminExcludeCol || '';
  const activeExcludeHint = excludeValActive
    ? h('span', {
        className: 'admin-grouped-hint admin-exclude-hint',
        title: 'Click to clear exclusion filter',
        onClick: () => {
          (state as any)._adminExcludeSearch = '';
          (state as any)._adminExcludeCol = '';
          state.adminListPage = 1;
          options.render();
        },
      }, `Excluding: ${excludeColActive.replace(/_/g, ' ')} = ${excludeValActive} ✕`)
    : null;

  listPanel.appendChild(
    h('div', { className: 'admin-list-toolbar' },
      h('div', {
        className: 'admin-list-search-wrap',
        onMouseenter: function (this: HTMLElement) { showFastTip(this, 'Filter by text — or use: name is writer · score > 10 · status is not draft'); },
        onMouseleave: () => hideFastTip(),
        onFocusin: function (this: HTMLElement) { showFastTip(this, 'Filter by text — or use: name is writer · score > 10 · status is not draft'); },
        onFocusout: () => hideFastTip(),
      },
        h('span', { className: 'admin-list-search-icon' }, '🔍'),
        searchInput
      ),
      activeGroupHint,
      activeExcludeHint
    )
  );

  // Column manager button
  if (schema) {
    let colMgrBtn: HTMLElement;
    colMgrBtn = h('button', {
      className: 'nav-btn admin-col-mgr-btn',
      title: 'Show, hide, or reorder table columns',
      onClick: () => showColumnManager(colMgrBtn, currentTab, searchCols, cols, options.render),
    }, '⊞ Columns');
    (listPanel.querySelector('.admin-list-toolbar') as HTMLElement).appendChild(colMgrBtn);
  }

  // Kaggle competition discovery — pulls active competitions from the live
  // Kaggle API into kaggle_competitions_tracked so this list reflects the
  // real catalog rather than just hand-seeded demo rows.
  if (currentTab === 'kaggle-competitions') {
    const discoverBtn = h('button', {
      className: 'nav-btn',
      'data-testid': 'kaggle-discover-btn',
      title: 'Fetch active Kaggle competitions and add them to this table',
      style: 'background:var(--accent);color:#fff;border-color:var(--accent);',
      onClick: async (e: MouseEvent) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const pagesRaw = await promptDialog({ title: 'Discover Kaggle competitions', message: 'How many pages of Kaggle competitions to fetch? (1–10, ~20 per page)', defaultValue: '3', confirmLabel: 'Fetch' });
        if (pagesRaw === null) return;
        const pages = Math.max(1, Math.min(10, Number(pagesRaw) || 1));
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Discovering…';
        try {
          const resp = await api.post('/api/kaggle/competitions/discover', { pages });
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            void noticeDialog({ message: `Discovery failed (HTTP ${resp.status}): ${text || resp.statusText}` });
            return;
          }
          const body = await resp.json().catch(() => ({} as any));
          void noticeDialog({ message: `Discovered ${body.inserted ?? 0} competitions across ${body.pages ?? pages} page(s).` });
          options.render();
        } catch (err) {
          void noticeDialog({ message: `Discovery failed: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      },
    }, '🔎 Discover Competitions');
    (listPanel.querySelector('.admin-list-toolbar') as HTMLElement).appendChild(discoverBtn);
  }

  if (!schema) {
    listPanel.appendChild(h('div', { style: 'padding:16px;color:var(--fg3);' }, 'No schema for selected tab.'));
  } else if (!rows.length) {
    listPanel.appendChild(h('div', { style: 'padding:20px;color:var(--fg3);text-align:center;' }, 'No records found. Create one with + New.'));
  } else if (!filtered.length) {
    listPanel.appendChild(h('div', { style: 'padding:20px;color:var(--fg3);text-align:center;' }, `No records match "${state.adminListSearch}".`));
  } else {
    // Sortable column header cells — left-click sorts, right-click opens context menu
    const showStartAction = currentTab === 'kaggle-competitions';
    const headerCells = cols.map((col: string) => {
      const isActive = sortCol === col;
      const isGrouped = groupBy === col;
      const indicator = isActive ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
      const th = h('th', {
        className: `sortable${isActive ? ' sort-active' : ''}${isGrouped ? ' col-grouped' : ''}`,
        title: 'Left-click to sort · Right-click for more options',
        onClick: () => {
          if (state.adminListSortCol === col) {
            state.adminListSortDir = state.adminListSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            state.adminListSortCol = col;
            state.adminListSortDir = 'asc';
          }
          state.adminListPage = 1;
          options.render();
        },
        onContextmenu: (e: MouseEvent) => {
          e.preventDefault();
           showColumnContextMenu(col, currentTab, schema, cols, e.clientX, e.clientY, rows, filtered, options);
        },
      },
        col.replace(/_/g, ' '),
        h('span', { className: 'sort-indicator' }, ` ${indicator}`),
        isGrouped ? h('span', { className: 'col-group-badge' }, '⊞') : null
      );
      return th;
    });
    if (showStartAction) {
      headerCells.unshift(
        h('th', { className: 'admin-action-col', title: 'Start a live agent run', style: 'width:64px;text-align:center;' }, 'Run'),
      );
    }
    const tbody = h('tbody', null);
    let rowRenderIndex = 0;

    if (groupedRows) {
      groupedRows.forEach(({ groupKey, rows: groupRowList }) => {
        const isCollapsed = groupCollapsed[groupKey] === true;
        tbody.appendChild(
          h('tr', {
            className: 'admin-group-header-row',
            onClick: () => {
              state.adminListGroupCollapsed = { ...groupCollapsed, [groupKey]: !isCollapsed };
              options.render();
            },
          },
            h('td', { colSpan: String(cols.length + (showStartAction ? 1 : 0)) },
              isCollapsed ? '▶ ' : '▼ ',
              h('strong', null, groupKey),
              h('span', { className: 'admin-group-count' }, `${groupRowList.length} item${groupRowList.length !== 1 ? 's' : ''}`)
            )
          )
        );
        if (!isCollapsed) {
          groupRowList.forEach((row: any) => {
            tbody.appendChild(buildAdminRow(row, cols, currentTab, schema, visibleRowsForSelection, rowRenderIndex, selectedIdSet, options));
            rowRenderIndex++;
          });
        }
      });
    } else {
      pagedRows.forEach((row: any) => {
        tbody.appendChild(buildAdminRow(row, cols, currentTab, schema, visibleRowsForSelection, rowRenderIndex, selectedIdSet, options));
        rowRenderIndex++;
      });
    }
    listPanel.appendChild(
      h('table', { className: 'eval-table' },
        h('thead', null, h('tr', null, ...headerCells)),
        tbody
      )
    );

    // Pagination footer
    const from = pageStart + 1;
    const to = Math.min(pageStart + PAGE_SIZE, totalItems);
    const countLabel = searchQuery
      ? `${from}–${to} of ${totalItems} filtered (${rows.length} total)`
      : `${from}–${to} of ${totalItems} record${totalItems !== 1 ? 's' : ''}`;

    // Page number buttons with ellipsis
    const pageButtons: HTMLElement[] = [];
    const WINDOW = 2;
    let lastRendered = 0;
    for (let p = 1; p <= totalPages; p++) {
      const inWindow = p === 1 || p === totalPages || (p >= safePage - WINDOW && p <= safePage + WINDOW);
      if (inWindow) {
        if (lastRendered && p - lastRendered > 1) {
          pageButtons.push(h('span', { className: 'admin-page-ellipsis' }, '…'));
        }
        pageButtons.push(
          h('button', {
            className: `admin-page-btn${p === safePage ? ' active' : ''}`,
            disabled: p === safePage,
            onClick: () => { state.adminListPage = p; options.render(); },
          }, String(p))
        );
        lastRendered = p;
      }
    }

    listPanel.appendChild(
      h('div', { className: 'admin-list-footer' },
        h('span', { className: 'admin-list-info' }, countLabel),
        h('div', { className: 'admin-list-pagination' },
          h('button', {
            className: 'admin-page-btn',
            disabled: safePage <= 1,
            onClick: () => { state.adminListPage = safePage - 1; options.render(); },
          }, '← Prev'),
          ...pageButtons,
          h('button', {
            className: 'admin-page-btn',
            disabled: safePage >= totalPages,
            onClick: () => { state.adminListPage = safePage + 1; options.render(); },
          }, 'Next →')
        )
      )
    );
  }

  content.appendChild(listPanel);
  right.appendChild(content);
  page.appendChild(right);
  return page;
}

function showColumnContextMenu(
  col: string,
  currentTab: string,
  schema: any,
    visibleCols: string[],
  x: number,
  y: number,
  allRows: any[],
  filteredRows: any[],
  options: {
    hydrateWizardFromPrompt: (promptRow: any) => void;
    render: () => void;
    loadAdmin: () => Promise<void>;
  },
) {
  // Dismiss any existing menu
  document.querySelector('.col-ctx-menu')?.remove();

  const isSortedByThis = state.adminListSortCol === col;
  const sortedAsc = isSortedByThis && state.adminListSortDir === 'asc';
  const sortedDesc = isSortedByThis && state.adminListSortDir === 'desc';
  const isGrouped = state.adminListGroupBy === col;
  const hasGrouping = !!state.adminListGroupBy;

  // Collect unique values from filtered data for quick-filter
  const colIdx = visibleCols.indexOf(col);

  const allVals = filteredRows.map((r: any) => String(r?.[col] ?? ''));
  const uniqueVals = [...new Set(allVals)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 8);

  const dismissCol = () => document.querySelectorAll('.col-ctx-menu').forEach(el => el.remove());

  type MenuItem = CtxMenuItem;

  const items: MenuItem[] = [
    { kind: 'header', label: col.replace(/_/g, ' ').toUpperCase() },
    { kind: 'sep' },
    {
      kind: 'item', label: 'Sort A → Z', icon: '↑', active: sortedAsc,
      action: () => { state.adminListSortCol = col; state.adminListSortDir = 'asc'; state.adminListPage = 1; options.render(); },
    },
    {
      kind: 'item', label: 'Sort Z → A', icon: '↓', active: sortedDesc,
      action: () => { state.adminListSortCol = col; state.adminListSortDir = 'desc'; state.adminListPage = 1; options.render(); },
    },
    {
      kind: 'item', label: 'Clear Sort', icon: '✕', disabled: !isSortedByThis,
      action: () => { state.adminListSortCol = null; options.render(); },
    },
    { kind: 'sep' },
    {
      kind: 'item', label: isGrouped ? 'Ungroup' : 'Group by this column', icon: isGrouped ? '⊟' : '⊞', active: isGrouped,
      action: () => { state.adminListGroupBy = isGrouped ? '' : col; state.adminListPage = 1; state.adminListGroupCollapsed = {}; options.render(); },
    },
    {
      kind: 'item', label: 'Clear Grouping', icon: '◻', disabled: !hasGrouping,
      action: () => { state.adminListGroupBy = ''; state.adminListGroupCollapsed = {}; options.render(); },
    },
      { kind: 'sep' },
      {
        kind: 'item', label: 'Move Left', icon: '←', disabled: colIdx <= 0,
        action: () => {
          const nc = [...visibleCols];
            const tmp = nc[colIdx - 1] as string; nc[colIdx - 1] = nc[colIdx] as string; nc[colIdx] = tmp;
          setVisibleCols(currentTab, nc, options.render);
          dismissCol();
        },
      },
      {
        kind: 'item', label: 'Move Right', icon: '→', disabled: colIdx < 0 || colIdx >= visibleCols.length - 1,
        action: () => {
          const nc = [...visibleCols];
            const tmp = nc[colIdx + 1] as string; nc[colIdx + 1] = nc[colIdx] as string; nc[colIdx] = tmp;
          setVisibleCols(currentTab, nc, options.render);
          dismissCol();
        },
      },
      {
        kind: 'item', label: 'Hide Column', icon: '✕', disabled: visibleCols.length <= 1,
        action: () => {
          setVisibleCols(currentTab, visibleCols.filter((c) => c !== col), options.render);
          dismissCol();
        },
      },
    { kind: 'sep' },
    {
      kind: 'item', label: 'Copy All Values', icon: '⎘',
      action: () => { void navigator.clipboard.writeText(allVals.join('\n')); dismissCol(); },
    },
    {
      kind: 'item', label: 'Copy Unique Values', icon: '⎘',
      action: () => { void navigator.clipboard.writeText(uniqueVals.join('\n')); dismissCol(); },
    },
    {
      kind: 'item', label: 'Show Summary', icon: '∑',
      action: () => {
        const nums = allVals.map(Number).filter(n => !isNaN(n));
        let msg = `Column: ${col}\nTotal rows: ${allVals.length}\nUnique values: ${uniqueVals.length}`;
        if (nums.length === allVals.length && nums.length > 0) {
          const sum = nums.reduce((a, b) => a + b, 0);
          msg += `\nMin: ${Math.min(...nums)}\nMax: ${Math.max(...nums)}\nAvg: ${(sum / nums.length).toFixed(2)}\nSum: ${sum}`;
        }
        void noticeDialog({ message: msg });
        dismissCol();
      },
    },
    { kind: 'sep' },
    {
      kind: 'item', label: 'Export all', icon: '⇪',
      submenu: [
        { label: 'JSON', icon: '{ }', action: () => { exportRows(allRows, schema, currentTab, 'json', 'all'); dismissCol(); } },
        { label: 'CSV', icon: '🧾', action: () => { exportRows(allRows, schema, currentTab, 'csv', 'all'); dismissCol(); } },
        { label: 'Excel', icon: '📗', action: () => { exportRows(allRows, schema, currentTab, 'excel', 'all'); dismissCol(); } },
      ],
    },
  ];

  renderContextMenu(items, x, y, 'col-ctx-menu');
}

function showColumnManager(
  anchorEl: HTMLElement,
  currentTab: string,
  schemaCols: string[],
  _currentVisible: string[],
  render: () => void,
): void {
  document.querySelector('.admin-col-manager')?.remove();

  const panel = document.createElement('div');
  panel.className = 'admin-col-manager';

  const rect = anchorEl.getBoundingClientRect();
  panel.style.cssText = `position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;z-index:9000;`;

  const rebuild = () => {
    panel.innerHTML = '';
    const vis = getVisibleCols(currentTab, schemaCols);
    const hidden = schemaCols.filter((c) => !vis.includes(c));

    const hdrRow = document.createElement('div');
    hdrRow.className = 'admin-col-manager-header';
    const hdrTitle = document.createElement('span');
    hdrTitle.textContent = 'Columns';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'admin-col-manager-reset';
    resetBtn.textContent = 'Reset';
    resetBtn.onclick = () => {
      const config: Record<string, string[]> = (state as any)._adminColConfig || {};
      const { [currentTab]: _r, ...rest } = config;
      (state as any)._adminColConfig = rest;
      render();
      rebuild();
    };
    hdrRow.appendChild(hdrTitle);
    hdrRow.appendChild(resetBtn);
    panel.appendChild(hdrRow);

    const visLabel = document.createElement('div');
    visLabel.className = 'admin-col-manager-section-label';
    visLabel.textContent = `Visible (${vis.length})`;
    panel.appendChild(visLabel);

    vis.forEach((col, i) => {
      const item = document.createElement('div');
      item.className = 'admin-col-manager-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'admin-col-manager-name';
      nameSpan.textContent = col.replace(/_/g, ' ');

      const upBtn = document.createElement('button');
      upBtn.className = 'admin-col-manager-btn';
      upBtn.title = 'Move left';
      upBtn.textContent = '←';
      upBtn.disabled = i === 0;
  upBtn.onclick = () => { const nc = [...vis]; const t = nc[i - 1] as string; nc[i - 1] = nc[i] as string; nc[i] = t; setVisibleCols(currentTab, nc, render); rebuild(); };

      const downBtn = document.createElement('button');
      downBtn.className = 'admin-col-manager-btn';
      downBtn.title = 'Move right';
      downBtn.textContent = '→';
      downBtn.disabled = i === vis.length - 1;
  downBtn.onclick = () => { const nc = [...vis]; const t = nc[i + 1] as string; nc[i + 1] = nc[i] as string; nc[i] = t; setVisibleCols(currentTab, nc, render); rebuild(); };

      const hideBtn = document.createElement('button');
      hideBtn.className = 'admin-col-manager-btn admin-col-manager-hide';
      hideBtn.title = 'Hide column';
      hideBtn.textContent = '✕';
      hideBtn.disabled = vis.length <= 1;
      hideBtn.onclick = () => { setVisibleCols(currentTab, vis.filter((c) => c !== col), render); rebuild(); };

      item.appendChild(nameSpan);
      item.appendChild(upBtn);
      item.appendChild(downBtn);
      item.appendChild(hideBtn);
      panel.appendChild(item);
    });

    if (hidden.length > 0) {
      const hidLabel = document.createElement('div');
      hidLabel.className = 'admin-col-manager-section-label admin-col-manager-section-label-hidden';
      hidLabel.textContent = `Hidden (${hidden.length})`;
      panel.appendChild(hidLabel);

      hidden.forEach((col) => {
        const item = document.createElement('div');
        item.className = 'admin-col-manager-item admin-col-manager-item-hidden';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'admin-col-manager-name';
        nameSpan.textContent = col.replace(/_/g, ' ');

        const addBtn = document.createElement('button');
        addBtn.className = 'admin-col-manager-btn admin-col-manager-add';
        addBtn.title = 'Show column';
        addBtn.textContent = '+';
        addBtn.onclick = () => { setVisibleCols(currentTab, [...vis, col], render); rebuild(); };

        item.appendChild(nameSpan);
        item.appendChild(addBtn);
        panel.appendChild(item);
      });
    }
  };

  rebuild();
  document.body.appendChild(panel);

  const outsideClick = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node) && e.target !== anchorEl && !anchorEl.contains(e.target as Node)) {
      panel.remove();
      document.removeEventListener('mousedown', outsideClick);
      document.removeEventListener('keydown', escClose);
    }
  };
  const escClose = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      panel.remove();
      document.removeEventListener('mousedown', outsideClick);
      document.removeEventListener('keydown', escClose);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', outsideClick);
    document.addEventListener('keydown', escClose);
  }, 0);
}

type CtxMenuItem =
  | { kind: 'sep' }
  | { kind: 'header'; label: string }
  | {
      kind: 'item';
      label: string;
      icon?: string;
      disabled?: boolean;
      active?: boolean;
      danger?: boolean;
      action?: () => void;
      submenu?: Array<{ label: string; icon?: string; disabled?: boolean; action: () => void }>;
    };

function renderContextMenu(items: CtxMenuItem[], x: number, y: number, cls = 'col-ctx-menu') {
  document.querySelectorAll('.col-ctx-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = cls;

  let activeSubmenu: HTMLDivElement | null = null;
  const closeSubmenu = () => {
    activeSubmenu?.remove();
    activeSubmenu = null;
  };

  const dismiss = () => {
    closeSubmenu();
    menu.remove();
  };

  const openSubmenu = (
    hostEl: HTMLElement,
    submenuItems: Array<{ label: string; icon?: string; disabled?: boolean; action: () => void }>,
  ) => {
    closeSubmenu();
    const submenu = document.createElement('div');
    submenu.className = `${cls} col-ctx-submenu`;

    submenuItems.forEach((sub) => {
      const subEl = document.createElement('div');
      subEl.className = `col-ctx-item${sub.disabled ? ' ctx-disabled' : ''}`;
      subEl.innerHTML = `<span class="ctx-icon">${sub.icon ?? ' '}</span><span>${sub.label}</span>`;
      if (!sub.disabled) {
        subEl.addEventListener('click', () => {
          sub.action();
          dismiss();
        });
      }
      submenu.appendChild(subEl);
    });

    document.body.appendChild(submenu);
    activeSubmenu = submenu;

    const hostRect = hostEl.getBoundingClientRect();
    const subRect = submenu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const preferredLeft = hostRect.right + 4;
    const fallbackLeft = hostRect.left - subRect.width - 4;
    const left = preferredLeft + subRect.width <= vw - 4 ? preferredLeft : Math.max(4, fallbackLeft);
    const top = Math.min(Math.max(4, hostRect.top - 2), Math.max(4, vh - subRect.height - 4));

    submenu.style.left = `${left}px`;
    submenu.style.top = `${top}px`;
  };

  items.forEach(item => {
    if (item.kind === 'sep') {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'col-ctx-sep' }));
    } else if (item.kind === 'header') {
      const el = document.createElement('div');
      el.className = 'col-ctx-header';
      el.textContent = item.label;
      menu.appendChild(el);
    } else {
      const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
      const el = document.createElement('div');
      el.className = `col-ctx-item${item.disabled ? ' ctx-disabled' : ''}${item.active ? ' ctx-active' : ''}${item.danger ? ' ctx-danger' : ''}${hasSubmenu ? ' ctx-has-submenu' : ''}`;
      el.innerHTML = `<span class="ctx-icon">${item.icon ?? ' '}</span><span>${item.label}</span>${hasSubmenu ? '<span class="ctx-caret">›</span>' : ''}`;

      if (!item.disabled) {
        if (hasSubmenu && item.submenu) {
          el.addEventListener('mouseenter', () => openSubmenu(el, item.submenu!));
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            openSubmenu(el, item.submenu!);
          });
        } else if (item.action) {
          el.addEventListener('mouseenter', closeSubmenu);
          el.addEventListener('click', () => { item.action?.(); dismiss(); });
        }
      }

      menu.appendChild(el);
    }
  });

  document.body.appendChild(menu);

  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  const left = x + rect.width > vw ? vw - rect.width - 8 : x;
  const top = y + rect.height > vh ? vh - rect.height - 8 : y;
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  const onOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (!menu.contains(target) && !(activeSubmenu && activeSubmenu.contains(target))) {
      dismiss();
      document.removeEventListener('mousedown', onOutside);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey); }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function showCellContextMenu(
  col: string,
  value: string,
  row: any,
  currentTab: string,
  schema: any,
  visibleRowsForSelection: any[],
  x: number,
  y: number,
  options: {
    hydrateWizardFromPrompt: (promptRow: any) => void;
    render: () => void;
    loadAdmin: () => Promise<void>;
  },
) {
  const colLabel = col.replace(/_/g, ' ');
  const isFiltered = state.adminListSearch === value;
  const isExcluded = (state as any)._adminExcludeSearch === value && (state as any)._adminExcludeCol === col;
  const isUrl = /^https?:\/\//.test(value);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const isNumeric = value !== '' && value !== '—' && !isNaN(Number(value));
  const selectedIds = new Set<string>(((state as any)._adminSelectedRowIds || []).map((id: any) => String(id)));
  const rowId = getRowSelectionId(row, schema);
  const selectedRows = rowId && selectedIds.has(rowId)
    ? visibleRowsForSelection.filter((r) => selectedIds.has(getRowSelectionId(r, schema)))
    : [];
  const hasMultiSelection = selectedRows.length > 1;
  const exportRowsSet = hasMultiSelection ? selectedRows : [row];
  const exportScope: 'selected' | 'record' = hasMultiSelection ? 'selected' : 'record';
  const exportCount = exportRowsSet.length;

  const items: CtxMenuItem[] = [
    { kind: 'header', label: `${colLabel}: ${value.length > 40 ? value.slice(0, 37) + '…' : value || '(empty)'}` },
    { kind: 'sep' },
    {
      kind: 'item', label: isFiltered ? 'Remove Filter' : 'Filter by This Value', icon: isFiltered ? '✕' : '▼', active: isFiltered,
      action: () => {
        state.adminListSearch = isFiltered ? '' : value;
        (state as any)._adminExcludeSearch = '';
        state.adminListPage = 1;
        options.render();
      },
    },
    {
      kind: 'item', label: isExcluded ? 'Remove Exclusion' : 'Filter Out This Value', icon: isExcluded ? '✕' : '⊘', active: isExcluded,
      action: () => {
        if (isExcluded) {
          (state as any)._adminExcludeSearch = '';
          (state as any)._adminExcludeCol = '';
        } else {
          (state as any)._adminExcludeSearch = value;
          (state as any)._adminExcludeCol = col;
        }
        state.adminListPage = 1;
        options.render();
      },
    },
    { kind: 'sep' },
    {
      kind: 'item', label: 'Copy Value', icon: '⎘',
      action: () => { void navigator.clipboard.writeText(value); },
    },
    {
      kind: 'item', label: 'Copy Row as JSON', icon: '{ }',
      action: () => { void navigator.clipboard.writeText(JSON.stringify(row, null, 2)); },
    },
    {
      kind: 'item', label: 'Copy Record Link', icon: '⤴',
      action: () => {
        const rowId = row?.id ?? row?.[schema?.cols?.[0]];
        if (rowId == null || rowId === '') return;
        const url = buildAdminUrl(currentTab, rowId);
        void navigator.clipboard.writeText(url);
      },
    },
    { kind: 'sep' },
    {
      kind: 'item', label: `Export ${exportCount}`, icon: '⇪',
      submenu: [
        { label: 'JSON', icon: '{ }', action: () => { exportRows(exportRowsSet, schema, currentTab, 'json', exportScope); } },
        { label: 'CSV', icon: '🧾', action: () => { exportRows(exportRowsSet, schema, currentTab, 'csv', exportScope); } },
        { label: 'Excel', icon: '📗', action: () => { exportRows(exportRowsSet, schema, currentTab, 'excel', exportScope); } },
      ],
    },
    { kind: 'sep' },
    {
      kind: 'item', label: 'Edit This Record', icon: '✎',
      disabled: !!schema?.readOnly,
      action: () => { adminEditRow(currentTab, row, options.hydrateWizardFromPrompt, options.render); },
    },
    {
      kind: 'item', label: 'Duplicate Record', icon: '⧉',
      disabled: !!schema?.readOnly,
      action: () => {
        // Strip id/pk fields so a new record is created
        const clone = { ...row };
        delete clone.id;
        delete clone.key;
        state.adminForm = clone;
        state.adminEditing = null;
        options.render();
      },
    },
    {
      kind: 'item', label: 'Delete This Record', icon: '🗑', danger: true,
      disabled: !!schema?.readOnly,
      action: () => { void adminDeleteRow(currentTab, row, options.render, options.loadAdmin); },
    },
    ...(isUrl ? [
      { kind: 'sep' as const },
      { kind: 'item' as const, label: 'Open URL in New Tab', icon: '↗', action: () => { window.open(value, '_blank', 'noopener'); } },
    ] : []),
    ...(isEmail ? [
      { kind: 'sep' as const },
      { kind: 'item' as const, label: 'Send Email', icon: '✉', action: () => { window.location.href = `mailto:${value}`; } },
    ] : []),
    ...(isNumeric ? [
      { kind: 'sep' as const },
      { kind: 'item' as const, label: 'Highlight Rows ≥ This', icon: '≥', action: () => {
        state.adminListSearch = value;
        state.adminListSortCol = col;
        state.adminListSortDir = 'asc';
        state.adminListPage = 1;
        options.render();
      }},
    ] : []),
  ];

  renderContextMenu(items, x, y, 'col-ctx-menu');
}

function buildAdminRow(
  row: any,
  cols: string[],
  currentTab: string,
  schema: any,
  visibleRowsForSelection: any[],
  rowIndex: number,
  selectedIdSet: Set<string>,
  options: {
    hydrateWizardFromPrompt: (promptRow: any) => void;
    render: () => void;
    loadAdmin: () => Promise<void>;
  },
): HTMLElement {
  // Apply cell-level exclusion filter
  const excludeVal: string = '';
  const excludeCol: string = '';
  // (filtering handled upstream in the main filter pass)
  const rowId = getRowSelectionId(row, schema);
  const isSelected = rowId ? selectedIdSet.has(rowId) : false;
  return h('tr', {
    className: `admin-data-row${isSelected ? ' admin-data-row-selected' : ''}`,
    title: 'Click to edit',
    onClick: (e: MouseEvent) => {
      // Don't trigger row edit if the click was on a context menu or came from it
      if ((e.target as HTMLElement).closest('.col-ctx-menu')) return;
      if ((e.target as HTMLElement).closest('.admin-row-action-btn')) return;
      if (e.shiftKey && rowId) {
        const selected = new Set<string>(((state as any)._adminSelectedRowIds || []).map((id: any) => String(id)));
        const anchorRaw = (state as any)._adminSelectionAnchor;
        const anchor = typeof anchorRaw === 'number' ? anchorRaw : rowIndex;
        const start = Math.min(anchor, rowIndex);
        const end = Math.max(anchor, rowIndex);
        for (let i = start; i <= end; i++) {
          const id = getRowSelectionId(visibleRowsForSelection[i], schema);
          if (id) selected.add(id);
        }
        (state as any)._adminSelectedRowIds = Array.from(selected);
        (state as any)._adminSelectionAnchor = anchor;
        options.render();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && rowId) {
        const selected = new Set<string>(((state as any)._adminSelectedRowIds || []).map((id: any) => String(id)));
        if (selected.has(rowId)) selected.delete(rowId);
        else selected.add(rowId);
        (state as any)._adminSelectedRowIds = Array.from(selected);
        (state as any)._adminSelectionAnchor = rowIndex;
        options.render();
        return;
      }
      adminEditRow(currentTab, row, options.hydrateWizardFromPrompt, options.render);
    },
  },
    ...(currentTab === 'kaggle-competitions' ? [
      h('td', { className: 'admin-action-cell', style: 'width:64px;text-align:center;' },
        h('button', {
          className: 'admin-row-action-btn',
          title: `Start a live agent run for ${row?.competition_ref || 'this competition'}`,
          'data-testid': 'kaggle-row-start',
          style: 'background:transparent;border:1px solid var(--bg4);border-radius:6px;padding:4px 8px;cursor:pointer;color:var(--accent);font-size:14px;',
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            void startKaggleCompetitionRun(row, e.currentTarget as HTMLElement);
          },
        }, '▶'),
      ),
    ] : []),
    ...(currentTab === 'kaggle-competition-runs' ? [
      renderKglRunRowActions(row, options.render),
    ] : []),
    ...cols.map((col: string) => {
      const raw = row?.[col];
      const str = raw == null ? '—' : String(raw);
      const display = str.length > 60 ? str.slice(0, 57) + '…' : str;
      const attrs: Record<string, any> = {};
      if (str.length > 60) attrs['title'] = str;
      attrs['onContextmenu'] = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        showCellContextMenu(col, str === '—' ? '' : str, row, currentTab, schema, visibleRowsForSelection, e.clientX, e.clientY, options);
      };
      return h('td', attrs, display);
    }),
  );
}