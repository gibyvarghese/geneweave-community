// SPDX-License-Identifier: MIT
/**
 * geneWeave Upgrade Engine — signed RESOLUTION BUNDLES (cross-instance propagation of review decisions).
 *
 * A staging instance triages its review queue once; a production instance should not have to repeat the
 * identical decisions. A resolution bundle is the portable, tamper-evident record of "how staging resolved
 * these items": a list of `(family, logicalKey, remoteHash) → resolution` entries, signed with the SAME
 * Ed25519 construction the release manifest uses (canonical JSON + a detached signature over a trusted-key
 * fingerprint — reused from `@weaveintel/upgrade`, so there is NO new crypto here).
 *
 * Import is deliberately conservative and keyed on the FULL triple:
 *   • signature is verified FIRST — a bad/untrusted signature applies nothing;
 *   • an entry only auto-resolves a LOCAL unresolved item whose `(family, logical_key, remote_hash)` matches
 *     exactly — a production item shipped with DIFFERENT content (a different `remote_hash`) is SKIPPED, never
 *     blindly adopted, because the staging decision was about different bytes;
 *   • a P1 item is never auto-resolved (the same hard guardrail the rule engine and bulk resolve enforce);
 *   • applied resolutions are stamped `resolution_source = 'imported'` for audit.
 *
 * The `ix_upgrade_details_propagation` index on `(family, logical_key, remote_hash)` (m163) exists for exactly
 * this lookup. Engine-agnostic over the `SqlClient` / `SqlDialect` seam; all SQL parameterized.
 */
import { type KeyObject } from 'node:crypto';
import {
  signManifest, createEd25519Verifier, type ManifestBody, type ManifestSignature, type SignatureResult, type SignatureVerifier,
} from '@weaveintel/upgrade';
import type { SqlClient, SqlDialect } from '@weaveintel/realm';
import { ph } from './realm-sql.js';
import { parseTrustedKeys } from './upgrade-check.js';
import { resolveReviewItem, actionForResolution } from './upgrade-review.js';

/** One portable resolution decision, keyed on the propagation triple. */
export interface ResolutionBundleEntry {
  readonly family: string;
  readonly logicalKey: string;
  /** The shipped-default content hash the decision was made against — the propagation key's third leg. */
  readonly remoteHash: string;
  /** The persisted resolution string ('kept' | 'adopted' | 'deferred'). */
  readonly resolution: string;
  /** The item's priority band at export time (informational; P1 is never replayed regardless). */
  readonly priority: string;
}

/** The unsigned bundle body (the bytes that get signed). */
export interface ResolutionBundleBody {
  readonly kind: 'geneweave-resolution-bundle';
  readonly version: 1;
  /** The edition the exporting instance runs — import can refuse a cross-edition bundle. */
  readonly edition: string;
  /** An optional human label for the source instance (audit only; not part of the trust decision). */
  readonly sourceInstance?: string | null;
  /** When the bundle was exported (ISO); audit only. */
  readonly exportedAt?: string | null;
  readonly entries: readonly ResolutionBundleEntry[];
}

/** A bundle body plus its detached Ed25519 signature (the same shape a signed manifest carries). */
export interface SignedResolutionBundle extends ResolutionBundleBody {
  readonly signature: ManifestSignature;
}

/**
 * Collect the exportable resolution decisions from the ledger — every RESOLVED detail that carries a
 * `remote_hash` (the propagation key needs it) and whose resolution is a replayable review action
 * (kept/adopted/deferred; a 'merged' resolution isn't portable — the merge is instance-specific).
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param opts.runId optional — restrict to one run's resolutions (else all resolved details).
 * @param opts.edition the exporting instance's edition (stamped on the bundle).
 * @param opts.sourceInstance optional source label; opts.exportedAt optional ISO timestamp.
 * @returns the unsigned bundle body.
 */
