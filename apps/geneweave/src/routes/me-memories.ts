/**
 * /api/me/memories — user-authored long-term memory (W9b Gap 1)
 *
 *   GET    /api/me/memories            list the caller's memories grouped by kind
 *   POST   /api/me/memories            create a user-authored memory
 *   PATCH  /api/me/memories/:id        correct a memory (preserves lineage)
 *   DELETE /api/me/memories/:id        delete a single memory
 *   DELETE /api/me/memories            clear ALL of the caller's memories (confirm:true)
 *
 * Storage reuses the existing semantic_memory + entity_memory tables (no new
 * table). Three list kinds:
 *   - semantic        semantic_memory rows where source != 'user' (assistant-derived)
 *   - entity          entity_memory rows
 *   - user-authored   semantic_memory rows where source = 'user'
 *
 * Corrections route through @weaveintel/memory applyCorrection so the original
 * is marked _supersededBy and a new corrected entry is written — never a blind
 * overwrite. Clear-all routes through forgetUser.
 *
 * Governance: a tenant may mark user memory read-only (org-managed). The
 * injectable MemoryGovernanceGate is consulted before every mutation; a denied
 * or erroring gate fails closed to HTTP 403 { managedByOrg: true }. Reads are
 * never gated. Cross-principal ids return 404 (never 403 — do not leak existence).
 *
 * Vocabulary: no "chat", "conversation", "message" (HTTP sense), "turn".
 */

import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type { ExecutionContext, MemoryEntry, MemoryStore, MemoryQuery, MemoryFilter, MemoryType } from '@weaveintel/core';
import { applyCorrection, forgetUser, getProvenance, weaveGovernancePolicy } from '@weaveintel/memory';
import type { GovernanceRule } from '@weaveintel/memory';
import type { DurableConsentManager } from '@weaveintel/guardrails/compliance';
import type { ServerResponse } from 'node:http';
import type { Router } from '../server-core.js';
import { readBody } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';
import type { SemanticMemoryRow } from '../db-types/memory.js';
import type { MemoryGovernanceRow } from '../db-types/admin.js';

const MAX_CONTENT = 2000;
const MIN_CONTENT = 1;

// ─── Governance gate ────────────────────────────────────────────────────────

/**
 * Decides whether the caller may mutate their own memory. Returning `false`
 * (or throwing) means the tenant has marked user memory read-only / org-managed
 * and the mutating route must fail closed to 403.
 */
export interface MemoryGovernanceGate {
  /** true ⇒ mutation allowed; false ⇒ read-only. Throwing is treated as false. */
  canMutate(ctx: ExecutionContext): Promise<boolean>;
}

// Probe content used to ask the governance policy whether benign user memory
// may be stored. A tenant configures "read-only" by installing a block-all
// (".*") governance rule scoped to its tenant.
const GOVERNANCE_PROBE = 'user-authored memory note';

/**
 * Build a DB-driven governance gate from the memory_governance rows. The gate
 * constructs a @weaveintel/memory policy from the tenant-applicable rules and
 * probes it; if a benign user-authored note would be blocked, the principal's
 * memory is treated as read-only. Never throws — any failure resolves to a
 * read-only (fail-closed) decision so the route returns 403, not 500.
 */
export function createDbMemoryGovernanceGate(db: DatabaseAdapter): MemoryGovernanceGate {
  return {
    async canMutate(ctx: ExecutionContext): Promise<boolean> {
      const rows = await db.listMemoryGovernance();
      const tenantId = ctx.tenantId ?? null;
      const applicable = rows.filter((r: MemoryGovernanceRow) =>
        r.enabled === 1 &&
        (r.tenant_id === null || r.tenant_id === tenantId) &&
        appliesToUserMemory(r.memory_types),
      );
      const rules: GovernanceRule[] = applicable.map((r) => toGovernanceRule(r));
      const policy = weaveGovernancePolicy(rules);
      const probe: MemoryEntry = {
        id: 'governance-probe',
        type: 'semantic',
        content: GOVERNANCE_PROBE,
        metadata: { source: 'user' },
        createdAt: new Date().toISOString(),
        ...(tenantId ? { tenantId } : {}),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
      };
      return policy.shouldStore(ctx, probe);
    },
  };
}

