// Skill governance — app-side wiring for the remaining @weaveintel/skills 0.1.2 capabilities:
//   • Level-3 sandboxed skill-package execution (runs a bundled script in the app's Docker CSE),
//   • the mining review queue (propose skills from failing traces → human-approved → live),
//   • evaluation + trust-tier promotion.
// The engine ships the mechanism; this module is the app policy/persistence around it.

import type BetterSqlite3 from 'better-sqlite3';
import { newUUIDv7 } from '@weaveintel/core';
import {
  runSkillScript,
  mineSkillCandidates,
  approveMinedSkill,
  evaluateSkill,
  evaluatePromotion,
  skillFromRow,
  defineSkill,
  type SkillScriptRunner,
  type SkillPackage,
  type SkillScriptResult,
  type SkillRunTrace,
  type SkillProposer,
  type SkillProposal,
  type SkillEvaluation,
  type EvaluateSkillOptions,
  type PromotionDecision,
  type SkillTrustTierNum,
} from '@weaveintel/skills';
import type { ComputeSandboxEngine } from '@weaveintel/sandbox';
import type { DatabaseAdapter } from './db.js';

// The proposals table has no adapter method; access the underlying handle (app-internal, contained here).
function handle(db: DatabaseAdapter): BetterSqlite3.Database {
  return (db as unknown as { d: BetterSqlite3.Database }).d;
}

// ── Level 3: run a bundled skill-package script in the app's Docker sandbox (CSE) ──────────────

/** Adapt the app's ComputeSandboxEngine to the engine's injected SkillScriptRunner seam. */
export function cseSkillScriptRunner(engine: ComputeSandboxEngine): SkillScriptRunner {
  return {
    async run(spec): Promise<SkillScriptResult> {
      const lang = spec.language === 'node' ? 'javascript' : spec.language;
      const res = await engine.run({
        code: spec.code,
        language: (lang as 'python' | 'javascript' | 'typescript' | 'bash' | 'shell') ?? 'python',
        files: Object.entries(spec.files ?? {}).map(([name, content]) => ({ name, content })),
        timeoutMs: spec.timeoutMs,
        networkAccess: spec.networkAccess,
      });
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status === 'success' ? 0 : 1, timedOut: res.status === 'timeout' };
    },
  };
}

/** Run a bundled `scripts/*` file from a skill package in the sandbox, with the engine's safe defaults. */
export async function runSkillPackageScript(
  engine: ComputeSandboxEngine,
  pkg: SkillPackage,
  path: string,
  inputFiles?: Record<string, string>,
): Promise<SkillScriptResult> {
  return runSkillScript({ pkg, path, runner: cseSkillScriptRunner(engine), inputFiles });
}

// ── Mining review queue ────────────────────────────────────────────────────────────────────────

export interface StoredProposalRow {
  id: string; proposed_skill_id: string; name: string; description: string; instructions: string;
  tool_names: string; pattern: string; occurrences: number; evidence: string; safety: string;
  status: string; created_at: string; reviewed_at: string | null; reviewed_by: string | null;
}

