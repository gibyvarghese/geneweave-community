/**
 * Migration m76 — Scope Coverage Expansion
 *
 * Extends scope isolation to all remaining entity types:
 *
 *   worker_agents   — ADD agentic_scope column; UPDATE all 15 rows
 *   tool_catalog    — ADD agentic_scope column; UPDATE all 121 rows by domain
 *   scope_skill_assignments — INSERT 22 internal skill→scope mappings
 *     (6 analytics skills + 16 kaggle agent skills / playbooks)
 *
 * After this migration every entity in the system carries an explicit scope:
 *   a2a_skills (m75)     → seeded with agentic_scope per skill
 *   scope_skill_assignments (m75 + m76) → all 37 skills mapped
 *   worker_agents (m76)  → 14 analytics + 1 code
 *   tool_catalog (m76)   → 39 analytics + 31 kaggle + 14 memory + 9 browser + 4 code + 24 system
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM76ScopeCoverage(db: BetterSqlite3.Database): void {

  // ── 1. Add agentic_scope column to worker_agents ──────────────────────────
  safe(db, `ALTER TABLE worker_agents ADD COLUMN agentic_scope TEXT NOT NULL DEFAULT 'system'`);

  // ── 2. Add agentic_scope column to tool_catalog ───────────────────────────
  safe(db, `ALTER TABLE tool_catalog ADD COLUMN agentic_scope TEXT NOT NULL DEFAULT 'system'`);

  // ── 3. Assign worker agent scopes ─────────────────────────────────────────
  // All SV (scientific validation) sub-agents, the analyst, researcher,
  // statsnz_specialist, and writer all operate in the analytics domain.
  db.prepare(`
    UPDATE worker_agents SET agentic_scope = 'analytics'
    WHERE name IN (
      'analyst', 'researcher', 'statsnz_specialist', 'writer',
      'sv-supervisor', 'sv-decomposer', 'sv-literature', 'sv-statistical',
      'sv-mathematical', 'sv-simulation', 'sv-replication', 'sv-data-quality',
      'sv-bias-detector', 'sv-adversarial'
    )
  `).run();

  // The code executor runs sandboxed Python/R — it lives in the code scope.
  db.prepare(`UPDATE worker_agents SET agentic_scope = 'code' WHERE name = 'code_executor'`).run();

  // ── 4. Assign tool catalog scopes ─────────────────────────────────────────

  // KAGGLE — all kaggle-prefixed tool IDs (kgl00000-0000-4000-8000-*) and
  // the additional kaggle API tools seeded with 019e2059-d251-* IDs.
  db.prepare(`
    UPDATE tool_catalog SET agentic_scope = 'kaggle'
    WHERE id LIKE 'kgl00000-0000-4000-8000-%'
       OR id LIKE '019e2059-d251-%'
  `).run();

  // ANALYTICS — SV science tool suite (f5000001-*) + academic literature
  // search engines + statistical/mathematical libraries + Stats NZ + text analysis.
  db.prepare(`
    UPDATE tool_catalog SET agentic_scope = 'analytics'
    WHERE id LIKE 'f5000001-5300-7000-b000-%'
       OR name IN (
         'arxiv_search', 'pubmed_search', 'europepmc_search',
         'semanticscholar_search', 'openalex_search', 'crossref_resolve',
         'scipy_stats_test', 'scipy_power',
         'sympy_simplify', 'sympy_integrate', 'sympy_solve',
         'wolfram_query',
         'pymc_mcmc', 'r_metafor', 'statsmodels_meta',
         'networkx_analyse', 'rdkit_descriptors', 'biopython_align',
         'text_analysis'
       )
       OR name LIKE 'statsnz_%'
  `).run();

  // CODE — Python/R sandboxed code execution session tools.
  db.prepare(`UPDATE tool_catalog SET agentic_scope = 'code' WHERE name LIKE 'cse_%'`).run();

  // BROWSER — browser automation, web search, and social media tools.
  db.prepare(`
    UPDATE tool_catalog SET agentic_scope = 'browser'
    WHERE name LIKE 'browser_%'
       OR name IN (
         'web_search',
         'social_post', 'social_comments_read', 'social_insights_read'
       )
  `).run();

  // MEMORY — vector/episodic memory recall, knowledge graph, and snapshot tools.
  // Kept in 'memory' scope (not 'system') because memory operations are
  // coordinated through dedicated memory mesh roles; cross-scope access
  // goes through the analytics→memory or * →memory policies.
  db.prepare(`
    UPDATE tool_catalog SET agentic_scope = 'memory'
    WHERE id LIKE 'mem-00000-%'
       OR id LIKE 'tc-memory-%'
       OR id LIKE 'tool-graph-%'
  `).run();

  // SYSTEM (default) — utility tools: datetime, calculator, json_format,
  // timers, stopwatches, reminders, GeneWeave MCP Gateway, workflow control.
  // These already have agentic_scope = 'system' from the DEFAULT, but we
  // set them explicitly here so the intent is part of the migration record.
  db.prepare(`
    UPDATE tool_catalog SET agentic_scope = 'system'
    WHERE name IN (
      'calculator', 'datetime', 'datetime_add', 'timezone_info', 'json_format',
      'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list',
      'stopwatch_start', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'stopwatch_lap',
      'reminder_create', 'reminder_list', 'reminder_cancel',
      'workflow_run', 'checkpoint_list_runs', 'checkpoint_load_run'
    )
       OR name LIKE 'GeneWeave%'
  `).run();

  // ── 5. Insert internal skill → scope assignments ──────────────────────────
  // Analytics-domain internal skills (6 total)
  const analyticsSkills = [
    'skill-data-analysis-execution',
    'skill-equity-thesis',
    'skill-investigation-brief',
    'skill-structured-extraction',
    'skill-tool-orchestrated-analysis',
    'c3000001-5300-7000-b000-000000000001',   // Hypothesis Validation
  ];

  // Kaggle-domain internal skills — 10 agent capability skills + 6 playbooks
  const kaggleSkills = [
    'kgl00000-0000-4000-8002-000000000001',
    'kgl00000-0000-4000-8002-000000000002',
    'kgl00000-0000-4000-8002-000000000003',
    'kgl00000-0000-4000-8002-000000000004',
    'kgl00000-0000-4000-8002-000000000005',
    'kgl00000-0000-4000-8002-000000000006',
    'kgl00000-0000-4000-8002-000000000007',
    'kgl00000-0000-4000-8002-000000000008',
    'kgl00000-0000-4000-8002-000000000009',
    'kgl00000-0000-4000-8002-000000000010',
    'kaggle-playbook-arc-agi-3',
    'kaggle-playbook-default',
    'kaggle-playbook-nlp-sequence',
    'kaggle-playbook-orbit-wars',
    'kaggle-playbook-time-series',
    'kaggle-playbook-vision-cnn',
  ];

  const insertSkill = db.prepare(
    `INSERT OR IGNORE INTO scope_skill_assignments (scope_id, skill_id) VALUES (?, ?)`,
  );

  const insertAll = db.transaction(() => {
    for (const skillId of analyticsSkills) {
      insertSkill.run('analytics', skillId);
    }
    for (const skillId of kaggleSkills) {
      insertSkill.run('kaggle', skillId);
    }
  });

  insertAll();
}
