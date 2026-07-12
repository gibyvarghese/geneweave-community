// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — persistence for the `upgrade_releases` audit trail (the `check` command's
 * record of every release manifest this instance has seen).
 *
 * Written once against the framework's `SqlClient` seam (shared `ph`/`nowExpr` helpers) so it serves both
 * SQLite and Postgres. Two reads matter: the latest check (what the admin UI shows) and the list of
 * ACCEPTED release versions (from which the check computes the anti-rollback floor — as a semver max, in
 * the check module, since a SQL string `max` would order "10.0.0" below "9.0.0").
 */
import { randomUUID } from 'node:crypto';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph, nowExpr } from './realm-sql.js';

/** The check outcome recorded for a release. `none` is never persisted (there was no release to record). */
export type ReleaseOutcome = 'up_to_date' | 'update_available' | 'rejected';

/** What to record about one checked release. */
export interface UpgradeReleaseEntry {
  readonly name?: string | null;
  readonly version: string;
  readonly edition?: string | null;
  readonly channel?: string | null;
  readonly publishedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly keyFingerprint?: string | null;
  readonly outcome: ReleaseOutcome;
  readonly rejectReason?: string | null;
  /** True iff the manifest passed EVERY check — only accepted releases raise the anti-rollback floor. */
  readonly accepted: boolean;
  /** The manifest JSON, kept for an accepted release (so a later apply doesn't re-fetch). */
  readonly manifestJson?: string | null;
}

/** A persisted upgrade_releases row (read shape). */
export interface UpgradeReleaseRow {
  id: string; name: string | null; version: string; edition: string | null; channel: string | null;
  published_at: string | null; expires_at: string | null; key_fingerprint: string | null;
  outcome: string; reject_reason: string | null; accepted: number; manifest_json: string | null; checked_at: string;
}

/**
 * Record one checked release.
 * @param client the SqlClient (SQLite or Postgres).
 * @param dialect 'sqlite' | 'postgres'.
 * @param e the release check result to persist.
 * @param at optional ISO timestamp override (tests).
 * @returns the new row id. Side effect: one INSERT into upgrade_releases.
 */
export async function recordUpgradeRelease(client: SqlClient, dialect: SqlDialect, e: UpgradeReleaseEntry, at?: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO upgrade_releases (id, name, version, edition, channel, published_at, expires_at, key_fingerprint, outcome, reject_reason, accepted, manifest_json, checked_at)
     VALUES (${ph(dialect, 1)}, ${ph(dialect, 2)}, ${ph(dialect, 3)}, ${ph(dialect, 4)}, ${ph(dialect, 5)}, ${ph(dialect, 6)}, ${ph(dialect, 7)}, ${ph(dialect, 8)}, ${ph(dialect, 9)}, ${ph(dialect, 10)}, ${ph(dialect, 11)}, ${ph(dialect, 12)}, COALESCE(${ph(dialect, 13)}, ${nowExpr(dialect)}))`,
    [id, e.name ?? null, e.version, e.edition ?? null, e.channel ?? null, e.publishedAt ?? null, e.expiresAt ?? null,
     e.keyFingerprint ?? null, e.outcome, e.rejectReason ?? null, e.accepted ? 1 : 0, e.manifestJson ?? null, at ?? null],
  );
  return id;
}

/**
 * The versions of all ACCEPTED releases — the raw inputs to the anti-rollback floor (the check module
 * takes their semver max). Only accepted (fully-verified) releases count, so a rejected manifest can never
 * influence the floor.
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the accepted version strings.
 */
export async function listAcceptedReleaseVersions(client: SqlClient, dialect: SqlDialect): Promise<string[]> {
  void dialect;
  const { rows } = await client.query(`SELECT version FROM upgrade_releases WHERE accepted = 1`);
  return rows.map((r) => String(r['version']));
}

/**
 * The most recent check (for the admin UI / status).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @returns the newest release row, or null if none.
 */
export async function latestReleaseCheck(client: SqlClient, dialect: SqlDialect): Promise<UpgradeReleaseRow | null> {
  void dialect;
  const { rows } = await client.query(`SELECT * FROM upgrade_releases ORDER BY checked_at DESC, id DESC LIMIT 1`);
  return (rows[0] as unknown as UpgradeReleaseRow) ?? null;
}