/** Mine draft skills from failing run traces and store them in the review queue (all pending/disabled). */
export async function mineAndStoreProposals(
  db: DatabaseAdapter,
  traces: readonly SkillRunTrace[],
  opts: { proposer?: SkillProposer; minOccurrences?: number } = {},
): Promise<Array<{ id: string; proposal: SkillProposal }>> {
  const proposals = await mineSkillCandidates(traces, { proposer: opts.proposer, minOccurrences: opts.minOccurrences ?? 3 });
  const insert = handle(db).prepare(
    `INSERT INTO mined_skill_proposals (id, proposed_skill_id, name, description, instructions, tool_names, pattern, occurrences, evidence, safety, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );
  const out: Array<{ id: string; proposal: SkillProposal }> = [];
  for (const p of proposals) {
    const id = 'prop-' + newUUIDv7().slice(-8);
    insert.run(id, p.draft.id, p.draft.name, p.draft.summary ?? '', p.draft.executionGuidance ?? '',
      JSON.stringify(p.draft.toolNames ?? []), p.evidence.pattern, p.evidence.occurrences,
      JSON.stringify(p.evidence), JSON.stringify(p.safety));
    out.push({ id, proposal: p });
  }
  return out;
}

export function listProposals(db: DatabaseAdapter, status = 'pending'): StoredProposalRow[] {
  return handle(db).prepare(`SELECT * FROM mined_skill_proposals WHERE status = ? ORDER BY occurrences DESC, created_at DESC`).all(status) as StoredProposalRow[];
}

/**
 * Approve a mined proposal → a live skill. Requires a human sign-off AND a passing evaluation (the
 * engine's approveMinedSkill gate); a proposal whose draft tripped the safety scan can never be enabled.
 */
export async function approveProposal(
  db: DatabaseAdapter,
  proposalId: string,
  opts: { evaluation: SkillEvaluation; humanApproved: boolean; reviewer?: string; targetTier?: SkillTrustTierNum; signatureValid?: boolean },
): Promise<{ approved: boolean; reasons: readonly string[]; skillId?: string }> {
  const h = handle(db);
  const row = h.prepare(`SELECT * FROM mined_skill_proposals WHERE id = ?`).get(proposalId) as StoredProposalRow | undefined;
  if (!row) throw new Error(`proposal not found: ${proposalId}`);

  const draft = {
    ...defineSkill({ id: row.proposed_skill_id, name: row.name, summary: row.description, executionGuidance: row.instructions, toolNames: JSON.parse(row.tool_names || '[]'), trust: 0 }),
    enabled: false as const, lifecycle: 'draft' as const,
  };
  const proposal: SkillProposal = { draft, evidence: JSON.parse(row.evidence || '{}'), safety: JSON.parse(row.safety || '{}'), requiresApproval: true };

  const result = approveMinedSkill({ proposal, evaluation: opts.evaluation, humanApproved: opts.humanApproved, targetTier: opts.targetTier, signatureValid: opts.signatureValid });
  if (!result.approved || !result.skill) return { approved: false, reasons: result.reasons };

  await db.createSkill({
    id: result.skill.id, name: result.skill.name, description: result.skill.summary ?? '',
    category: 'mined', trigger_patterns: '[]', instructions: result.skill.executionGuidance ?? '',
    tool_names: JSON.stringify(result.skill.toolNames ?? []), examples: null,
    tags: JSON.stringify(['mined']), priority: 0, version: '1.0', enabled: 1,
    tool_policy_key: null, domain_sections: null,
  });
  h.prepare(`UPDATE mined_skill_proposals SET status='approved', reviewed_at=datetime('now'), reviewed_by=? WHERE id=?`).run(opts.reviewer ?? null, proposalId);
  return { approved: true, reasons: result.reasons, skillId: result.skill.id };
}

export function rejectProposal(db: DatabaseAdapter, proposalId: string, reviewer?: string): void {
  handle(db).prepare(`UPDATE mined_skill_proposals SET status='rejected', reviewed_at=datetime('now'), reviewed_by=? WHERE id=?`).run(reviewer ?? null, proposalId);
}

// ── Evaluation + trust-tier promotion ────────────────────────────────────────────────────────────

/** Score a skill (by id) on reusability / composability / maintainability / task completion. */
export async function evaluateSkillById(db: DatabaseAdapter, skillId: string, opts: EvaluateSkillOptions = {}): Promise<SkillEvaluation> {
  const row = handle(db).prepare(`SELECT * FROM skills WHERE id = ?`).get(skillId) as Parameters<typeof skillFromRow>[0] | undefined;
  if (!row) throw new Error(`skill not found: ${skillId}`);
  return evaluateSkill(skillFromRow(row), opts);
}

/**
 * Decide (and persist) a skill's trust tier from an evaluation. Promotion needs a passing eval, a
 * signature for T2+, and a human sign-off for the high tiers; a regression auto-demotes.
 */
export function promoteSkillTier(
  db: DatabaseAdapter,
  skillId: string,
  evaluation: SkillEvaluation,
  opts: { targetTier: SkillTrustTierNum; humanApproved?: boolean; signatureValid?: boolean; baseline?: SkillEvaluation },
): PromotionDecision {
  const h = handle(db);
  const row = h.prepare(`SELECT trust_tier FROM skills WHERE id = ?`).get(skillId) as { trust_tier?: number } | undefined;
  if (!row) throw new Error(`skill not found: ${skillId}`);
  const currentTier = (row.trust_tier ?? 1) as SkillTrustTierNum;
  const decision = evaluatePromotion({ currentTier, targetTier: opts.targetTier, evaluation, humanApproved: opts.humanApproved, signatureValid: opts.signatureValid, baseline: opts.baseline });
  if (decision.decision === 'promote' || decision.decision === 'demote') {
    h.prepare(`UPDATE skills SET trust_tier = ? WHERE id = ?`).run(decision.toTier, skillId);
  }
  return decision;
}
