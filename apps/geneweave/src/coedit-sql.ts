/**
 * geneWeave CRDT co-editing repository (Collaboration Phase 7) — the TRUSTED
 * RELAY around `@weaveintel/collab`.
 *
 * The server holds the canonical replica of each shared document. A client never
 * edits the database directly: it submits ops, which this repository VALIDATES
 * (anti-forgery + size/flood caps), applies to a server-side `RgaDoc` loaded from
 * the persisted snapshot, persists the new snapshot + appends to the op log, and
 * hands back the ops to broadcast. Because the agent is just another peer with
 * its own site id, the same path streams the agent's output into the doc.
 *
 * Why server-authoritative: CRDTs converge but are NOT Byzantine-tolerant (a
 * malicious peer could forge ids or flood) — so the server is the single point
 * that checks every edit before it becomes part of the shared truth (mid-2026
 * research: Kleppmann BFT-CRDT).
 */
import {
  RgaDoc,
  createAgentPeer,
  fromRgaDoc,
  agentSiteId,
  validateClientOps,
  opIdOf,
  type RgaOp,
  type RgaSnapshot,
  type StateVector,
} from '@weaveintel/collab';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from './db-types.js';
import type { CoeditDocRow, CoeditOpRow } from './db-types/adapter-me.js';

const SERVER_SITE = 'server'; // the site id the server replica loads snapshots under

type CoeditDb = Pick<DatabaseAdapter,
  'createCoeditDoc' | 'getCoeditDoc' | 'getCoeditDocByRun' | 'updateCoeditDoc' | 'appendCoeditOp' | 'listCoeditOps'>;

/** The site id a given user edits as in a co-edit doc (derived server-side, anti-forgery). */
export function userSiteId(userId: string): string {
  return `u:${userId}`;
}

export interface CoeditView {
  docId: string;
  text: string;
  snapshot: RgaSnapshot;
  stateVector: StateVector;
}

function loadDoc(row: CoeditDocRow): RgaDoc {
  let snap: RgaSnapshot;
  try { snap = JSON.parse(row.snapshot_json) as RgaSnapshot; } catch { snap = { nodes: [] }; }
  return RgaDoc.fromSnapshot(SERVER_SITE, snap);
}

async function persist(db: CoeditDb, row: CoeditDocRow, doc: RgaDoc, agentWritten: number, ops: RgaOp[], now: number): Promise<void> {
  await db.updateCoeditDoc(row.id, {
    snapshot_json: JSON.stringify(doc.snapshot()),
    state_vector_json: JSON.stringify(doc.stateVector()),
    agent_written: agentWritten,
    updated_at: now,
  });
  for (const op of ops) {
    const opId = opIdOf(op);
    await db.appendCoeditOp({ id: newUUIDv7(), doc_id: row.id, op_site: opId.siteId, op_counter: opId.counter, op_json: JSON.stringify(op), created_at: now });
  }
}

export function createCoeditRepo(db: CoeditDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  return {
    /** Create (idempotently) the co-edit doc for a run; returns the current view. */
    async ensureDoc(input: { runId: string; tenantId: string | null; ownerId: string; title?: string }): Promise<CoeditView> {
      const existing = await db.getCoeditDocByRun(input.runId);
      if (existing) return this.view(existing);
      const ts = now();
      const empty = new RgaDoc(SERVER_SITE);
      const id = newUUIDv7();
      await db.createCoeditDoc({
        id, run_id: input.runId, tenant_id: input.tenantId, owner_id: input.ownerId,
        title: input.title ?? null, snapshot_json: JSON.stringify(empty.snapshot()),
        state_vector_json: JSON.stringify(empty.stateVector()), created_at: ts, updated_at: ts,
      });
      const row = (await db.getCoeditDocByRun(input.runId))!;
      return this.view(row);
    },

    view(row: CoeditDocRow): CoeditView {
      const doc = loadDoc(row);
      return { docId: row.id, text: doc.text(), snapshot: doc.snapshot(), stateVector: doc.stateVector() };
    },

    async getView(docId: string): Promise<CoeditView | null> {
      const row = await db.getCoeditDoc(docId);
      return row ? this.view(row) : null;
    },

    /**
     * Apply a batch of client-submitted ops authored by `authorSiteId`. Validates
     * (anti-forgery + caps), applies to the canonical replica, persists, and
     * returns the accepted ops to broadcast (or an error string).
     */
    async submitOps(docId: string, authorSiteId: string, rawOps: unknown): Promise<{ ok: true; applied: RgaOp[]; view: CoeditView } | { ok: false; error: string }> {
      const row = await db.getCoeditDoc(docId);
      if (!row) return { ok: false, error: 'doc not found' };
      const valid = validateClientOps(rawOps, { expectedSiteId: authorSiteId });
      if (!valid.ok) return { ok: false, error: valid.error ?? 'invalid ops' };
      const doc = loadDoc(row);
      const applied: RgaOp[] = [];
      for (const op of valid.ops!) if (doc.apply(op)) applied.push(op);
      await persist(db, row, doc, row.agent_written, applied, now());
      return { ok: true, applied, view: { docId, text: doc.text(), snapshot: doc.snapshot(), stateVector: doc.stateVector() } };
    },

    /** The ops a peer (described by `since`) is missing — for offline reconcile. */
    async opsSince(docId: string, since: StateVector): Promise<RgaOp[]> {
      const ops = await db.listCoeditOps(docId);
      const out: RgaOp[] = [];
      for (const row of ops) {
        if (row.op_counter > (since[row.op_site] ?? 0)) {
          try { out.push(JSON.parse(row.op_json) as RgaOp); } catch { /* skip malformed */ }
        }
      }
      return out;
    },

    /**
     * Stream the agent's output into the doc as the agent PEER. Idempotent: only
     * the NEW suffix beyond `agent_written` is inserted, so calling it repeatedly
     * with the run's growing output never double-inserts. Returns the ops to
     * broadcast (empty if nothing new).
     */
    async agentAppend(docId: string, runId: string, fullText: string): Promise<{ applied: RgaOp[]; view: CoeditView } | null> {
      const row = await db.getCoeditDoc(docId);
      if (!row) return null;
      const already = row.agent_written;
      const suffix = [...fullText].slice(already).join('');
      if (suffix.length === 0) return { applied: [], view: this.view(row) };
      // The agent edits as its own site, anchored to the current end of the doc.
      const doc = RgaDoc.fromSnapshot(agentSiteId(runId), JSON.parse(row.snapshot_json) as RgaSnapshot);
      const peer = createAgentPeer(fromRgaDoc(doc)); // direct co-edit, through the CoeditDoc port

      const ops = peer.append(suffix);
      await persist(db, row, doc, already + [...suffix].length, ops, now());
      return { applied: ops, view: { docId, text: doc.text(), snapshot: doc.snapshot(), stateVector: doc.stateVector() } };
    },
  };
}
