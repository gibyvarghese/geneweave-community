// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — PREVIEW: a read-only, four-layer plan of what applying a release WOULD do.
 *
 * Preview is the default first command of the upgrade flow. It classifies every change the release ships,
 * across the four upgrade layers, and persists the plan as an `upgrade_runs` row (mode `'preview'`) with one
 * `upgrade_details` row per item — so the Upgrade Center can show "here's exactly what will happen" before an
 * operator commits. Crucially it changes NOTHING it plans over: no package is installed, no migration runs, no
 * seeded default is touched. The only writes are the run/detail bookkeeping (the record of the preview), which
 * a test asserts leaves every content-bearing table byte-for-byte identical.
 *
 *   L1 packages — which required platform packages are stale (installed version doesn't satisfy the release).
 *   L2 code     — which application-code tag the release targets. The running app can't self-apply code (it
 *                 ships via package/deploy), so this layer is reported as "requires deploy", not applied here.
 *   L3 schema   — which migration batches the release declares that aren't in this instance's `schema_migrations`
 *                 ledger yet (i.e. would run), versus those already applied.
 *   L4 content  — for each shipped default, the three-way `classifyDrift(Base, Local, Remote)` using the SAME
 *                 live-row hashing the boot-time reconcile uses: Base = the row's recorded `origin_hash`,
 *                 Local = the live row hashed now, Remote = the manifest's declared hash. This yields, per
 *                 record, whether the release would auto-adopt it (stale), keep your edit (customized), or need
 *                 a three-way merge (diverged) — exactly what the apply will do, with nothing applied.
 *
 * Written once against the framework's `SqlClient` seam so it serves SQLite and Postgres identically.
 */
import { classifyDrift } from '@weaveintel/realm';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import type { UpgradeManifest } from '@weaveintel/upgrade';
import { isRealmFamily, realmFamily } from './realm-families.js';
import { fetchGlobalRealmRow, hashLiveRealmRow } from './realm-seed-reconcile.js';
import { upgradePriority, type UpgradeDisposition } from './upgrade-priority.js';
import { beginUpgradeRun, recordUpgradeDetail, finishUpgradeRun } from './upgrade-run-store.js';
import { stalePackages, type StalePackage } from './upgrade-preflight.js';

/** L1 — packages the release requires that are stale/missing (would need upgrading before/with an apply). */
export interface PreviewL1 {
  readonly stale: StalePackage[];
  readonly checked: number;
}
/** L2 — the application-code layer (informational: the running app can't self-apply code). */
export interface PreviewL2 {
  readonly repoTag: string | null;
  readonly requiresDeploy: boolean;
  readonly note: string;
}
/** L3 — schema migration batches the release declares: which would run vs which are already applied. */
export interface PreviewL3 {
  readonly toRun: string[];
  readonly alreadyApplied: string[];
}
/** One planned content change (an L4 detail preview row). */
export interface PreviewL4Entry {
  readonly family: string;
  readonly logicalKey: string;
  readonly disposition: UpgradeDisposition;
  readonly priority: string;
  readonly baseHash: string | null;
  readonly localHash: string | null;
  readonly remoteHash: string;
}
/** L4 — the seeded-content plan, tallied by disposition + priority, with any unknown families skipped. */
export interface PreviewL4 {
  readonly entries: PreviewL4Entry[];
  readonly byDisposition: Record<string, number>;
  readonly byPriority: Record<string, number>;
  readonly skippedFamilies: string[];
}

/** The whole four-layer preview + the persisted run id. */
export interface UpgradePreview {
  readonly runId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly layers: { readonly L1: PreviewL1; readonly L2: PreviewL2; readonly L3: PreviewL3; readonly L4: PreviewL4 };
}

/** Options for the preview (mostly injectables for deterministic tests). */
export interface PreviewConfig {
  readonly manifest: UpgradeManifest;
  /** The installed application version (recorded as the run's `from_version`). */
  readonly installedVersion: string;
  /** Installed-package version reader (default: the node_modules probe, via preflight). */
  readonly readInstalledPackageVersion?: (name: string) => string | null;
  /** Timestamp override for the run/detail rows (tests / deterministic replay). */
  readonly at?: string;
}

/**
 * The set of migration batch ids already recorded in this instance's `schema_migrations` ledger. Used to
 * decide which of the release's declared batches would run. Read-only.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns a Set of applied batch ids.
 */
async function appliedSchemaBatchIds(client: SqlClient, dialect: SqlDialect): Promise<Set<string>> {
  void dialect;
  const { rows } = await client.query(`SELECT id FROM schema_migrations`);
  return new Set(rows.map((r) => String((r as { id: unknown }).id)));
}

