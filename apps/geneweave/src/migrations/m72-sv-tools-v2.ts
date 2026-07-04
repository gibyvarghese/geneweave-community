/**
 * m72-sv-tools-v2
 *
 * Phase 5 Scientific Validation Enhancement — mid-2026.
 *
 * Changes:
 *   1. ENABLE 3 SymPy tools (CSE sandbox is now live; placeholder digests resolved)
 *   2. INSERT 12 new SV tool catalog entries:
 *        Literature : preprint_search, unpaywall_fetch, retraction_watch,
 *                     clinicaltrials_search, cochrane_search, dimensions_search, lens_search
 *        Statistical: pymc5_bayes, arviz_diagnostics, causalml_estimate
 *        Simulation : mesa_abm (enabled), rapids_cuml (disabled — GPU sandbox not ready)
 *   3. UPDATE standard budget envelope: max_llm_cents 50→100, max_wall_seconds 300→600
 *   4. UPDATE premium budget envelope: max_llm_cents 200→500, max_wall_seconds 900→1800
 *   5. INSERT 2 new budget envelopes: express (quick feasibility) and research (deep)
 *   6. INSERT 3 new SV specialist worker agents:
 *        Rex (sv-replication), Dana (sv-data-quality), Bianca (sv-bias-detector)
 *   7. UPDATE sv-supervisor: enabled=1 for standalone A2A skill usage
 */

import type BetterSqlite3 from 'better-sqlite3';

// ── Stable UUIDs (idempotent across re-runs) ─────────────────────────────────

/** tool_catalog IDs for 12 new Phase 5 tools. */
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

/** hv_budget_envelope IDs for 2 new Phase 5 envelopes. */
const NEW_BUDGET_IDS = {
  express:  'c3000001-5300-7000-b000-000000000003',
  research: 'c3000001-5300-7000-b000-000000000004',
};

/** hv_budget_envelope IDs for existing envelopes to update. */
const EXISTING_BUDGET_IDS = {
  standard: 'c3000001-5300-7000-b000-000000000001',
  premium:  'c3000001-5300-7000-b000-000000000002',
};

/** worker_agents IDs for 3 new Phase 5 specialists. */
const NEW_AGENT_IDS = {
  replication:   'b2000001-5300-7000-b000-000000000008',
  data_quality:  'b2000001-5300-7000-b000-000000000009',
  bias_detector: 'b2000001-5300-7000-b000-000000000010',
};

const SV_SUPERVISOR_ID = 'b2000001-5300-7000-b000-000000000001';

// ── Tool catalog rows ─────────────────────────────────────────────────────────

interface ToolRow {
  id: string; tool_key: string; name: string; description: string;
  category: string; risk_level: string; enabled: number; tags: string;
}

