/**
 * @weaveintel/geneweave — Admin Capability Packs routes (Phase 6)
 *
 * Operator CRUD over `capability_packs`, plus install/uninstall actions and
 * a readonly view of the installation ledger. Pack manifests are validated
 * via `@weaveintel/core/capability-packs` before save.
 */

import { newUUIDv7 } from '@weaveintel/core';
import {
  validateManifest,
  installPack,
  uninstallPack,
  type CapabilityPack,
  type PackInstallationLedger,
} from '@weaveintel/core/capability-packs';
import type { DatabaseAdapter, CapabilityPackStatus } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { createGeneweavePackInstallAdapter } from '../../capability-packs/install-adapter.js';

export function registerCapabilityPackRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;
  const delMethod = router.del.bind(router);

  router.get('/api/admin/capability-packs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: { packKey?: string; status?: CapabilityPackStatus; limit?: number; offset?: number } = {};
    const pk = url.searchParams.get('pack_key'); if (pk) opts.packKey = pk;
    const st = url.searchParams.get('status'); if (st) opts.status = st as CapabilityPackStatus;
    const lim = url.searchParams.get('limit'); if (lim) opts.limit = parseInt(lim, 10);
    const off = url.searchParams.get('offset'); if (off) opts.offset = parseInt(off, 10);
    const packs = await db.listCapabilityPacks(opts);
    json(res, 200, { packs });
  }, { auth: true });

  router.get('/api/admin/capability-packs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const pack = await db.getCapabilityPack(params['id']!);
    if (!pack) { json(res, 404, { error: 'Capability pack not found' }); return; }
    json(res, 200, { pack });
  }, { auth: true });

  router.get('/api/admin/capability-packs/:id/export', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const pack = await db.getCapabilityPack(params['id']!);
    if (!pack) { json(res, 404, { error: 'Capability pack not found' }); return; }
    let manifest: unknown;
    try { manifest = JSON.parse(pack.manifest); } catch { json(res, 500, { error: 'Stored manifest is not valid JSON' }); return; }
    json(res, 200, { manifest });
  }, { auth: true });

  router.post('/api/admin/capability-packs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const manifest = body['manifest'] as CapabilityPack | undefined;
    if (!manifest || typeof manifest !== 'object') {
      json(res, 400, { error: 'manifest required (full CapabilityPack JSON)' });
      return;
    }
    const validation = validateManifest(manifest);
    if (!validation.ok) {
      json(res, 400, { error: 'Invalid manifest', issues: validation.issues });
      return;
    }
    const existing = await db.getCapabilityPackByKeyVersion(manifest.key, manifest.version);
    if (existing) {
      json(res, 409, { error: `Pack ${manifest.key}@${manifest.version} already exists` });
      return;
    }
    const id = newUUIDv7();
    await db.createCapabilityPack({
      id,
      pack_key: manifest.key,
      version: manifest.version,
      status: 'draft',
      name: manifest.name,
      description: manifest.description,
      authored_by: manifest.authoredBy ?? null,
      manifest: JSON.stringify(manifest),
      installed_at: null,
      installed_by: null,
    });
    const pack = await db.getCapabilityPack(id);
    json(res, 201, { pack });
  }, { auth: true, csrf: true });

  router.put('/api/admin/capability-packs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCapabilityPack(params['id']!);
    if (!existing) { json(res, 404, { error: 'Capability pack not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['status'] !== undefined) {
      const s = String(body['status']);
      if (s !== 'draft' && s !== 'published' && s !== 'retired') {
        json(res, 400, { error: 'status must be draft|published|retired' });
        return;
      }
      fields['status'] = s;
    }
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['authored_by'] !== undefined) fields['authored_by'] = body['authored_by'];
    if (body['manifest'] !== undefined) {
      const validation = validateManifest(body['manifest'] as CapabilityPack);
      if (!validation.ok) {
        json(res, 400, { error: 'Invalid manifest', issues: validation.issues });
        return;
      }
      fields['manifest'] = JSON.stringify(body['manifest']);
    }
    await db.updateCapabilityPack(params['id']!, fields as never);
    const pack = await db.getCapabilityPack(params['id']!);
    json(res, 200, { pack });
  }, { auth: true, csrf: true });

  delMethod('/api/admin/capability-packs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCapabilityPack(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ─── Install / Uninstall ───────────────────────────────────

  router.post('/api/admin/capability-packs/:id/install', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const pack = await db.getCapabilityPack(params['id']!);
    if (!pack) { json(res, 404, { error: 'Capability pack not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }
    let manifest: CapabilityPack;
    try { manifest = JSON.parse(pack.manifest) as CapabilityPack; }
    catch { json(res, 500, { error: 'Stored manifest is not valid JSON' }); return; }

    const adapter = createGeneweavePackInstallAdapter(db);
    const opts: { skipPreconditions?: boolean; installOrder?: string[] } = {};
    if (body['skip_preconditions'] === true) opts.skipPreconditions = true;
    if (Array.isArray(body['install_order'])) opts.installOrder = body['install_order'] as string[];

    let result: { ledger: PackInstallationLedger; unmetPreconditions: string[] };
    try {
      result = await installPack(manifest, adapter, opts);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (result.unmetPreconditions.length > 0) {
      json(res, 412, { error: 'Unmet preconditions', unmet: result.unmetPreconditions });
      return;
    }
    const installationId = newUUIDv7();
    await db.createCapabilityPackInstallation({
      id: installationId,
      pack_id: pack.id,
      pack_key: pack.pack_key,
      pack_version: pack.version,
      ledger: JSON.stringify(result.ledger),
      installed_by: (auth as { userId?: string } | null)?.userId ?? null,
    });
    await db.updateCapabilityPack(pack.id, {
      installed_at: new Date().toISOString(),
      installed_by: (auth as { userId?: string } | null)?.userId ?? null,
    });
    const installation = await db.getCapabilityPackInstallation(installationId);
    json(res, 201, { installation, ledger: result.ledger });
  }, { auth: true, csrf: true });

  router.post('/api/admin/capability-pack-installations/:id/uninstall', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const installation = await db.getCapabilityPackInstallation(params['id']!);
    if (!installation) { json(res, 404, { error: 'Installation not found' }); return; }
    if (installation.uninstalled_at) {
      json(res, 409, { error: 'Already uninstalled', uninstalled_at: installation.uninstalled_at });
      return;
    }
    let ledger: PackInstallationLedger;
    try { ledger = JSON.parse(installation.ledger) as PackInstallationLedger; }
    catch { json(res, 500, { error: 'Stored ledger is not valid JSON' }); return; }
    const adapter = createGeneweavePackInstallAdapter(db);
    try {
      await uninstallPack(ledger, adapter);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    await db.markCapabilityPackInstallationUninstalled(installation.id);
    const updated = await db.getCapabilityPackInstallation(installation.id);
    json(res, 200, { installation: updated });
  }, { auth: true, csrf: true });

  router.get('/api/admin/capability-pack-installations', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const opts: { packId?: string; activeOnly?: boolean; limit?: number; offset?: number } = {};
    const pid = url.searchParams.get('pack_id'); if (pid) opts.packId = pid;
    const active = url.searchParams.get('active_only'); if (active === 'true') opts.activeOnly = true;
    const lim = url.searchParams.get('limit'); if (lim) opts.limit = parseInt(lim, 10);
    const off = url.searchParams.get('offset'); if (off) opts.offset = parseInt(off, 10);
    const installations = await db.listCapabilityPackInstallations(opts);
    json(res, 200, { installations });
  }, { auth: true });

  router.get('/api/admin/capability-pack-installations/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const installation = await db.getCapabilityPackInstallation(params['id']!);
    if (!installation) { json(res, 404, { error: 'Installation not found' }); return; }
    json(res, 200, { installation });
  }, { auth: true });
}
