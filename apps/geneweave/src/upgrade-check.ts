// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — the `check` command: discover, verify, and record the latest release.
 *
 * This is the app-side glue over `@weaveintel/upgrade`'s `UpdateChecker`. It:
 *   • computes the anti-rollback FLOOR = the semver max of the installed version and every release we've
 *     previously ACCEPTED (from `upgrade_releases`), so a replayed old-but-signed manifest can't downgrade us;
 *   • runs the framework checker (signature → edition → freshness → anti-rollback, each with a distinct reason);
 *   • records the outcome to `upgrade_releases` (accepted ones raise the floor; rejected ones are an audit trail).
 *
 * It also builds the pieces from environment config: a RESILIENT HTTP getter (through `@weaveintel/resilience`),
 * the Ed25519 verifier from trusted public keys, and the GitHub release source (public, or authenticated for a
 * private repo with a token from a provider — never an env-var plaintext when a vault credential is configured).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { rsort as semverRsort, valid as semverValid } from 'semver';
import { runResilient } from '@weaveintel/resilience';
import {
  createUpdateChecker, createEd25519Verifier, createGitHubReleaseSource,
  type HttpGetter, type ReleaseSource, type SignatureVerifier, type CheckOutcome,
} from '@weaveintel/upgrade';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { listAcceptedReleaseVersions, recordUpgradeRelease } from './upgrade-release-store.js';

/** Everything the check needs — injectable so tests supply a mock source + verifier. */
export interface CheckConfig {
  readonly source: ReleaseSource;
  readonly verifier: SignatureVerifier;
  /** This instance's edition (a manifest for another edition is rejected). */
  readonly edition: string;
  /** The installed application version. */
  readonly installedVersion: string;
  /** Clock injection for expiry (tests). */
  readonly now?: () => Date;
  /** Persistence timestamp override (tests). */
  readonly at?: string;
}

/** A check result: the framework outcome, plus the floor it was evaluated against. */
export type CheckResult = CheckOutcome & { readonly floor: string };

/** The semver-highest of a set of versions (invalid ones ignored); falls back to the first input. */
function highestVersion(versions: string[]): string {
  const valid = versions.filter((v) => semverValid(v));
  if (valid.length === 0) return versions[0] ?? '0.0.0';
  return semverRsort(valid)[0]!;
}

/**
 * Run a check: compute the anti-rollback floor from history, verify the latest manifest, and persist the
 * outcome.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param config the release source, verifier, edition, installed version (+ optional clock/timestamp).
 * @returns the check outcome and the floor. Side effect: one row in upgrade_releases (unless there was no
 *   release at all — `none` records nothing).
 */
export async function checkForUpdate(client: SqlClient, dialect: SqlDialect, config: CheckConfig): Promise<CheckResult> {
  const accepted = await listAcceptedReleaseVersions(client, dialect);
  const floor = highestVersion([config.installedVersion, ...accepted]);

  const outcome = await createUpdateChecker({
    source: config.source, verifier: config.verifier, edition: config.edition,
    currentVersion: floor, now: config.now,
  }).check();

  if (outcome.status !== 'none') {
    const m = outcome.manifest;
    const isAccepted = outcome.status === 'up_to_date' || outcome.status === 'update_available';
    await recordUpgradeRelease(client, dialect, {
      name: m.name, version: m.version, edition: m.edition, channel: m.channel,
      publishedAt: m.publishedAt, expiresAt: m.expiresAt ?? null, keyFingerprint: m.signature.keyFingerprint,
      outcome: outcome.status, rejectReason: outcome.status === 'rejected' ? outcome.reason : null,
      accepted: isAccepted, manifestJson: isAccepted ? JSON.stringify(m) : null,
    }, config.at);
  }
  return { ...outcome, floor };
}

// ── Building the check from environment config ──────────────────────────────────────────────────────────

