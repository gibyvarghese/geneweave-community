/**
 * Public, read-only, REDACTED share of an annotated run (Collaboration Phase 4).
 *
 * A capability-URL route — no login required; access is the unguessable token in
 * the URL (W3C Capability URLs). It renders a run's assistant OUTPUT plus the
 * review (comments + annotation summary) as static HTML, and NOTHING that should
 * stay private:
 *   - read-only by construction (only GET handlers; no write path exists here);
 *   - redacted: author DISPLAY NAMES only (never emails or internal user ids),
 *     no tenant ids, no system prompts, no raw tool arguments / internal payloads;
 *   - noindex + no-referrer so the token cannot leak to crawlers or via Referer.
 *
 * The token is matched by SHA-256 hash (the plaintext is never stored); expired
 * or revoked links return 404 (no oracle about which). Security follows the
 * mid-2026 research: capability URL as a bearer secret, strict redaction layer.
 */
import type { Router } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';
import { hashPublicShareToken } from '../run-comment-sql.js';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string { return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!); }

function sendHtml(res: import('node:http').ServerResponse, status: number, html: string): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');           // keep tokens out of search
  res.setHeader('Referrer-Policy', 'no-referrer');              // don't leak the token via Referer
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.writeHead(status);
  res.end(html);
}

/** Resolve a public-share token to its run, or null if missing/expired/revoked. */
async function resolveShare(db: DatabaseAdapter, token: string): Promise<{ runId: string; tenantId: string | null } | null> {
  const row = await db.getRunPublicShareByHash(hashPublicShareToken(token));
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < Date.now())) return null;
  return { runId: row.run_id, tenantId: row.tenant_id };
}

/** Build the redacted public-view DATA (also used by the JSON endpoint). */
async function buildPublicView(db: DatabaseAdapter, runId: string): Promise<{
  status: string;
  output: string;
  comments: Array<{ author: string; partId: string; bodyHtml: string; resolved: boolean; createdAt: number }>;
  annotationSummary: Array<{ name: string; count: number; average: number | null }>;
} | null> {
  const run = await db.getUserRunById(runId);
  if (!run) return null;

  // Assistant OUTPUT only — concatenate text deltas. We deliberately skip tool
  // calls / reasoning / system content so nothing internal leaks publicly.
  const events = await db.listUserRunEvents(runId);
  let output = '';
  for (const ev of events) {
    if (ev.kind !== 'text.delta') continue;
    try {
      const p = JSON.parse(ev.payload) as { delta?: unknown };
      if (typeof p.delta === 'string') output += p.delta;
    } catch { /* skip malformed */ }
  }

  // Resolve author DISPLAY NAMES (never expose ids/emails).
  const nameCache = new Map<string, string>();
  async function displayName(userId: string): Promise<string> {
    if (nameCache.has(userId)) return nameCache.get(userId)!;
    const u = await db.getUserById(userId).catch(() => null);
    const name = u?.name?.trim() || 'A reviewer';
    nameCache.set(userId, name);
    return name;
  }

  const rawComments = await db.listRunComments(runId);
  const comments = [];
  for (const c of rawComments) {
    if (c.deleted_at) continue; // hide tombstones from the public view
    comments.push({
      author: await displayName(c.author_id),
      partId: c.anchor_part_id,
      bodyHtml: c.body_html, // already sanitized at write time
      resolved: c.resolved_at !== null,
      createdAt: c.created_at,
    });
  }

  const annotations = await db.listRunAnnotations(runId);
  const byName = new Map<string, number[]>();
  for (const a of annotations) {
    const arr = byName.get(a.name) ?? [];
    if (typeof a.value === 'number') arr.push(a.value);
    byName.set(a.name, arr);
  }
  const annotationSummary = [...byName.entries()].map(([name, vals]) => ({
    name, count: annotations.filter((a) => a.name === name).length,
    average: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null,
  }));

  return { status: run.status, output, comments, annotationSummary };
}

export function registerRunShareRoutes(router: Router, db: DatabaseAdapter): void {
  // JSON (for a SPA / programmatic read). Read-only.
  router.get('/share/runs/:token/data', async (_req, res, params) => {
    const token = params['token'];
    const share = token ? await resolveShare(db, token) : null;
    if (!share) { res.setHeader('X-Robots-Tag', 'noindex'); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid or expired link' })); return; }
    const view = await buildPublicView(db, share.runId);
    if (!view) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(view));
  });

  // Rendered HTML page. Read-only, redacted, noindex.
  router.get('/share/runs/:token', async (_req, res, params) => {
    const token = params['token'];
    const share = token ? await resolveShare(db, token) : null;
    if (!share) { sendHtml(res, 404, '<!doctype html><meta name="robots" content="noindex"><h1>Invalid or expired link</h1>'); return; }
    const view = await buildPublicView(db, share.runId);
    if (!view) { sendHtml(res, 404, '<!doctype html><meta name="robots" content="noindex"><h1>Run not found</h1>'); return; }

    const commentsHtml = view.comments.length === 0
      ? '<p class="muted">No comments.</p>'
      : view.comments.map((c) => `
        <div class="comment${c.resolved ? ' resolved' : ''}">
          <div class="meta"><strong>${esc(c.author)}</strong>${c.partId ? ` · on <code>${esc(c.partId)}</code>` : ''}${c.resolved ? ' · <span class="badge">resolved</span>' : ''}</div>
          <div class="body">${c.bodyHtml}</div>
        </div>`).join('');
    const scoresHtml = view.annotationSummary.length === 0
      ? '<p class="muted">No scores.</p>'
      : `<ul>${view.annotationSummary.map((s) => `<li><strong>${esc(s.name)}</strong>: ${s.count} score(s)${s.average !== null ? ` · avg ${s.average.toFixed(2)}` : ''}</li>`).join('')}</ul>`;

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Shared run review</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a2e}
  h1{font-size:1.4rem} h2{font-size:1.05rem;margin-top:2rem;border-bottom:1px solid #eee;padding-bottom:.3rem}
  .output{white-space:pre-wrap;background:#f7f7fb;border:1px solid #eee;border-radius:8px;padding:1rem}
  .comment{border-left:3px solid #6c63ff;padding:.4rem .8rem;margin:.6rem 0;background:#fafaff}
  .comment.resolved{opacity:.6;border-left-color:#4caf50}
  .meta{font-size:.85rem;color:#555} .badge{background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:0 .4rem;font-size:.75rem}
  .mention{color:#6c63ff;font-weight:600} code{background:#eee;border-radius:4px;padding:0 .3rem}
  .muted{color:#999} .footer{margin-top:2rem;font-size:.8rem;color:#999;border-top:1px solid #eee;padding-top:.8rem}
</style></head><body>
<h1>Shared run review <span class="badge">${esc(view.status)}</span></h1>
<p class="muted">Read-only public view. Comments and scores are shown with reviewer display names only.</p>
<h2>Run output</h2>
<div class="output">${esc(view.output) || '<span class="muted">No text output.</span>'}</div>
<h2>Comments (${view.comments.length})</h2>
${commentsHtml}
<h2>Scores</h2>
${scoresHtml}
<div class="footer">Shared via geneWeave · this link is read-only and can be revoked by the owner.</div>
</body></html>`;
    sendHtml(res, 200, html);
  });
}