const PHASE5_TOOLS: ToolRow[] = [
  // ── Literature (7) ────────────────────────────────────────────────────────
  {
    id: TOOL_IDS.preprint_search, tool_key: 'preprint_search',
    name: 'Preprint Search (bioRxiv / medRxiv / chemRxiv)',
    description: 'Search bioRxiv, medRxiv, and chemRxiv for recent preprints not yet indexed in peer-reviewed databases. Essential for rapidly evolving fields (ML, genomics, climate, COVID-era medicine).',
    category: 'literature', risk_level: 'external-side-effect', enabled: 1,
    tags: JSON.stringify(['literature', 'biorxiv', 'medrxiv', 'preprint', 'external']),
  },
  {
    id: TOOL_IDS.unpaywall_fetch, tool_key: 'unpaywall_fetch',
    name: 'Unpaywall Full-Text Fetch',
    description: 'Retrieve open-access full-text of an article via Unpaywall using its DOI. Covers ~50% of all scholarly articles published since 2010.',
    category: 'literature', risk_level: 'external-side-effect', enabled: 1,
    tags: JSON.stringify(['literature', 'unpaywall', 'full-text', 'open-access', 'external']),
  },
  {
    id: TOOL_IDS.retraction_watch, tool_key: 'retraction_watch',
    name: 'Retraction Watch Lookup',
    description: 'Check whether a paper has been retracted or issued an expression of concern using the Retraction Watch database (~50k retraction records).',
    category: 'literature', risk_level: 'external-side-effect', enabled: 1,
    tags: JSON.stringify(['literature', 'retraction', 'quality-check', 'integrity', 'external']),
  },
  {
    id: TOOL_IDS.clinicaltrials_search, tool_key: 'clinicaltrials_search',
    name: 'ClinicalTrials.gov Search',
    description: 'Search ClinicalTrials.gov for registered clinical trials relevant to medical, pharmaceutical, or public-health hypotheses.',
    category: 'literature', risk_level: 'external-side-effect', enabled: 1,
    tags: JSON.stringify(['literature', 'clinical-trials', 'medical', 'rct', 'external']),
  },
  {
    id: TOOL_IDS.cochrane_search, tool_key: 'cochrane_search',
    name: 'Cochrane Library Search',
    description: 'Search the Cochrane Library for systematic reviews and meta-analyses — the gold standard for medical evidence synthesis.',
    category: 'literature', risk_level: 'external-side-effect', enabled: 1,
    tags: JSON.stringify(['literature', 'cochrane', 'systematic-review', 'meta-analysis', 'external']),
  },
  {
    id: TOOL_IDS.dimensions_search, tool_key: 'dimensions_search',
    name: 'Dimensions.ai Search',
    description: 'Search Dimensions.ai — now larger than Semantic Scholar for biomedical literature — with grant, patent, and clinical-trial cross-links.',
    category: 'literature', risk_level: 'external-side-effect', enabled: 1,
    tags: JSON.stringify(['literature', 'dimensions', 'biomedical', 'cross-database', 'external']),
  },
  {
    id: TOOL_IDS.lens_search, tool_key: 'lens_search',
    name: 'The Lens Scholarly Search',
    description: 'Search The Lens open scholarly database, which aggregates PubMed, Crossref, Microsoft Academic, and CORE with free full-text where available.',
    category: 'literature', risk_level: 'external-side-effect', enabled: 1,
    tags: JSON.stringify(['literature', 'lens', 'open-access', 'aggregator', 'external']),
  },
  // ── Statistical (3) ──────────────────────────────────────────────────────
  {
    id: TOOL_IDS.pymc5_bayes, tool_key: 'pymc5_bayes',
    name: 'PyMC 5.x Bayesian Inference',
    description: 'Bayesian posterior inference via PyMC 5.x (breaking API change from PyMC 4). Uses pm.sample() with JAX backend for faster sampling. Preferred over pymc_mcmc for new analyses.',
    category: 'statistical', risk_level: 'read-only', enabled: 1,
    tags: JSON.stringify(['statistics', 'bayesian', 'mcmc', 'pymc5', 'sandbox']),
  },
  {
    id: TOOL_IDS.arviz_diagnostics, tool_key: 'arviz_diagnostics',
    name: 'ArviZ 0.18+ MCMC Diagnostics',
    description: 'Compute MCMC convergence diagnostics (R-hat, ESS, MCSE) and posterior predictive checks via ArviZ 0.18+. Pairs with pymc5_bayes or pymc_mcmc output.',
    category: 'statistical', risk_level: 'read-only', enabled: 1,
    tags: JSON.stringify(['statistics', 'bayesian', 'diagnostics', 'arviz', 'sandbox']),
  },
  {
    id: TOOL_IDS.causalml_estimate, tool_key: 'causalml_estimate',
    name: 'Causal ML Estimation (DoWhy / EconML)',
    description: 'Causal effect estimation using DoWhy identification + EconML estimation (DML, IV, DRIV). For RCT data or quasi-experimental designs with observational confounding.',
    category: 'statistical', risk_level: 'read-only', enabled: 1,
    tags: JSON.stringify(['statistics', 'causal-inference', 'dowhy', 'econml', 'sandbox']),
  },
  // ── Simulation (2) ───────────────────────────────────────────────────────
  {
    id: TOOL_IDS.mesa_abm, tool_key: 'mesa_abm',
    name: 'Mesa Agent-Based Model (ABM)',
    description: 'Run agent-based models using Mesa 3.x (Python). Useful for simulating emergent social, ecological, or economic phenomena as per hypothesis.',
    category: 'simulation', risk_level: 'read-only', enabled: 1,
    tags: JSON.stringify(['simulation', 'agent-based', 'mesa', 'emergence', 'sandbox']),
  },
  {
    id: TOOL_IDS.rapids_cuml, tool_key: 'rapids_cuml',
    name: 'RAPIDS cuML (GPU-accelerated ML)',
    description: 'GPU-accelerated ML for large-scale simulation via RAPIDS cuML. Disabled until GPU sandbox infrastructure is available.',
    category: 'simulation', risk_level: 'read-only', enabled: 0,
    tags: JSON.stringify(['simulation', 'gpu', 'rapids', 'cuml', 'sandbox', 'disabled']),
  },
];

// ── Worker agent rows ─────────────────────────────────────────────────────────

interface AgentRow {
  id: string; name: string; display_name: string; job_profile: string;
  description: string; tool_names: string; category: string; enabled: number;
}

