/**
 * GeneWeave — Public Share & Embed Routes (Phase 7)
 *
 * Public endpoints for sharing artifacts via signed JWT tokens.
 * No authentication required — access is controlled by the share token.
 *
 *   GET  /share/artifacts/:token         — render shared artifact (like /api/artifacts/:id/render)
 *   POST /share/artifacts/:token         — password-protected artifact form submission
 *   GET  /share/artifacts/:token/raw     — return raw artifact data
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../db.js';
import type { Router } from '../server-core.js';
import { createHash } from 'node:crypto';
import { verifyShareToken, buildArtifactRenderHtml } from './artifacts.js';

export interface RegisterShareRoutesOptions {
  jwtSecret: string;
}

// Read body helper (shared between endpoints)
async function readBodyRaw(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let s = '';
    req.on('data', (c: Buffer) => { s += c.toString(); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

// Share token password check HTML page
function passwordPage(token: string, error?: string): string {
  const errHtml = error ? `<p style="color:#ff6b6b;margin-bottom:12px;">${error}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Protected Artifact</title>
<style>
body{background:#0e1117;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.box{background:#1a1d24;border:1px solid #2a2d36;border-radius:12px;padding:32px;max-width:360px;width:100%;text-align:center}
h2{margin:0 0 8px;font-size:18px;color:#fff}
p{color:#9ca3af;font-size:14px;margin:0 0 20px}
input{width:100%;padding:10px 14px;border:1px solid #3a3d4a;border-radius:8px;background:#0e1117;color:#fff;font-size:15px;outline:none;box-sizing:border-box;margin-bottom:12px}
input:focus{border-color:#4f7df5}
button{width:100%;padding:10px;background:#4f7df5;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600}
button:hover{background:#3d6be0}
.badge{display:inline-block;background:#2a2d36;padding:4px 10px;border-radius:20px;font-size:12px;color:#9ca3af;margin-bottom:20px}
</style>
</head>
<body>
<div class="box">
  <span class="badge">Password Protected</span>
  <h2>Enter Password</h2>
  <p>This artifact is password-protected. Enter the password to view it.</p>
  ${errHtml}
  <form method="POST" action="/share/artifacts/${token}">
    <input type="password" name="p" placeholder="Password" autofocus required>
    <button type="submit">View Artifact</button>
  </form>
</div>
</body></html>`;
}

// Shared artifact footer injected into rendered artifacts
function injectShareFooter(html: string, artifactName: string): string {
  const safeName = artifactName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const footer = `<div id="share-footer" style="position:fixed;bottom:0;left:0;right:0;background:rgba(14,17,23,0.95);border-top:1px solid #2a2d36;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#9ca3af;z-index:9999">
<span><strong style="color:#e0e0e0">${safeName}</strong></span>
<span style="color:#4f7df5">Shared via geneWeave</span>
</div>`;
  if (html.includes('</body>')) return html.replace('</body>', `${footer}</body>`);
  return html + footer;
}

function sendHtml(res: ServerResponse, status: number, htmlContent: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(htmlContent);
}

export function registerShareRoutes(
  router: Router,
  db: DatabaseAdapter,
  opts: RegisterShareRoutesOptions,
): void {
  // ── Render shared artifact ────────────────────────────────────────────────

  router.get('/share/artifacts/:token', async (req, res, params) => {
    const token = params['token'];
    if (!token) { sendHtml(res, 400, '<h1>Bad request</h1>'); return; }
    const payload = verifyShareToken(token, opts.jwtSecret);
    if (!payload) { sendHtml(res, 401, '<h1>Invalid or expired share link</h1>'); return; }
    if (!db.getArtifact) { sendHtml(res, 501, '<h1>Artifact storage not available</h1>'); return; }
    const artifact = await db.getArtifact(payload.sub);
    if (!artifact) { sendHtml(res, 404, '<h1>Artifact not found or deleted</h1>'); return; }
    // Password gate — query param carries the password after POST redirect
    if (payload.ph) {
      const pQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get('p');
      if (!pQuery) {
        sendHtml(res, 200, passwordPage(token));
        return;
      }
      const provided = createHash('sha256').update(pQuery).digest('hex');
      if (provided !== payload.ph) {
        sendHtml(res, 401, passwordPage(token, 'Incorrect password. Please try again.'));
        return;
      }
    }
    const data = artifact.data_text ?? '';
    const language = (() => {
      try { return (JSON.parse(artifact.metadata ?? '{}') as Record<string, unknown>)?.['language'] as string | undefined; }
      catch { return undefined; }
    })();
    let htmlOut = buildArtifactRenderHtml(artifact.type, data, artifact.mime_type ?? 'text/plain', artifact.name, language, artifact.id);
    htmlOut = injectShareFooter(htmlOut, artifact.name);
    // Relax CSP for shared artifacts (allow inline scripts needed for renderers)
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "frame-src 'none'",
    ].join('; ');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.writeHead(200);
    res.end(htmlOut);
  });

  // ── POST handler for password-protected shared artifacts ──────────────────

  // csrf: false because this is a public form POST with no session cookie
  router.post('/share/artifacts/:token', async (req, res, params) => {
    const token = params['token'];
    if (!token) { sendHtml(res, 400, '<h1>Bad request</h1>'); return; }
    const payload = verifyShareToken(token, opts.jwtSecret);
    if (!payload) { sendHtml(res, 401, '<h1>Invalid or expired share link</h1>'); return; }
    if (!db.getArtifact) { sendHtml(res, 501, '<h1>Artifact storage not available</h1>'); return; }
    // Parse form data (application/x-www-form-urlencoded)
    const rawBody = await readBodyRaw(req);
    const formData = new URLSearchParams(rawBody);
    const password = formData.get('p') ?? '';
    if (payload.ph) {
      const provided = createHash('sha256').update(password).digest('hex');
      if (provided !== payload.ph) {
        sendHtml(res, 401, passwordPage(token, 'Incorrect password. Please try again.'));
        return;
      }
    }
    // Password correct — redirect to GET with password in query parameter so GET can verify
    const redirectUrl = `/share/artifacts/${token}?p=${encodeURIComponent(password)}`;
    res.setHeader('Location', redirectUrl);
    res.statusCode = 302;
    res.end();
  }, { csrf: false });

  // ── Raw data for shared artifact ──────────────────────────────────────────

  router.get('/share/artifacts/:token/raw', async (_req, res, params) => {
    const token = params['token'];
    if (!token) { res.statusCode = 400; res.end('Bad request'); return; }
    const payload = verifyShareToken(token, opts.jwtSecret);
    if (!payload) { res.statusCode = 401; res.end('Invalid or expired share link'); return; }
    if (!db.getArtifact) { res.statusCode = 501; res.end('Artifact storage not available'); return; }
    // Note: /raw does not support password protection (to keep it simple for direct downloads)
    if (payload.ph) {
      res.statusCode = 403;
      res.end('Password-protected artifacts cannot be downloaded via /raw');
      return;
    }
    const artifact = await db.getArtifact(payload.sub);
    if (!artifact) { res.statusCode = 404; res.end('Artifact not found'); return; }
    const mime = artifact.mime_type ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex');
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
}