export async function collectResolutionBundle(
  client: SqlClient, dialect: SqlDialect,
  opts: { runId?: string; edition?: string; sourceInstance?: string | null; exportedAt?: string | null } = {},
): Promise<ResolutionBundleBody> {
  const where = [`resolution IS NOT NULL`, `remote_hash IS NOT NULL`, `remote_hash <> ''`];
  const params: unknown[] = [];
  if (opts.runId) { params.push(opts.runId); where.push(`run_id = ${ph(dialect, params.length)}`); }
  const { rows } = await client.query(
    `SELECT family, logical_key, remote_hash, resolution, priority FROM upgrade_details WHERE ${where.join(' AND ')} ORDER BY family, logical_key`,
    params,
  );
  const entries: ResolutionBundleEntry[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const resolution = String(r['resolution']);
    // Only export decisions another instance can replay through the review write path.
    if (!actionForResolution(resolution)) continue;
    entries.push({
      family: String(r['family']),
      logicalKey: String(r['logical_key']),
      remoteHash: String(r['remote_hash']),
      resolution,
      priority: String(r['priority']),
    });
  }
  return {
    kind: 'geneweave-resolution-bundle',
    version: 1,
    edition: opts.edition ?? 'community',
    sourceInstance: opts.sourceInstance ?? null,
    exportedAt: opts.exportedAt ?? null,
    entries,
  };
}

/**
 * Sign a bundle body, producing a signed bundle with a detached Ed25519 signature.
 *
 * Reuses `signManifest` from `@weaveintel/upgrade`: it canonicalizes the body (RFC-8785-style, keys sorted,
 * no whitespace) and appends `{ alg, keyFingerprint, value }`. It is typed to a manifest body but operates on
 * any JSON object, so we pass the bundle body through with a cast — SAME canonical bytes, SAME fingerprint
 * trust model, zero new crypto.
 * @param body the unsigned bundle body.
 * @param signingKey the Ed25519 private key (a KeyObject or PEM string).
 * @returns the signed bundle.
 */
export function signResolutionBundle(body: ResolutionBundleBody, signingKey: KeyObject | string): SignedResolutionBundle {
  const signed = signManifest(body as unknown as ManifestBody, signingKey);
  return signed as unknown as SignedResolutionBundle;
}

/**
 * Verify a signed bundle's signature (over the body with the signature field removed).
 * @param bundle the signed bundle.
 * @param verifier the trust policy (an Ed25519 verifier over the trusted bundle-signing public keys).
 * @returns the signature result ({ ok } or { ok:false, reason }).
 */
export function verifyResolutionBundle(bundle: SignedResolutionBundle, verifier: SignatureVerifier): SignatureResult {
  const { signature, ...body } = bundle;
  return verifier.verify(body as unknown as ManifestBody, signature);
}

/** The outcome of importing a bundle. `signatureOk:false` means nothing was applied. */
export interface ImportBundleResult {
  readonly signatureOk: boolean;
  /** Set when the whole bundle was rejected before applying anything (bad signature / edition mismatch). */
  readonly rejected?: 'untrusted_key' | 'bad_signature' | 'edition_mismatch';
  /** Entries that resolved a matching local item. */
  readonly applied: number;
  /** Entries whose family+logicalKey exists locally but with a DIFFERENT remote_hash → skipped (safe). */
  readonly skippedHash: number;
  /** Entries that matched a P1 item → refused (never auto-resolve P1). */
  readonly skippedP1: number;
  /** Entries with no corresponding local item at all. */
  readonly unmatched: number;
  /** Entries whose replay failed (e.g. adopt with no upstream, or a non-replayable resolution). */
  readonly failed: number;
}

/** A local unresolved detail row (the columns import needs). */
interface LocalDetail { id: string; priority: string; remote_hash: string | null; }

/**
 * Import a signed resolution bundle: verify, then replay each matching decision onto the local queue.
 *
 * @param client the SqlClient.
 * @param dialect 'sqlite' | 'postgres'.
 * @param bundle the signed bundle.
 * @param verifier the trust policy (trusted bundle-signing public keys).
 * @param opts.resolvedBy audit actor (defaults to 'imported').
 * @param opts.edition the LOCAL edition — an entry-edition mismatch rejects the whole bundle when provided.
 * @returns an {@link ImportBundleResult}. Side effects: resolves matching non-P1 items with
 *          `resolution_source = 'imported'`. No writes at all when the signature fails.
 */
