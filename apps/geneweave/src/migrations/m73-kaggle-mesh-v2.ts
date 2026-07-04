/**
 * m73-kaggle-mesh-v2
 *
 * Phase 6 Kaggle Mesh & Playbook Modernization — mid-2026.
 *
 * Changes (synchronous bootstrap layer):
 *   1. UPDATE kaggle_role_capabilities:
 *        - Add KAGGLE_READ_LEADERBOARD to strategist
 *          (strategist must see hourly scores from leaderboard_monitor to adjust strategy)
 *        - Add KAGGLE_LOCAL_COMPUTE to implementer
 *          (implementer now runs local validation before handing off to validator)
 *        - Add KAGGLE_READ_LEADERBOARD to submitter
 *          (submitter should check own submission score after posting)
 *
 * Playbook content (new NLP/Vision/TimeSeries playbooks + updated
 * GENERIC_ML_SOLVER/DEFAULT_DISCOVERY/ARC_AGI_3 content) and new mesh
 * blueprint agents (leaderboard_monitor, parallel_implementer, debrief) are
 * handled by the async seed functions:
 *   - seedKaggleArcPlaybook  (playbook-seed.ts — bumped to v1.8.0 / v1.3.0)
 *   - seedLiveMeshDefinitions (live-mesh-defs-seed.ts — extended to add missing agents/edges)
 */

import type BetterSqlite3 from 'better-sqlite3';

/**
 * Capabilities to add to each role.
 * Only added if not already present (idempotent).
 */
const ROLE_CAP_ADDITIONS: Record<string, string[]> = {
  strategist:  ['KAGGLE_READ_LEADERBOARD'],
  implementer: ['KAGGLE_LOCAL_COMPUTE'],
  submitter:   ['KAGGLE_READ_LEADERBOARD'],
};

export function applyM73KaggleMeshV2(db: BetterSqlite3.Database): void {
  const readCaps = db.prepare<[string], { capabilities: string }>(
    `SELECT capabilities FROM kaggle_role_capabilities WHERE role = ?`,
  );
  const writeCaps = db.prepare(
    `UPDATE kaggle_role_capabilities SET capabilities = ?, updated_at = datetime('now') WHERE role = ?`,
  );

  for (const [role, toAdd] of Object.entries(ROLE_CAP_ADDITIONS)) {
    const row = readCaps.get(role);
    if (!row) continue; // table not yet seeded — m45 + seed will handle fresh installs
    let caps: string[];
    try {
      caps = JSON.parse(row.capabilities) as string[];
    } catch {
      continue; // malformed JSON — leave alone
    }
    let changed = false;
    for (const cap of toAdd) {
      if (!caps.includes(cap)) {
        caps.push(cap);
        changed = true;
      }
    }
    if (changed) {
      writeCaps.run(JSON.stringify(caps), role);
    }
  }
}
