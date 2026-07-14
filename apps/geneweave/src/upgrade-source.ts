// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the release SOURCE configuration store.
 *
 * "Where does this instance look for a new version?" Historically that was environment-only
 * (`GENEWEAVE_UPGRADE_REPO` + trusted keys). This module persists it as an operator-managed, platform-global
 * SINGLETON row in `upgrade_source_config` (migration m177) so a platform admin can point the Upgrade Center
 * at a GitHub repo from the UI — and so the check command has a durable record of it.
 *
 * It provides:
 *   • load/save of the singleton config (id = 'default'),
 *   • validation of operator input (repo shape, at least one usable PUBLIC key, non-empty edition),
 *   • `buildCheckConfigFromSource` — the DB-config analogue of `buildCheckConfigFromEnv` in upgrade-check.ts,
 *     assembling the SAME resilient GitHub release source + Ed25519 verifier the env path builds.
 *
 * Secret hygiene: the config stores PUBLIC signing keys (safe at rest) and, for a private repo, only a
 * `tokenCredentialId` REFERENCE into the encrypted credential vault — never the token itself. The token is
 * resolved lazily per check via the injected provider and never logged or returned (mirrors the env path).
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';
import {
  createGitHubReleaseSource, createEd25519Verifier,
} from '@weaveintel/upgrade';
import { resilientHttpGetter, parseTrustedKeys, type CheckConfig } from './upgrade-check.js';

/** The persisted source config as the UI edits it. `trustedKeysPem` is a PUBLIC-key PEM bundle. */
export interface UpgradeSourceConfig {
  /** GitHub `owner/repo` the signed release manifest is published on. */
  readonly repo: string;
  /** The edition this instance accepts (a manifest for another edition is rejected downstream). */
  readonly edition: string;
  /** The manifest asset's file name on the release (default 'manifest.json'). */
  readonly assetName: string;
  /** One or more PUBLIC Ed25519 keys as a PEM bundle — the signature trust root. */
  readonly trustedKeysPem: string;
  /** GitHub API base override for GitHub Enterprise; null/omitted = public github.com. */
  readonly apiBase?: string | null;
  /** Vault credential id for a PRIVATE-repo bearer token; null = public repo. The token is NOT stored. */
  readonly tokenCredentialId?: string | null;
  /** Reserved for Phase 3 scheduled checks. */
  readonly autoCheck?: boolean;
  /** 0 = configured but paused (check treats it as not configured). */
  readonly enabled?: boolean;
}

/** A stored config row plus its non-editable audit fields (what a GET returns to the UI). */
export interface UpgradeSourceConfigRow extends UpgradeSourceConfig {
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** The single row's fixed primary key — this is a platform-global singleton. */
const SINGLETON_ID = 'default';

/** A field-level validation failure (never carries secret material). */
export interface SourceValidationError { readonly field: string; readonly message: string; }

/**
 * Validate operator-supplied source config before it is saved or used.
 * @param input the candidate config (as parsed from the request body).
 * @returns a list of field errors; empty means valid. Pure — no I/O, no secrets in messages.
 */
export function validateSourceConfig(input: Partial<UpgradeSourceConfig>): SourceValidationError[] {
  const errors: SourceValidationError[] = [];
  const repo = (input.repo ?? '').trim();
  // GitHub owner/repo: each segment is 1..100 of [A-Za-z0-9._-]; exactly one slash. Rejects URLs, spaces, paths.
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    errors.push({ field: 'repo', message: "repo must be in 'owner/repo' form" });
  }
  if (!(input.edition ?? '').trim()) errors.push({ field: 'edition', message: 'edition is required' });
  if (parseTrustedKeys(input.trustedKeysPem ?? '').length === 0) {
    errors.push({ field: 'trustedKeysPem', message: 'at least one PEM PUBLIC KEY block is required' });
  }
  const assetName = (input.assetName ?? 'manifest.json').trim();
  // The asset name is used as a plain file-name match; forbid path separators to avoid ambiguous lookups.
  if (assetName.includes('/') || assetName.includes('\\')) {
    errors.push({ field: 'assetName', message: 'assetName must be a plain file name' });
  }
  if (input.apiBase != null && input.apiBase !== '' && !/^https:\/\/[^\s]+$/.test(input.apiBase)) {
    errors.push({ field: 'apiBase', message: 'apiBase must be an https URL' });
  }
  return errors;
}

/**
 * Load the singleton source config.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the stored row, or null if the operator has not configured a source yet.
 */
export async function loadSourceConfig(client: SqlClient, dialect: SqlDialect): Promise<UpgradeSourceConfigRow | null> {
  const { rows } = await client.query(
    `SELECT repo, edition, asset_name, trusted_keys_pem, api_base, token_credential_id, auto_check, enabled, updated_at, updated_by
       FROM upgrade_source_config WHERE id = ${ph(dialect, 1)} LIMIT 1`,
    [SINGLETON_ID],
  );
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    repo: String(r['repo']),
    edition: String(r['edition']),
    assetName: String(r['asset_name']),
    trustedKeysPem: String(r['trusted_keys_pem']),
    apiBase: (r['api_base'] as string | null) ?? null,
    tokenCredentialId: (r['token_credential_id'] as string | null) ?? null,
    autoCheck: Number(r['auto_check']) === 1,
    enabled: Number(r['enabled']) === 1,
    updatedAt: (r['updated_at'] as string | null) ?? null,
    updatedBy: (r['updated_by'] as string | null) ?? null,
  };
}

