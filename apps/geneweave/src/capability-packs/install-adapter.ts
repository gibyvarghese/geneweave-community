/**
 * @weaveintel/geneweave — Capability Pack install adapter (Phase 6)
 *
 * Bridges the package-level `PackInstallAdapter` from `@weaveintel/core/capability-packs`
 * onto `DatabaseAdapter`. Each supported `kind` in a pack's `contents` maps to one
 * SQLite table via the upserter map below. Adding a new bucket is one entry here;
 * the package contract stays opaque about row shape.
 */

import type {
  PackInstallAdapter,
  PackPreconditions,
} from '@weaveintel/core/capability-packs';
import type { DatabaseAdapter } from '../db.js';

type Upserter = (
  db: DatabaseAdapter,
  rows: ReadonlyArray<Record<string, unknown>>,
) => Promise<string[]>;

type Deleter = (
  db: DatabaseAdapter,
  rowIds: ReadonlyArray<string>,
) => Promise<void>;

interface BucketHandler {
  upsert: Upserter;
  delete: Deleter;
}

/**
 * Registry of `kind` → DB table. Pack authors use these keys verbatim in
 * `manifest.contents`. Rows are the row-shape that the matching DB method
 * accepts (camelCase on the package side, snake_case on the DB side).
 */
const BUCKETS: Record<string, BucketHandler> = {
  workflow_defs: {
    async upsert(db, rows) {
      const ids: string[] = [];
      for (const r of rows) {
        const id = String(r['id']);
        const existing = await db.getWorkflowDef(id);
        if (existing) {
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k !== 'id' && k !== 'created_at' && k !== 'updated_at') fields[k] = v;
          }
          await db.updateWorkflowDef(id, fields as never);
        } else {
          await db.createWorkflowDef({
            id,
            name: String(r['name'] ?? id),
            description: r['description'] != null ? String(r['description']) : null,
            version: String(r['version'] ?? '1.0.0'),
            steps: typeof r['steps'] === 'string' ? r['steps'] : JSON.stringify(r['steps'] ?? []),
            entry_step_id: String(r['entry_step_id'] ?? ''),
            metadata: r['metadata'] == null ? null : (typeof r['metadata'] === 'string' ? r['metadata'] : JSON.stringify(r['metadata'])),
            enabled: r['enabled'] === false || r['enabled'] === 0 ? 0 : 1,
          });
        }
        ids.push(id);
      }
      return ids;
    },
    async delete(db, ids) {
      for (const id of ids) await db.deleteWorkflowDef(id);
    },
  },

  triggers: {
    async upsert(db, rows) {
      const ids: string[] = [];
      for (const r of rows) {
        const id = String(r['id']);
        const existing = await db.getTrigger(id);
        if (existing) {
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k !== 'id' && k !== 'created_at' && k !== 'updated_at') fields[k] = v;
          }
          await db.updateTrigger(id, fields as never);
        } else {
          await db.createTrigger(r as never);
        }
        ids.push(id);
      }
      return ids;
    },
    async delete(db, ids) {
      for (const id of ids) await db.deleteTrigger(id);
    },
  },

  prompts: {
    async upsert(db, rows) {
      const ids: string[] = [];
      for (const r of rows) {
        const id = String(r['id']);
        const existing = await db.getPrompt(id);
        if (existing) {
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k !== 'id' && k !== 'created_at' && k !== 'updated_at') fields[k] = v;
          }
          await db.updatePrompt(id, fields as never);
        } else {
          await db.createPrompt(r as never);
        }
        ids.push(id);
      }
      return ids;
    },
    async delete(db, ids) {
      for (const id of ids) await db.deletePrompt(id);
    },
  },

  prompt_fragments: {
    async upsert(db, rows) {
      const ids: string[] = [];
      for (const r of rows) {
        const id = String(r['id']);
        const existing = await db.getPromptFragment(id);
        if (existing) {
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k !== 'id' && k !== 'created_at' && k !== 'updated_at') fields[k] = v;
          }
          await db.updatePromptFragment(id, fields as never);
        } else {
          await db.createPromptFragment(r as never);
        }
        ids.push(id);
      }
      return ids;
    },
    async delete(db, ids) {
      for (const id of ids) await db.deletePromptFragment(id);
    },
  },

  tool_policies: {
    async upsert(db, rows) {
      const ids: string[] = [];
      for (const r of rows) {
        const id = String(r['id']);
        const existing = await db.getToolPolicy(id);
        if (existing) {
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k !== 'id' && k !== 'created_at' && k !== 'updated_at') fields[k] = v;
          }
          await db.updateToolPolicy(id, fields as never);
        } else {
          await db.createToolPolicy(r as never);
        }
        ids.push(id);
      }
      return ids;
    },
    async delete(db, ids) {
      for (const id of ids) await db.deleteToolPolicy(id);
    },
  },

  capability_policy_bindings: {
    async upsert(db, rows) {
      const ids: string[] = [];
      for (const r of rows) {
        const id = String(r['id']);
        const existing = await db.getCapabilityPolicyBinding(id);
        if (existing) {
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k !== 'id' && k !== 'created_at' && k !== 'updated_at') fields[k] = v;
          }
          await db.updateCapabilityPolicyBinding(id, fields as never);
        } else {
          await db.createCapabilityPolicyBinding(r as never);
        }
        ids.push(id);
      }
      return ids;
    },
    async delete(db, ids) {
      for (const id of ids) await db.deleteCapabilityPolicyBinding(id);
    },
  },
};

export function supportedPackBuckets(): string[] {
  return Object.keys(BUCKETS);
}

export interface GeneweavePackInstallAdapterOptions {
  /** Optional handler-kind catalog reader; used by `checkPreconditions`. */
  listHandlerKinds?: () => Promise<string[]>;
  /** Optional tool-catalog reader; used by `checkPreconditions`. */
  listToolKeys?: () => Promise<string[]>;
}

export function createGeneweavePackInstallAdapter(
  db: DatabaseAdapter,
  options: GeneweavePackInstallAdapterOptions = {},
): PackInstallAdapter {
  return {
    async checkPreconditions(pre: PackPreconditions): Promise<string[]> {
      const unmet: string[] = [];
      const wanted = pre.requiredHandlerKinds ?? [];
      if (wanted.length && options.listHandlerKinds) {
        const present = new Set(await options.listHandlerKinds());
        for (const k of wanted) if (!present.has(k)) unmet.push(`handlerKind:${k}`);
      }
      const wantedTools = pre.requiredToolKeys ?? [];
      if (wantedTools.length && options.listToolKeys) {
        const present = new Set(await options.listToolKeys());
        for (const k of wantedTools) if (!present.has(k)) unmet.push(`toolKey:${k}`);
      }
      return unmet;
    },

    async upsertRows(kind, rows) {
      const handler = BUCKETS[kind];
      if (!handler) throw new Error(`Unsupported pack content kind: ${kind}`);
      return handler.upsert(db, rows);
    },

    async deleteRows(kind, rowIds) {
      const handler = BUCKETS[kind];
      if (!handler) throw new Error(`Unsupported pack content kind: ${kind}`);
      await handler.delete(db, rowIds);
    },
  };
}