export async function importResolutionBundle(
  client: SqlClient, dialect: SqlDialect, bundle: SignedResolutionBundle, verifier: SignatureVerifier,
  opts: { resolvedBy?: string | null; edition?: string } = {},
): Promise<ImportBundleResult> {
  const empty = { applied: 0, skippedHash: 0, skippedP1: 0, unmatched: 0, failed: 0 };
  // 1. Signature FIRST — a failed check applies nothing.
  const sig = verifyResolutionBundle(bundle, verifier);
  if (!sig.ok) return { signatureOk: false, rejected: sig.reason ?? 'bad_signature', ...empty };
  // 2. Edition guard (when the caller supplies the local edition) — never cross editions.
  if (opts.edition && bundle.edition && bundle.edition !== opts.edition) {
    return { signatureOk: true, rejected: 'edition_mismatch', ...empty };
  }

  const resolvedBy = opts.resolvedBy ?? 'imported';
  let applied = 0, skippedHash = 0, skippedResolved = 0, skippedP1 = 0, unmatched = 0, failed = 0;

  for (const entry of bundle.entries) {
    const action = actionForResolution(entry.resolution);
    if (!action) { failed++; continue; } // not a replayable review action

    // Exact-triple match on an UNRESOLVED item (uses ix_upgrade_details_propagation).
    const exact = await client.query(
      `SELECT id, priority, remote_hash FROM upgrade_details
       WHERE family = ${ph(dialect, 1)} AND logical_key = ${ph(dialect, 2)} AND remote_hash = ${ph(dialect, 3)} AND resolution IS NULL
       ORDER BY created_at ASC LIMIT 1`,
      [entry.family, entry.logicalKey, entry.remoteHash],
    );
    const hit = (exact.rows[0] as LocalDetail | undefined);
    if (!hit) {
      // No exact match. Distinguish "different shipped content locally" (skip on hash) from "no such item".
      const other = await client.query(
        `SELECT id FROM upgrade_details WHERE family = ${ph(dialect, 1)} AND logical_key = ${ph(dialect, 2)} AND resolution IS NULL LIMIT 1`,
        [entry.family, entry.logicalKey],
      );
      if (other.rows[0]) skippedHash++; else unmatched++;
      continue;
    }
    if (hit.priority === 'P1') { skippedP1++; continue; } // never auto-resolve P1

    const res = await resolveReviewItem(client, dialect, hit.id, action, { resolvedBy, resolutionSource: 'imported' });
    if (res.ok) applied++; else failed++;
  }
  return { signatureOk: true, applied, skippedHash, skippedP1, unmatched, failed };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Environment config — signing key (export) + trusted keys (import), mirroring the manifest `check` wiring.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Ed25519 private key used to SIGN exported bundles, from the environment. Mirrors
 * `buildUpgradeTokenProvider`: prefers a vault credential id (`GENEWEAVE_UPGRADE_SIGNING_KEY_CREDENTIAL_ID`,
 * decrypted per-call via the injected `readVaultToken` — never logged, never retained), and falls back to a
 * plaintext PEM env var (`GENEWEAVE_UPGRADE_SIGNING_KEY`). Returns null when no signing key is configured
 * (export is then disabled — a bundle is only trustworthy if signed).
 * @param readVaultToken optional vault reader (credentialId → PEM), backed by getToolCredential+decryptCredential.
 * @returns the private-key PEM string, or null.
 */
export async function buildBundleSignerFromEnv(readVaultToken?: (credentialId: string) => Promise<string | null>): Promise<string | null> {
  const credId = process.env['GENEWEAVE_UPGRADE_SIGNING_KEY_CREDENTIAL_ID'];
  if (credId && readVaultToken) {
    const pem = await readVaultToken(credId);
    if (pem) return pem;
  }
  return process.env['GENEWEAVE_UPGRADE_SIGNING_KEY'] ?? null;
}

/**
 * The verifier trusting the public keys that may sign an IMPORTED bundle, from
 * `GENEWEAVE_UPGRADE_BUNDLE_TRUSTED_KEYS` (a PEM bundle of one-or-more SPKI public keys — the same format the
 * manifest `check` uses for release keys, split by `parseTrustedKeys`). Returns null when none are configured
 * (import is then disabled — an unsigned/untrusted bundle must never mutate the queue).
 * @returns a verifier, or null.
 */
export function buildBundleVerifierFromEnv(): SignatureVerifier | null {
  const pem = process.env['GENEWEAVE_UPGRADE_BUNDLE_TRUSTED_KEYS'];
  if (!pem) return null;
  const keys = parseTrustedKeys(pem);
  if (keys.length === 0) return null;
  return createEd25519Verifier(keys);
}

/** The edition this instance runs (stamped on exports, checked on imports). Defaults to 'community'. */
export const bundleEditionFromEnv = (): string => process.env['GENEWEAVE_EDITION'] ?? 'community';
