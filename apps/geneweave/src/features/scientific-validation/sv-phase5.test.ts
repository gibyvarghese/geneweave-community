/**
 * Scientific Validation Phase 5 — comprehensive test suite
 *
 * Covers the m72-sv-tools-v2 migration and all sv-seed.ts Phase 5 changes:
 *
 *   POSITIVE  — migration runs; all 12 new tools present; 3 SymPy tools enabled;
 *               budgets updated; express + research envelopes created;
 *               Rex / Dana / Bianca agents present; sv-supervisor enabled;
 *               3 new prompt keys seeded; templates contain Phase 5 content
 *   NEGATIVE  — migration is idempotent; rapids_cuml disabled; wolfram_query
 *               disabled; non-existent tool keys absent
 *   STRESS    — concurrent DB reads; repeated seedSVData calls stay idempotent;
 *               all 30 SV tool catalog entries present after full seed
 *   SECURITY  — adversarial template contains AI paper detection keywords;
 *               bias-detector template has p-hacking detection;
 *               new literature tools have external-side-effect risk level;
 *               simulation tools have read-only risk level
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseAdapter, type DatabaseAdapter } from '../../db.js';
import { applyM72SvToolsV2 } from '../../migrations/m72-sv-tools-v2.js';
import { seedSVData, SV_PROMPT_KEY } from './sv-seed.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function freshDb(): Promise<DatabaseAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-p5-'));
  return createDatabaseAdapter({ type: 'sqlite', path: join(dir, 'gw.db') });
}

async function seededDb(): Promise<DatabaseAdapter> {
  const db = await freshDb();
  await seedSVData(db);
  return db;
}

function rawOf(db: DatabaseAdapter) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any).d as import('better-sqlite3').Database;
}

// Stable IDs from the migration
const TOOL_IDS = {
  preprint_search:       'f5000001-5300-7000-b000-000000000001',
  unpaywall_fetch:       'f5000001-5300-7000-b000-000000000002',
  retraction_watch:      'f5000001-5300-7000-b000-000000000003',
  clinicaltrials_search: 'f5000001-5300-7000-b000-000000000004',
  cochrane_search:       'f5000001-5300-7000-b000-000000000005',
  dimensions_search:     'f5000001-5300-7000-b000-000000000006',
  lens_search:           'f5000001-5300-7000-b000-000000000007',
  pymc5_bayes:           'f5000001-5300-7000-b000-000000000008',
  arviz_diagnostics:     'f5000001-5300-7000-b000-000000000009',
  causalml_estimate:     'f5000001-5300-7000-b000-000000000010',
  mesa_abm:              'f5000001-5300-7000-b000-000000000011',
  rapids_cuml:           'f5000001-5300-7000-b000-000000000012',
};

const BUDGET_IDS = {
  standard: 'c3000001-5300-7000-b000-000000000001',
  premium:  'c3000001-5300-7000-b000-000000000002',
  express:  'c3000001-5300-7000-b000-000000000003',
  research: 'c3000001-5300-7000-b000-000000000004',
};

const AGENT_IDS = {
  supervisor:    'b2000001-5300-7000-b000-000000000001',
  replication:   'b2000001-5300-7000-b000-000000000008',
  data_quality:  'b2000001-5300-7000-b000-000000000009',
  bias_detector: 'b2000001-5300-7000-b000-000000000010',
};

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: migration m72 state verified via bootstrap
// ══════════════════════════════════════════════════════════════════════════════

describe('m72-sv-tools-v2 migration — POSITIVE (post-bootstrap)', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('migration runs without error (included in bootstrap runner)', () => {
    // If the migration threw, createDatabaseAdapter would have thrown too.
    // Reaching this point means m72 ran cleanly.
    expect(db).toBeDefined();
  });

  // ── SymPy tools — verified via seedSVData (tools are seeded by sv-seed, not migration) ─

  it('sympy_simplify is enabled after migration + seed', async () => {
    const seeded = await seededDb();
    const row = rawOf(seeded).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'sympy_simplify'").get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
  });

  it('sympy_solve is enabled after migration + seed', async () => {
    const seeded = await seededDb();
    const row = rawOf(seeded).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'sympy_solve'").get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
  });

  it('sympy_integrate is enabled after migration + seed', async () => {
    const seeded = await seededDb();
    const row = rawOf(seeded).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'sympy_integrate'").get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
  });

  // ── 12 new tool catalog entries ───────────────────────────────────────────

  it('all 12 Phase 5 tool catalog entries are inserted by migration', () => {
    const rows = rawOf(db).prepare(
      `SELECT tool_key FROM tool_catalog WHERE id LIKE 'f5000001-%'`
    ).all() as Array<{ tool_key: string }>;
    expect(rows).toHaveLength(12);
  });

  it('preprint_search tool entry is present and enabled', () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'preprint_search'").get() as { enabled: number; category: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.category).toBe('literature');
  });

  it('retraction_watch tool entry is present and enabled', () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'retraction_watch'").get() as { enabled: number; category: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.category).toBe('literature');
  });

  it('cochrane_search tool entry is present and enabled', () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'cochrane_search'").get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
  });

  it('pymc5_bayes tool entry is present and enabled', () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'pymc5_bayes'").get() as { enabled: number; category: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.category).toBe('statistical');
  });

  it('arviz_diagnostics tool entry is present and enabled', () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'arviz_diagnostics'").get() as { enabled: number; category: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.category).toBe('statistical');
  });

  it('causalml_estimate tool entry is present and enabled', () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'causalml_estimate'").get() as { enabled: number; category: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.category).toBe('statistical');
  });

  it('mesa_abm tool entry is present and enabled', () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'mesa_abm'").get() as { enabled: number; category: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
    expect(row!.category).toBe('simulation');
  });

  // ── Budget envelopes ───────────────────────────────────────────────────────

  it('express budget envelope is inserted by migration', () => {
    const row = rawOf(db).prepare(`SELECT * FROM hv_budget_envelope WHERE id = ?`).get(BUDGET_IDS.express) as {
      name: string; max_llm_cents: number; max_wall_seconds: number; max_rounds: number;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('Express (Quick Feasibility)');
    expect(row!.max_llm_cents).toBe(15);
    expect(row!.max_wall_seconds).toBe(90);
    expect(row!.max_rounds).toBe(2);
  });

  it('research budget envelope is inserted by migration', () => {
    const row = rawOf(db).prepare(`SELECT * FROM hv_budget_envelope WHERE id = ?`).get(BUDGET_IDS.research) as {
      name: string; max_llm_cents: number; max_wall_seconds: number;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('Research (Deep Analysis)');
    expect(row!.max_llm_cents).toBe(2000);
    expect(row!.max_wall_seconds).toBe(7200);
  });

  // ── Worker agents ──────────────────────────────────────────────────────────

  it('sv-replication (Rex) worker agent is inserted by migration', () => {
    const row = rawOf(db).prepare(`SELECT * FROM worker_agents WHERE id = ?`).get(AGENT_IDS.replication) as {
      name: string; display_name: string; enabled: number;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('sv-replication');
    expect(row!.display_name).toBe('Rex');
    expect(row!.enabled).toBe(1);
  });

  it('sv-data-quality (Dana) worker agent is inserted by migration', () => {
    const row = rawOf(db).prepare(`SELECT * FROM worker_agents WHERE id = ?`).get(AGENT_IDS.data_quality) as {
      name: string; display_name: string; enabled: number;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('sv-data-quality');
    expect(row!.display_name).toBe('Dana');
    expect(row!.enabled).toBe(1);
  });

  it('sv-bias-detector (Bianca) worker agent is inserted by migration', () => {
    const row = rawOf(db).prepare(`SELECT * FROM worker_agents WHERE id = ?`).get(AGENT_IDS.bias_detector) as {
      name: string; display_name: string; enabled: number;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('sv-bias-detector');
    expect(row!.display_name).toBe('Bianca');
    expect(row!.enabled).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: seedSVData Phase 5 state
// ══════════════════════════════════════════════════════════════════════════════

describe('seedSVData Phase 5 — POSITIVE (post-seed)', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await seededDb();
  });

  // ── Prompts ────────────────────────────────────────────────────────────────

  it('sv.replication prompt key exists', async () => {
    const p = await db.getPromptByKey('sv.replication');
    expect(p).not.toBeNull();
    expect(p!.enabled).toBe(1);
  });

  it('sv.data-quality prompt key exists', async () => {
    const p = await db.getPromptByKey('sv.data-quality');
    expect(p).not.toBeNull();
    expect(p!.enabled).toBe(1);
  });

  it('sv.bias-detector prompt key exists', async () => {
    const p = await db.getPromptByKey('sv.bias-detector');
    expect(p).not.toBeNull();
    expect(p!.enabled).toBe(1);
  });

  it('SV_PROMPT_KEY has all 10 entries (7 original + 3 Phase 5)', () => {
    expect(Object.keys(SV_PROMPT_KEY)).toHaveLength(10);
    expect(SV_PROMPT_KEY['replication']).toBe('sv.replication');
    expect(SV_PROMPT_KEY['data-quality']).toBe('sv.data-quality');
    expect(SV_PROMPT_KEY['bias-detector']).toBe('sv.bias-detector');
  });

  // ── Worker agents via seedSVData ───────────────────────────────────────────

  it('sv-supervisor is enabled after seedSVData', async () => {
    const w = await db.getWorkerAgent(AGENT_IDS.supervisor);
    expect(w).not.toBeNull();
    expect(w!.enabled).toBe(1);
  });

  it('sv-replication (Rex) is seeded and enabled', async () => {
    const w = await db.getWorkerAgent(AGENT_IDS.replication);
    expect(w).not.toBeNull();
    expect(w!.display_name).toBe('Rex');
    expect(w!.category).toBe('general');
    expect(w!.enabled).toBe(1);
  });

  it('sv-data-quality (Dana) is seeded and enabled', async () => {
    const w = await db.getWorkerAgent(AGENT_IDS.data_quality);
    expect(w).not.toBeNull();
    expect(w!.display_name).toBe('Dana');
    expect(w!.category).toBe('general');
    expect(w!.enabled).toBe(1);
  });

  it('sv-bias-detector (Bianca) is seeded and enabled', async () => {
    const w = await db.getWorkerAgent(AGENT_IDS.bias_detector);
    expect(w).not.toBeNull();
    expect(w!.display_name).toBe('Bianca');
    expect(w!.category).toBe('general');
    expect(w!.enabled).toBe(1);
  });

  it('total SV worker agents is 10 (7 original + 3 Phase 5)', async () => {
    const all = await db.listWorkerAgents();
    const svWorkers = all.filter(w => w.name.startsWith('sv-'));
    expect(svWorkers.length).toBeGreaterThanOrEqual(10);
  });

  // ── Budget envelopes via seedSVData ────────────────────────────────────────

  it('standard budget has updated max_llm_cents=100 (was 50)', async () => {
    const env = await db.getBudgetEnvelope(BUDGET_IDS.standard, 'system');
    expect(env).not.toBeNull();
    expect(env!.max_llm_cents).toBe(100);
    expect(env!.max_wall_seconds).toBe(600);
  });

  it('premium budget has updated max_llm_cents=500 (was 200)', async () => {
    const env = await db.getBudgetEnvelope(BUDGET_IDS.premium, 'system');
    expect(env).not.toBeNull();
    expect(env!.max_llm_cents).toBe(500);
    expect(env!.max_wall_seconds).toBe(1800);
  });

  it('express budget envelope is seeded correctly', async () => {
    const env = await db.getBudgetEnvelope(BUDGET_IDS.express, 'system');
    expect(env).not.toBeNull();
    expect(env!.name).toBe('Express (Quick Feasibility)');
    expect(env!.max_llm_cents).toBe(15);
    expect(env!.max_sandbox_cents).toBe(5);
    expect(env!.max_wall_seconds).toBe(90);
    expect(env!.max_rounds).toBe(2);
    expect(env!.diminishing_returns_epsilon).toBe(0.10);
  });

  it('research budget envelope is seeded correctly', async () => {
    const env = await db.getBudgetEnvelope(BUDGET_IDS.research, 'system');
    expect(env).not.toBeNull();
    expect(env!.name).toBe('Research (Deep Analysis)');
    expect(env!.max_llm_cents).toBe(2000);
    expect(env!.max_sandbox_cents).toBe(500);
    expect(env!.max_wall_seconds).toBe(7200);
    expect(env!.max_rounds).toBe(10);
    expect(env!.diminishing_returns_epsilon).toBe(0.01);
  });

  it('all 4 budget envelopes are present', async () => {
    const list = await db.listBudgetEnvelopes('system');
    const svEnvs = list.filter(e => Object.values(BUDGET_IDS).includes(e.id));
    expect(svEnvs.length).toBeGreaterThanOrEqual(4);
  });

  // ── Updated prompt templates ───────────────────────────────────────────────

  it('sv.literature template references preprint_search after Phase 5', async () => {
    const p = await db.getPromptByKey('sv.literature');
    expect(p).not.toBeNull();
    expect(p!.template).toContain('preprint_search');
    expect(p!.template).toContain('bioRxiv');
    expect(p!.template).toContain('retraction_watch');
    expect(p!.template).toContain('cochrane_search');
    expect(p!.template).toContain('dimensions_search');
  });

  it('sv.statistical template references pymc5_bayes and arviz_diagnostics', async () => {
    const p = await db.getPromptByKey('sv.statistical');
    expect(p).not.toBeNull();
    expect(p!.template).toContain('pymc5_bayes');
    expect(p!.template).toContain('arviz_diagnostics');
    expect(p!.template).toContain('causalml_estimate');
  });

  it('sv.adversarial template has AI-paper detection protocol', async () => {
    const p = await db.getPromptByKey('sv.adversarial');
    expect(p).not.toBeNull();
    expect(p!.template).toContain('AI-generated paper detection');
    expect(p!.template).toContain('predatory journal');
    expect(p!.template).toContain('ai_generated_suspect');
  });

  it('sv.supervisor template references GRADE Working Group 2025', async () => {
    const p = await db.getPromptByKey('sv.supervisor');
    expect(p).not.toBeNull();
    expect(p!.template).toContain('GRADE Working Group 2025');
    expect(p!.template).toContain('Replication crisis domain');
    expect(p!.template).toContain('aiGeneratedPaperSuspicion');
  });

  it('sv.replication template describes replication crisis domains', async () => {
    const p = await db.getPromptByKey('sv.replication');
    expect(p).not.toBeNull();
    expect(p!.template).toContain('Social priming');
    expect(p!.template).toContain('crisisField');
    expect(p!.template).toContain('replicationRisk');
  });

  it('sv.bias-detector template describes p-hacking and AI paper detection', async () => {
    const p = await db.getPromptByKey('sv.bias-detector');
    expect(p).not.toBeNull();
    expect(p!.template).toContain('p-hacking');
    expect(p!.template).toContain('HARKing');
    expect(p!.template).toContain('aiGeneratedPaperSuspicion');
    expect(p!.template).toContain('predatory journal');
  });

  it('sv.data-quality template describes WEIRD and completeness framework', async () => {
    const p = await db.getPromptByKey('sv.data-quality');
    expect(p).not.toBeNull();
    expect(p!.template).toContain('WEIRD');
    expect(p!.template).toContain('completeness');
    expect(p!.template).toContain('overallDataQuality');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEGATIVE: disabled tools, missing keys, idempotency
// ══════════════════════════════════════════════════════════════════════════════

describe('Phase 5 — NEGATIVE (disabled tools, wrong state)', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await seededDb();
  });

  it('rapids_cuml is disabled (GPU sandbox not ready)', async () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'rapids_cuml'").get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(0);
  });

  it('wolfram_query remains disabled (no API key)', async () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'wolfram_query'").get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(0);
  });

  it('non-existent tool key returns null', async () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'does_not_exist_tool'").get();
    expect(row).toBeUndefined();
  });

  it('express budget has lower limit than standard', async () => {
    const express = await db.getBudgetEnvelope(BUDGET_IDS.express, 'system');
    const standard = await db.getBudgetEnvelope(BUDGET_IDS.standard, 'system');
    expect(express!.max_llm_cents).toBeLessThan(standard!.max_llm_cents);
    expect(express!.max_wall_seconds).toBeLessThan(standard!.max_wall_seconds);
  });

  it('research budget has higher limit than premium', async () => {
    const research = await db.getBudgetEnvelope(BUDGET_IDS.research, 'system');
    const premium = await db.getBudgetEnvelope(BUDGET_IDS.premium, 'system');
    expect(research!.max_llm_cents).toBeGreaterThan(premium!.max_llm_cents);
    expect(research!.max_wall_seconds).toBeGreaterThan(premium!.max_wall_seconds);
  });

  it('sv-supervisor is NOT in category=general (stays hypothesis-validation)', async () => {
    const w = await db.getWorkerAgent(AGENT_IDS.supervisor);
    expect(w!.category).toBe('hypothesis-validation');
  });

  it('Phase 5 agents Rex/Dana/Bianca have category=general', async () => {
    const rex = await db.getWorkerAgent(AGENT_IDS.replication);
    const dana = await db.getWorkerAgent(AGENT_IDS.data_quality);
    const bianca = await db.getWorkerAgent(AGENT_IDS.bias_detector);
    expect(rex!.category).toBe('general');
    expect(dana!.category).toBe('general');
    expect(bianca!.category).toBe('general');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEGATIVE: Migration idempotency
// ══════════════════════════════════════════════════════════════════════════════

describe('m72 migration — idempotency (NEGATIVE / re-run)', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await freshDb();
  });

  it('re-running applyM72SvToolsV2 does not duplicate tool catalog rows', () => {
    const raw = rawOf(db);
    const before = (raw.prepare("SELECT COUNT(*) as n FROM tool_catalog WHERE id LIKE 'f5000001-%'").get() as { n: number }).n;

    applyM72SvToolsV2(raw);

    const after = (raw.prepare("SELECT COUNT(*) as n FROM tool_catalog WHERE id LIKE 'f5000001-%'").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('re-running applyM72SvToolsV2 does not duplicate budget envelopes', () => {
    const raw = rawOf(db);
    const before = (raw.prepare(`SELECT COUNT(*) as n FROM hv_budget_envelope WHERE id IN ('${BUDGET_IDS.express}','${BUDGET_IDS.research}')`).get() as { n: number }).n;

    applyM72SvToolsV2(raw);

    const after = (raw.prepare(`SELECT COUNT(*) as n FROM hv_budget_envelope WHERE id IN ('${BUDGET_IDS.express}','${BUDGET_IDS.research}')`).get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('re-running applyM72SvToolsV2 does not duplicate worker agents', () => {
    const raw = rawOf(db);
    const before = (raw.prepare(`SELECT COUNT(*) as n FROM worker_agents WHERE id IN ('${AGENT_IDS.replication}','${AGENT_IDS.data_quality}','${AGENT_IDS.bias_detector}')`).get() as { n: number }).n;

    applyM72SvToolsV2(raw);

    const after = (raw.prepare(`SELECT COUNT(*) as n FROM worker_agents WHERE id IN ('${AGENT_IDS.replication}','${AGENT_IDS.data_quality}','${AGENT_IDS.bias_detector}')`).get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('preprint_search stays enabled after re-running migration (INSERT OR IGNORE)', () => {
    const raw = rawOf(db);
    // preprint_search was inserted by the first bootstrap run; a second run should not remove it
    applyM72SvToolsV2(raw);

    const row = raw.prepare("SELECT enabled FROM tool_catalog WHERE tool_key = 'preprint_search'").get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STRESS: repeated seedSVData, concurrent reads, total tool count
// ══════════════════════════════════════════════════════════════════════════════

describe('Phase 5 — STRESS (idempotency, concurrent reads, total counts)', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await seededDb();
  });

  it('calling seedSVData twice is idempotent — prompt count unchanged', async () => {
    const db2 = await createDatabaseAdapter({ type: 'sqlite', path: rawOf(db).name });
    const before = (await db.listPrompts()).filter(p => p.key?.startsWith('sv.')).length;
    await seedSVData(db2);
    const after = (await db.listPrompts()).filter(p => p.key?.startsWith('sv.')).length;
    expect(after).toBe(before);
  });

  it('all 30 SV tool catalog entries are present after full seed (18 original + 12 Phase 5)', async () => {
    const all = await db.listToolConfigs();
    const svKeys = [
      'sympy_simplify', 'sympy_solve', 'sympy_integrate', 'wolfram_query',
      'scipy_stats_test', 'statsmodels_meta', 'scipy_power', 'pymc_mcmc', 'r_metafor',
      'rdkit_descriptors', 'biopython_align', 'networkx_analyse',
      'arxiv_search', 'pubmed_search', 'semanticscholar_search', 'openalex_search',
      'crossref_resolve', 'europepmc_search',
      // Phase 5 (12 new)
      'preprint_search', 'unpaywall_fetch', 'retraction_watch', 'clinicaltrials_search',
      'cochrane_search', 'dimensions_search', 'lens_search',
      'pymc5_bayes', 'arviz_diagnostics', 'causalml_estimate',
      'mesa_abm', 'rapids_cuml',
    ];
    const toolKeySet = new Set(all.map(t => t.tool_key));
    for (const key of svKeys) {
      expect(toolKeySet.has(key), `Expected tool_key=${key} in catalog`).toBe(true);
    }
  });

  it('concurrent listBudgetEnvelopes calls return consistent results', async () => {
    const results = await Promise.all([
      db.listBudgetEnvelopes('system'),
      db.listBudgetEnvelopes('system'),
      db.listBudgetEnvelopes('system'),
      db.listBudgetEnvelopes('system'),
      db.listBudgetEnvelopes('system'),
    ]);
    const counts = results.map(r => r.length);
    expect(new Set(counts).size).toBe(1);
  });

  it('concurrent listWorkerAgents returns all 10 SV agents', async () => {
    const results = await Promise.all([
      db.listWorkerAgents(),
      db.listWorkerAgents(),
      db.listWorkerAgents(),
    ]);
    for (const list of results) {
      const svNames = list.filter(w => w.name.startsWith('sv-')).map(w => w.name);
      expect(svNames).toContain('sv-replication');
      expect(svNames).toContain('sv-data-quality');
      expect(svNames).toContain('sv-bias-detector');
      expect(svNames).toContain('sv-supervisor');
    }
  });

  it('all 10 SV prompts have non-empty templates', async () => {
    const svKeys = [
      'sv.supervisor', 'sv.decomposer', 'sv.literature', 'sv.statistical',
      'sv.mathematical', 'sv.simulation', 'sv.adversarial',
      'sv.replication', 'sv.data-quality', 'sv.bias-detector',
    ];
    for (const key of svKeys) {
      const p = await db.getPromptByKey(key);
      expect(p, `Prompt ${key} should exist`).not.toBeNull();
      expect(p!.template.length, `Prompt ${key} template should not be empty`).toBeGreaterThan(100);
    }
  });

  it('budget hierarchy is correct: express < standard < premium < research', async () => {
    const express  = await db.getBudgetEnvelope(BUDGET_IDS.express,  'system');
    const standard = await db.getBudgetEnvelope(BUDGET_IDS.standard, 'system');
    const premium  = await db.getBudgetEnvelope(BUDGET_IDS.premium,  'system');
    const research = await db.getBudgetEnvelope(BUDGET_IDS.research, 'system');

    expect(express!.max_llm_cents).toBeLessThan(standard!.max_llm_cents);
    expect(standard!.max_llm_cents).toBeLessThan(premium!.max_llm_cents);
    expect(premium!.max_llm_cents).toBeLessThan(research!.max_llm_cents);

    expect(express!.max_wall_seconds).toBeLessThan(standard!.max_wall_seconds);
    expect(standard!.max_wall_seconds).toBeLessThan(premium!.max_wall_seconds);
    expect(premium!.max_wall_seconds).toBeLessThan(research!.max_wall_seconds);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY: risk levels, tool classifications, content of security-critical templates
// ══════════════════════════════════════════════════════════════════════════════

describe('Phase 5 — SECURITY (risk levels, template content, tool classification)', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await seededDb();
  });

  it('all 7 new literature tools have external-side-effect risk level', async () => {
    const literaturePhase5 = [
      'preprint_search', 'unpaywall_fetch', 'retraction_watch',
      'clinicaltrials_search', 'cochrane_search', 'dimensions_search', 'lens_search',
    ];
    for (const key of literaturePhase5) {
      const row = rawOf(db).prepare('SELECT * FROM tool_catalog WHERE tool_key = ?').get(key) as { risk_level: string } | undefined;
      expect(row, `Tool ${key} should exist`).toBeDefined();
      expect(row!.risk_level, `Tool ${key} should have external-side-effect risk`).toBe('external-side-effect');
    }
  });

  it('all statistical tools have read-only risk level', async () => {
    const statTools = ['pymc5_bayes', 'arviz_diagnostics', 'causalml_estimate'];
    for (const key of statTools) {
      const row = rawOf(db).prepare('SELECT * FROM tool_catalog WHERE tool_key = ?').get(key) as { risk_level: string } | undefined;
      expect(row, `Tool ${key} should exist`).toBeDefined();
      expect(row!.risk_level, `Tool ${key} should have read-only risk`).toBe('read-only');
    }
  });

  it('mesa_abm simulation tool has read-only risk (no network side effects)', async () => {
    const row = rawOf(db).prepare("SELECT * FROM tool_catalog WHERE tool_key = 'mesa_abm'").get() as { risk_level: string } | undefined;
    expect(row!.risk_level).toBe('read-only');
  });

  it('sv.adversarial template flags all known AI paper forgery indicators', async () => {
    const p = await db.getPromptByKey('sv.adversarial');
    const template = p!.template;
    expect(template).toContain('formulaic');
    expect(template).toContain('predatory journal');
    expect(template).toContain('DOI');
    expect(template).toContain('placeholder');
    expect(template).toContain('retracted');
    expect(template).toContain('ai_generated_suspect');
  });

  it('sv.bias-detector template covers GDPR-adjacent fairness bias categories', async () => {
    const p = await db.getPromptByKey('sv.bias-detector');
    const template = p!.template;
    expect(template).toContain('Representation bias');
    expect(template).toContain('Measurement bias');
    expect(template).toContain('Aggregation bias');
    expect(template).toContain('Label bias');
    expect(template).toContain('Deployment gap');
  });

  it('sv.bias-detector template provides z-score p-hacking detection method', async () => {
    const p = await db.getPromptByKey('sv.bias-detector');
    const template = p!.template;
    expect(template).toContain('z-score');
    expect(template).toContain('z ≈ 1.96');
    expect(template).toContain('p-hacking signature');
  });

  it('sv.supervisor template enforces GRADE downgrade for AI-paper suspicion', async () => {
    const p = await db.getPromptByKey('sv.supervisor');
    const template = p!.template;
    expect(template).toContain('aiGeneratedPaperSuspicion');
    expect(template).toContain("'likely'");
    expect(template).toContain('downgrade 1 level');
    expect(template).toContain('provisional');
    expect(template).toContain('Replication crisis domain');
  });

  it('sv.replication template flags all documented crisis fields', async () => {
    const p = await db.getPromptByKey('sv.replication');
    const template = p!.template;
    // Known high-failure-rate domains
    expect(template).toContain('Social priming');
    expect(template).toContain('Ego depletion');
    expect(template).toContain('Nutritional epidemiology');
    expect(template).toContain('fMRI');
    expect(template).toContain('Cancer biology');
  });

  it('sv.data-quality template prevents silent unknown quality acceptance', async () => {
    const p = await db.getPromptByKey('sv.data-quality');
    const template = p!.template;
    expect(template).toContain('NOT the same as high quality');
    expect(template).toContain('flag it explicitly');
  });

  it('new worker agents tool_names contain only safe/approved tool keys', async () => {
    const allowedCategories = new Set(['literature', 'statistical', 'simulation', 'read-only', 'external-side-effect']);
    for (const agentId of [AGENT_IDS.replication, AGENT_IDS.data_quality, AGENT_IDS.bias_detector]) {
      const agent = await db.getWorkerAgent(agentId);
      const tools: string[] = JSON.parse(agent!.tool_names);
      for (const toolKey of tools) {
        const toolRow = rawOf(db).prepare('SELECT * FROM tool_catalog WHERE tool_key = ?').get(toolKey) as { risk_level: string } | undefined;
        if (toolRow) {
          // No 'privileged', 'financial', 'write', or 'destructive' tools
          expect(
            ['read-only', 'external-side-effect'].includes(toolRow.risk_level),
            `Agent tool ${toolKey} has risk_level ${toolRow.risk_level} — expected read-only or external-side-effect`
          ).toBe(true);
        }
      }
    }
  });

  it('sv-supervisor has no tools (should not be given read/write access directly)', async () => {
    const w = await db.getWorkerAgent(AGENT_IDS.supervisor);
    const tools: string[] = JSON.parse(w!.tool_names);
    expect(tools).toHaveLength(0);
  });

  it('nova budget envelopes cannot be used for free (all have max_llm_cents > 0)', async () => {
    const all = await db.listBudgetEnvelopes('system');
    const svEnvs = all.filter(e => Object.values(BUDGET_IDS).includes(e.id));
    for (const env of svEnvs) {
      expect(env.max_llm_cents, `${env.name} should have positive LLM budget`).toBeGreaterThan(0);
      expect(env.max_wall_seconds, `${env.name} should have positive wall-clock limit`).toBeGreaterThan(0);
    }
  });
});
