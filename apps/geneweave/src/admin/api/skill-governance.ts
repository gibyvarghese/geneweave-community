/**
 * @weaveintel/geneweave — Admin Skill governance routes
 *
 * The mining review queue (propose skills from failing traces → human-approved → live) and
 * evaluation + trust-tier promotion, built on @weaveintel/skills 0.1.2 via ../../skill-governance.js.
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { listProposals, approveProposal, rejectProposal, evaluateSkillById, promoteSkillTier } from '../../skill-governance.js';
import type { SkillEvaluation, SkillTrustTierNum } from '@weaveintel/skills';

export function registerSkillGovernanceRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // ── Mining review queue ──
  router.get('/api/admin/skill-proposals', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { proposals: listProposals(db, 'pending') });
  }, { auth: true });

  // Approve a mined proposal → a live skill. Requires a passing evaluation AND an explicit human sign-off.
  router.post('/api/admin/skill-proposals/:id/approve', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['evaluation']) { json(res, 400, { error: 'an evaluation is required to approve a mined skill' }); return; }
    try {
      const result = await approveProposal(db, params['id']!, {
        evaluation: body['evaluation'] as SkillEvaluation,
        humanApproved: body['humanApproved'] === true,
        reviewer: auth.userId,
        targetTier: (body['targetTier'] as SkillTrustTierNum) ?? 1,
        signatureValid: body['signatureValid'] === true,
      });
      json(res, result.approved ? 200 : 409, result);
    } catch (e) { json(res, 404, { error: (e as Error).message }); }
  }, { auth: true, csrf: true });

  router.post('/api/admin/skill-proposals/:id/reject', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    rejectProposal(db, params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Evaluation + trust-tier promotion ──
  router.post('/api/admin/skills/:id/evaluate', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    try { json(res, 200, { evaluation: await evaluateSkillById(db, params['id']!) }); }
    catch (e) { json(res, 404, { error: (e as Error).message }); }
  }, { auth: true });

  router.post('/api/admin/skills/:id/promote', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['evaluation']) { json(res, 400, { error: 'an evaluation is required to promote' }); return; }
    try {
      const decision = promoteSkillTier(db, params['id']!, body['evaluation'] as SkillEvaluation, {
        targetTier: (body['targetTier'] as SkillTrustTierNum) ?? 2,
        humanApproved: body['humanApproved'] === true,
        signatureValid: body['signatureValid'] === true,
        baseline: body['baseline'] as SkillEvaluation | undefined,
      });
      json(res, 200, { decision });
    } catch (e) { json(res, 404, { error: (e as Error).message }); }
  }, { auth: true, csrf: true });
}
