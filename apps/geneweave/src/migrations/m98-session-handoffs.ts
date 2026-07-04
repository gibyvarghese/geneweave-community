import type BetterSqlite3 from 'better-sqlite3';

/**
 * m98 — Collaboration Phase 5: unified handoff (user↔user, agent↔human,
 * agent↔agent). One durable, audited lifecycle for passing the baton on a run.
 *
 * Two tables (tenant-isolated by construction):
 *
 * 1. `session_handoffs` — the durable handoff record. `run_id` is the spine that
 *    survives the whole chain (A2A `contextId`-style). `scope` is which kind of
 *    pass this is. `from_*`/`to_*` are typed actors (user/agent/role). `state` is
 *    the lifecycle position (requested → accepted/rejected → in_progress →
 *    handed_back → completed, plus failed/cancelled/timed_out). `reason` is the
 *    escalation reason; `rejection_reason` is REQUIRED on reject (evidentiary).
 *    `briefing_json` is the SCOPED context handed forward (a structured briefing,
 *    NOT the raw transcript); `hand_back_briefing_json` is the context handed
 *    back. `depth`/`parent_handoff_id` bound chained delegation (anti-loop);
 *    `reference_task_ids_json` carries A2A `referenceTaskIds`. `expires_at` is the
 *    SLA timer (an unbounded human wait would deadlock the run).
 *
 * 2. `handoff_events` — the APPEND-ONLY audit trail. One row per transition
 *    (who/when/from→to/note). Never mutate; insert. This is what makes a handoff
 *    defensible under EU AI Act Art. 12 (automatic event logging for high-risk
 *    systems) — reject reasons in particular are evidentiary.
 *
 * Security model (mid-2026 research): authorization is enforced by ACTOR (only
 * the recipient accepts/rejects/starts/hands-back; only the requester cancels)
 * AND by run ACCESS at the app layer (you cannot hand off a run you cannot see);
 * the briefing is scoped so an unauthorized recipient never receives parent
 * context; anti-loop depth caps runaway delegation.
 */
export function applyM98SessionHandoffs(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_handoffs (
      id                      TEXT PRIMARY KEY,
      run_id                  TEXT NOT NULL REFERENCES user_runs(id) ON DELETE CASCADE,
      tenant_id               TEXT,
      scope                   TEXT NOT NULL,            -- user_to_user | agent_to_human | agent_to_agent
      from_actor_type         TEXT NOT NULL,            -- user | agent | role
      from_actor_id           TEXT NOT NULL,
      to_actor_type           TEXT NOT NULL,
      to_actor_id             TEXT NOT NULL,
      state                   TEXT NOT NULL DEFAULT 'requested',
      reason                  TEXT NOT NULL,
      briefing_json           TEXT,                     -- scoped context handed FORWARD
      rejection_reason        TEXT,                     -- required on reject / failed
      hand_back_briefing_json TEXT,                     -- scoped context handed BACK
      depth                   INTEGER NOT NULL DEFAULT 0,
      parent_handoff_id       TEXT,
      reference_task_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL,
      resolved_at             INTEGER,
      expires_at              INTEGER                   -- SLA deadline
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_run   ON session_handoffs(run_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_to    ON session_handoffs(to_actor_id, state)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_sla   ON session_handoffs(state, expires_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_events (
      id          TEXT PRIMARY KEY,
      handoff_id  TEXT NOT NULL REFERENCES session_handoffs(id) ON DELETE CASCADE,
      at          INTEGER NOT NULL,
      actor_id    TEXT NOT NULL,
      from_state  TEXT,                                 -- null for the initial 'requested'
      to_state    TEXT NOT NULL,
      note        TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_handoff_events_handoff ON handoff_events(handoff_id, at)`);
}
