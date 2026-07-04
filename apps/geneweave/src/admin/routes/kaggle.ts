import type { IncomingMessage, ServerResponse } from 'node:http';
import { hardenedFetch, newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike } from '../api/types.js';

/**
 * Domain segment validator for OAuth providers that template a tenant
 * subdomain into `authorizationUrl` / `tokenUrl` (e.g. ServiceNow's
 * `https://{{domain}}.service-now.com/...`). Without strict validation a
 * caller can break out of the template and redirect the server's
 * `client_secret` POST to an arbitrary host.
 *
 * Allowed: ASCII letters, digits, single hyphens between alnum runs.
 * Length: 1..63 (RFC 1035 label).
 */
function isSafeDomainSegment(s: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s);
}

/**
 * Render a postMessage bridge page WITHOUT interpolating untrusted strings
 * into inline JavaScript. Payload travels through a `<script
 * type="application/json">` block (which the browser does not execute) and
 * is parsed at runtime. JSON serialization escapes `<` to `\u003c` so the
 * data block cannot terminate the script tag.
 */
function renderOAuthBridgeHtml(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  return `<!doctype html><html><head><meta charset="utf-8"><title>OAuth</title>`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'">`
    + `</head><body>`
    + `<script id="oauth-payload" type="application/json">${json}</script>`
    + `<script>(function(){try{`
    + `var d=JSON.parse(document.getElementById('oauth-payload').textContent);`
    + `if(window.opener){window.opener.postMessage(d, window.location.origin);}`
    + `}catch(e){}window.close();})();</script>`
    + `</body></html>`;
}

function validateSsrfSafeUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'Only HTTPS URLs are allowed' };
  const host = parsed.hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^::1$/,
    /^fd[0-9a-f]{2}:/i,
  ];
  for (const pattern of privatePatterns) {
    if (pattern.test(host)) return { ok: false, reason: 'Private/loopback hosts are not allowed' };
  }
  return { ok: true, url: parsed };
}

