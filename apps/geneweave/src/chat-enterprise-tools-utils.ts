import type { Tool } from '@weaveintel/core';
import { assertSafeForEgress } from '@weaveintel/core';
import {
  createEnterpriseTools,
  createEnterpriseToolGroups,
  ServiceNowProvider,
  type EnterpriseConnectorConfig,
  type EnterpriseToolGroup,
} from '@weaveintel/tools-enterprise';
import type { DatabaseAdapter } from './db.js';
import type { EnterpriseConnectorRow } from './db-types.js';

export type { EnterpriseToolGroup };

export async function refreshTokenIfNeeded(
  db: DatabaseAdapter,
  row: EnterpriseConnectorRow,
): Promise<void> {
  if (row.auth_type !== 'oauth2' || !row.refresh_token || !row.token_expires_at) return;
  const expiresAt = new Date(row.token_expires_at).getTime();
  const now = Date.now();
  // Refresh if token expires within 60 seconds
  if (expiresAt - now > 60_000) return;

  const authConfig = row.auth_config ? (JSON.parse(row.auth_config) as Record<string, string>) : {};
  const clientId = authConfig['clientId'] ?? authConfig['client_id'];
  const clientSecret = authConfig['clientSecret'] ?? authConfig['client_secret'];
  if (!clientId || !clientSecret || !row.base_url) return;

  // SSRF guard: reject cloud-metadata endpoints, RFC-1918 ranges, loopback, and
  // plain HTTP before handing the operator-supplied base_url to the OAuth provider.
  // allowLoopback: false — no legitimate external OAuth server lives at 127.0.0.1.
  await assertSafeForEgress(row.base_url, {
    errorTag: 'enterprise-oauth-refresh',
    policy: { allowLoopback: false },
  });

  const provider = new ServiceNowProvider();
  const result = await provider.refreshOAuthToken(row.base_url, clientId, clientSecret, row.refresh_token);
  if (!result) return;

  const newExpiresAt = new Date(now + result.expiresIn * 1000).toISOString();
  await db.updateEnterpriseConnector(row.id, {
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
    token_expires_at: newExpiresAt,
  });
  // Mutate the row so callers pick up the fresh token
  row.access_token = result.accessToken;
  row.refresh_token = result.refreshToken;
  row.token_expires_at = newExpiresAt;
}

function buildConnectorConfigs(enabled: EnterpriseConnectorRow[]): EnterpriseConnectorConfig[] {
  return enabled.map((row) => {
    const authConfig: Record<string, string> = row.auth_config
      ? (JSON.parse(row.auth_config) as Record<string, string>)
      : {};
    if (row.access_token && !authConfig['accessToken']) {
      authConfig['accessToken'] = row.access_token;
    }
    return {
      name: row.name,
      type: row.connector_type,
      enabled: true,
      baseUrl: row.base_url ?? '',
      authType: (row.auth_type ?? 'bearer') as EnterpriseConnectorConfig['authType'],
      authConfig,
      options: row.options ? (JSON.parse(row.options) as Record<string, string>) : undefined,
    };
  });
}

export type SimpleLogger = { error: (msg: string, meta?: unknown) => void };

export async function loadEnterpriseTools(
  db: DatabaseAdapter,
  log?: SimpleLogger,
): Promise<Tool[]> {
  try {
    const rows = await db.listEnterpriseConnectors();
    const enabled = rows.filter((r) => r.enabled === 1 && r.status === 'connected');
    if (enabled.length === 0) return [];

    await Promise.all(enabled.map((r) => refreshTokenIfNeeded(db, r)));
    const configs = buildConnectorConfigs(enabled);
    return createEnterpriseTools(configs, undefined, { includeExtended: false });
  } catch (err) {
    (log ?? console).error('[chat] Failed to load enterprise tools', err);
    return [];
  }
}

export async function loadEnterpriseToolGroups(
  db: DatabaseAdapter,
  log?: SimpleLogger,
): Promise<EnterpriseToolGroup[]> {
  try {
    const rows = await db.listEnterpriseConnectors();
    const enabled = rows.filter((r) => r.enabled === 1 && r.status === 'connected');
    if (enabled.length === 0) return [];

    await Promise.all(enabled.map((r) => refreshTokenIfNeeded(db, r)));
    const configs = buildConnectorConfigs(enabled);
    return createEnterpriseToolGroups(configs);
  } catch (err) {
    (log ?? console).error('[chat] Failed to load enterprise tool groups', err);
    return [];
  }
}
