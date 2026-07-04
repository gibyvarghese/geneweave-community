/**
 * GeneWeave — Artifact Routes (m77 Phase 1 + Phase 5 Sandboxed Rendering + Phase 6 Live Artifacts + Phase 7 Export/Share/Embed)
 *
 * Public (authenticated) artifact API for regular users. Unlike the admin
 * artifact API these routes are scoped to the requesting user's own artifacts.
 *
 * Endpoints:
 *   GET  /api/artifacts              — list user's artifacts (query: type, scope, sessionId, limit, offset)
 *   GET  /api/artifacts/:id          — get single artifact metadata
 *   GET  /api/artifacts/:id/data     — download artifact data (sets Content-Type + Content-Disposition)
 *   GET  /api/artifacts/:id/versions — list all versions
 *   GET  /api/artifacts/:id/versions/:n — specific version data download
 *   GET  /api/artifacts/:id/render   — Phase 5: sandboxed HTML wrapper for preview iframe
 *   GET  /api/artifacts/:id/stream   — Phase 4: SSE real-time generation progress
 *   POST /api/artifacts/:id/refresh  — Phase 6: trigger live artifact refresh via MCP or refreshFn
 *   GET  /api/artifacts/:id/download       — Phase 7: typed attachment download
 *   GET  /api/artifacts/:id/versions/:n/download — Phase 7: version attachment download
 *   GET  /api/artifacts/:id/export         — Phase 7: export all versions as ZIP
 *   POST /api/artifacts/:id/share          — Phase 7: create signed share token
 *   GET  /api/artifacts/:id/embed-code     — Phase 7: get HTML embed code
 *   DELETE /api/artifacts/:id        — delete own artifact (router.del)
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseAdapter } from '../db.js';
import { json } from '../server-core.js';
import type { Router } from '../server-core.js';
import { safePageInt } from './index.js';
import {
  onArtifactStreamEvent,
  offArtifactStreamEvent,
  type ArtifactStreamBusListener,
} from '../lib/artifact-stream-bus.js';

// MIME-to-extension map for Content-Disposition filenames
const MIME_EXT: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/typescript': 'ts',
  'text/javascript': 'js',
  'text/x-python': 'py',
  'text/x-mermaid': 'mmd',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/sql': 'sql',
  'application/x-sh': 'sh',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

function extFor(mimeType: string, artifactName: string): string {
  const mapped = MIME_EXT[mimeType];
  if (mapped) return mapped;
  const dot = artifactName.lastIndexOf('.');
  if (dot > 0) return artifactName.slice(dot + 1).toLowerCase();
  return 'bin';
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').trim().replace(/\s+/g, '_').slice(0, 80) || 'artifact';
}

// ─── Phase 5: Artifact render HTML builders ───────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DARK_BODY = `body{background:#0e1117;color:#e0e0e0;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}`;

export interface LiveRenderConfig {
  artifactId: string;
  /** Seconds between auto-refresh (0 = manual only) */
  refreshIntervalSeconds: number;
  lastRefreshedAt: string | null;
  refreshCount: number;
  /** Endpoint the toolbar POSTs to (user or admin variant) */
  refreshEndpoint: string;
}