export function registerAdminConnectorRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
  providers?: Record<string, { apiKey?: string }>,
  html?: (res: ServerResponse, status: number, body: string) => void,
): void {
  const htmlResp = html ?? ((res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  // ── Connector OAuth routes ─────────────────────────────────

  // OAuth config for each connector type
  const OAUTH_CONFIGS: Record<string, { authorizationUrl: string; tokenUrl: string; scopes: string[]; domainTemplate?: string }> = {
    jira: {
      authorizationUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'],
    },
    servicenow: {
      authorizationUrl: 'https://{{domain}}.service-now.com/oauth_auth.do',
      tokenUrl: 'https://{{domain}}.service-now.com/oauth_token.do',
      scopes: ['useraccount'],
      domainTemplate: '{{domain}}.service-now.com',
    },
    facebook: {
      authorizationUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content'],
    },
    instagram: {
      authorizationUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
      scopes: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments'],
    },
    canva: {
      authorizationUrl: 'https://www.canva.com/api/oauth/authorize',
      tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
      scopes: ['design:content:read', 'design:content:write', 'design:meta:read', 'asset:read', 'asset:write'],
    },
  };

  // GET /api/connectors — list all connectors (enterprise + social combined)
  router.get('/api/connectors', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const [enterprise, social] = await Promise.all([db.listEnterpriseConnectors(), db.listSocialAccounts()]);
    json(res, 200, { enterprise, social });
  });

  // GET /api/connectors/:type/authorize — build OAuth authorization URL
  router.get('/api/connectors/:type/authorize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const connectorType = params['type']!;
    const oauthCfg = OAUTH_CONFIGS[connectorType];
    if (!oauthCfg) { json(res, 400, { error: `Unknown connector type: ${connectorType}` }); return; }

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const connectorId = url.searchParams.get('connector_id');
    const domain = url.searchParams.get('domain') || '';

    // If the provider templates {{domain}} into its endpoints, validate it
    // strictly before substitution. Otherwise an attacker-controlled value
    // can swap the upstream host (and exfiltrate the client_secret on the
    // callback's token exchange).
    const needsDomain = oauthCfg.authorizationUrl.includes('{{domain}}') || oauthCfg.tokenUrl.includes('{{domain}}');
    if (needsDomain) {
      if (!domain || !isSafeDomainSegment(domain)) {
        json(res, 400, { error: 'Invalid domain: must be a single DNS label (alphanumeric + hyphens, 1-63 chars)' });
        return;
      }
    }

    // Client ID from env: e.g. JIRA_CLIENT_ID, FACEBOOK_CLIENT_ID
    const envPrefix = connectorType.toUpperCase();
    const clientId = process.env[`${envPrefix}_CLIENT_ID`];
    if (!clientId) { json(res, 400, { error: `${envPrefix}_CLIENT_ID not configured in environment` }); return; }

    // Generate CSRF state
    const oauthState = newUUIDv7();

    // Store state in connector record (if connector_id provided) for callback validation
    if (connectorId) {
      const isSocial = ['facebook', 'instagram'].includes(connectorType);
      if (isSocial) {
        await db.updateSocialAccount(connectorId, { oauth_state: oauthState });
      } else {
        await db.updateEnterpriseConnector(connectorId, { oauth_state: oauthState });
      }
    }

    // Build authorization URL
    let authUrl = oauthCfg.authorizationUrl.replace('{{domain}}', domain);
    const redirectUri = `${url.protocol}//${url.host}/api/connectors/callback`;
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: oauthCfg.scopes.join(' '),
      state: `${connectorType}:${connectorId || 'new'}:${oauthState}`,
    });
    // Jira/Atlassian needs audience and prompt params
    if (connectorType === 'jira') {
      authParams.set('audience', 'api.atlassian.com');
      authParams.set('prompt', 'consent');
    }

    json(res, 200, { url: `${authUrl}?${authParams.toString()}` });
  });

  // GET /api/connectors/callback — OAuth redirect callback
  router.get('/api/connectors/callback', async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    const replyError = (status: number, message: string): void => {
      htmlResp(res, status, renderOAuthBridgeHtml({ type: 'oauth-error', error: message }));
    };

    if (error) { replyError(200, String(error).slice(0, 200)); return; }
    if (!code || !stateParam) { replyError(400, 'Missing code or state'); return; }

    // Parse state: "type:connectorId:oauthState"
    const parts = stateParam.split(':');
    if (parts.length < 3) { replyError(400, 'Invalid state'); return; }
    const connectorType = parts[0]!;
    const connectorId = parts[1]!;
    const oauthState = parts.slice(2).join(':');

    const oauthCfg = OAUTH_CONFIGS[connectorType];
    if (!oauthCfg) { replyError(400, 'Unknown connector type'); return; }

    // Require a persisted connector row — 'new' has nothing to validate
    // state against and would let a callback proceed unauthenticated.
    if (!connectorId || connectorId === 'new') {
      replyError(400, 'Connector must be created before initiating OAuth (connector_id required at /authorize)');
      return;
    }

    // Validate state against stored value (transactional consume not required
    // because the state is rotated on every authorize and cleared on success).
    const isSocial = ['facebook', 'instagram'].includes(connectorType);
    const stored = isSocial
      ? await db.getSocialAccount(connectorId)
      : await db.getEnterpriseConnector(connectorId);
    if (!stored || !stored.oauth_state || stored.oauth_state !== oauthState) {
      replyError(400, 'State mismatch — possible CSRF or expired flow');
      return;
    }

    // If the provider templates {{domain}}, re-validate it on the callback.
    // (The authorize endpoint validated once but the callback URL is
    // attacker-reachable and {{domain}} affects the token endpoint host.)
    const needsDomain = oauthCfg.authorizationUrl.includes('{{domain}}') || oauthCfg.tokenUrl.includes('{{domain}}');
    const domain = url.searchParams.get('domain') || '';
    if (needsDomain) {
      if (!domain || !isSafeDomainSegment(domain)) {
        replyError(400, 'Invalid domain on callback');
        return;
      }
    }

    // Exchange code for tokens
    const envPrefix = connectorType.toUpperCase();
    const clientId = process.env[`${envPrefix}_CLIENT_ID`] || '';
    const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`] || '';
    const redirectUri = `${url.protocol}//${url.host}/api/connectors/callback`;
    const tokenUrl = oauthCfg.tokenUrl.replace('{{domain}}', domain);

    try {
      const tokenResp = await hardenedFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      }, { errorTag: 'geneweave-oauth-callback' });

      if (!tokenResp.ok) {
        replyError(200, `Token exchange failed: ${tokenResp.status}`);
        return;
      }

      const tokens = await tokenResp.json() as Record<string, unknown>;
      const accessToken = (tokens['access_token'] as string) || '';
      const refreshToken = (tokens['refresh_token'] as string) || null;
      const expiresIn = (tokens['expires_in'] as number) || 3600;
      const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

      // Update connector with tokens
      if (isSocial) {
        await db.updateSocialAccount(connectorId, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_expires_at: tokenExpiresAt,
          oauth_state: null,
          status: 'connected',
        });
      } else {
        await db.updateEnterpriseConnector(connectorId, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_expires_at: tokenExpiresAt,
          oauth_state: null,
          status: 'connected',
          auth_type: 'oauth2',
        });
      }

      htmlResp(res, 200, renderOAuthBridgeHtml({
        type: 'oauth-success',
        connectorType,
        connectorId,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      replyError(200, msg.slice(0, 500));
    }
  }, { auth: false, csrf: false });

  // POST /api/connectors/:id/disconnect — clear tokens and disconnect
  router.post('/api/connectors/:id/disconnect', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const raw = await readBody(req);
    let body: { table?: string };
    try { body = JSON.parse(raw); } catch { body = {}; }
    const table = body.table || 'enterprise';

    if (table === 'social') {
      await db.updateSocialAccount(id, {
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      });
    } else {
      await db.updateEnterpriseConnector(id, {
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      });
    }
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // POST /api/connectors/:id/test — test a connection
  router.post('/api/connectors/:id/test', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const raw = await readBody(req);
    let body: { table?: string };
    try { body = JSON.parse(raw); } catch { body = {}; }
    const table = body.table || 'enterprise';

    const connector = table === 'social'
      ? await db.getSocialAccount(id)
      : await db.getEnterpriseConnector(id);

    if (!connector) { json(res, 404, { error: 'Connector not found' }); return; }
    if (!('access_token' in connector) || !connector.access_token) {
      json(res, 400, { error: 'Connector not authenticated' }); return;
    }

    // Simple health check — test if token is valid by making a lightweight API call
    try {
      const type = table === 'social' ? (connector as any).platform : (connector as any).connector_type;
      const testUrls: Record<string, string> = {
        jira: 'https://api.atlassian.com/me',
        facebook: 'https://graph.facebook.com/v25.0/me',
        instagram: 'https://graph.facebook.com/v25.0/me',
        canva: 'https://api.canva.com/rest/v1/users/me',
        servicenow: (() => {
          if (!connector.base_url) return '';
          const validation = validateSsrfSafeUrl(connector.base_url);
          if (!validation.ok) return '';
          return `${validation.url.origin}/api/now/table/sys_user?sysparm_limit=1`;
        })(),
      };
      const testUrl = testUrls[type] || '';
      if (!testUrl) {
        // If servicenow base_url failed validation, tell the user rather than silently succeeding
        if (type === 'servicenow' && connector.base_url) {
          const validation = validateSsrfSafeUrl(connector.base_url);
          if (!validation.ok) { json(res, 400, { error: `Invalid connector URL: ${validation.reason}` }); return; }
        }
        json(res, 200, { ok: true, message: 'No test endpoint configured' }); return;
      }

      const testResp = await hardenedFetch(testUrl, {
        headers: { 'Authorization': `Bearer ${connector.access_token}`, 'Accept': 'application/json' },
      }, { errorTag: 'geneweave-connector-test' });

      if (testResp.ok) {
        json(res, 200, { ok: true, message: 'Connection verified' });
      } else {
        json(res, 200, { ok: false, message: `API returned ${testResp.status}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 200, { ok: false, message: msg });
    }
  }, { auth: true, csrf: true });

}