function appliesToUserMemory(memoryTypes: string | null): boolean {
  if (!memoryTypes) return true; // unscoped rule applies to all kinds
  try {
    const parsed = JSON.parse(memoryTypes) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return true;
      return parsed.some((t) => t === 'semantic' || t === 'user_fact' || t === 'entity');
    }
  } catch { /* treat malformed scope as global */ }
  return true;
}

function toGovernanceRule(r: MemoryGovernanceRow): GovernanceRule {
  const block = parseStringArray(r.block_patterns);
  const redact = parseStringArray(r.redact_patterns);
  return {
    id: r.id,
    name: r.name,
    enabled: true,
    ...(r.tenant_id ? { tenantId: r.tenant_id } : {}),
    ...(block.length > 0 ? { blockPatterns: block } : {}),
    ...(redact.length > 0 ? { redactPatterns: redact } : {}),
    ...(r.max_age ? { maxAge: r.max_age } : {}),
    ...(r.max_entries !== null && r.max_entries !== undefined ? { maxEntries: r.max_entries } : {}),
  };
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

// ─── MemoryStore over semantic_memory ────────────────────────────────────────

/**
 * A MemoryStore backed by the semantic_memory table, scoped to one principal.
 * Used by applyCorrection (write) and forgetUser (clear). Writes upsert by id
 * so a correction can mark the superseded original in place and insert the new
 * corrected entry in a single round-trip.
 */
export function createSemanticMemoryStore(db: DatabaseAdapter, userId: string, tenantId: string | null): MemoryStore {
  return {
    async write(_ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void> {
      for (const e of entries) {
        await db.saveSemanticMemory({
          id: e.id,
          userId,
          ...(tenantId ? { tenantId } : {}),
          content: e.content,
          memoryType: mapTypeToColumn(e.type),
          source: typeof e.metadata?.['source'] === 'string' ? e.metadata['source'] as string : 'user',
          metadata: JSON.stringify(e.metadata ?? {}),
        });
      }
    },
    async query(_ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      const rows = await db.listSemanticMemory(userId, options.topK ?? 100);
      return rows.map((r) => rowToEntry(r));
    },
    async delete(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      for (const id of ids) await db.deleteSemanticMemory(id, userId);
    },
    async clear(_ctx: ExecutionContext, _filter?: MemoryFilter): Promise<void> {
      await db.clearUserSemanticMemory(userId);
      await db.clearUserEntityMemory(userId);
    },
  };
}

function mapTypeToColumn(_type: MemoryType): string {
  return 'user_fact';
}

function rowToEntry(r: SemanticMemoryRow): MemoryEntry {
  let metadata: Record<string, unknown> = {};
  if (r.metadata) {
    try { metadata = JSON.parse(r.metadata) as Record<string, unknown>; } catch { /* ignore */ }
  }
  if (!('source' in metadata)) metadata['source'] = r.source;
  return {
    id: r.id,
    type: 'semantic',
    content: r.content,
    metadata,
    createdAt: r.created_at,
    ...(r.tenant_id ? { tenantId: r.tenant_id } : {}),
    userId: r.user_id,
  };
}

// ─── Provenance shaping ───────────────────────────────────────────────────────

interface MemoryItemView {
  id: string;
  content: string;
  kind: 'semantic' | 'entity' | 'user-authored';
  createdAt: string;
  provenance: {
    source: string;
    confidence?: number;
    extractedBy?: string;
    verifiedBy?: string;
    sourceRunId?: string;
    sourceRef?: string;
  };
}

function semanticRowToView(r: SemanticMemoryRow): MemoryItemView {
  let metadata: Record<string, unknown> = {};
  if (r.metadata) {
    try { metadata = JSON.parse(r.metadata) as Record<string, unknown>; } catch { /* ignore */ }
  }
  const prov = getProvenance(r.id);
  const provenance: MemoryItemView['provenance'] = {
    source: prov?.source ?? r.source,
    ...(prov?.confidence !== undefined ? { confidence: prov.confidence } : {}),
    ...(prov?.extractedBy ? { extractedBy: prov.extractedBy } : {}),
    ...(prov?.verifiedBy ? { verifiedBy: prov.verifiedBy } : {}),
    ...(typeof metadata['sourceRunId'] === 'string' ? { sourceRunId: metadata['sourceRunId'] as string } : {}),
    ...(typeof metadata['sourceRef'] === 'string' ? { sourceRef: metadata['sourceRef'] as string } : {}),
  };
  return {
    id: r.id,
    content: r.content,
    kind: r.source === 'user' ? 'user-authored' : 'semantic',
    createdAt: r.created_at,
    provenance,
  };
}

function isSuperseded(r: SemanticMemoryRow): boolean {
  if (!r.metadata) return false;
  try {
    const m = JSON.parse(r.metadata) as Record<string, unknown>;
    return typeof m['_supersededBy'] === 'string';
  } catch { return false; }
}

// ─── Consent helper ──────────────────────────────────────────────────────────

/**
 * M5-3: Check personalization consent before a user-authored memory write.
 *
 * Semantics: permit-if-no-record.
 *   - No consent flag for this user → allow (preserves behavior for users who
 *     have never interacted with a consent UI; consent is managed going forward).
 *   - Consent flag present and isGranted() = true → allow.
 *   - Consent flag present but isGranted() = false (expired) → deny (returns false).
 *
 * This ensures the call is live on every write path (satisfies the audit
 * finding M5-3: "isGranted() never called") while not silently dropping
 * memory for existing users who have no consent record.
 */
async function checkPersonalizationConsent(
  consentManager: DurableConsentManager | null | undefined,
  userId: string,
): Promise<boolean> {
  if (!consentManager) return true; // no consent manager wired → allow
  try {
    const flags = await consentManager.listBySubject(userId);
    const flag = flags.find(f => f.purpose === 'personalization');
    if (!flag) return true; // permit-if-no-record
    return consentManager.isGranted(userId, 'personalization');
  } catch {
    return true; // fail-open on transient KV error
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export function registerMeMemoryRoutes(
  router: Router,
  db: DatabaseAdapter,
  opts: { governance?: MemoryGovernanceGate; consentManager?: DurableConsentManager } = {},
): void {
  const governance = opts.governance ?? createDbMemoryGovernanceGate(db);
  const consentManager = opts.consentManager ?? null;

  /** Returns true if the route may proceed; otherwise writes a 403 and returns false. */
  async function ensureMutable(ctx: ExecutionContext, res: ServerResponse): Promise<boolean> {
    let allowed: boolean;
    try {
      allowed = await governance.canMutate(ctx);
    } catch {
      allowed = false; // fail closed
    }
    if (!allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User memory is managed by your organization and is read-only.', managedByOrg: true }));
      return false;
    }
    return true;
  }

  /** Returns true if personalization consent is active (or absent — permit-if-no-record). */
  async function ensurePersonalizationConsent(userId: string, res: ServerResponse): Promise<boolean> {
    const granted = await checkPersonalizationConsent(consentManager, userId);
    if (!granted) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Personalization consent is required to write memories. Please update your consent settings.', consentRequired: 'personalization' }));
      return false;
    }
    return true;
  }

  // ── GET list (grouped by kind) ────────────────────────────────────────────
  router.get('/api/me/memories', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const semanticRows = await db.listSemanticMemory(auth.userId, 500);
    const entityRows = await db.listEntities(auth.userId);

    const semantic: MemoryItemView[] = [];
    const userAuthored: MemoryItemView[] = [];
    for (const r of semanticRows) {
      if (isSuperseded(r)) continue; // hide superseded originals from the active list
      const view = semanticRowToView(r);
      (view.kind === 'user-authored' ? userAuthored : semantic).push(view);
    }

    const entity: MemoryItemView[] = entityRows.map((e) => {
      let facts: Record<string, unknown> = {};
      try { facts = JSON.parse(e.facts) as Record<string, unknown>; } catch { /* ignore */ }
      const factSummary = Object.entries(facts).map(([k, v]) => `${k}: ${String(v)}`).join('; ');
      return {
        id: e.id,
        content: factSummary ? `${e.entity_name} — ${factSummary}` : e.entity_name,
        kind: 'entity' as const,
        createdAt: e.created_at,
        provenance: { source: e.source, confidence: e.confidence },
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      memories: { semantic, entity, 'user-authored': userAuthored },
      counts: { semantic: semantic.length, entity: entity.length, 'user-authored': userAuthored.length },
    }));
  }, { auth: true });

  // ── POST create user-authored ─────────────────────────────────────────────
  router.post('/api/me/memories', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const ctx = weaveContext({ userId: auth.userId, ...(auth.tenantId ? { tenantId: auth.tenantId } : {}) });
    if (!(await ensureMutable(ctx, res))) return;
    if (!(await ensurePersonalizationConsent(auth.userId, res))) return;

    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const content = typeof body['content'] === 'string' ? body['content'].trim() : '';
    if (content.length < MIN_CONTENT || content.length > MAX_CONTENT) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `content must be between ${MIN_CONTENT} and ${MAX_CONTENT} characters` }));
      return;
    }
    const kind = typeof body['kind'] === 'string' ? body['kind'] : 'user_fact';
    const id = newUUIDv7();
    await db.saveSemanticMemory({
      id,
      userId: auth.userId,
      ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
      content,
      memoryType: kind,
      source: 'user',
      metadata: JSON.stringify({ source: 'user', authoredBy: auth.userId }),
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, content, kind: 'user-authored', createdAt: new Date().toISOString() }));
  }, { auth: true, csrf: true });

  // ── PATCH correct ──────────────────────────────────────────────────────────
  router.add('PATCH', '/api/me/memories/:id', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const ctx = weaveContext({ userId: auth.userId, ...(auth.tenantId ? { tenantId: auth.tenantId } : {}) });
    if (!(await ensureMutable(ctx, res))) return;
    if (!(await ensurePersonalizationConsent(auth.userId, res))) return;

    const id = params['id']!;
    const existing = await db.getSemanticMemoryById(id, auth.userId);
    if (!existing) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; } // cross-principal ⇒ 404

    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const correctedContent = typeof body['content'] === 'string' ? body['content'].trim() : '';
    if (correctedContent.length < MIN_CONTENT || correctedContent.length > MAX_CONTENT) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `content must be between ${MIN_CONTENT} and ${MAX_CONTENT} characters` }));
      return;
    }
    const reason = typeof body['reason'] === 'string' ? body['reason'] : 'user correction';

    const store = createSemanticMemoryStore(db, auth.userId, auth.tenantId ?? null);
    const original = rowToEntry(existing);
    const corrected = await applyCorrection(store, ctx, original, correctedContent, auth.userId, reason);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: corrected.id,
      content: corrected.content,
      kind: 'user-authored',
      correctedFrom: id,
      createdAt: corrected.createdAt,
    }));
  }, { auth: true, csrf: true });

  // ── DELETE single ────────────────────────────────────────────────────────────
  router.del('/api/me/memories/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const ctx = weaveContext({ userId: auth.userId, ...(auth.tenantId ? { tenantId: auth.tenantId } : {}) });
    if (!(await ensureMutable(ctx, res))) return;

    const id = params['id']!;
    const existing = await db.getSemanticMemoryById(id, auth.userId);
    if (!existing) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; } // cross-principal ⇒ 404
    await db.deleteSemanticMemory(id, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true, csrf: true });

  // ── DELETE all (clear) ───────────────────────────────────────────────────────
  router.del('/api/me/memories', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const ctx = weaveContext({ userId: auth.userId, ...(auth.tenantId ? { tenantId: auth.tenantId } : {}) });
    if (!(await ensureMutable(ctx, res))) return;

    const body = JSON.parse(await readBody(req).catch(() => '{}')) as Record<string, unknown>;
    if (body['confirm'] !== true) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Clearing all memories requires { "confirm": true }' }));
      return;
    }
    const store = createSemanticMemoryStore(db, auth.userId, auth.tenantId ?? null);
    await forgetUser(store, ctx, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: true }));
  }, { auth: true, csrf: true });
}
