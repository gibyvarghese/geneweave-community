/**
 * m69 — A2A Skills Taxonomy Expansion (mid-2026)
 *
 * Phase 2 of the mid-2026 DB content audit.  Fully idempotent:
 *   - INSERTs use INSERT OR IGNORE; UPDATEs check current values before writing.
 *
 * Changes:
 *   1. INSERT 12 new a2a_skills rows (computer-use, browser-automation,
 *      code-execution, document-intelligence, image-analysis, image-generation,
 *      voice-interaction, data-pipeline, memory-retrieval,
 *      workflow-orchestration, research-synthesis, hypothesis-validation)
 *   2. UPDATE supervisor-orchestration agent_workers: append computer_use_worker,
 *      document_worker, image_worker (if not already present)
 *   3. UPDATE input_modes on all 3 existing skills: add video/*, text/html,
 *      and application/vnd.openxmlformats-* MIME types
 *   4. UPDATE output_modes on supervisor + ensemble: add application/json
 *      (these modes can return structured reports)
 *
 * Architecture note:
 *   Skill type definitions live in packages/skills/src/a2a-skill-catalog.ts
 *   so they can be imported by tests and future tooling without pulling in
 *   the entire geneweave app.  This migration imports from that package.
 */

import type BetterSqlite3 from 'better-sqlite3';
import {
  A2A_NEW_SKILLS_V2,
  SUPERVISOR_V2_WORKERS,
  M69_NEW_INPUT_MIME_TYPES,
  mapA2ASkillToRow,
} from '@weaveintel/skills';

type WorkerShape = { name: string; description: string; tools: string[]; persona: string };

export function applyM69A2ASkillsV2(db: BetterSqlite3.Database): void {

  // ── 1. INSERT 12 new skills (INSERT OR IGNORE = fully idempotent) ─────────
  const insertSkill = db.prepare(`
    INSERT OR IGNORE INTO a2a_skills
      (id, name, description, tags, examples, input_modes, output_modes,
       security_scopes, mode, required_permission, sort_order, enabled,
       agent_tools, agent_workers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const skill of A2A_NEW_SKILLS_V2) {
    const row = mapA2ASkillToRow(skill);
    insertSkill.run(
      row.id, row.name, row.description, row.tags, row.examples,
      row.input_modes, row.output_modes, row.security_scopes,
      row.mode, row.required_permission, row.sort_order, row.enabled,
      row.agent_tools, row.agent_workers,
    );
  }

  // ── 2. UPDATE supervisor-orchestration: append 3 new workers ──────────────
  // Read the current agent_workers JSON, merge, write back only if needed.
  const supervisorRow = db.prepare(
    `SELECT agent_workers FROM a2a_skills WHERE id = 'supervisor-orchestration'`,
  ).get() as { agent_workers: string | null } | undefined;

  if (supervisorRow) {
    const currentWorkers: WorkerShape[] = supervisorRow.agent_workers
      ? (JSON.parse(supervisorRow.agent_workers) as WorkerShape[])
      : [];
    const existingNames = new Set(currentWorkers.map(w => w.name));
    const toAdd = SUPERVISOR_V2_WORKERS.filter(w => !existingNames.has(w.name));

    if (toAdd.length > 0) {
      db.prepare(
        `UPDATE a2a_skills SET agent_workers = ?, updated_at = datetime('now')
         WHERE id = 'supervisor-orchestration'`,
      ).run(JSON.stringify([...currentWorkers, ...toAdd]));
    }
  }

  // ── 3. UPDATE existing skills' input_modes: add video/*, html, openxmlformats
  const EXISTING_SKILL_IDS = ['general-chat', 'supervisor-orchestration', 'ensemble-reasoning'];

  const selectInputModes = db.prepare(
    `SELECT input_modes FROM a2a_skills WHERE id = ?`,
  );
  const updateInputModes = db.prepare(
    `UPDATE a2a_skills SET input_modes = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  for (const skillId of EXISTING_SKILL_IDS) {
    const row = selectInputModes.get(skillId) as { input_modes: string | null } | undefined;
    if (!row) continue;
    const currentModes: string[] = row.input_modes ? JSON.parse(row.input_modes) : [];
    const modeSet = new Set(currentModes);
    const toAdd = M69_NEW_INPUT_MIME_TYPES.filter(m => !modeSet.has(m));
    if (toAdd.length > 0) {
      updateInputModes.run(JSON.stringify([...currentModes, ...toAdd]), skillId);
    }
  }

  // ── 4. UPDATE output_modes: add application/json to supervisor + ensemble ──
  // Both modes can return structured JSON reports; text/plain stays for compat.
  const STRUCTURED_OUTPUT_SKILLS = ['supervisor-orchestration', 'ensemble-reasoning'];

  const selectOutputModes = db.prepare(
    `SELECT output_modes FROM a2a_skills WHERE id = ?`,
  );
  const updateOutputModes = db.prepare(
    `UPDATE a2a_skills SET output_modes = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  for (const skillId of STRUCTURED_OUTPUT_SKILLS) {
    const row = selectOutputModes.get(skillId) as { output_modes: string | null } | undefined;
    if (!row) continue;
    const currentModes: string[] = row.output_modes
      ? JSON.parse(row.output_modes)
      : ['text/plain'];
    if (!currentModes.includes('application/json')) {
      updateOutputModes.run(JSON.stringify([...currentModes, 'application/json']), skillId);
    }
  }
}