/**
 * Upsert the singleton source config.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param input the validated config to store (caller must have run validateSourceConfig first).
 * @param opts.updatedBy the user id of the platform admin saving it (audit); optional.
 * @param opts.at persistence-timestamp override (tests); optional.
 * @returns the freshly stored row.
 * @sideEffect one INSERT or UPDATE of upgrade_source_config (single row).
 */
export async function saveSourceConfig(
  client: SqlClient, dialect: SqlDialect, input: UpgradeSourceConfig,
  opts: { updatedBy?: string | null; at?: string } = {},
): Promise<UpgradeSourceConfigRow> {
  const assetName = (input.assetName ?? 'manifest.json').trim() || 'manifest.json';
  const autoCheck = input.autoCheck ? 1 : 0;
  const enabled = input.enabled === false ? 0 : 1;
  const apiBase = input.apiBase?.trim() || null;
  const tokenCredentialId = input.tokenCredentialId?.trim() || null;
  const updatedBy = opts.updatedBy ?? null;
  const at = opts.at ?? null;
  // Update-or-insert on the fixed singleton id. We AVOID `ON CONFLICT … DO UPDATE` with reused placeholders
  // because `ph()` renders `?` for SQLite (positional-by-occurrence) — reusing an index there under-supplies
  // params. Instead: try the UPDATE first; if it changed nothing, INSERT. Each placeholder is a distinct,
  // sequential index and every value is passed once per `?` (mirrors setFamilyPolicy in upgrade-automation.ts).
  const existing = await loadSourceConfig(client, dialect);
  if (existing) {
    await client.query(
      `UPDATE upgrade_source_config SET
         repo = ${ph(dialect, 1)}, edition = ${ph(dialect, 2)}, asset_name = ${ph(dialect, 3)},
         trusted_keys_pem = ${ph(dialect, 4)}, api_base = ${ph(dialect, 5)}, token_credential_id = ${ph(dialect, 6)},
         auto_check = ${ph(dialect, 7)}, enabled = ${ph(dialect, 8)},
         updated_at = COALESCE(${ph(dialect, 9)}, ${nowExpr(dialect)}), updated_by = ${ph(dialect, 10)}
       WHERE id = ${ph(dialect, 11)}`,
      [input.repo.trim(), input.edition.trim(), assetName, input.trustedKeysPem, apiBase, tokenCredentialId,
        autoCheck, enabled, at, updatedBy, SINGLETON_ID],
    );
  } else {
    await client.query(
      `INSERT INTO upgrade_source_config
         (id, repo, edition, asset_name, trusted_keys_pem, api_base, token_credential_id, auto_check, enabled, created_at, updated_at, updated_by)
       VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)}, ${ph(dialect, 6)}, ${ph(dialect, 7)}, ${ph(dialect, 8)}, ${ph(dialect, 9)},
         COALESCE(${ph(dialect, 10)}, ${nowExpr(dialect)}), COALESCE(${ph(dialect, 11)}, ${nowExpr(dialect)}), ${ph(dialect, 12)})`,
      [SINGLETON_ID, input.repo.trim(), input.edition.trim(), assetName, input.trustedKeysPem, apiBase,
        tokenCredentialId, autoCheck, enabled, at, at, updatedBy],
    );
  }
  const saved = await loadSourceConfig(client, dialect);
  if (!saved) throw new Error('source config not found after save'); // unreachable: we just wrote it
  return saved;
}

/**
 * Build a `CheckConfig` from a stored source config — the DB-config analogue of `buildCheckConfigFromEnv`.
 *
 * @param source the loaded config (from loadSourceConfig).
 * @param installedVersion the app's installed version (the anti-rollback floor base).
 * @param tokenProvider optional bearer-token provider for a private repo. The CALLER decides whether to build
 *   one from `source.tokenCredentialId` (vault) — this module never touches secrets directly.
 * @returns a CheckConfig, or null when the source is disabled or unusable (no keys) so the caller reports
 *   `not_configured` exactly like the env path.
 */
export function buildCheckConfigFromSource(
  source: UpgradeSourceConfigRow | UpgradeSourceConfig,
  installedVersion: string,
  tokenProvider?: () => Promise<string>,
): CheckConfig | null {
  if ('enabled' in source && source.enabled === false) return null;
  const keys = parseTrustedKeys(source.trustedKeysPem);
  if (!source.repo || keys.length === 0) return null;
  const releaseSource = createGitHubReleaseSource({
    repo: source.repo,
    http: resilientHttpGetter(),
    assetName: source.assetName || 'manifest.json',
    ...(source.apiBase ? { apiBase: source.apiBase } : {}),
    ...(tokenProvider ? { tokenProvider } : {}),
  });
  return {
    source: releaseSource,
    verifier: createEd25519Verifier(keys),
    edition: source.edition || 'community',
    installedVersion,
  };
}