/**
 * Build the read-only four-layer preview of applying `config.manifest`, persisting it as a `preview` run.
 *
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param config the manifest, installed version, and injectable probes.
 * @returns the four-layer plan and the persisted run id. Side effects: ONE `upgrade_runs` row (mode
 *   'preview') and one `upgrade_details` row per planned item. Nothing the plan describes is applied — no
 *   package, migration, or seeded default is changed.
 */
export async function previewUpgrade(client: SqlClient, dialect: SqlDialect, config: PreviewConfig): Promise<UpgradePreview> {
  const { manifest } = config;
  const runId = await beginUpgradeRun(client, dialect, {
    mode: 'preview', fromVersion: config.installedVersion, toVersion: manifest.version, at: config.at,
  });

  // ── L1 packages ─────────────────────────────────────────────────────────────────────────────────────
  const { stale, checked } = stalePackages(manifest, config.readInstalledPackageVersion);
  const L1: PreviewL1 = { stale, checked };
  for (const p of manifest.layers.packages) {
    if (!p.requires) continue;
    const isStale = stale.some((s) => s.name === p.name);
    await recordUpgradeDetail(client, dialect, runId, {
      family: 'packages', logicalKey: p.name, layer: 'L1',
      disposition: isStale ? 'stale' : 'in_sync', remoteHash: p.version,
      note: isStale ? `requires ${p.requires}` : null, priority: 'P3',
    });
  }

  // ── L2 code ─────────────────────────────────────────────────────────────────────────────────────────
  const code = manifest.layers.code ?? null;
  const L2: PreviewL2 = code
    ? { repoTag: code.repoTag, requiresDeploy: true, note: 'code ships via package/deploy; not applied by the running instance' }
    : { repoTag: null, requiresDeploy: false, note: 'no code-layer change' };
  if (code) {
    await recordUpgradeDetail(client, dialect, runId, {
      family: 'code', logicalKey: code.repoTag, layer: 'L2', disposition: 'new',
      remoteHash: code.fileManifestDigest, note: 'requires deploy', priority: 'P3',
    });
  }

  // ── L3 schema ───────────────────────────────────────────────────────────────────────────────────────
  const applied = await appliedSchemaBatchIds(client, dialect);
  const toRun: string[] = [];
  const alreadyApplied: string[] = [];
  for (const batch of manifest.layers.schema) {
    const isApplied = applied.has(batch.batchId);
    (isApplied ? alreadyApplied : toRun).push(batch.batchId);
    await recordUpgradeDetail(client, dialect, runId, {
      family: 'schema', logicalKey: batch.batchId, layer: 'L3',
      disposition: isApplied ? 'in_sync' : 'new', remoteHash: batch.contentHash, priority: 'P3',
    });
  }
  const L3: PreviewL3 = { toRun, alreadyApplied };

  // ── L4 content ──────────────────────────────────────────────────────────────────────────────────────
  const entries: PreviewL4Entry[] = [];
  const byDisposition: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const skippedFamilies: string[] = [];
  for (const c of manifest.layers.content) {
    // Forward-compatibility: a release may ship a family this build doesn't know yet — skip, don't throw.
    if (!isRealmFamily(c.family)) {
      if (!skippedFamilies.includes(c.family)) skippedFamilies.push(c.family);
      continue;
    }
    const spec = realmFamily(c.family);
    const row = await fetchGlobalRealmRow(client, dialect, spec, c.logicalKey);
    const base = row ? ((row['origin_hash'] as string | null) || null) : null;
    const local = row ? hashLiveRealmRow(spec, row) : null;
    const state = classifyDrift(base, local, c.remoteHash) as UpgradeDisposition;
    // The publisher may pin a review priority; else derive it from (family, disposition) — a conflict is P1.
    const priority = c.priority ?? upgradePriority(c.family, state);
    entries.push({ family: c.family, logicalKey: c.logicalKey, disposition: state, priority, baseHash: base, localHash: local, remoteHash: c.remoteHash });
    byDisposition[state] = (byDisposition[state] ?? 0) + 1;
    byPriority[priority] = (byPriority[priority] ?? 0) + 1;
    await recordUpgradeDetail(client, dialect, runId, {
      family: c.family, logicalKey: c.logicalKey, layer: 'L4', disposition: state,
      baseHash: base, localHash: local, remoteHash: c.remoteHash, note: c.releaseNote, priority,
    });
  }
  const L4: PreviewL4 = { entries, byDisposition, byPriority, skippedFamilies };

  // Close the run. A preview always 'succeeds' (it's read-only); the summary carries the headline counts.
  await finishUpgradeRun(client, dialect, runId, {
    status: 'succeeded',
    summary: {
      packagesStale: L1.stale.length, schemaToRun: L3.toRun.length,
      contentChanges: L4.entries.length, contentSkipped: L4.skippedFamilies.length,
    },
    at: config.at,
  });

  return { runId, fromVersion: config.installedVersion, toVersion: manifest.version, layers: { L1, L2, L3, L4 } };
}
