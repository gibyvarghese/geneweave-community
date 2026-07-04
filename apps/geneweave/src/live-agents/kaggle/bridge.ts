/**
 * Phase K5 — Kaggle CrossMeshBridge wiring.
 *
 * Per design §5.1, the kaggle research mesh bridges to the user's main mesh on
 * three topics: submission_result, rank_change, escalation_request. The user
 * mesh sees notifications and provides human approvals for dual-control gates.
 */

import type { CrossMeshBridge } from '@weaveintel/live-agents';

export interface KaggleBridgeOptions {
  fromMeshId: string;
  toMeshId: string;
  authorisedByHumanId: string;
  coAuthorisedByHumanId?: string | null;
  nowIso?: string;
  bridgeId?: string;
  /** Override the default topic set. Falls back to KAGGLE_BRIDGE_TOPICS. */
  allowedTopics?: ReadonlyArray<string>;
  /** Override the default per-hour rate limit (100). */
  rateLimitPerHour?: number;
  /** Override the default purpose prose. */
  purposeProse?: string;
  /** Override the default constraints prose. Auto-derived from topics +
   *  rate limit when omitted. */
  constraintsProse?: string;
}

export const KAGGLE_BRIDGE_TOPICS = [
  'kaggle.submission_result',
  'kaggle.rank_change',
  'kaggle.escalation_request',
] as const;

const DEFAULT_PURPOSE_PROSE =
  'Surface Kaggle submission results, rank changes, and escalation requests to the user mesh; receive human approvals for dual-control gates.';

export function buildKaggleBridge(opts: KaggleBridgeOptions): CrossMeshBridge {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const topics = opts.allowedTopics ?? KAGGLE_BRIDGE_TOPICS;
  const rateLimitPerHour = opts.rateLimitPerHour ?? 100;
  const purposeProse = opts.purposeProse ?? DEFAULT_PURPOSE_PROSE;
  const constraintsProse =
    opts.constraintsProse ?? `Topics: ${topics.join(', ')}. Rate-limited to ${rateLimitPerHour}/hour.`;
  return {
    id: opts.bridgeId ?? `bridge-kaggle-${opts.fromMeshId}-${opts.toMeshId}`,
    fromMeshId: opts.fromMeshId,
    toMeshId: opts.toMeshId,
    allowedAgentPairs: null,
    allowedTopics: [...topics],
    rateLimitPerHour,
    authorisedByType: 'HUMAN',
    authorisedById: opts.authorisedByHumanId,
    coAuthorisedByType: opts.coAuthorisedByHumanId ? 'HUMAN' : null,
    coAuthorisedById: opts.coAuthorisedByHumanId ?? null,
    effectiveFrom: nowIso,
    effectiveTo: null,
    revokedAt: null,
    purposeProse,
    constraintsProse,
  };
}