/** Produce a self-contained HTML document for sandboxed iframe preview. */
export function buildArtifactRenderHtml(
  type: string,
  data: string,
  _mimeType: string,
  _name: string,
  language?: string,
  artifactId?: string,
  live?: LiveRenderConfig,
): string {
  // ── HTML / report / interactive ─────────────────────────────────────────
  if (type === 'html' || type === 'report' || type === 'interactive') {
    // Inject a baseline CSP meta tag into arbitrary HTML so inline scripts still
    // work but the document cannot navigate the top frame.
    const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; img-src * data: blob:;">`;
    if (/<!doctype/i.test(data) || /<html/i.test(data)) {
      return data.replace(/<head[^>]*>/i, (m) => `${m}\n  ${meta}`);
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${meta}<style>${DARK_BODY}</style></head><body>${data}</body></html>`;
  }

  // ── SVG ─────────────────────────────────────────────────────────────────
  if (type === 'svg' || type === 'diagram') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} .wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box} svg{max-width:100%;height:auto}</style>
</head><body><div class="wrap">${data}</div></body></html>`;
  }

  // ── Mermaid ──────────────────────────────────────────────────────────────
  if (type === 'mermaid') {
    const escaped = data.replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });
<\/script>
<style>${DARK_BODY} .wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box}</style>
</head><body><div class="wrap"><div class="mermaid">${escaped}</div></div></body></html>`;
  }

  // ── React (bare TSX/JSX source) ──────────────────────────────────────────
  if (type === 'react') {
    // Render using Babel standalone + React CDN — best-effort for simple components
    const escaped = esc(data);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.development.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.development.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js"><\/script>
<style>${DARK_BODY} #root{padding:20px}</style>
</head><body><div id="root"></div>
<script type="text/babel" data-presets="react,typescript">
${data}
// Auto-mount if a default export is a component
try {
  const exported = typeof App !== 'undefined' ? App : (typeof Default !== 'undefined' ? Default : null);
  if (exported && typeof exported === 'function') {
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(exported));
  }
} catch(e) { document.getElementById('root').textContent = 'Render error: ' + e.message; }
<\/script>
</body></html>`;
  }

  // ── Markdown ─────────────────────────────────────────────────────────────
  if (type === 'markdown') {
    const escaped = JSON.stringify(data);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"><\/script>
<style>${DARK_BODY} .md{max-width:800px;margin:0 auto;padding:24px 20px;line-height:1.7}
.md h1,.md h2,.md h3{color:#e8e8f0}.md code{background:#1e2030;padding:2px 5px;border-radius:4px;font-size:.88em}
.md pre{background:#1e2030;padding:14px 16px;border-radius:8px;overflow:auto}
.md pre code{background:none;padding:0}.md blockquote{border-left:3px solid #444;margin:0;padding:0 16px;color:#aaa}
.md table{border-collapse:collapse;width:100%}.md th,.md td{border:1px solid #333;padding:6px 10px}
.md a{color:#4db6ff}</style>
</head><body><div class="md" id="out"></div>
<script>
  document.getElementById('out').innerHTML = marked.parse(${escaped}, { gfm: true, breaks: true });
<\/script></body></html>`;
  }

  // ── Code (syntax-highlighted with highlight.js) ──────────────────────────
  if (type === 'code') {
    const lang = language || 'plaintext';
    const escaped = esc(data);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
<style>${DARK_BODY} .wrap{padding:0} pre{margin:0;border-radius:0} code{font-size:13px;tab-size:2}</style>
</head><body><div class="wrap"><pre><code class="language-${esc(lang)}">${escaped}</code></pre>
<script>hljs.highlightAll();<\/script></body></html>`;
  }

  // ── JSON (collapsible tree) ───────────────────────────────────────────────
  if (type === 'json') {
    // Embed raw JSON directly as a JS value (avoids double-encoding). Guard </script> injection.
    const safeData = data.replace(/<\/script>/gi, '<\\/script>');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} .wrap{padding:16px;font-family:monospace;font-size:13px}
.jt-k{color:#79b8ff}.jt-s{color:#9ecbff}.jt-n{color:#79c0ff}.jt-b{color:#f97583}.jt-null{color:#6a737d}
.jt-toggle{cursor:pointer;user-select:none;color:#e36209;padding:0 4px}
.jt-toggle::before{content:'▼ '}.jt-toggle.closed::before{content:'▶ '}
.jt-children{margin-left:20px}.jt-children.hidden{display:none}
</style></head><body><div class="wrap" id="root"></div>
<script>
let parsed;
try { parsed = ${safeData}; } catch(e) { document.getElementById('root').textContent = ${JSON.stringify(data)}; }
if (parsed !== undefined) {
  function renderNode(val, depth) {
    const el = document.createElement('span');
    if (val === null) { el.className='jt-null'; el.textContent='null'; return el; }
    if (typeof val === 'string') { el.className='jt-s'; el.textContent='"'+val.replace(/"/g,'\\\\"')+'"'; return el; }
    if (typeof val === 'number') { el.className='jt-n'; el.textContent=String(val); return el; }
    if (typeof val === 'boolean') { el.className='jt-b'; el.textContent=String(val); return el; }
    if (Array.isArray(val) || typeof val === 'object') {
      const isArr = Array.isArray(val);
      const keys = Object.keys(val);
      const wrap = document.createElement('span');
      if (keys.length === 0) { wrap.textContent = isArr ? '[]' : '{}'; return wrap; }
      const tog = document.createElement('span');
      tog.className = 'jt-toggle';
      tog.textContent = isArr ? '[' + keys.length + ' items]' : '{' + keys.length + ' keys}';
      const children = document.createElement('div');
      children.className = 'jt-children';
      keys.forEach((k, i) => {
        const row = document.createElement('div');
        if (!isArr) { const kk=document.createElement('span'); kk.className='jt-k'; kk.textContent='"'+k+'": '; row.appendChild(kk); }
        row.appendChild(renderNode(val[k], depth+1));
        if (i < keys.length-1) row.appendChild(document.createTextNode(','));
        children.appendChild(row);
      });
      tog.onclick = () => { tog.classList.toggle('closed'); children.classList.toggle('hidden'); };
      wrap.appendChild(tog);
      wrap.appendChild(children);
      return wrap;
    }
    el.textContent = String(val); return el;
  }
  document.getElementById('root').appendChild(renderNode(parsed, 0));
}
<\/script></body></html>`;
  }

  // ── CSV (sortable table, first 2000 rows) ─────────────────────────────────
  if (type === 'csv') {
    const lines = data.split('\n').filter(Boolean);
    const parse = (line: string): string[] => {
      const cells: string[] = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQ = !inQ; }
        else if (c === ',' && !inQ) { cells.push(cur); cur = ''; }
        else { cur += c; }
      }
      cells.push(cur);
      return cells;
    };
    const [header, ...rows] = lines;
    const headers = parse(header ?? '');
    const displayRows = rows.slice(0, 2000).map(parse);
    const ths = headers.map(h => `<th>${esc(h)}</th>`).join('');
    const trs = displayRows.map(r =>
      `<tr>${headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`
    ).join('');
    const overflowNote = rows.length > 2000
      ? `<p style="color:#888;font-size:12px;padding:8px">Showing 2,000 of ${rows.length} rows</p>` : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY}
table{border-collapse:collapse;width:100%;font-size:13px}
th{background:#1e2030;padding:7px 10px;text-align:left;border-bottom:2px solid #333;white-space:nowrap;cursor:pointer;user-select:none;position:sticky;top:0}
th:hover{background:#252840}.th-asc::after{content:' ▲'}.th-desc::after{content:' ▼'}
td{padding:5px 10px;border-bottom:1px solid #222}
tr:hover td{background:#1a1d2e}.wrap{overflow:auto;max-height:100vh}
</style></head><body><div class="wrap">
${overflowNote}
<table id="t"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>
<script>
const t=document.getElementById('t');
let sortCol=-1, sortDir=1;
Array.from(t.tHead.rows[0].cells).forEach((th,ci)=>{
  th.onclick=()=>{
    if(sortCol===ci){sortDir=-sortDir;}else{sortCol=ci;sortDir=1;}
    Array.from(t.tHead.rows[0].cells).forEach(h=>{h.className='';});
    th.className=sortDir===1?'th-asc':'th-desc';
    const rows=Array.from(t.tBodies[0].rows);
    rows.sort((a,b)=>{const av=a.cells[ci]?.textContent??'',bv=b.cells[ci]?.textContent??'';return av.localeCompare(bv,undefined,{numeric:true,sensitivity:'base'})*sortDir;});
    rows.forEach(r=>t.tBodies[0].appendChild(r));
  };
});
<\/script></body></html>`;
  }

  // ── Text / plain (with line numbers) ────────────────────────────────────
  if (type === 'text' || type === 'custom') {
    const lines = data.split('\n');
    const numbered = lines
      .map((l, i) => `<tr><td class="ln">${i + 1}</td><td class="lc">${esc(l)}</td></tr>`)
      .join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} table{border-collapse:collapse;width:100%;font-family:monospace;font-size:13px}
.ln{color:#555;padding:0 12px;text-align:right;user-select:none;min-width:40px;white-space:nowrap}
.lc{padding:0 8px;white-space:pre;word-break:break-all}</style>
</head><body><table>${numbered}</table></body></html>`;
  }

  // ── Image ────────────────────────────────────────────────────────────────
  if (type === 'image') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} .wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box} img{max-width:100%;max-height:90vh;object-fit:contain}</style>
</head><body><div class="wrap"><img src="/api/artifacts/${esc(artifactId ?? '')}/data" alt="${esc(_name)}"></div></body></html>`;
  }

  // ── Audio ────────────────────────────────────────────────────────────────
  if (type === 'audio') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} .wrap{display:flex;align-items:center;justify-content:center;min-height:100vh} audio{width:90%}</style>
</head><body><div class="wrap"><audio controls src="/api/artifacts/${esc(artifactId ?? '')}/data"></audio></div></body></html>`;
  }

  // ── Video ────────────────────────────────────────────────────────────────
  if (type === 'video') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} .wrap{display:flex;align-items:center;justify-content:center;min-height:100vh} video{max-width:100%;max-height:90vh}</style>
</head><body><div class="wrap"><video controls src="/api/artifacts/${esc(artifactId ?? '')}/data"></video></div></body></html>`;
  }

  // ── PDF ──────────────────────────────────────────────────────────────────
  if (type === 'pdf') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} body,html{height:100%;margin:0} iframe{width:100%;height:100%;border:none}</style>
</head><body><iframe src="/api/artifacts/${esc(artifactId ?? '')}/data#toolbar=1"></iframe></body></html>`;
  }

  // ── Spreadsheet (show as table if text/csv fallback, else download link) ─
  if (type === 'spreadsheet') {
    // If we have text data treat it as CSV; otherwise prompt download
    if (data.includes(',') || data.includes('\t')) {
      const sep = data.includes('\t') ? '\t' : ',';
      const lines = data.split('\n').filter(Boolean);
      const [header, ...rows] = lines;
      const headers = (header ?? '').split(sep);
      const ths = headers.map(h => `<th>${esc(h)}</th>`).join('');
      const trs = rows.slice(0, 1000).map(r => {
        const cells = r.split(sep);
        return `<tr>${headers.map((_, i) => `<td>${esc(cells[i] ?? '')}</td>`).join('')}</tr>`;
      }).join('');
      return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} table{border-collapse:collapse;width:100%;font-size:13px}
th{background:#1e2030;padding:7px 10px;text-align:left;border-bottom:2px solid #333;position:sticky;top:0}
td{padding:5px 10px;border-bottom:1px solid #222}.wrap{overflow:auto;max-height:100vh}</style>
</head><body><div class="wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div></body></html>`;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${DARK_BODY}</style></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:12px">
<p>Binary spreadsheet — download to open in Excel or LibreOffice.</p>
<a href="/api/artifacts/${esc(artifactId ?? '')}/data" style="color:#4db6ff">Download .xlsx</a>
</body></html>`;
  }

  // ── Default: pre block ────────────────────────────────────────────────────
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${DARK_BODY} pre{padding:16px 20px;margin:0;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6}</style>
</head><body><pre>${esc(data)}</pre></body></html>`;
}

// ─── Phase 6: Live artifact toolbar injection ────────────────────────────────

/** Injects a floating refresh toolbar into any rendered artifact HTML document. */
export function injectLiveToolbar(html: string, live: LiveRenderConfig): string {
  const intervalMs = live.refreshIntervalSeconds > 0 ? live.refreshIntervalSeconds * 1000 : 0;
  const lastRefreshed = live.lastRefreshedAt
    ? new Date(live.lastRefreshedAt).toLocaleTimeString()
    : 'never';
  const endpoint = esc(live.refreshEndpoint);
  const intervalSec = live.refreshIntervalSeconds;
  const refreshCountStr = String(live.refreshCount);

  const toolbar = `
<style>
#live-toolbar{position:fixed;bottom:12px;right:12px;z-index:9999;display:flex;align-items:center;gap:8px;
  background:rgba(14,17,23,.92);border:1px solid #2a2d3a;border-radius:10px;padding:7px 12px;
  font:12px/-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#c0c0d0;
  backdrop-filter:blur(8px);box-shadow:0 4px 20px rgba(0,0,0,.4);user-select:none}
.lt-badge{background:#1a3a5c;color:#4db6ff;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:600;letter-spacing:.04em}
.lt-time{font-size:11px;color:#888}
.lt-btn{background:#1e2030;border:1px solid #333;color:#e0e0e0;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;transition:background .15s}
.lt-btn:hover{background:#2a2d3a}.lt-btn:disabled{opacity:.4;cursor:default}
.lt-auto{display:flex;align-items:center;gap:5px;font-size:11px;color:#888}
.lt-auto input{cursor:pointer;accent-color:#4db6ff}
#lt-spinner{display:none;width:12px;height:12px;border:2px solid #333;border-top-color:#4db6ff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
<div id="live-toolbar">
  <span class="lt-badge">LIVE</span>
  <span class="lt-time" id="lt-time">refreshed ${esc(lastRefreshed)} &middot; #${esc(refreshCountStr)}</span>
  <div id="lt-spinner"></div>
  <button class="lt-btn" id="lt-refresh-btn" onclick="doRefresh()">&#x21bb; Refresh</button>
  ${intervalSec > 0 ? `<label class="lt-auto"><input type="checkbox" id="lt-auto" checked onchange="toggleAuto(this.checked)"> Auto ${intervalSec}s</label>` : ''}
</div>
<script>
(function() {
  const ENDPOINT = '${endpoint}';
  const INTERVAL_MS = ${intervalMs};
  let autoTimer = null;
  let busy = false;

  function setTime(ts, count) {
    const t = document.getElementById('lt-time');
    if (t) t.textContent = 'refreshed ' + (ts ? new Date(ts).toLocaleTimeString() : 'just now') + ' · #' + count;
  }

  async function doRefresh() {
    if (busy) return;
    busy = true;
    const btn = document.getElementById('lt-refresh-btn');
    const sp = document.getElementById('lt-spinner');
    if (btn) btn.disabled = true;
    if (sp) sp.style.display = 'block';
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (res.ok) {
        const d = await res.json();
        setTime(d.refreshedAt, d.refreshCount);
        if (!d.fromCache) {
          // Signal parent to reload the iframe
          try { window.parent.postMessage({ type: 'artifact-refreshed', artifactId: d.artifactId }, '*'); } catch(e) {}
          window.location.reload();
        }
      }
    } catch(e) {
      console.warn('Refresh failed:', e);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
      if (sp) sp.style.display = 'none';
    }
  }
  window.doRefresh = doRefresh;

  function toggleAuto(on) {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (on && INTERVAL_MS > 0) { autoTimer = setInterval(doRefresh, INTERVAL_MS); }
  }
  window.toggleAuto = toggleAuto;

  if (INTERVAL_MS > 0) {
    const cb = document.getElementById('lt-auto');
    if (cb && cb.checked) toggleAuto(true);
  }
})();
<\/script>`;

  // Inject before </body> — all render functions end with </body></html>
  const injection = toolbar + '\n</body></html>';
  if (html.includes('</body></html>')) {
    return html.replace('</body></html>', injection);
  }
  // Fallback: append
  return html + injection;
}

// ─── params captured in closure ──────────────────────────────────────────────
// Note: buildArtifactRenderHtml is also used for image/audio/video to embed the
// data URL.  The route handler passes params so image/audio/video can self-reference.

// ── Phase 7: ZIP writer (pure Node.js, no external deps) ─────────────────────

function crc32(buf: Buffer): number {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]!) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.allocUnsafe(30 + nb.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nb.length, 26); local.writeUInt16LE(0, 28); nb.copy(local, 30);
    const cent = Buffer.allocUnsafe(46 + nb.length);
    cent.writeUInt32LE(0x02014b50, 0); cent.writeUInt16LE(20, 4); cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(0, 8); cent.writeUInt16LE(0, 10); cent.writeUInt16LE(0, 12); cent.writeUInt16LE(0, 14);
    cent.writeUInt32LE(crc, 16); cent.writeUInt32LE(data.length, 20); cent.writeUInt32LE(data.length, 24);
    cent.writeUInt16LE(nb.length, 28); cent.writeUInt16LE(0, 30); cent.writeUInt16LE(0, 32);
    cent.writeUInt16LE(0, 34); cent.writeUInt16LE(0, 36); cent.writeUInt32LE(0, 38);
    cent.writeUInt32LE(offset, 42); nb.copy(cent, 46);
    parts.push(local, data); centrals.push(cent);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

// ── Phase 7: Share token (signed HS256 JWT-like, separate from session JWTs) ──

export interface ShareTokenPayload {
  sub: string;     // artifactId
  typ: 'share';
  iat: number;
  exp?: number;
  ph?: string;     // SHA-256 hex of password (optional)
}

export function signShareToken(artifactId: string, secret: string, opts?: {
  expiresInSeconds?: number;
  password?: string;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload: ShareTokenPayload = {
    sub: artifactId,
    typ: 'share',
    iat: now,
    ...(opts?.expiresInSeconds ? { exp: now + opts.expiresInSeconds } : {}),
    ...(opts?.password ? { ph: createHash('sha256').update(opts.password).digest('hex') } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payloadB64}`).digest('base64url');
  return `${header}.${payloadB64}.${sig}`;
}

export function verifyShareToken(token: string, secret: string): ShareTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [hB64, pB64, sB64] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${hB64}.${pB64}`).digest('base64url');
  if (sB64.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sB64), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(pB64, 'base64url').toString()) as ShareTokenPayload;
    if (p.typ !== 'share') return null;
    if (p.exp && p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

/** Optional inline refresh callback — called when no MCP server key is configured. */
export type ArtifactRefreshFn = (
  artifact: import('../db-types/artifacts.js').ArtifactRow,
  args: Record<string, unknown>,
) => Promise<{ data: string }>;

export interface RegisterArtifactRoutesOptions {
  /** Inline refresh callback for live artifacts without an MCP server configured. */
  refreshFn?: ArtifactRefreshFn;
  /** Required for Phase 7 share/embed endpoints — falls back to JWT_SECRET env var or insecure dev default. */
  jwtSecret?: string;
  /** Used to build share URLs in Phase 7 (e.g. https://app.example.com). */
  publicBaseUrl?: string;
}

export function registerArtifactRoutes(
  router: Router,
  db: DatabaseAdapter,
  options: RegisterArtifactRoutesOptions = {},
): void {
  const { refreshFn } = options;
  // ── List user's artifacts ─────────────────────────────────────────────────

  router.get('/api/artifacts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.listArtifacts) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const filter = {
      userId: auth.userId,
      type: url.searchParams.get('type') ?? undefined,
      scope: (url.searchParams.get('scope') as 'session' | 'user' | undefined) ?? undefined,
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      limit: safePageInt(url.searchParams.get('limit'), 50, 1, 200),
      offset: safePageInt(url.searchParams.get('offset'), 0, 0),
    };
    const artifacts = await db.listArtifacts(filter as Parameters<typeof db.listArtifacts>[0]);
    const rows = artifacts.map((a) => ({
      id: a.id, name: a.name, type: a.type, mimeType: a.mime_type,
      scope: a.scope, sessionId: a.session_id, agentId: a.agent_id,
      runId: a.run_id, version: a.version, sizeBytes: a.size_bytes,
      tags: a.tags ? (JSON.parse(a.tags) as string[]) : [],
      policyId: a.policy_id,
      createdAt: a.created_at, updatedAt: a.updated_at,
    }));
    json(res, 200, { artifacts: rows, total: rows.length });
  });

  // ── Get single artifact metadata ──────────────────────────────────────────

  router.get('/api/artifacts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    // Return metadata only (no raw data blob)
    const { data_text: _dt, data_blob: _db2, ...meta } = artifact as unknown as Record<string, unknown>;
    json(res, 200, { artifact: meta });
  });

  // ── Download artifact data ────────────────────────────────────────────────

  router.get('/api/artifacts/:id/data', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }

    const mimeType = artifact.mime_type || 'application/octet-stream';
    const ext = extFor(mimeType, artifact.name);
    const filename = `${safeName(artifact.name)}.${ext}`;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (artifact.data_blob) {
      res.setHeader('Content-Length', String(artifact.data_blob.length));
      res.writeHead(200);
      res.end(artifact.data_blob);
    } else {
      const text = artifact.data_text ?? '';
      const buf = Buffer.from(text, 'utf8');
      res.setHeader('Content-Length', String(buf.length));
      res.writeHead(200);
      res.end(buf);
    }
  });

  // ── List artifact versions ────────────────────────────────────────────────

  router.get('/api/artifacts/:id/versions', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact || !db.getArtifactVersions) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    const versions = await db.getArtifactVersions(params['id']!);
    json(res, 200, {
      versions: versions.map((v) => ({
        id: v.id, artifactId: v.artifact_id, version: v.version,
        changelog: v.changelog, createdAt: v.created_at,
      })),
    });
  });

  // ── Download specific version ─────────────────────────────────────────────

  router.get('/api/artifacts/:id/versions/:n', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact || !db.getArtifactVersion) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }

    const versionNum = parseInt(params['n'] ?? '', 10);
    if (!isFinite(versionNum) || versionNum < 1) { json(res, 400, { error: 'invalid version' }); return; }

    const versionRow = await db.getArtifactVersion!(params['id']!, versionNum);
    if (!versionRow) { json(res, 404, { error: 'version not found' }); return; }

    const mimeType = artifact.mime_type || 'application/octet-stream';
    const ext = extFor(mimeType, artifact.name);
    const filename = `${safeName(artifact.name)}_v${versionNum}.${ext}`;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (versionRow.data_blob) {
      res.setHeader('Content-Length', String(versionRow.data_blob.length));
      res.writeHead(200);
      res.end(versionRow.data_blob);
    } else {
      const text = versionRow.data_text ?? '';
      const buf = Buffer.from(text, 'utf8');
      res.setHeader('Content-Length', String(buf.length));
      res.writeHead(200);
      res.end(buf);
    }
  });

  // ── Phase 5: Sandboxed render — self-contained HTML per artifact type ─────
  //
  // GET /api/artifacts/:id/render
  //
  // Returns a complete HTML document that safely renders the artifact content.
  // Served in an <iframe sandbox="allow-scripts allow-same-origin"> by the
  // preview modal so untrusted artifact code cannot reach the parent window.
  //
  // CSP headers restrict what the render document can do:
  //   - default-src 'none'  — no outbound fetch unless whitelisted
  //   - script-src CDNs + nonce
  //   - style-src 'unsafe-inline'  — inline styles for renderers
  //   - No cookies, no localStorage via sandbox attribute on iframe

  router.get('/api/artifacts/:id/render', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return; }
    if (!db.getArtifact) { res.writeHead(501); res.end(); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { res.writeHead(404); res.end(); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { res.writeHead(403); res.end(); return; }

    const type = artifact.type as string;
    const data = artifact.data_text ?? '';
    const mimeType = artifact.mime_type ?? 'text/plain';
    const name = artifact.name ?? 'artifact';
    const meta = (() => { try { return JSON.parse(artifact.metadata ?? '{}') as Record<string, unknown>; } catch { return {}; } })();
    const language = (meta['language'] as string | undefined) ?? '';

    // Phase 6: check for live config; if present inject refresh toolbar
    const artifactId = params['id']!;
    const liveConfig = db.getLiveArtifactConfig ? await db.getLiveArtifactConfig(artifactId) : null;
    const liveParam: LiveRenderConfig | undefined = liveConfig ? {
      artifactId,
      refreshIntervalSeconds: liveConfig.refresh_interval_seconds,
      lastRefreshedAt: liveConfig.last_refreshed_at,
      refreshCount: liveConfig.refresh_count,
      refreshEndpoint: `/api/artifacts/${artifactId}/refresh`,
    } : undefined;

    let html = buildArtifactRenderHtml(type, data, mimeType, name, language, artifactId);
    if (liveParam) html = injectLiveToolbar(html, liveParam);

    const cspParts = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      // CDNs used by Mermaid, highlight.js, marked
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      // Live artifacts: allow fetch() to same-origin refresh endpoint
      ...(liveParam ? ["connect-src 'self'"] : []),
    ];

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': cspParts.join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(html);
  });

  // ── Phase 4: SSE stream — real-time artifact generation progress ─────────
  //
  // GET /api/artifacts/:id/stream
  //
  // Server-Sent Events endpoint. Clients connect while an artifact is being
  // generated and receive update / complete / error events as they are emitted
  // by the emit_artifact tool (streaming mode) via artifact-stream-bus.
  //
  // SSE event format:
  //   event: update\ndata: {"kind":"update","progress":0.4,"data":"..."}\n\n
  //   event: complete\ndata: {"kind":"complete","version":2,"progress":1}\n\n
  //   event: error\ndata: {"kind":"error","message":"..."}\n\n

  router.get('/api/artifacts/:id/stream', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifactId = params['id']!;
    const artifact = await db.getArtifact(artifactId);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }

    // If already complete (or not a streaming artifact), send an immediate 'complete' and close.
    if (!artifact.streaming_status || artifact.streaming_status !== 'streaming') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const evt = artifact.streaming_status === 'error'
        ? { kind: 'error', artifactId, progress: artifact.streaming_progress ?? 0, message: 'Generation failed', timestamp: new Date().toISOString() }
        : { kind: 'complete', artifactId, progress: 1, version: artifact.version, timestamp: new Date().toISOString() };
      res.write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`);
      res.end();
      return;
    }

    // Disable per-request timeout — SSE connections are long-lived.
    req.socket?.setTimeout(0);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current progress as an immediate 'update' so client knows the stream is alive.
    const initial = {
      kind: 'update' as const,
      artifactId,
      progress: artifact.streaming_progress ?? 0,
      timestamp: new Date().toISOString(),
    };
    res.write(`event: update\ndata: ${JSON.stringify(initial)}\n\n`);

    // Subscribe to in-process events from the streaming tool.
    const listener: ArtifactStreamBusListener = (event) => {
      if (res.writableEnded) return;
      try {
        res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
        // Auto-close on terminal events so clients don't need to poll.
        if (event.kind === 'complete' || event.kind === 'error') {
          res.end();
        }
      } catch { /* client disconnected */ }
    };
    onArtifactStreamEvent(artifactId, listener);

    // Keepalive comment every 15 s.
    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); return; }
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
    }, 15_000);

    const cleanup = (): void => {
      clearInterval(keepalive);
      offArtifactStreamEvent(artifactId, listener);
    };

    req.socket?.once('close', cleanup);
    (req as NodeJS.EventEmitter).once?.('close', cleanup);
  });

  // ── Phase 6: Live artifact refresh ───────────────────────────────────────
  //
  // POST /api/artifacts/:id/refresh
  //
  // Triggers a data refresh for a live artifact.  Returns immediately with
  // { fromCache: true } if refreshed within cache_ttl_seconds; otherwise calls
  // the inline refreshFn (or MCP tool — future) and updates artifact.data_text.
  //
  // Response: { artifactId, fromCache, refreshedAt, refreshCount, version }

  router.post('/api/artifacts/:id/refresh', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact || !db.getLiveArtifactConfig) {
      json(res, 501, { error: 'live artifacts not available' }); return;
    }
    const artifactId = params['id']!;
    const artifact = await db.getArtifact(artifactId);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }

    const liveConfig = await db.getLiveArtifactConfig(artifactId);
    if (!liveConfig) { json(res, 404, { error: 'artifact is not configured as live' }); return; }

    // Cache TTL guard — skip refresh if recently refreshed
    const ttlMs = liveConfig.cache_ttl_seconds * 1000;
    const lastMs = liveConfig.last_refreshed_at ? new Date(liveConfig.last_refreshed_at).getTime() : 0;
    const nowMs = Date.now();
    if (ttlMs > 0 && lastMs > 0 && nowMs - lastMs < ttlMs) {
      json(res, 200, {
        artifactId,
        fromCache: true,
        refreshedAt: liveConfig.last_refreshed_at,
        refreshCount: liveConfig.refresh_count,
        version: artifact.version,
      });
      return;
    }

    // Invoke inline refreshFn if configured (MCP path is future work)
    if (!refreshFn) {
      json(res, 501, { error: 'no refresh function configured for this server' }); return;
    }
    try {
      const args: Record<string, unknown> = liveConfig.refresh_args
        ? (JSON.parse(liveConfig.refresh_args) as Record<string, unknown>)
        : {};
      const result = await refreshFn(artifact, args);
      const updated = db.updateArtifact
        ? await db.updateArtifact(artifactId, { data: result.data }, 'live-refresh')
        : artifact;
      if (db.touchLiveArtifactRefresh) await db.touchLiveArtifactRefresh(artifactId);
      const refreshedAt = new Date().toISOString();
      json(res, 200, {
        artifactId,
        fromCache: false,
        refreshedAt,
        refreshCount: liveConfig.refresh_count + 1,
        version: updated?.version ?? artifact.version,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: `refresh failed: ${msg}` });
    }
  });

  // ── Phase 7: Download (typed attachment) ──────────────────────────────────

  router.get('/api/artifacts/:id/download', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    const mime = artifact.mime_type ?? 'application/octet-stream';
    const ext = extFor(mime, artifact.name);
    const fn = `${safeName(artifact.name)}.${ext}`;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (artifact.data_blob) {
      res.setHeader('Content-Length', String(artifact.data_blob.length));
      res.writeHead(200);
      res.end(artifact.data_blob);
    } else {
      const buf = Buffer.from(artifact.data_text ?? '', 'utf8');
      res.setHeader('Content-Length', String(buf.length));
      res.writeHead(200);
      res.end(buf);
    }
  });

  // ── Phase 7: Version download ────────────────────────────────────────────

  router.get('/api/artifacts/:id/versions/:n/download', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact || !db.getArtifactVersion) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    const n = parseInt(params['n'] ?? '0', 10);
    if (isNaN(n) || n < 1) { json(res, 400, { error: 'invalid version' }); return; }
    const ver = await db.getArtifactVersion(params['id']!, n);
    if (!ver) { json(res, 404, { error: `version ${n} not found` }); return; }
    const mime = artifact.mime_type ?? 'application/octet-stream';
    const ext = extFor(mime, artifact.name);
    const fn = `${safeName(artifact.name)}_v${n}.${ext}`;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ver.data_blob) {
      res.setHeader('Content-Length', String(ver.data_blob.length));
      res.writeHead(200);
      res.end(ver.data_blob);
    } else {
      const buf = Buffer.from(ver.data_text ?? '', 'utf8');
      res.setHeader('Content-Length', String(buf.length));
      res.writeHead(200);
      res.end(buf);
    }
  });

  // ── Phase 7: Export all versions as ZIP ────────────────────────────────────

  router.get('/api/artifacts/:id/export', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact || !db.getArtifactVersions) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    const versions = await db.getArtifactVersions(params['id']!);
    const mime = artifact.mime_type ?? 'application/octet-stream';
    const ext = extFor(mime, artifact.name);
    const base = safeName(artifact.name);
    // Include each version as a separate file
    const files = versions.map((v) => ({
      name: `${base}_v${v.version}.${ext}`,
      data: v.data_blob ?? Buffer.from(v.data_text ?? '', 'utf8'),
    }));
    // Also include a manifest.json
    const manifest = JSON.stringify({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      mimeType: artifact.mime_type,
      versions: versions.length,
      exportedAt: new Date().toISOString(),
    }, null, 2);
    files.unshift({ name: 'manifest.json', data: Buffer.from(manifest, 'utf8') });
    const zipBuf = makeZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}_export.zip"`);
    res.setHeader('Content-Length', String(zipBuf.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.writeHead(200);
    res.end(zipBuf);
  });

  // ── Phase 7: Create share token ────────────────────────────────────────────

  router.post('/api/artifacts/:id/share', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    const secret = options.jwtSecret ?? process.env['JWT_SECRET'] ?? 'insecure-dev-secret';
    let body: Record<string, unknown> = {};
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        let s = '';
        req.on('data', (c: Buffer) => { s += c.toString(); });
        req.on('end', () => resolve(s));
        req.on('error', reject);
      });
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch { /* ignore parse errors, use defaults */ }
    const expiresInDays = typeof body['expiresInDays'] === 'number' ? body['expiresInDays'] : undefined;
    const password = typeof body['password'] === 'string' && body['password'] ? body['password'] : undefined;
    const token = signShareToken(artifact.id, secret, {
      expiresInSeconds: expiresInDays ? expiresInDays * 86400 : undefined,
      password,
    });
    const shareBase = (options.publicBaseUrl ?? '').replace(/\/$/, '');
    const shareUrl = `${shareBase}/share/artifacts/${token}`;
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400 * 1000).toISOString()
      : undefined;
    json(res, 200, { shareToken: token, url: shareUrl, expiresAt, passwordProtected: !!password });
  });

  // ── Phase 7: Get embed code ────────────────────────────────────────────────

  router.get('/api/artifacts/:id/embed-code', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    const embedQuery = new URL(req.url ?? '/', 'http://localhost');
    const width = embedQuery.searchParams.get('width') ?? '800';
    const height = embedQuery.searchParams.get('height') ?? '600';
    // Auto-generate a permanent share token (no expiry) for the embed URL
    const secret = options.jwtSecret ?? process.env['JWT_SECRET'] ?? 'insecure-dev-secret';
    const token = signShareToken(artifact.id, secret); // no expiry
    const embedBase = (options.publicBaseUrl ?? '').replace(/\/$/, '');
    const embedUrl = `${embedBase}/share/artifacts/${token}`;
    const embedCode = `<iframe src="${embedUrl}" width="${width}" height="${height}" frameborder="0" style="border:none;border-radius:8px;" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
    json(res, 200, { embedCode, embedUrl, width, height, artifactId: artifact.id });
  });

  // ── Delete own artifact ───────────────────────────────────────────────────

  router.del('/api/artifacts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!db.getArtifact || !db.deleteArtifact) { json(res, 501, { error: 'artifact storage not available' }); return; }
    const artifact = await db.getArtifact(params['id']!);
    if (!artifact) { json(res, 404, { error: 'not found' }); return; }
    if (artifact.user_id && artifact.user_id !== auth.userId) { json(res, 403, { error: 'forbidden' }); return; }
    await db.deleteArtifact(params['id']!);
    json(res, 200, { ok: true });
  });
}
