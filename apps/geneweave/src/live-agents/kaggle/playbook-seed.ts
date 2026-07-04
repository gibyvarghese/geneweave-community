/**
 * Seed Kaggle competition playbooks into GeneWeave DB.
 *
 * Idempotent. Inserts (or skips if present, by stable id):
 *   - prompt_fragments:
 *       kaggle.workflow.default_discovery  — catch-all generic discovery prompt
 *       kaggle.workflow.arc_agi_3          — verbatim ARC-AGI-3 strategist workflow
 *       kaggle.solver_template.arc_agi_3   — verbatim Python solver template
 *   - skills (category=kaggle_playbook):
 *       kaggle-playbook-default  — catch-all (`*`); instructions are a fragment ref
 *       kaggle-playbook-arc-agi-3 — matches `arc-prize-*`, `*arc-agi*`
 *
 * After seeding, ALL playbook content lives in the DB and is editable via
 * admin (skills + prompt fragments tabs). The runtime resolver
 * (playbook-resolver.ts) loads the matching playbook per competition slug
 * and expands `{{>...}}` fragment markers via `@weaveintel/prompts`.
 */

import type { DatabaseAdapter } from '../../db-types.js';
import {
  KAGGLE_ARC_AGI_3_WORKFLOW,
  KAGGLE_ARC_AGI_3_SOLVER_TEMPLATE,
  KAGGLE_DEFAULT_DISCOVERY,
  KAGGLE_ARC_STRATEGY_PRESETS,
  KAGGLE_GENERIC_ML_SOLVER,
  KAGGLE_ORBIT_WARS_WORKFLOW,
  KAGGLE_ORBIT_WARS_SOLVER_TEMPLATE,
  KAGGLE_NLP_SEQUENCE,
  KAGGLE_VISION_CNN,
  KAGGLE_TIME_SERIES,
} from './playbook-seed-content.js';
import { KAGGLE_PLAYBOOK_CATEGORY } from './playbook-resolver.js';

const FRAGMENT_ID_DEFAULT_DISCOVERY = 'frag-kaggle-workflow-default-discovery';
const FRAGMENT_KEY_DEFAULT_DISCOVERY = 'kaggle.workflow.default_discovery';
const FRAGMENT_ID_ARC_WORKFLOW = 'frag-kaggle-workflow-arc-agi-3';
const FRAGMENT_KEY_ARC_WORKFLOW = 'kaggle.workflow.arc_agi_3';
const FRAGMENT_ID_ARC_SOLVER = 'frag-kaggle-solver-template-arc-agi-3';
const FRAGMENT_KEY_ARC_SOLVER = 'kaggle.solver_template.arc_agi_3';
const FRAGMENT_ID_GENERIC_ML_SOLVER = 'frag-kaggle-solver-template-generic-ml';
const FRAGMENT_KEY_GENERIC_ML_SOLVER = 'kaggle.solver_template.generic_ml';
const FRAGMENT_ID_ORBIT_WARS_WORKFLOW = 'frag-kaggle-workflow-orbit-wars';
const FRAGMENT_KEY_ORBIT_WARS_WORKFLOW = 'kaggle.workflow.orbit_wars';
const FRAGMENT_ID_ORBIT_WARS_SOLVER = 'frag-kaggle-solver-template-orbit-wars';
const FRAGMENT_KEY_ORBIT_WARS_SOLVER = 'kaggle.solver_template.orbit_wars';

// Phase 6 — NLP, Vision, Time Series playbooks
const FRAGMENT_ID_NLP_SEQUENCE = 'frag-kaggle-workflow-nlp-sequence';
const FRAGMENT_KEY_NLP_SEQUENCE = 'kaggle.workflow.nlp_sequence';
const FRAGMENT_ID_VISION_CNN = 'frag-kaggle-workflow-vision-cnn';
const FRAGMENT_KEY_VISION_CNN = 'kaggle.workflow.vision_cnn';
const FRAGMENT_ID_TIME_SERIES = 'frag-kaggle-workflow-time-series';
const FRAGMENT_KEY_TIME_SERIES = 'kaggle.workflow.time_series';