/**
 * A resilient HTTP GET for the release source — every request flows through `@weaveintel/resilience`
 * (retry + circuit-breaker), and ordinary HTTP errors resolve (not reject) so the release source handles
 * status codes itself.
 * @param name a label for the resilience pipeline (defaults to 'upgrade-release-source').
 * @returns an HttpGetter suitable for the GitHub release source.
 */
export function resilientHttpGetter(endpoint = 'upgrade:release-source'): HttpGetter {
  return (url, headers) =>
    runResilient(async () => {
      const res = await fetch(url, { headers: headers as Record<string, string> | undefined });
      return { status: res.status, text: await res.text() };
    }, { endpoint });
}

/** Split a PEM bundle (one or more `-----BEGIN PUBLIC KEY----- … -----END PUBLIC KEY-----` blocks). */
export function parseTrustedKeys(pemBundle: string): string[] {
  const matches = pemBundle.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g);
  return matches ?? [];
}

/**
 * Build a check configuration from environment + an optional token provider, or return null if update
 * checks aren't configured (no repo or no trusted keys — then the app simply doesn't offer the command).
 *
 * Env: `GENEWEAVE_UPGRADE_REPO` (owner/repo), `GENEWEAVE_UPGRADE_TRUSTED_KEYS` (PEM bundle),
 * `GENEWEAVE_EDITION` (default 'community'), `GENEWEAVE_UPGRADE_ASSET` (default 'manifest.json').
 * @param installedVersion the app's installed version.
 * @param tokenProvider optional bearer-token provider for a private repo (vault-backed; never logged).
 * @returns a CheckConfig, or null when unconfigured.
 */
export function buildCheckConfigFromEnv(installedVersion: string, tokenProvider?: () => Promise<string>): CheckConfig | null {
  const repo = process.env['GENEWEAVE_UPGRADE_REPO'];
  const keysPem = process.env['GENEWEAVE_UPGRADE_TRUSTED_KEYS'];
  if (!repo || !keysPem) return null;
  const keys = parseTrustedKeys(keysPem);
  if (keys.length === 0) return null;
  const source = createGitHubReleaseSource({
    repo, http: resilientHttpGetter(),
    assetName: process.env['GENEWEAVE_UPGRADE_ASSET'] ?? 'manifest.json',
    ...(tokenProvider ? { tokenProvider } : {}),
  });
  return {
    source,
    verifier: createEd25519Verifier(keys),
    edition: process.env['GENEWEAVE_EDITION'] ?? 'community',
    installedVersion,
  };
}

/**
 * The installed application version, read from the app's package.json. Used as the base of the anti-rollback
 * floor.
 * @returns the version string, or '0.0.0' if it can't be read.
 */
export function getAppVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return String((JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * Build a bearer-token provider for a PRIVATE release repo, or undefined for a public repo.
 *
 * Order of preference: a vault credential id (`GENEWEAVE_UPGRADE_TOKEN_CREDENTIAL_ID`) whose stored secret
 * is decrypted per call — the hardened path — then a plain `GENEWEAVE_UPGRADE_TOKEN` env var. The token is
 * fetched lazily and never retained. Returns undefined when neither is set (public repo).
 *
 * @param readVaultToken a callback that decrypts the stored token for a credential id (the adapter provides
 *   one backed by `getToolCredential` + `decryptCredential`); optional.
 * @returns a token provider, or undefined.
 */
export function buildUpgradeTokenProvider(readVaultToken?: (credentialId: string) => Promise<string | null>): (() => Promise<string>) | undefined {
  const credentialId = process.env['GENEWEAVE_UPGRADE_TOKEN_CREDENTIAL_ID'];
  if (credentialId && readVaultToken) {
    return async () => {
      const token = await readVaultToken(credentialId);
      if (!token) throw new Error('upgrade token credential not found or empty'); // no token value in the message
      return token;
    };
  }
  const envToken = process.env['GENEWEAVE_UPGRADE_TOKEN'];
  if (envToken) return async () => envToken;
  return undefined;
}
