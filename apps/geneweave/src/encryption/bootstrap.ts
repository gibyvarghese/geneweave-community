/**
 * GeneWeave: encryption bootstrap. Constructs a TenantKeyManager wired to
 * the SQLite-backed EncryptionStore, audit emitter, and a Phase-7 cached
 * per-tenant KMS resolver backed by a built-in provider registry.
 *
 * Per-tenant provider selection is fully data-driven: `tenant_encryption_policy`
 * stores `kms_provider_id` + `kms_config` and the resolver constructs the
 * correct provider on demand. The local default (env-loaded master key) is
 * still used for new tenants that have no policy yet.
 *
 * Returns `null` when no local master key is available AND no `defaultProviderId`
 * override is provided — keeps geneweave bootable for environments that have
 * not opted into tenant encryption.
 */

import {
  createBuiltinKmsRegistry,
  createCachedKmsResolver,
  InMemoryMetricsEmitter,
  loadMasterKeyFromEnv,
  weaveTenantKeyManager,
  type CachedKmsResolver,
  type KmsProviderRegistry,
  type MetricsEmitter,
  type TenantKeyManager,
} from '@weaveintel/encryption';
import { LocalKmsProvider } from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../db-types.js';
import { createDbEncryptionStore } from './db-encryption-store.js';
import { createDbEncryptionAuditEmitter } from './db-audit-emitter.js';

export interface BootstrapEncryptionOptions {
  /** When true and master-key env var is missing, generate a random key (DEV ONLY). */
  readonly devGenerateIfMissing?: boolean;
  /** Override env var name. Default: 'WEAVE_ENCRYPTION_MASTER_KEY'. */
  readonly envVar?: string;
  /**
   * Default KMS provider id used for tenants that have no policy row yet.
   * Defaults to `'local'`. Overriding only makes sense if you've also
   * registered an alternative default config below.
   */
  readonly defaultProviderId?: string;
  /** Default provider config (used only when `defaultProviderId` differs from `local`). */
  readonly defaultProviderConfig?: Record<string, unknown>;
  /**
   * Hook to register additional custom providers on the registry built here.
   * Runs after the built-ins are registered. Useful for HSM/PKCS#11 integrations
   * or in-house KMS APIs.
   */
  readonly registerExtra?: (registry: KmsProviderRegistry) => void;
  /**
   * Phase 9 — optional metrics emitter. When omitted, an `InMemoryMetricsEmitter`
   * is constructed so the admin "Encryption Health" dashboard has data without
   * any extra wiring. Pass a custom emitter (e.g. one that fans out to Prometheus
   * or OpenTelemetry) for production deployments.
   */
  readonly metrics?: MetricsEmitter & { snapshot?: (now?: number) => unknown };
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface BootstrapEncryptionResult {
  readonly manager: TenantKeyManager;
  readonly registry: KmsProviderRegistry;
  readonly resolver: CachedKmsResolver;
  /**
   * The metrics emitter wired into the manager + resolver. When the caller
   * did not supply one, this is the default `InMemoryMetricsEmitter` so the
   * admin dashboard can render histograms/counters out of the box.
   */
  readonly metrics: MetricsEmitter & { snapshot?: (now?: number) => unknown };
  /** `'env' | 'dev-generated' | 'no-default'` — `no-default` means the local fallback is unavailable but cloud-only tenants can still operate. */
  readonly source: 'env' | 'dev-generated' | 'no-default';
}

export function bootstrapEncryption(
  db: DatabaseAdapter,
  opts: BootstrapEncryptionOptions = {},
): BootstrapEncryptionResult | null {
  const log = opts.log ?? ((msg, meta) => console.log(`[encryption] ${msg}`, meta ?? {}));
  const registry = createBuiltinKmsRegistry();
  if (opts.registerExtra) opts.registerExtra(registry);

  // Try to load a local master key for the default fallback. If it's missing
  // we can still operate IFF every tenant has an explicit cloud policy.
  let defaultKms: LocalKmsProvider | null = null;
  let source: BootstrapEncryptionResult['source'] = 'no-default';
  try {
    const loaded = loadMasterKeyFromEnv({
      ...(opts.envVar !== undefined ? { envVar: opts.envVar } : {}),
      ...(opts.devGenerateIfMissing !== undefined
        ? { devGenerateIfMissing: opts.devGenerateIfMissing }
        : {}),
    });
    defaultKms = new LocalKmsProvider({ masterKey: loaded.key });
    source = loaded.source;
  } catch (err) {
    log('local master key unavailable — cloud-only tenants required', {
      err: (err as Error).message,
    });
  }

  const store = createDbEncryptionStore(db);
  const audit = createDbEncryptionAuditEmitter(db);
  const metrics = opts.metrics ?? new InMemoryMetricsEmitter();
  const resolver = createCachedKmsResolver({
    registry,
    store,
    defaultProviderId: opts.defaultProviderId ?? 'local',
    ...(opts.defaultProviderConfig ? { defaultConfig: opts.defaultProviderConfig } : {}),
    metrics,
  });

  // Without a default KMS provider AND without any tenant policies, we can't
  // boot encryption — return null so the server starts without it.
  if (!defaultKms && (opts.defaultProviderId ?? 'local') === 'local') {
    log('encryption disabled at boot (no local master key and no cloud default configured)');
    return null;
  }

  const manager = weaveTenantKeyManager({
    store,
    ...(defaultKms ? { kms: defaultKms } : {}),
    kmsResolver: resolver.resolve,
    audit,
    metrics,
  });
  log(
    `encryption bootstrapped (source: ${source}, providers: [${registry.list().join(', ')}], metrics: ${opts.metrics ? 'custom' : 'in-memory'})`,
  );
  return { manager, registry, resolver, metrics, source };
}
