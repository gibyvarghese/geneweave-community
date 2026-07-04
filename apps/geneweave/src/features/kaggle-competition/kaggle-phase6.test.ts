/**
 * Kaggle Phase 6 — Kaggle Mesh & Playbook Modernization (mid-2026)
 *
 * Covers:
 *   POSITIVE  — m73 migration adds capabilities; 3 new agents in mesh;
 *               new edges present; 3 new playbook skills seeded; 3 new
 *               fragments seeded; updated content contains Phase 6 keywords;
 *               version bump triggers fragment refresh
 *   NEGATIVE  — only designated roles get new capabilities; pre-existing
 *               roles unchanged; new agents have correct handler kinds;
 *               new playbooks enforce baseline quality bars
 *   STRESS    — idempotency of migration; repeated seedLiveMeshDefinitions;
 *               repeated seedKaggleArcPlaybook; concurrent DB reads;
 *               total mesh agents + edges counts correct
 *   SECURITY  — parallel_implementer cannot submit (no KAGGLE_SUBMIT);
 *               debrief has no write tools; observer roles only read;
 *               no SQL injection vectors in playbook content;
 *               new playbooks enforce ML quality (no baselines as final entry)
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { SQLiteAdapter } from '../../db-sqlite.js';
import { applyM73KaggleMeshV2 } from '../../migrations/m73-kaggle-mesh-v2.js';
import { seedKaggleArcPlaybook } from '../../live-agents/kaggle/playbook-seed.js';
import { seedLiveMeshDefinitions } from '../../live-agents/live-mesh-defs-seed.js';
import {
  KAGGLE_NLP_SEQUENCE,
  KAGGLE_VISION_CNN,
  KAGGLE_TIME_SERIES,
  KAGGLE_GENERIC_ML_SOLVER,
  KAGGLE_DEFAULT_DISCOVERY,
  KAGGLE_ARC_AGI_3_WORKFLOW,
} from '../../live-agents/kaggle/playbook-seed-content.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDbPath(): string {
  return `/tmp/gw-phase6-${Date.now()}-${randomUUID()}.db`;
}

async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(makeTempDbPath());
  await db.initialize();
  return db;
}

async function seededDb(): Promise<SQLiteAdapter> {
  const db = await freshDb();
  await db.seedDefaultData();
  await seedLiveMeshDefinitions(db);
  await seedKaggleArcPlaybook(db);
  return db;
}

function rawOf(db: SQLiteAdapter) {
  return db.rawDb;
}

function getCaps(db: SQLiteAdapter, role: string): string[] {
  const raw = rawOf(db);
  const row = raw.prepare<[string], { capabilities: string }>(
    `SELECT capabilities FROM kaggle_role_capabilities WHERE role = ?`,
  ).get(role);
  return row ? (JSON.parse(row.capabilities) as string[]) : [];
}

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: migration m73 — kaggle_role_capabilities updated
// ══════════════════════════════════════════════════════════════════════════════

describe('m73-kaggle-mesh-v2 migration — POSITIVE', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await freshDb(); });

  it('DB initializes without error (m73 runs in bootstrap)', () => {
    expect(db).toBeTruthy();
  });

  it('strategist gains KAGGLE_READ_LEADERBOARD capability', () => {
    const caps = getCaps(db, 'strategist');
    expect(caps).toContain('KAGGLE_READ_LEADERBOARD');
  });

  it('strategist original capabilities preserved (KAGGLE_LIST_KERNELS, KAGGLE_READ_KERNELS)', () => {
    const caps = getCaps(db, 'strategist');
    expect(caps).toContain('KAGGLE_LIST_KERNELS');
    expect(caps).toContain('KAGGLE_READ_KERNELS');
  });

  it('implementer gains KAGGLE_LOCAL_COMPUTE capability', () => {
    const caps = getCaps(db, 'implementer');
    expect(caps).toContain('KAGGLE_LOCAL_COMPUTE');
  });

  it('implementer original capabilities preserved (KAGGLE_PUSH_KERNEL, KAGGLE_READ_KERNELS)', () => {
    const caps = getCaps(db, 'implementer');
    expect(caps).toContain('KAGGLE_PUSH_KERNEL');
    expect(caps).toContain('KAGGLE_READ_KERNELS');
  });

  it('submitter gains KAGGLE_READ_LEADERBOARD capability', () => {
    const caps = getCaps(db, 'submitter');
    expect(caps).toContain('KAGGLE_READ_LEADERBOARD');
  });

  it('submitter original capability preserved (KAGGLE_SUBMIT)', () => {
    const caps = getCaps(db, 'submitter');
    expect(caps).toContain('KAGGLE_SUBMIT');
  });

  it('discoverer capabilities unchanged — no new caps added', () => {
    const caps = getCaps(db, 'discoverer');
    expect(caps).toContain('KAGGLE_LIST_COMPETITIONS');
    expect(caps).toContain('KAGGLE_READ_DATASETS');
    expect(caps).not.toContain('KAGGLE_READ_LEADERBOARD');
    expect(caps).not.toContain('KAGGLE_LOCAL_COMPUTE');
  });

  it('validator capabilities unchanged', () => {
    const caps = getCaps(db, 'validator');
    expect(caps).toContain('KAGGLE_DOWNLOAD_DATA');
    expect(caps).toContain('KAGGLE_LOCAL_COMPUTE');
  });

  it('observer already had KAGGLE_READ_LEADERBOARD — count stays 1', () => {
    const caps = getCaps(db, 'observer');
    expect(caps).toContain('KAGGLE_READ_LEADERBOARD');
    expect(caps).toContain('KAGGLE_READ_SUBMISSIONS');
    const count = caps.filter(c => c === 'KAGGLE_READ_LEADERBOARD').length;
    expect(count).toBe(1);
  });

  it('migration is idempotent — running m73 extra times leaves no duplicates', () => {
    const raw = rawOf(db);
    applyM73KaggleMeshV2(raw);
    applyM73KaggleMeshV2(raw);
    const stratCaps = getCaps(db, 'strategist');
    expect(stratCaps.filter(c => c === 'KAGGLE_READ_LEADERBOARD').length).toBe(1);
    const implCaps = getCaps(db, 'implementer');
    expect(implCaps.filter(c => c === 'KAGGLE_LOCAL_COMPUTE').length).toBe(1);
    const submCaps = getCaps(db, 'submitter');
    expect(submCaps.filter(c => c === 'KAGGLE_READ_LEADERBOARD').length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: live mesh definitions — 3 new agents + 5 new edges
// ══════════════════════════════════════════════════════════════════════════════

describe('seedLiveMeshDefinitions Phase 6 — POSITIVE (new agents + edges)', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => {
    db = await freshDb();
    await db.seedDefaultData();
    await seedLiveMeshDefinitions(db);
  });

  it('kaggle mesh definition exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    expect(mesh).not.toBeNull();
    expect(mesh!.name).toBe('Kaggle Research Mesh');
  });

  it('leaderboard_monitor agent is seeded', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    const lbm = agents.find(a => a.role_key === 'leaderboard_monitor');
    expect(lbm).toBeTruthy();
    expect(lbm!.role_label).toBe('Score Tracker');
    expect(lbm!.default_handler_kind).toBe('kaggle.observer.agentic');
  });

  it('parallel_implementer agent is seeded', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    const pi = agents.find(a => a.role_key === 'parallel_implementer');
    expect(pi).toBeTruthy();
    expect(pi!.role_label).toBe('Multi-Approach Kernel Author');
    expect(pi!.default_handler_kind).toBe('kaggle.implementer.deterministic');
    const config = JSON.parse(pi!.default_handler_config_json ?? '{}');
    expect(config.max_parallel).toBe(3);
  });

  it('debrief agent is seeded', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    const deb = agents.find(a => a.role_key === 'debrief');
    expect(deb).toBeTruthy();
    expect(deb!.role_label).toBe('Run Retrospective');
    expect(deb!.default_handler_kind).toBe('deterministic.template');
  });

  it('total agent count is 9', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    expect(agents.length).toBe(9);
  });

  it('leaderboard_monitor → strategist COLLABORATES_WITH edge exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'leaderboard_monitor' && e.to_role_key === 'strategist',
    );
    expect(edge).toBeTruthy();
    expect(edge!.relationship).toBe('COLLABORATES_WITH');
  });

  it('strategist → parallel_implementer DIRECTS edge exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'strategist' && e.to_role_key === 'parallel_implementer',
    );
    expect(edge).toBeTruthy();
    expect(edge!.relationship).toBe('DIRECTS');
  });

  it('parallel_implementer → validator DIRECTS edge exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'parallel_implementer' && e.to_role_key === 'validator',
    );
    expect(edge).toBeTruthy();
    expect(edge!.relationship).toBe('DIRECTS');
  });

  it('submitter → debrief DIRECTS edge exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'submitter' && e.to_role_key === 'debrief',
    );
    expect(edge).toBeTruthy();
    expect(edge!.relationship).toBe('DIRECTS');
  });

  it('observer → debrief COLLABORATES_WITH edge exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'observer' && e.to_role_key === 'debrief',
    );
    expect(edge).toBeTruthy();
    expect(edge!.relationship).toBe('COLLABORATES_WITH');
  });

  it('total edge count is 10', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    expect(edges.length).toBe(10);
  });

  it('original discoverer → strategist edge still exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'discoverer' && e.to_role_key === 'strategist',
    );
    expect(edge).toBeTruthy();
    expect(edge!.relationship).toBe('DIRECTS');
  });

  it('original implementer → validator edge still exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'implementer' && e.to_role_key === 'validator',
    );
    expect(edge).toBeTruthy();
    expect(edge!.relationship).toBe('DIRECTS');
  });

  it('original validator → submitter edge still exists', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    const edge = edges.find(
      e => e.from_role_key === 'validator' && e.to_role_key === 'submitter',
    );
    expect(edge).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: seedKaggleArcPlaybook — 3 new skills + fragments seeded
// ══════════════════════════════════════════════════════════════════════════════

describe('seedKaggleArcPlaybook Phase 6 — POSITIVE (new skills + updated content)', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await seededDb(); });

  it('NLP sequence skill is seeded', async () => {
    const skill = await db.getSkill('kaggle-playbook-nlp-sequence');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('Kaggle Playbook — NLP Sequence');
    expect(skill!.version).toBe('1.3.0');
  });

  it('Vision CNN skill is seeded', async () => {
    const skill = await db.getSkill('kaggle-playbook-vision-cnn');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('Kaggle Playbook — Vision CNN');
    expect(skill!.version).toBe('1.3.0');
  });

  it('Time Series skill is seeded', async () => {
    const skill = await db.getSkill('kaggle-playbook-time-series');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('Kaggle Playbook — Time Series');
    expect(skill!.version).toBe('1.3.0');
  });

  it('NLP fragment is seeded with correct key', async () => {
    const frag = await db.getPromptFragmentByKey('kaggle.workflow.nlp_sequence');
    expect(frag).not.toBeNull();
    expect(frag!.content).toContain('transformer backbone');
  });

  it('Vision CNN fragment is seeded with correct key', async () => {
    const frag = await db.getPromptFragmentByKey('kaggle.workflow.vision_cnn');
    expect(frag).not.toBeNull();
    expect(frag!.content).toContain('timm');
  });

  it('Time Series fragment is seeded with correct key', async () => {
    const frag = await db.getPromptFragmentByKey('kaggle.workflow.time_series');
    expect(frag).not.toBeNull();
    expect(frag!.content).toContain('TimeSeriesSplit');
  });

  it('DEFAULT_DISCOVERY fragment refreshed to version 1.8.0', async () => {
    const frag = await db.getPromptFragmentByKey('kaggle.workflow.default_discovery');
    expect(frag).not.toBeNull();
    expect(frag!.version).toBe('1.8.0');
  });

  it('existing skills are refreshed to version 1.3.0', async () => {
    const def = await db.getSkill('kaggle-playbook-default');
    const arc = await db.getSkill('kaggle-playbook-arc-agi-3');
    const ow = await db.getSkill('kaggle-playbook-orbit-wars');
    expect(def!.version).toBe('1.3.0');
    expect(arc!.version).toBe('1.3.0');
    expect(ow!.version).toBe('1.3.0');
  });

  it('total kaggle skills count is 6', async () => {
    const raw = rawOf(db);
    const count = (raw.prepare(`SELECT COUNT(*) as c FROM skills WHERE id LIKE 'kaggle-playbook-%'`).get() as { c: number }).c;
    expect(count).toBe(6);
  });

  it('NLP playbook trigger patterns cover key NLP competition slugs', async () => {
    const skill = await db.getSkill('kaggle-playbook-nlp-sequence');
    const triggers: string[] = JSON.parse(skill!.trigger_patterns);
    expect(triggers).toContain('*nlp*');
    expect(triggers).toContain('*sentiment*');
    expect(triggers).toContain('*summariz*');
  });

  it('Vision CNN playbook trigger patterns cover key vision slugs', async () => {
    const skill = await db.getSkill('kaggle-playbook-vision-cnn');
    const triggers: string[] = JSON.parse(skill!.trigger_patterns);
    expect(triggers).toContain('*image*');
    expect(triggers).toContain('*detection*');
    expect(triggers).toContain('*segmentation*');
  });

  it('Time Series playbook trigger patterns cover key forecasting slugs', async () => {
    const skill = await db.getSkill('kaggle-playbook-time-series');
    const triggers: string[] = JSON.parse(skill!.trigger_patterns);
    expect(triggers).toContain('*forecast*');
    expect(triggers).toContain('*demand*');
    expect(triggers).toContain('*m5*');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: content validation — Phase 6 keywords in updated playbooks
// ══════════════════════════════════════════════════════════════════════════════

describe('Phase 6 content validation — POSITIVE', () => {
  it('DEFAULT_DISCOVERY contains GPU tier probe block', () => {
    expect(KAGGLE_DEFAULT_DISCOVERY).toContain('GPU_TIER_PROBE');
    expect(KAGGLE_DEFAULT_DISCOVERY).toContain('nvidia-smi');
    expect(KAGGLE_DEFAULT_DISCOVERY).toContain('Phase 0.6');
  });

  it('GENERIC_ML_SOLVER uses LightGBM as primary tier', () => {
    expect(KAGGLE_GENERIC_ML_SOLVER).toContain('LightGBM');
    expect(KAGGLE_GENERIC_ML_SOLVER).toContain('lgb.LGBMClassifier');
    expect(KAGGLE_GENERIC_ML_SOLVER).toContain('lgb.LGBMRegressor');
  });

  it('GENERIC_ML_SOLVER logs model_tier in AGENT_RESULT (traceability)', () => {
    expect(KAGGLE_GENERIC_ML_SOLVER).toContain('model_tier=');
  });

  it('GENERIC_ML_SOLVER retains HistGBM as fallback', () => {
    expect(KAGGLE_GENERIC_ML_SOLVER).toContain('HistGradientBoosting');
  });

  it('ARC_AGI_3_WORKFLOW contains ARC-AGI-4 awareness note', () => {
    expect(KAGGLE_ARC_AGI_3_WORKFLOW).toContain('ARC-AGI-4');
    expect(KAGGLE_ARC_AGI_3_WORKFLOW).toContain('arc-prize-2026');
  });

  it('NLP playbook requires transformer backbone and names strong models', () => {
    expect(KAGGLE_NLP_SEQUENCE).toContain('MUST use a pretrained transformer backbone');
    expect(KAGGLE_NLP_SEQUENCE).toContain('DeBERTa');
    expect(KAGGLE_NLP_SEQUENCE).toContain('RoBERTa');
  });

  it('Vision CNN playbook requires pretrained backbone and enforces GPU probe', () => {
    expect(KAGGLE_VISION_CNN).toContain('MUST use a pretrained CNN/ViT backbone');
    expect(KAGGLE_VISION_CNN).toContain('GPU probe');
    expect(KAGGLE_VISION_CNN).toContain('timm.create_model');
    expect(KAGGLE_VISION_CNN).toContain('EfficientNet');
  });

  it('Time Series playbook mandates TimeSeriesSplit and lag features', () => {
    expect(KAGGLE_TIME_SERIES).toContain('TimeSeriesSplit');
    expect(KAGGLE_TIME_SERIES).toContain('lag features');
    expect(KAGGLE_TIME_SERIES).toContain('LightGBM');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEGATIVE: invariant preservation
// ══════════════════════════════════════════════════════════════════════════════

describe('Phase 6 — NEGATIVE (invariants preserved)', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await seededDb(); });

  it('leaderboard_monitor is not in kaggle_role_capabilities (mesh agent, not a capability role)', () => {
    const caps = getCaps(db, 'leaderboard_monitor');
    expect(caps).toHaveLength(0);
  });

  it('debrief has no tools in its default_tool_catalog_keys', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    const deb = agents.find(a => a.role_key === 'debrief');
    const keys: string[] = JSON.parse(deb!.default_tool_catalog_keys ?? '[]');
    expect(keys).toHaveLength(0);
  });

  it('NLP playbook priority (150) is less than orbit-wars priority (200)', async () => {
    const nlp = await db.getSkill('kaggle-playbook-nlp-sequence');
    const ow = await db.getSkill('kaggle-playbook-orbit-wars');
    expect(nlp!.priority).toBeLessThan(ow!.priority);
  });

  it('Vision CNN playbook priority (160) is greater than NLP priority (150)', async () => {
    const vision = await db.getSkill('kaggle-playbook-vision-cnn');
    const nlp = await db.getSkill('kaggle-playbook-nlp-sequence');
    expect(vision!.priority).toBeGreaterThan(nlp!.priority);
  });

  it('Time Series priority (140) is less than NLP priority (150)', async () => {
    const ts = await db.getSkill('kaggle-playbook-time-series');
    const nlp = await db.getSkill('kaggle-playbook-nlp-sequence');
    expect(ts!.priority).toBeLessThan(nlp!.priority);
  });

  it('default catch-all playbook priority is 0 — lowest of all playbooks', async () => {
    const def = await db.getSkill('kaggle-playbook-default');
    expect(def!.priority).toBe(0);
  });

  it('NLP playbook explicitly bans bag-of-words / TF-IDF as final submission', () => {
    expect(KAGGLE_NLP_SEQUENCE).toContain('TF-IDF');
    expect(KAGGLE_NLP_SEQUENCE).toContain('bag-of-words');
    expect(KAGGLE_NLP_SEQUENCE).toContain('no bag-of-words or TF-IDF baselines as the final submission');
  });

  it('Vision CNN playbook explicitly bans from-scratch networks', () => {
    expect(KAGGLE_VISION_CNN).toContain('no from-scratch networks');
  });

  it('Time Series playbook explicitly bans naive baselines as final entry', () => {
    expect(KAGGLE_TIME_SERIES).toContain('no naive mean/last-value baselines as the final entry');
  });

  it('Time Series playbook explicitly bans random KFold on temporal data', () => {
    expect(KAGGLE_TIME_SERIES).toContain('never random KFold on temporal data');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STRESS: idempotency + concurrent reads
// ══════════════════════════════════════════════════════════════════════════════

describe('Phase 6 — STRESS (idempotency + concurrent reads)', () => {
  it('migration is idempotent: running m73 3× additional times leaves capabilities unchanged', async () => {
    const db = await freshDb();
    const raw = rawOf(db);
    applyM73KaggleMeshV2(raw);
    applyM73KaggleMeshV2(raw);
    applyM73KaggleMeshV2(raw);
    expect(getCaps(db, 'strategist').filter(c => c === 'KAGGLE_READ_LEADERBOARD').length).toBe(1);
    expect(getCaps(db, 'implementer').filter(c => c === 'KAGGLE_LOCAL_COMPUTE').length).toBe(1);
    await db.close();
  });

  it('repeated seedLiveMeshDefinitions calls are idempotent (agent count stays 9)', async () => {
    const db = await freshDb();
    await db.seedDefaultData();
    await seedLiveMeshDefinitions(db);
    await seedLiveMeshDefinitions(db);
    await seedLiveMeshDefinitions(db);
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    expect(agents.length).toBe(9);
    await db.close();
  });

  it('repeated seedLiveMeshDefinitions calls are idempotent (edge count stays 10)', async () => {
    const db = await freshDb();
    await db.seedDefaultData();
    await seedLiveMeshDefinitions(db);
    await seedLiveMeshDefinitions(db);
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const edges = await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id });
    expect(edges.length).toBe(10);
    await db.close();
  });

  it('repeated seedKaggleArcPlaybook calls are idempotent (total skills = 6)', async () => {
    const db = await freshDb();
    await db.seedDefaultData();
    await seedKaggleArcPlaybook(db);
    await seedKaggleArcPlaybook(db);
    await seedKaggleArcPlaybook(db);
    const raw = rawOf(db);
    const count = (raw.prepare(`SELECT COUNT(*) as c FROM skills WHERE id LIKE 'kaggle-playbook-%'`).get() as { c: number }).c;
    expect(count).toBe(6);
    await db.close();
  });

  it('concurrent listLiveAgentDefinitions reads return consistent results', async () => {
    const db = await seededDb();
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const [r1, r2, r3] = await Promise.all([
      db.listLiveAgentDefinitions({ meshDefId: mesh!.id }),
      db.listLiveAgentDefinitions({ meshDefId: mesh!.id }),
      db.listLiveAgentDefinitions({ meshDefId: mesh!.id }),
    ]);
    expect(r1.length).toBe(9);
    expect(r2.length).toBe(9);
    expect(r3.length).toBe(9);
    await db.close();
  });

  it('concurrent listLiveMeshDelegationEdges reads return consistent results', async () => {
    const db = await seededDb();
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const [r1, r2] = await Promise.all([
      db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id }),
      db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id }),
    ]);
    expect(r1.length).toBe(10);
    expect(r2.length).toBe(10);
    await db.close();
  });

  it('backfill handles pre-Phase-6 mesh: deleting 3 new agents + 5 new edges then re-seeding recreates them', async () => {
    const db = await freshDb();
    await db.seedDefaultData();
    await seedLiveMeshDefinitions(db);

    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const raw = rawOf(db);
    raw.prepare(
      `DELETE FROM live_agent_definitions WHERE mesh_def_id = ? AND role_key IN ('leaderboard_monitor','parallel_implementer','debrief')`
    ).run(mesh!.id);
    raw.prepare(
      `DELETE FROM live_mesh_delegation_edges WHERE mesh_def_id = ? AND (
        (from_role_key = 'strategist'           AND to_role_key = 'parallel_implementer') OR
        (from_role_key = 'parallel_implementer' AND to_role_key = 'validator') OR
        (from_role_key = 'leaderboard_monitor'  AND to_role_key = 'strategist') OR
        (from_role_key = 'submitter'            AND to_role_key = 'debrief') OR
        (from_role_key = 'observer'             AND to_role_key = 'debrief')
      )`
    ).run(mesh!.id);

    expect((await db.listLiveAgentDefinitions({ meshDefId: mesh!.id })).length).toBe(6);
    expect((await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id })).length).toBe(5);

    await seedLiveMeshDefinitions(db);

    expect((await db.listLiveAgentDefinitions({ meshDefId: mesh!.id })).length).toBe(9);
    expect((await db.listLiveMeshDelegationEdges({ meshDefId: mesh!.id })).length).toBe(10);
    await db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY: role separation, no inject vectors, ML baseline enforcement
// ══════════════════════════════════════════════════════════════════════════════

describe('Phase 6 — SECURITY (role separation + content safety)', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await seededDb(); });

  it('submitter is the only role in kaggle_role_capabilities with KAGGLE_SUBMIT', () => {
    const nonSubmitRoles = ['discoverer', 'strategist', 'implementer', 'validator', 'observer'];
    for (const role of nonSubmitRoles) {
      const caps = getCaps(db, role);
      expect(caps, `role ${role} must not have KAGGLE_SUBMIT`).not.toContain('KAGGLE_SUBMIT');
    }
    expect(getCaps(db, 'submitter')).toContain('KAGGLE_SUBMIT');
  });

  it('leaderboard_monitor has only read tool (kaggle_get_competition — no write tools)', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    const lbm = agents.find(a => a.role_key === 'leaderboard_monitor');
    const keys: string[] = JSON.parse(lbm!.default_tool_catalog_keys ?? '[]');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('kaggle_get_competition');
    expect(keys).not.toContain('kaggle_push_kernel');
    expect(keys).not.toContain('kaggle_submit');
  });

  it('debrief agent uses deterministic.template handler (not an agentic LLM loop)', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    const deb = agents.find(a => a.role_key === 'debrief');
    expect(deb!.default_handler_kind).toBe('deterministic.template');
    expect(deb!.default_handler_kind).not.toContain('agentic');
  });

  it('parallel_implementer max_parallel is capped at 3 (no unbounded fan-out)', async () => {
    const mesh = await db.getLiveMeshDefinitionByKey('kaggle');
    const agents = await db.listLiveAgentDefinitions({ meshDefId: mesh!.id });
    const pi = agents.find(a => a.role_key === 'parallel_implementer');
    const cfg = JSON.parse(pi!.default_handler_config_json ?? '{}');
    expect(cfg.max_parallel).toBeLessThanOrEqual(3);
    expect(cfg.max_parallel).toBeGreaterThan(0);
  });

  it('NLP playbook does not contain SQL injection vectors', () => {
    expect(KAGGLE_NLP_SEQUENCE).not.toMatch(/DROP\s+TABLE/i);
    expect(KAGGLE_NLP_SEQUENCE).not.toMatch(/;\s*SELECT/i);
  });

  it('Vision CNN playbook does not contain SQL injection vectors', () => {
    expect(KAGGLE_VISION_CNN).not.toMatch(/DROP\s+TABLE/i);
    expect(KAGGLE_VISION_CNN).not.toMatch(/;\s*SELECT/i);
  });

  it('Time Series playbook does not contain SQL injection vectors', () => {
    expect(KAGGLE_TIME_SERIES).not.toMatch(/DROP\s+TABLE/i);
    expect(KAGGLE_TIME_SERIES).not.toMatch(/;\s*SELECT/i);
  });

  it('GPU probe in DEFAULT_DISCOVERY uses fixed nvidia-smi command (no eval)', () => {
    expect(KAGGLE_DEFAULT_DISCOVERY).toContain('nvidia-smi');
    expect(KAGGLE_DEFAULT_DISCOVERY).toContain('subprocess.run');
    expect(KAGGLE_DEFAULT_DISCOVERY).not.toContain('eval(');
  });

  it('NLP playbook enforces transformer requirement: bans bag-of-words / TF-IDF as final', () => {
    expect(KAGGLE_NLP_SEQUENCE).toContain('MUST use a pretrained transformer backbone');
    expect(KAGGLE_NLP_SEQUENCE).toContain('no bag-of-words or TF-IDF baselines as the final submission');
  });

  it('Vision CNN playbook enforces pretrained backbone: bans from-scratch networks', () => {
    expect(KAGGLE_VISION_CNN).toContain('MUST use a pretrained CNN/ViT backbone');
    expect(KAGGLE_VISION_CNN).toContain('no from-scratch networks');
  });

  it('Time Series playbook enforces TimeSeriesSplit: bans random KFold on temporal data', () => {
    expect(KAGGLE_TIME_SERIES).toContain('TimeSeriesSplit');
    expect(KAGGLE_TIME_SERIES).toContain('never random KFold on temporal data');
  });
});