const SKILL_ID_DEFAULT = 'kaggle-playbook-default';
const SKILL_ID_ARC = 'kaggle-playbook-arc-agi-3';
const SKILL_ID_ORBIT_WARS = 'kaggle-playbook-orbit-wars';
// Phase 6
const SKILL_ID_NLP = 'kaggle-playbook-nlp-sequence';
const SKILL_ID_VISION = 'kaggle-playbook-vision-cnn';
const SKILL_ID_TIME_SERIES = 'kaggle-playbook-time-series';

const DEFAULT_PLAYBOOK_INSTRUCTIONS = `{{>${FRAGMENT_KEY_DEFAULT_DISCOVERY}}}`;
const ARC_PLAYBOOK_INSTRUCTIONS = `{{>${FRAGMENT_KEY_ARC_WORKFLOW}}}`;

/** Quietly insert a fragment if not present. */
async function ensureFragment(
  db: DatabaseAdapter,
  id: string,
  key: string,
  name: string,
  category: string,
  content: string,
): Promise<'inserted' | 'exists'> {
  // Phase 6 (mid-2026): bumped from 1.7.0 to 1.8.0 to trigger refresh of
  // updated GENERIC_ML_SOLVER (LightGBM tier), DEFAULT_DISCOVERY (GPU probe),
  // and ARC_AGI_3_WORKFLOW (ARC-AGI-4 awareness note).
  const CURRENT_VERSION = '1.8.0';
  const existing = await db.getPromptFragment(id).catch(() => null);
  const byKey = existing ?? (await db.getPromptFragmentByKey(key).catch(() => null));
  if (byKey) {
    // Refresh content when the seeded version differs OR the bundled seed
    // content has changed under us. Operator-edited rows whose content has
    // already drifted from the seed are left alone (version stamp lets the
    // operator opt back in by resetting it to the bundled CURRENT_VERSION).
    if (byKey.version !== CURRENT_VERSION || byKey.content !== content) {
      try {
        await db.updatePromptFragment(byKey.id, { content, version: CURRENT_VERSION });
        return 'inserted';
      } catch {
        return 'exists';
      }
    }
    return 'exists';
  }
  await db.createPromptFragment({
    id,
    key,
    name,
    description: `Kaggle live-agents playbook fragment (${key}).`,
    category,
    content,
    variables: null,
    tags: JSON.stringify(['kaggle', 'live-agents', 'playbook']),
    version: CURRENT_VERSION,
    enabled: 1,
  });
  return 'inserted';
}

async function ensureSkill(
  db: DatabaseAdapter,
  row: {
    id: string;
    name: string;
    description: string;
    triggerPatterns: string[];
    instructions: string;
    toolNames: string[];
    examples: unknown;
    priority: number;
  },
): Promise<'inserted' | 'exists'> {
  // Phase 6 (mid-2026): bumped from 1.2.0 to 1.3.0 to refresh existing
  // skills (default, arc-agi-3, orbit-wars) with updated content + add 3 new
  // competition-type skills (nlp-sequence, vision-cnn, time-series).
  const CURRENT_SKILL_VERSION = '1.3.0';
  const existing = await db.getSkill(row.id).catch(() => null);
  if (existing) {
    // Refresh examples + instructions when the bundled seed has bumped its
    // version. Operators who edit the row in admin should bump the row's
    // version too if they want to opt back into seed updates.
    if (existing.version !== CURRENT_SKILL_VERSION) {
      try {
        await db.updateSkill(row.id, {
          examples: JSON.stringify(row.examples),
          instructions: row.instructions,
          tool_names: JSON.stringify(row.toolNames),
          trigger_patterns: JSON.stringify(row.triggerPatterns),
          version: CURRENT_SKILL_VERSION,
        });
        return 'inserted';
      } catch {
        return 'exists';
      }
    }
    return 'exists';
  }
  await db.createSkill({
    id: row.id,
    name: row.name,
    description: row.description,
    category: KAGGLE_PLAYBOOK_CATEGORY,
    trigger_patterns: JSON.stringify(row.triggerPatterns),
    instructions: row.instructions,
    tool_names: JSON.stringify(row.toolNames),
    examples: JSON.stringify(row.examples),
    tags: JSON.stringify(['kaggle', 'live-agents', 'playbook']),
    priority: row.priority,
    version: CURRENT_SKILL_VERSION,
    tool_policy_key: null,
    supervisor_agent_id: null,
    domain_sections: null,
    execution_contract: null,
    enabled: 1,
  });
  return 'inserted';
}