const PHASE5_AGENTS: AgentRow[] = [
  {
    id: NEW_AGENT_IDS.replication,
    name: 'sv-replication',
    display_name: 'Rex',
    job_profile: 'Replication Validator',
    description:
      'USE FOR hypothesis validation — assesses whether supporting studies have been independently replicated, checks for pre-registration, and flags claims from replication-crisis domains (social priming, nutritional epidemiology, underpowered fMRI). Returns structured replication risk assessment.',
    tool_names: JSON.stringify(['pubmed_search', 'semanticscholar_search', 'arxiv_search', 'retraction_watch']),
    category: 'general',
    enabled: 1,
  },
  {
    id: NEW_AGENT_IDS.data_quality,
    name: 'sv-data-quality',
    display_name: 'Dana',
    job_profile: 'Data Quality Agent',
    description:
      'USE FOR hypothesis validation — evaluates the completeness, measurement validity, selection bias, and temporal validity of the data underlying sub-claims. Applies WEIRD-population and MCAR/MAR/MNAR missing-data frameworks. Returns structured data quality grades.',
    tool_names: JSON.stringify(['semanticscholar_search', 'arxiv_search', 'cse_run_code']),
    category: 'general',
    enabled: 1,
  },
  {
    id: NEW_AGENT_IDS.bias_detector,
    name: 'sv-bias-detector',
    display_name: 'Bianca',
    job_profile: 'Bias & Fairness Agent',
    description:
      'USE LATE in hypothesis validation — detects p-hacking, HARKing, publication bias, AI-generated paper fabrication, and fairness/representation bias. Computes z-score landscape for p-value clustering and flags 2026-era AI-paper red flags. Returns structured bias assessment.',
    tool_names: JSON.stringify(['pubmed_search', 'semanticscholar_search', 'arxiv_search', 'cse_run_code']),
    category: 'general',
    enabled: 1,
  },
];

// ── Migration entry point ─────────────────────────────────────────────────────

export function applyM72SvToolsV2(db: BetterSqlite3.Database): void {

  // ── 1. Enable SymPy tools (CSE sandbox live) ─────────────────────────────

  const sympy_keys = ['sympy_simplify', 'sympy_solve', 'sympy_integrate'];
  const enableTool = db.prepare(`UPDATE tool_catalog SET enabled = 1 WHERE tool_key = ? AND enabled = 0`);
  for (const key of sympy_keys) {
    enableTool.run(key);
  }

  // ── 2. Insert 12 new tool catalog entries ────────────────────────────────

  const insertTool = db.prepare(`
    INSERT OR IGNORE INTO tool_catalog
      (id, tool_key, name, description, category, risk_level,
       requires_approval, max_execution_ms, rate_limit_per_min,
       enabled, version, side_effects, tags, source)
    VALUES
      (?, ?, ?, ?, ?, ?,
       0, 60000, 30,
       ?, '1.0', 0, ?, 'builtin')
  `);

  const insertAllTools = db.transaction(() => {
    for (const t of PHASE5_TOOLS) {
      insertTool.run(t.id, t.tool_key, t.name, t.description, t.category, t.risk_level, t.enabled, t.tags);
    }
  });
  insertAllTools();

  // ── 3. Update existing budget envelopes ──────────────────────────────────
  // These updates only take effect on existing installs. Fresh installs get
  // the correct values via _seedDefaultBudgetEnvelopes in sv-seed.ts.

  db.prepare(`
    UPDATE hv_budget_envelope
       SET max_llm_cents = 100, max_wall_seconds = 600
     WHERE id = ? AND max_llm_cents = 50
  `).run(EXISTING_BUDGET_IDS.standard);

  db.prepare(`
    UPDATE hv_budget_envelope
       SET max_llm_cents = 500, max_wall_seconds = 1800
     WHERE id = ? AND max_llm_cents = 200
  `).run(EXISTING_BUDGET_IDS.premium);

  // ── 4. Insert 2 new budget envelopes ─────────────────────────────────────

  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO hv_budget_envelope
      (id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds,
       max_rounds, diminishing_returns_epsilon, created_at)
    VALUES (?, 'system', 'Express (Quick Feasibility)', 15, 5, 90, 2, 0.10, ?)
  `).run(NEW_BUDGET_IDS.express, now);

  db.prepare(`
    INSERT OR IGNORE INTO hv_budget_envelope
      (id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds,
       max_rounds, diminishing_returns_epsilon, created_at)
    VALUES (?, 'system', 'Research (Deep Analysis)', 2000, 500, 7200, 10, 0.01, ?)
  `).run(NEW_BUDGET_IDS.research, now);

  // ── 5. Insert 3 new SV worker agents ─────────────────────────────────────

  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO worker_agents
      (id, name, display_name, job_profile, description,
       system_prompt, tool_names, persona, trigger_patterns,
       task_contract_id, max_retries, priority, category, enabled)
    VALUES (?, ?, ?, ?, ?, '', ?, 'agent_worker', NULL, NULL, 0, 0, ?, ?)
  `);

  const insertAllAgents = db.transaction(() => {
    for (const a of PHASE5_AGENTS) {
      insertAgent.run(a.id, a.name, a.display_name, a.job_profile, a.description, a.tool_names, a.category, a.enabled);
    }
  });
  insertAllAgents();

  // ── 6. Enable sv-supervisor for A2A skill usage ───────────────────────────

  db.prepare(`
    UPDATE worker_agents SET enabled = 1 WHERE id = ? AND enabled = 0
  `).run(SV_SUPERVISOR_ID);
}
