/**
 * GeneWeave adapters for `@weaveintel/live-agents/trace-tools`.
 *
 * The trace-tools package is intentionally DB-agnostic: it accepts
 * `LiveRunEventReader` / `LiveRunStepReader` interfaces with no
 * geneweave or SQLite knowledge. These adapters wrap the geneweave
 * `DatabaseAdapter` so the supervisor can build a tool registry per
 * tick that is closure-bound to a single `runId`.
 */

import type {
  LiveRunEventLike,
  LiveRunEventReader,
  LiveRunStepLike,
  LiveRunStepReader,
} from '@weaveintel/live-agents/trace-tools';
import type {
  DatabaseAdapter,
  LiveRunEventRow,
  LiveRunStepRow,
} from '../db-types.js';

function toEvent(r: LiveRunEventRow): LiveRunEventLike {
  return {
    id: r.id,
    run_id: r.run_id,
    step_id: r.step_id,
    kind: r.kind,
    agent_id: r.agent_id,
    tool_key: r.tool_key,
    summary: r.summary,
    payload_json: r.payload_json,
    created_at: r.created_at,
  };
}

function toStep(r: LiveRunStepRow): LiveRunStepLike {
  return {
    id: r.id,
    run_id: r.run_id,
    mesh_id: r.mesh_id,
    agent_id: r.agent_id,
    role_key: r.role_key,
    status: r.status,
    started_at: r.started_at,
    completed_at: r.completed_at,
    summary: r.summary,
    payload_json: r.payload_json,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createDbLiveRunEventReader(db: DatabaseAdapter): LiveRunEventReader {
  return {
    async listEvents({ runId, afterId, limit }) {
      const rows = await db.listLiveRunEvents({
        runId,
        ...(afterId !== undefined ? { afterId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return rows.map(toEvent);
    },
    async getEvent(id) {
      const row = await db.getLiveRunEvent(id);
      return row ? toEvent(row) : null;
    },
  };
}

export function createDbLiveRunStepReader(db: DatabaseAdapter): LiveRunStepReader {
  return {
    async listSteps({ runId }) {
      const rows = await db.listLiveRunSteps({ runId });
      return rows.map(toStep);
    },
    async getStep(id) {
      const row = await db.getLiveRunStep(id);
      return row ? toStep(row) : null;
    },
  };
}