export interface SeedKaggleArcPlaybookResult {
  fragments: Record<string, 'inserted' | 'exists'>;
  skills: Record<string, 'inserted' | 'exists'>;
}

export async function seedKaggleArcPlaybook(
  db: DatabaseAdapter,
): Promise<SeedKaggleArcPlaybookResult> {
  const fragments: Record<string, 'inserted' | 'exists'> = {};
  fragments[FRAGMENT_KEY_DEFAULT_DISCOVERY] = await ensureFragment(
    db,
    FRAGMENT_ID_DEFAULT_DISCOVERY,
    FRAGMENT_KEY_DEFAULT_DISCOVERY,
    'Kaggle default discovery workflow',
    'kaggle',
    KAGGLE_DEFAULT_DISCOVERY,
  );
  fragments[FRAGMENT_KEY_ARC_WORKFLOW] = await ensureFragment(
    db,
    FRAGMENT_ID_ARC_WORKFLOW,
    FRAGMENT_KEY_ARC_WORKFLOW,
    'Kaggle ARC-AGI-3 strategist workflow',
    'kaggle',
    KAGGLE_ARC_AGI_3_WORKFLOW,
  );
  fragments[FRAGMENT_KEY_ARC_SOLVER] = await ensureFragment(
    db,
    FRAGMENT_ID_ARC_SOLVER,
    FRAGMENT_KEY_ARC_SOLVER,
    'Kaggle ARC-AGI-3 baseline solver template',
    'kaggle',
    KAGGLE_ARC_AGI_3_SOLVER_TEMPLATE,
  );
  fragments[FRAGMENT_KEY_GENERIC_ML_SOLVER] = await ensureFragment(
    db,
    FRAGMENT_ID_GENERIC_ML_SOLVER,
    FRAGMENT_KEY_GENERIC_ML_SOLVER,
    'Kaggle generic ML baseline solver template (catch-all default)',
    'kaggle',
    KAGGLE_GENERIC_ML_SOLVER,
  );
  fragments[FRAGMENT_KEY_ORBIT_WARS_WORKFLOW] = await ensureFragment(
    db,
    FRAGMENT_ID_ORBIT_WARS_WORKFLOW,
    FRAGMENT_KEY_ORBIT_WARS_WORKFLOW,
    'Kaggle Orbit Wars ML strategist workflow',
    'kaggle',
    KAGGLE_ORBIT_WARS_WORKFLOW,
  );
  fragments[FRAGMENT_KEY_ORBIT_WARS_SOLVER] = await ensureFragment(
    db,
    FRAGMENT_ID_ORBIT_WARS_SOLVER,
    FRAGMENT_KEY_ORBIT_WARS_SOLVER,
    'Kaggle Orbit Wars learned-policy (BC) solver template',
    'kaggle',
    KAGGLE_ORBIT_WARS_SOLVER_TEMPLATE,
  );

  const skills: Record<string, 'inserted' | 'exists'> = {};
  skills[SKILL_ID_DEFAULT] = await ensureSkill(db, {
    id: SKILL_ID_DEFAULT,
    name: 'Kaggle Playbook — Default',
    description:
      'Catch-all Kaggle playbook used when no competition-specific playbook matches the competition slug. Drives a generic identify-then-baseline workflow.',
    triggerPatterns: ['*'],
    instructions: DEFAULT_PLAYBOOK_INSTRUCTIONS,
    toolNames: [
      'kaggle_list_competitions',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'unknown',
      // Generic ML scaffold (not a heuristic): tries to detect the most-likely
      // tabular layout under /kaggle/input/, trains a quick HistGradientBoosting
      // baseline, and writes submission.csv. The agentic strategist can — and
      // should — push smarter kernels per competition; this template is only
      // the deterministic fallback for the catch-all playbook so a run never
      // silently no-ops with "no solverTemplate".
      solverTemplateFragmentKey: FRAGMENT_KEY_GENERIC_ML_SOLVER,
      maxIterations: 5,
      // Operational defaults applied across handlers. The catch-all `*`
      // playbook acts as the runtime config carrier so operators can edit
      // these in admin without touching code.
      topNAgentic: 5,
      topNDeterministic: 3,
      pollIntervalSec: 10,
      pollTimeoutSec: 300,
      kernelOutputHeadBytes: 4000,
      kernelOutputTailBytes: 4000,
      kernelWaitMaxTimeoutSec: 600,
      // Tier C: bridge + attention defaults. Operators tune these in admin
      // by editing the catch-all (`*`) skill's examples JSON.
      attentionRestMinutes: 60,
      bridgeTopics: [
        'kaggle.submission_result',
        'kaggle.rank_change',
        'kaggle.escalation_request',
      ],
      bridgeRateLimitPerHour: 100,
      bridgePurposeProse:
        'Surface Kaggle submission results, rank changes, and escalation requests to the user mesh; receive human approvals for dual-control gates.',
      // Tier D: capability matrix + dual-control gate. Operators tighten /
      // loosen these in admin without a deploy. Capability revocation takes
      // effect on the agent's next tick.
      capabilityMatrix: {
        discoverer: ['KAGGLE_LIST_COMPETITIONS', 'KAGGLE_READ_DATASETS'],
        strategist: ['KAGGLE_LIST_KERNELS', 'KAGGLE_READ_KERNELS'],
        implementer: ['KAGGLE_PUSH_KERNEL', 'KAGGLE_READ_KERNELS'],
        validator: ['KAGGLE_DOWNLOAD_DATA', 'KAGGLE_LOCAL_COMPUTE'],
        submitter: ['KAGGLE_SUBMIT'],
        observer: ['KAGGLE_READ_LEADERBOARD', 'KAGGLE_READ_SUBMISSIONS'],
      },
      dualControlRequiredFor: [
        'kaggle.competitions.submit',
        'kaggle.kernels.push',
      ],
      // Tier E: role personas + pipeline edges. Operators can rename roles,
      // tighten objectives, or rewire the pipeline (e.g. drop the observer)
      // entirely from admin without a code change.
      rolePersonas: {
        discoverer: {
          name: 'Kaggle Discoverer',
          role: 'Competition Discoverer',
          persona: 'Daily watch on the Kaggle catalog; surfaces high-fit competitions for the team.',
          objectives: 'Surface 1–3 candidate competitions per day with reward, deadline, and metric.',
          success: 'Each surfaced competition links to a Kaggle ref and includes deadline + evaluation metric.',
        },
        strategist: {
          name: 'Kaggle Strategist',
          role: 'Approach Ideator',
          persona: 'Proposes 2–3 modeling approaches per competition grounded in published kernels.',
          objectives: 'For each picked competition, propose distinct approaches with expected metric and rationale.',
          success: 'Each approach cites at least one source kernel and an expected metric range.',
        },
        implementer: {
          name: 'Kaggle Implementer',
          role: 'Kernel Author',
          persona: 'Builds notebook source from approved approaches and pushes to Kaggle as private kernels.',
          objectives: 'Push kernel; poll until status=complete; record kernel ref + output url.',
          success: 'Kernel pushes succeed at least 90% on first attempt; failures triage within one tick.',
        },
        validator: {
          name: 'Kaggle Validator',
          role: 'Submission Validator',
          persona: 'Runs deterministic header/row/id checks on submission CSVs before they reach the submitter.',
          objectives: 'Block any submission that fails header/row/id parity against the competition sample.',
          success: 'Zero malformed submissions reach the submitter.',
        },
        submitter: {
          name: 'Kaggle Submitter',
          role: 'Competition Submitter',
          persona: 'Final gate: requires dual-control approval before calling kaggle.competitions.submit.',
          objectives: 'Submit only validated entries; respect 4/day/competition cap.',
          success: 'No more than 4 submissions per competition per UTC day; every submission has a paired Promotion.',
        },
        observer: {
          name: 'Kaggle Observer',
          role: 'Leaderboard Observer',
          persona: 'Hourly poll of leaderboard + own submissions; flags rank drops to the strategist.',
          objectives: 'Detect rank drops > N positions and surface to strategist within one tick.',
          success: 'Rank-drop notices reach strategist before the next discoverer tick.',
        },
      },
      pipelineEdges: [
        { from: 'discoverer', to: 'strategist', relationship: 'DIRECTS', prose: 'Discoverer hands picked competitions to the strategist.' },
        { from: 'strategist', to: 'implementer', relationship: 'DIRECTS', prose: 'Strategist hands approved approaches to the implementer.' },
        { from: 'implementer', to: 'validator', relationship: 'DIRECTS', prose: 'Implementer hands kernel outputs to the validator.' },
        { from: 'validator', to: 'submitter', relationship: 'DIRECTS', prose: 'Validator hands passing submissions to the submitter.' },
        { from: 'observer', to: 'strategist', relationship: 'COLLABORATES_WITH', prose: 'Observer surfaces leaderboard signal to the strategist.' },
      ],
    },
    priority: 0,
  });

  skills[SKILL_ID_ARC] = await ensureSkill(db, {
    id: SKILL_ID_ARC,
    name: 'Kaggle Playbook — ARC-AGI-3',
    description:
      'Competition-specific playbook for ARC Prize / ARC-AGI-3 (live-API agent competitions). Carries the v0.9.3 framework facts, action gating, 5-rung ladder and stop conditions.',
    triggerPatterns: ['arc-prize-*', '*arc-agi*'],
    instructions: ARC_PLAYBOOK_INSTRUCTIONS,
    toolNames: [
      'kaggle_list_competitions',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'live_api',
      solverTemplateFragmentKey: FRAGMENT_KEY_ARC_SOLVER,
      strategyPresets: KAGGLE_ARC_STRATEGY_PRESETS,
      maxIterations: 8,
    },
    priority: 100,
  });

  skills[SKILL_ID_ORBIT_WARS] = await ensureSkill(db, {
    id: SKILL_ID_ORBIT_WARS,
    name: 'Kaggle Playbook — Orbit Wars (ML)',
    description:
      'Orbit Wars (kaggle_environments interactive-agent competition, SHAPE=B kernel_is_submission). Drives an ML-based agent: behavior-cloned scikit-learn classifier or RL policy. Hand-coded heuristics are ONLY allowed as the supervised teacher — never as the final entry.',
    triggerPatterns: ['orbit-wars', 'orbit_wars', '*orbit-wars*', '*orbit_wars*'],
    instructions: `{{>${FRAGMENT_KEY_ORBIT_WARS_WORKFLOW}}}`,
    toolNames: [
      'kaggle_get_competition',
      'kaggle_list_competition_files',
      'kaggle_get_competition_file',
      'kaggle_list_kernels',
      'kaggle_get_kernel_source',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'live_api',
      submissionFormat: 'python_script',
      submissionFilename: 'main.py',
      submissionWriter: 'kernel_is_submission',
      solverTemplateFragmentKey: FRAGMENT_KEY_ORBIT_WARS_SOLVER,
      maxIterations: 8,
      pollIntervalSec: 15,
      pollTimeoutSec: 600,
      kernelWaitMaxTimeoutSec: 900,
      kernelOutputHeadBytes: 6000,
      kernelOutputTailBytes: 6000,
      mlBaselineRequired: true,
      mlBaselineNote:
        'Final agent MUST be a learned policy (BC over a teacher, RL fine-tune, or self-play). Heuristic-only submissions are rejected at validation time.',
    },
    priority: 200,
  });

  // ── Phase 6: NLP Sequence playbook ──────────────────────────────────────
  fragments[FRAGMENT_KEY_NLP_SEQUENCE] = await ensureFragment(
    db,
    FRAGMENT_ID_NLP_SEQUENCE,
    FRAGMENT_KEY_NLP_SEQUENCE,
    'Kaggle NLP sequence / text classification workflow',
    'kaggle',
    KAGGLE_NLP_SEQUENCE,
  );
  skills[SKILL_ID_NLP] = await ensureSkill(db, {
    id: SKILL_ID_NLP,
    name: 'Kaggle Playbook — NLP Sequence',
    description:
      'HuggingFace transformer-backed playbook for NLP text classification, NER, and seq2seq (summarisation, translation, QA) competitions. Backbone cascade: MiniLM-LM6 (CPU) → RoBERTa-base (T4) → DeBERTa-v3-large (T4x2). Heuristic or TF-IDF baselines are NOT acceptable as the final entry.',
    triggerPatterns: ['*nlp*', '*text-class*', '*sentiment*', '*toxic*', '*spam*', '*qa*', '*summariz*', '*translation*', '*ner*'],
    instructions: `{{>${FRAGMENT_KEY_NLP_SEQUENCE}}}`,
    toolNames: [
      'kaggle_get_competition',
      'kaggle_list_competition_files',
      'kaggle_get_competition_file',
      'kaggle_list_kernels',
      'kaggle_get_kernel_source',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'static_file',
      submissionFormat: 'csv',
      modelTierCascade: ['minilm-lgbm', 'roberta-base', 'deberta-v3-large'],
      gpuRequired: false,
      maxIterations: 8,
      pollIntervalSec: 15,
      kernelWaitMaxTimeoutSec: 600,
    },
    priority: 150,
  });

  // ── Phase 6: Vision CNN playbook ─────────────────────────────────────────
  fragments[FRAGMENT_KEY_VISION_CNN] = await ensureFragment(
    db,
    FRAGMENT_ID_VISION_CNN,
    FRAGMENT_KEY_VISION_CNN,
    'Kaggle computer vision CNN / ViT workflow',
    'kaggle',
    KAGGLE_VISION_CNN,
  );
  skills[SKILL_ID_VISION] = await ensureSkill(db, {
    id: SKILL_ID_VISION,
    name: 'Kaggle Playbook — Vision CNN',
    description:
      'timm/PyTorch pretrained backbone playbook for image classification, object detection, and segmentation competitions. Backbone cascade: EfficientNet-B3 (T4) → B4/ViT-B16 (P100) → B7/ViT-L16 (T4x2). Requires GPU session. From-scratch networks are NOT acceptable.',
    triggerPatterns: ['*image*', '*vision*', '*photo*', '*classify*', '*detection*', '*segmentation*', '*chest-xray*', '*satellite*', '*dermoscopy*'],
    instructions: `{{>${FRAGMENT_KEY_VISION_CNN}}}`,
    toolNames: [
      'kaggle_get_competition',
      'kaggle_list_competition_files',
      'kaggle_get_competition_file',
      'kaggle_list_kernels',
      'kaggle_get_kernel_source',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'static_file',
      submissionFormat: 'csv',
      modelTierCascade: ['efficientnet-b3', 'efficientnet-b4', 'vit-l16'],
      gpuRequired: true,
      maxIterations: 8,
      pollIntervalSec: 20,
      kernelWaitMaxTimeoutSec: 900,
    },
    priority: 160,
  });

  // ── Phase 6: Time Series playbook ────────────────────────────────────────
  fragments[FRAGMENT_KEY_TIME_SERIES] = await ensureFragment(
    db,
    FRAGMENT_ID_TIME_SERIES,
    FRAGMENT_KEY_TIME_SERIES,
    'Kaggle time series forecasting workflow',
    'kaggle',
    KAGGLE_TIME_SERIES,
  );
  skills[SKILL_ID_TIME_SERIES] = await ensureSkill(db, {
    id: SKILL_ID_TIME_SERIES,
    name: 'Kaggle Playbook — Time Series',
    description:
      'LightGBM + lag-feature and statsmodels ETS playbook for univariate and panel time series forecasting competitions. Always uses TimeSeriesSplit — never random KFold. Naive mean/last-value baselines are NOT acceptable as the final entry.',
    triggerPatterns: ['*forecast*', '*time-series*', '*timeseries*', '*demand*', '*energy*', '*sales-predict*', '*store-sales*', '*m5*'],
    instructions: `{{>${FRAGMENT_KEY_TIME_SERIES}}}`,
    toolNames: [
      'kaggle_get_competition',
      'kaggle_list_competition_files',
      'kaggle_get_competition_file',
      'kaggle_list_kernels',
      'kaggle_get_kernel_source',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'static_file',
      submissionFormat: 'csv',
      primaryStrategy: 'lgbm_lag_features',
      fallbackStrategy: 'ets_blend',
      maxIterations: 6,
      pollIntervalSec: 10,
      kernelWaitMaxTimeoutSec: 600,
    },
    priority: 140,
  });

  return { fragments, skills };
}
