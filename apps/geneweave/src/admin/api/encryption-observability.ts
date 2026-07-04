/**
 * @weaveintel/geneweave — Admin Encryption Observability routes (Phase 9).
 *
 * Read-only health dashboard + operator-configurable alert rules.
 *
 *   GET    /api/admin/encryption/health
 *     → Aggregated dashboard payload: per-tenant rotation status, cache hit
 *       summary, KMS health, firing alerts, and metrics summary. Pulled live
 *       from the in-memory metrics emitter + DB rows.
 *
 *   GET    /api/admin/encryption/metrics
 *     → Raw `MetricsSnapshot` (filterable by tenantId + name prefix). Useful
 *       for ad-hoc inspection and the dashboard's drill-down view.
 *
 *   POST   /api/admin/encryption/alerts/evaluate
 *     → Evaluate every enabled rule right now and return firings (does NOT
 *       persist). Used by the dashboard "test" button.
 *
 *   GET    /api/admin/encryption/alerts            (?tenantId=...|fleet)
 *   POST   /api/admin/encryption/alerts            (create or upsert by tenant+kind)
 *   PUT    /api/admin/encryption/alerts/:id        (update by id)
 *   DELETE /api/admin/encryption/alerts/:id
 *
 * The route file is geneweave-specific (it imports our DatabaseAdapter) but
 * the operations all delegate to package-level primitives in
 * `@weaveintel/encryption`. Other host apps can mount equivalent routes by
 * supplying their own adapter + metrics getter.
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import {
  evaluateAlerts,
  type AlertRule,
  type AlertRuleKind,
  type CachedKmsResolver,
  type InMemoryMetricsEmitter,
  type KmsProviderRegistry,
  type MetricsEmitter,
  type MetricsSnapshot,
  type RotationStatus,
} from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../../db.js';
import {
  deleteAlertRule,
  listAlertRules,
  rowToAlertRule,
  upsertAlertRule,
} from '../../encryption/alert-store.js';
import type { RouterLike } from './types.js';

export interface EncryptionObservabilityHelpers {
  json: (res: ServerResponse, status: number, data: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
}

/** Process-wide singletons exposed via getters — keeps live-binding semantics. */
export type GetMetricsEmitter = () => (MetricsEmitter & { snapshot?: InMemoryMetricsEmitter['snapshot'] }) | null;
export type GetKmsRegistry = () => KmsProviderRegistry | null;
export type GetKmsResolver = () => CachedKmsResolver | null;

const VALID_KINDS = new Set<AlertRuleKind>([
  'rotation_overdue',
  'kms_error_rate',
  'aead_error_rate',
  'decrypt_latency_p95',
  'cache_hit_rate',
]);

const ROTATION_CADENCE_DAYS: Record<string, number> = {
  manual: 365,
  monthly: 30,
  quarterly: 90,
  annual: 365,
};

function emptySnapshot(now: number): MetricsSnapshot {
  return { takenAt: now, series: [] };
}

async function buildRotationStatus(db: DatabaseAdapter): Promise<RotationStatus[]> {
  const policies = await db.listTenantEncryptionPolicies();
  const out: RotationStatus[] = [];
  for (const p of policies) {
    if (p.enabled !== 1) continue;
    const cadenceDays = ROTATION_CADENCE_DAYS[p.rotation_schedule] ?? 90;
    let lastRotationAt: number | null = null;
    if (p.active_dek_id) {
      const deks = await db.listTenantDeks?.(p.tenant_id);
      const active = deks?.find((d) => d.id === p.active_dek_id) ?? null;
      lastRotationAt = active?.created_at ?? null;
    }
    out.push({ tenantId: p.tenant_id, lastRotationAt, cadenceDays });
  }
  return out;
}

export function registerEncryptionObservabilityRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: EncryptionObservabilityHelpers,
  getMetrics: GetMetricsEmitter,
  getKmsRegistry: GetKmsRegistry,
  getKmsResolver: GetKmsResolver,
): void {
  const { json, readBody } = helpers;
  const delMethod = router.del.bind(router);

  function snapshotNow(): MetricsSnapshot {
    const m = getMetrics();
    if (m && typeof m.snapshot === 'function') return m.snapshot();
    return emptySnapshot(Date.now());
  }

  // ── Aggregated dashboard ───────────────────────────────

  router.get('/api/admin/encryption/health', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const snap = snapshotNow();
    const rotation = await buildRotationStatus(db);
    const fleetRules = await listAlertRules(db, { tenantId: null });
    const tenantRuleRows = await db.listEncryptionAlertConfig();
    const tenantRules = tenantRuleRows
      .filter((r) => r.tenant_id !== null)
      .map(rowToAlertRule);
    const allRules: AlertRule[] = [...fleetRules, ...tenantRules];
    const firings = evaluateAlerts({ rules: allRules, snapshot: snap, rotationStatus: rotation });

    // Cache hit-rate roll-ups by cache layer, fleet-wide.
    const cacheLayers: Record<string, { hits: number; misses: number }> = {};
    for (const s of snap.series) {
      const layer = (s.labels.cache as string) ?? 'unknown';
      cacheLayers[layer] ??= { hits: 0, misses: 0 };
      if (s.name === 'encryption.cache.hit') cacheLayers[layer].hits += s.counter?.count ?? 0;
      if (s.name === 'encryption.cache.miss') cacheLayers[layer].misses += s.counter?.count ?? 0;
    }
    const cacheHitRates = Object.fromEntries(
      Object.entries(cacheLayers).map(([k, v]) => {
        const total = v.hits + v.misses;
        return [k, { hits: v.hits, misses: v.misses, hit_rate: total ? Number((v.hits / total).toFixed(4)) : null }];
      }),
    );

    // Aggregate latency p95 per metric name (across all tenants).
    const latencySummary: Record<string, { p50: number; p95: number; p99: number; count: number }> = {};
    for (const s of snap.series) {
      if (s.kind !== 'histogram' || !s.histogram) continue;
      latencySummary[s.name] ??= { p50: 0, p95: 0, p99: 0, count: 0 };
      const acc = latencySummary[s.name]!;
      if (s.histogram.p50 > acc.p50) acc.p50 = s.histogram.p50;
      if (s.histogram.p95 > acc.p95) acc.p95 = s.histogram.p95;
      if (s.histogram.p99 > acc.p99) acc.p99 = s.histogram.p99;
      acc.count += s.histogram.count;
    }

    // KMS error counts (last 5 min).
    const now = Date.now();
    let kmsErrors5m = 0;
    let aeadErrors5m = 0;
    for (const s of snap.series) {
      if (s.kind !== 'counter' || !s.counter) continue;
      if (now - s.lastAt > 5 * 60_000) continue;
      if (s.name === 'encryption.kms.error') kmsErrors5m += s.counter.count;
      if (s.name === 'encryption.aead.error') aeadErrors5m += s.counter.count;
    }

    json(res, 200, {
      generated_at: snap.takenAt,
      tenants: rotation.map((r) => ({
        tenant_id: r.tenantId,
        last_rotation_at: r.lastRotationAt,
        cadence_days: r.cadenceDays,
        age_days: r.lastRotationAt === null ? null : Number(((now - r.lastRotationAt) / 86_400_000).toFixed(2)),
      })),
      cache_hit_rates: cacheHitRates,
      latency_summary: latencySummary,
      counters_5m: { kms_errors: kmsErrors5m, aead_errors: aeadErrors5m },
      alert_rules: { fleet: fleetRules.length, per_tenant: tenantRules.length, enabled: allRules.filter((r) => r.enabled).length },
      firing_alerts: firings,
      metrics_emitter: getMetrics() ? (typeof getMetrics()!.snapshot === 'function' ? 'in-memory' : 'custom') : 'none',
      registered_kms_providers: getKmsRegistry()?.list() ?? [],
    });
  }, { auth: true });

  // ── Raw snapshot ───────────────────────────────────────

  router.get('/api/admin/encryption/metrics', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const tenantId = url.searchParams.get('tenantId');
    const namePrefix = url.searchParams.get('name');
    const snap = snapshotNow();
    const filtered = snap.series.filter((s) => {
      if (tenantId && s.labels.tenantId !== tenantId) return false;
      if (namePrefix && !s.name.startsWith(namePrefix)) return false;
      return true;
    });
    json(res, 200, { ...snap, series: filtered, total_series: snap.series.length });
  }, { auth: true });

  // ── Alert rule CRUD ────────────────────────────────────

  router.get('/api/admin/encryption/alerts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const scope = url.searchParams.get('tenantId');
    let rules: AlertRule[];
    if (scope === null) {
      rules = (await db.listEncryptionAlertConfig()).map(rowToAlertRule);
    } else if (scope === 'fleet' || scope === '') {
      rules = await listAlertRules(db, { tenantId: null });
    } else {
      rules = await listAlertRules(db, { tenantId: scope });
    }
    json(res, 200, { rules });
  }, { auth: true });

  router.post('/api/admin/encryption/alerts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const kind = body['kind'];
    if (typeof kind !== 'string' || !VALID_KINDS.has(kind as AlertRuleKind)) {
      json(res, 400, { error: `kind must be one of ${[...VALID_KINDS].join(', ')}` }); return;
    }
    const threshold = body['threshold'];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      json(res, 400, { error: 'threshold (number) required' }); return;
    }
    const tenantIdRaw = body['tenant_id'] ?? body['tenantId'];
    const tenantId: string | null = typeof tenantIdRaw === 'string' && tenantIdRaw.trim() ? tenantIdRaw.trim() : null;
    const windowMsRaw = body['window_ms'] ?? body['windowMs'];
    const windowMs = typeof windowMsRaw === 'number' && windowMsRaw > 0 ? windowMsRaw : null;
    const enabled = body['enabled'] === undefined ? true : Boolean(body['enabled']);
    const description = typeof body['description'] === 'string' ? (body['description'] as string) : null;
    try {
      const rule = await upsertAlertRule(db, {
        tenantId,
        kind: kind as AlertRuleKind,
        threshold,
        windowMs,
        enabled,
        description,
      });
      json(res, 201, { rule });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  router.put('/api/admin/encryption/alerts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const rows = await db.listEncryptionAlertConfig();
    const existing = rows.find((r) => r.id === id);
    if (!existing) { json(res, 404, { error: 'Alert rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const next = {
      id,
      tenantId: existing.tenant_id,
      kind: existing.kind as AlertRuleKind,
      threshold: typeof body['threshold'] === 'number' ? (body['threshold'] as number) : existing.threshold,
      windowMs: 'window_ms' in body
        ? (typeof body['window_ms'] === 'number' ? (body['window_ms'] as number) : null)
        : existing.window_ms,
      enabled: body['enabled'] === undefined ? existing.enabled === 1 : Boolean(body['enabled']),
      description: 'description' in body ? (body['description'] as string | null) : existing.description,
    };
    try {
      const rule = await upsertAlertRule(db, next);
      json(res, 200, { rule });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }, { auth: true, csrf: true });

  delMethod('/api/admin/encryption/alerts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const ok = await deleteAlertRule(db, id);
    if (!ok) { json(res, 404, { error: 'Alert rule not found' }); return; }
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  router.post('/api/admin/encryption/alerts/evaluate', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const snap = snapshotNow();
    const rotation = await buildRotationStatus(db);
    const allRows = await db.listEncryptionAlertConfig();
    const rules = allRows.map(rowToAlertRule);
    const firings = evaluateAlerts({ rules, snapshot: snap, rotationStatus: rotation });
    json(res, 200, { firings, evaluated_rules: rules.length, snapshot_series: snap.series.length });
  }, { auth: true, csrf: true });

  // KMS resolver getter is intentionally unused here today but exposed in the
  // signature so we can add a "warm cache" or "invalidate" admin op later
  // without rewriting the wiring at the server.ts call site.
  void getKmsResolver;
}
