// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — VERIFY: the post-apply health gate that decides whether an upgrade "took".
 *
 * It closes the gap between "apply succeeded" and "the instance actually works": after apply has mutated the
 * database, verify runs a battery of checks and, if any fail, the apply orchestrator restores the pre-upgrade
 * snapshot unattended (see `upgrade-apply.ts`). The checks are three kinds, mirroring the design's
 * boot/readiness/invariants/`@upgrade-critical` split:
 *
 *   • readiness — the database is reachable and the engine's own ledger tables are present.
 *   • manifest invariants (DERIVED from the release, no extra manifest field) — every non-deferred schema
 *     batch the release declared is in the ledger; every content family it ships is a known realm family
 *     whose table exists; every required platform package is satisfied.
 *   • external `@upgrade-critical` checks — an OPTIONAL injected hook that runs an out-of-process smoke suite
 *     (e.g. the Playwright `@upgrade-critical` subset) and reports pass/fail; absent by default.
 *
 * Every check is a read; verify never writes. Each returns a name + ok + optional message so a failure is
 * legible in the audit and the Upgrade Center.
 */
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import type { UpgradeManifest } from '@weaveintel/upgrade';
import { isRealmFamily, realmFamily } from './realm-families.js';
import { stalePackages } from './upgrade-preflight.js';

/** One verify check's outcome. */
export interface VerifyCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
}

/** The overall verify verdict: ok iff every check passed. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly checks: VerifyCheck[];
}

/** Everything verify needs — injectable so tests are hermetic and the external hook is pluggable. */
export interface VerifyConfig {
  /** The release that was applied (its layers drive the derived invariants). */
  readonly manifest: UpgradeManifest;
  /** Schema batches that were deliberately DEFERRED — not expected in the ledger yet, so not asserted. */
  readonly deferredBatchIds?: ReadonlySet<string>;
  /** Content families held back because their schema was deferred — their table invariant is skipped. */
  readonly deferredFamilies?: ReadonlySet<string>;
  /** Installed-version reader for the package invariant (defaults to the node_modules probe via preflight). */
  readonly readInstalledPackageVersion?: (name: string) => string | null;
  /** Optional out-of-process smoke suite (the `@upgrade-critical` subset); returns extra checks. */
  readonly externalChecks?: () => Promise<VerifyCheck[]>;
}

/**
 * Does a table exist? Dialect-specific catalog lookup (SQLite `sqlite_master`, Postgres `information_schema`).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param table the table name (a trusted, code-supplied identifier — bound as a parameter regardless).
 * @returns true iff a base table with that name exists.
 */
async function tableExists(client: SqlClient, dialect: SqlDialect, table: string): Promise<boolean> {
  const sql = dialect === 'postgres'
    ? `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`
    : `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`;
  const { rows } = await client.query(sql, [table]);
  return rows.length > 0;
}

/**
 * Run the post-apply verification battery.
 * @param client the SqlClient (SQLite or Postgres) — read-only here.
 * @param dialect 'sqlite' | 'postgres'.
 * @param config the applied manifest + deferral sets + optional package reader / external hook.
 * @returns the {@link VerifyResult}. No side effects (every check is a read).
 */
export async function verifyUpgrade(client: SqlClient, dialect: SqlDialect, config: VerifyConfig): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];
  const deferredBatches = config.deferredBatchIds ?? new Set<string>();
  const deferredFamilies = config.deferredFamilies ?? new Set<string>();

  // ── readiness ─────────────────────────────────────────────────────────────────────────────────────
  try {
    await client.query('SELECT 1');
    checks.push({ name: 'readiness:db', ok: true });
  } catch (err) {
    checks.push({ name: 'readiness:db', ok: false, message: `database unreachable: ${(err as Error).message}` });
  }
  for (const t of ['schema_migrations', 'upgrade_runs', 'upgrade_details']) {
    const ok = await tableExists(client, dialect, t);
    checks.push({ name: `readiness:table:${t}`, ok, ...(ok ? {} : { message: `ledger table '${t}' missing` }) });
  }

  // ── manifest invariants (derived) ───────────────────────────────────────────────────────────────────
  // (1) Every non-deferred schema batch the release declared is now in the ledger. This is a SQLite invariant:
  //     Postgres applies its schema declaratively (no per-batch ledger), so the batch ids are never recorded
  //     there and the check is skipped — the content-family and package invariants still cover the PG schema.
  if (dialect === 'sqlite') {
    const { rows: ledgerRows } = await client.query('SELECT id FROM schema_migrations');
    const ledgered = new Set(ledgerRows.map((r) => String((r as { id: unknown }).id)));
    const missingBatches = config.manifest.layers.schema
      .filter((b) => !deferredBatches.has(b.batchId) && !ledgered.has(b.batchId))
      .map((b) => b.batchId);
    checks.push({
      name: 'invariant:schema-batches-ledgered',
      ok: missingBatches.length === 0,
      ...(missingBatches.length ? { message: `not applied: ${missingBatches.join(', ')}` } : {}),
    });
  }

  // (2) Every content family the release ships (that wasn't deferred) is a known realm family whose table exists.
  const badFamilies: string[] = [];
  for (const c of config.manifest.layers.content) {
    if (deferredFamilies.has(c.family)) continue;
    if (!isRealmFamily(c.family)) { badFamilies.push(`${c.family} (unknown)`); continue; }
    if (!(await tableExists(client, dialect, realmFamily(c.family).table))) badFamilies.push(`${c.family} (no table)`);
  }
  checks.push({
    name: 'invariant:content-families-present',
    ok: badFamilies.length === 0,
    ...(badFamilies.length ? { message: `unusable families: ${[...new Set(badFamilies)].join(', ')}` } : {}),
  });

  // (3) Every required platform package is satisfied (the deployed code matches what the release requires).
  const { stale } = stalePackages(config.manifest, config.readInstalledPackageVersion);
  checks.push({
    name: 'invariant:packages-satisfied',
    ok: stale.length === 0,
    ...(stale.length ? { message: `stale packages: ${stale.map((s) => s.name).join(', ')}` } : {}),
  });

  // ── external @upgrade-critical smoke suite (optional) ───────────────────────────────────────────────
  if (config.externalChecks) {
    try {
      checks.push(...(await config.externalChecks()));
    } catch (err) {
      checks.push({ name: 'external:@upgrade-critical', ok: false, message: `external checks threw: ${(err as Error).message}` });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
