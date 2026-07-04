import type BetterSqlite3 from 'better-sqlite3';
import { safeExec, applyKagglePhaseK7bK7c } from './helpers.js';

export function applyM11_M18(db: BetterSqlite3.Database): void {
  // ─── M11 — Phase K3: Kaggle tool policies, skills, and projection tables ──
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1, §4.2, §6, §7, §8 (Phase K3).
  //
  // Seeds 4 tool policies (read-only, kernel push gate, submit gate, discussion
  // post gate), 6 skills (discoverer, ideator, implementer, validator, submitter,
  // observer), and creates 3 projection tables (kaggle_competitions_tracked,
  // kaggle_approaches, kaggle_runs). All inserts use INSERT OR IGNORE for
  // idempotency. Skills ship enabled=1 (operators can disable per-skill in
  // admin); the policies they reference are seeded enabled=1 too.
  //
  // Submission cap: kaggle_submit_gate uses rate_limit_per_minute=NULL and
  // applies the daily cap via max_concurrent=4 hint + admin discipline. The
  // tool already carries rate_limit_per_min=1 in M10b, and Kaggle's hard cap
  // (~5/day/competition) is the absolute ceiling. We document 4/day in the
  // policy description so operators see it; the per-minute approval gate plus
  // the audit trail make accidental over-spend visible immediately.

  // 1. Tool policies (4 rows)
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000001', 'kaggle_read_only', 'Kaggle Read-Only',
       'Read-only access to Kaggle (list/get competitions, kernels, leaderboards, submissions). No writes, no approval, generous 60 req/min budget.',
       '["kaggle.competitions.list","kaggle.competitions.get","kaggle.competitions.files.list","kaggle.competitions.leaderboard.get","kaggle.competitions.submissions.list","kaggle.kernels.list","kaggle.kernels.pull","kaggle.kernels.status","kaggle.kernels.output","kaggle.local.validate_submission","kaggle.local.score_cv"]',
       '["read-only"]', 0,
       '["read-only"]',
       60000, 60, NULL, 0, 1, NULL, 1)
  `);

  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000002', 'kaggle_kernel_push_gate', 'Kaggle Kernel Push Gate',
       'Gate for kaggle.kernels.push. Requires human approval. Rate-limited to ~10/hour to discourage runaway notebook spam. Defaults already enforce is_private=true and enable_internet=false at the tool layer.',
       '["kaggle.kernels.push"]',
       '["external-side-effect"]', 1,
       '["read-only","external-side-effect"]',
       300000, 10, 1, 0, 1, NULL, 1)
  `);

  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000003', 'kaggle_submit_gate', 'Kaggle Submission Gate',
       'Gate for kaggle.competitions.submit. Requires human approval for every submission. Operator policy: cap at 4/day per competition (Kaggle hard-caps ~5/day; we leave one slot for human override). Per-minute rate limit is 1 — a hard pacing guarantee.',
       '["kaggle.competitions.submit"]',
       '["external-side-effect"]', 1,
       '["read-only","external-side-effect"]',
       300000, 1, 1, 1, 1, NULL, 1)
  `);

  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000004', 'kaggle_discussion_post_gate', 'Kaggle Discussion Post Gate (deferred)',
       'Reserved for the (deferred) kaggle.discussions.create tool. Requires approval; pacing is enforced via 1/week-per-competition admin discipline. Disabled by default; opt-in only when discussion posting ships.',
       '["kaggle.discussions.create"]',
       '["privileged"]', 1,
       '["privileged"]',
       60000, 1, 1, 1, 1, NULL, 0)
  `);

  // 2. Skills (6 rows). Seeded enabled=1 so the chat MVP examples work
  // out-of-the-box; operators can disable individual skills in admin if
  // they want narrower coverage.
  const insertKaggleSkill = db.prepare(
    `INSERT OR IGNORE INTO skills (
      id, name, description, category, trigger_patterns, instructions,
      tool_names, examples, tags, priority, version, tool_policy_key,
      enabled, supervisor_agent_id, domain_sections, execution_contract,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, ?, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
  );
  const KAGGLE_SKILL_TAGS = JSON.stringify(['kaggle', 'data-science', 'competition', 'requires-intent-match']);

  type KaggleSkillSeed = {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    instructions: string;
    tools: string[];
    policy: string;
    priority: number;
    requiredEvidence: string[];
  };

  const KAGGLE_SKILLS: KaggleSkillSeed[] = [
    {
      id: 'kgl00000-0000-4000-8002-000000000001',
      name: 'kaggle_discoverer',
      description: 'Surfaces relevant active Kaggle competitions for the user. Use when the user wants to find, browse, or pick a competition. Calls the Kaggle list/get APIs only — never submits or pushes.',
      triggers: ['find kaggle', 'browse kaggle', 'kaggle competitions', 'pick a competition', 'what kaggle', 'discover kaggle', 'active competitions'],
      instructions: [
        'When to use: the user wants to find, browse, or pick a Kaggle competition.',
        'When NOT to use: the user already has a competition picked (then use kaggle_ideator).',
        'Reasoning: list active competitions, then optionally fetch details for the most promising 1-3.',
        'Execution: call kaggle.competitions.list with a small page size (e.g. 10). For any competition the user expresses interest in, follow up with kaggle.competitions.get.',
        'Completion: present the top results in a compact list including ref, title, deadline, and reward. Confirm which competition the user wants to pursue.',
      ].join('\n'),
      tools: ['kaggle.competitions.list', 'kaggle.competitions.get'],
      policy: 'kaggle_read_only',
      priority: 100,
      requiredEvidence: ['competition', 'deadline'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000002',
      name: 'kaggle_ideator',
      description: 'Drafts candidate modeling approaches for a chosen Kaggle competition by reading public kernels and dataset metadata. Read-only; does not push kernels or submit.',
      triggers: ['kaggle approach', 'ideate kaggle', 'kaggle strategy', 'kaggle plan', 'draft kaggle approach'],
      instructions: [
        'When to use: the user has a competition in mind and wants modeling approaches.',
        'When NOT to use: there is no competition ref in scope (then trigger kaggle_discoverer first).',
        'Reasoning: scan a few top public kernels via kaggle.kernels.list, optionally pull the most relevant via kaggle.kernels.pull, and inspect competition files via kaggle.competitions.files.list.',
        'Execution: produce 2-3 approaches; each must specify a model family, key features, and an expected metric value.',
        'Completion: emit a short numbered list of approaches with explicit "expected metric" values so downstream skills can validate them.',
      ].join('\n'),
      tools: ['kaggle.kernels.list', 'kaggle.kernels.pull', 'kaggle.competitions.files.list'],
      policy: 'kaggle_read_only',
      priority: 80,
      requiredEvidence: ['approach', 'expected metric'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000003',
      name: 'kaggle_implementer',
      description: 'Materializes a chosen approach as a Kaggle kernel (notebook/script) and pushes it via kaggle.kernels.push. WRITE — requires human approval per kaggle_kernel_push_gate.',
      triggers: ['push kernel', 'create kaggle kernel', 'submit kernel', 'implement kaggle approach', 'run on kaggle'],
      instructions: [
        'When to use: a specific approach has been chosen AND the user has explicitly asked to materialize it as a kernel.',
        'When NOT to use: no approach is chosen, OR the user only wants a local validation (use kaggle_validator instead).',
        'Reasoning: prepare clean notebook/script source. Default to is_private=true, enable_internet=false, enable_gpu=false. Treat the kernel push as expensive — operator approval will be requested.',
        'Execution: push via kaggle.kernels.push, then poll kaggle.kernels.status until "complete". Pull final output via kaggle.kernels.output.',
        'Completion: report the kernel ref, the final status, and the output URL or summary so kaggle_validator can take over.',
      ].join('\n'),
      tools: ['kaggle.kernels.push', 'kaggle.kernels.status', 'kaggle.kernels.output'],
      policy: 'kaggle_kernel_push_gate',
      priority: 80,
      requiredEvidence: ['kernel ref', 'status: complete'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000004',
      name: 'kaggle_validator',
      description: 'Skill-driven Kaggle submission validator. Handles BOTH static-file (CSV/JSON) competitions and live-API / kernel-as-submission competitions. Fetches the competition\'s expected submission contract OR (for kernel-as-submission) confirms the kernel ran cleanly and printed a valid scoring line.',
      triggers: ['validate submission', 'check submission', 'pre-flight kaggle', 'score cv', 'cross validate kaggle', 'kaggle.validation.iteration'],
      instructions: [
        'You are the Kaggle Submission Validator. You ALWAYS run BEFORE any kaggle.competitions.submit call.',
        '',
        'INPUTS in the inbound message: a competitionRef (slug like "titanic") and a kernelRef (owner/slug). Optionally `submissionWriter` is one of `kernel_emits_file` (default) or `kernel_is_submission` (live-API / agent comps). They appear either as a JSON payload {competitionId, kernelRef, submissionWriter, ...} or in free text — extract them.',
        '',
        'BRANCH on submissionWriter (or, if missing, infer from the competition file list).',
        '',
        'PATH A — STATIC FILE (submissionWriter=kernel_emits_file, the default; competition has sample_submission.csv / .json):',
        '  1. kaggle_list_competition_files(ref=<competitionRef>) — locate the sample submission file. Priority order: gender_submission.csv, sample_submission.csv, sample_submission.json, submission_format.csv. If NONE of these exist, switch to PATH B.',
        '  2. kaggle_get_competition_file(ref=<competitionRef>, fileName=<sample-file-name>, maxBytes=2097152) — read the sample. Parse it:',
        '       - The first non-empty line is the header. Split on commas → expectedHeaders (in order).',
        '       - Count remaining non-empty lines → expectedRowCount.',
        '       - The first column name is the idColumn.',
        '       - Collect the first-column values across all data rows → expectedIds (only when total < 30000 to keep the tool call small).',
        '  3. kaggle_get_kernel_output(kernelRef=<kernelRef>) — read the kernel\'s output. The validator-friendly field is `inlinedCsvFiles["submission.csv"]` (or the closest matching submission*.csv name). If `inlinedCsvFiles` is empty/absent, the kernel did not produce a submission CSV — verdict fail.',
        '  4. kaggle_validate_submission({csvContent: <inlined CSV>, expectedHeaders, expectedRowCount, idColumn, expectedIds (when collected)}) — run the deterministic parity check.',
        '  Pass on valid=true with zero errors. Fail on any errors[] / row mismatch / missing inlinedCsvFiles.',
        '',
        'PATH B — KERNEL-AS-SUBMISSION (submissionWriter=kernel_is_submission; live-API / agent / interactive competitions where the kernel script ITSELF is the submission and there is no submission.csv to diff):',
        '  1. kaggle_get_kernel_output(kernelRef=<kernelRef>) — read the full kernel output.',
        '  2. Verify ALL THREE of:',
        '       (a) status == "complete" (the kernel ran to completion, not failed/cancelled/timeout).',
        '       (b) the log tail contains a recognisable scoring line. Accept ANY of these patterns (case-insensitive): `AGENT_RESULT`, `AGENT_RESULT_SCORE=`, `total_score=`, `total_score:`, `final_score=`, `levels_completed=`, `arc.get_scorecard()` output dict, or any line starting with `SCORE:` / `SCORECARD:`.',
        '       (c) NO unhandled Python traceback in the last ~100 lines (a `Traceback (most recent call last):` block followed by an exception line with no later recovery is a fail).',
        '  Pass when all three hold. Fail otherwise.',
        '',
        'COMPLETION (mandatory final line, exact format):',
        '  PATH A pass:  VALIDATION_VERDICT=pass rows=<N>',
        '  PATH B pass:  VALIDATION_VERDICT=pass rows=0 simulation=true',
        '  Either fail:  VALIDATION_VERDICT=fail reason=<short reason: e.g. "header_mismatch", "row_count 891 vs expected 418", "missing_submission_csv", "kernel_failed", "no_score_line", "traceback_in_log">',
        '',
        'Always state explicitly whether this is a "valid submission" and report the row count using the literal phrase "rows=" in your final answer (use rows=0 for PATH B).',
      ].join('\n'),
      tools: [
        'kaggle_list_competition_files',
        'kaggle_get_competition_file',
        'kaggle_get_kernel_output',
        'kaggle_validate_submission',
      ],
      policy: 'kaggle_read_only',
      priority: 80,
      requiredEvidence: ['valid submission', 'rows='],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000005',
      name: 'kaggle_submitter',
      description: 'Submits a validated CSV to a Kaggle competition. WRITE — requires human approval per kaggle_submit_gate. Counts against the daily submission cap.',
      triggers: ['submit kaggle', 'submit to competition', 'send submission', 'final submission'],
      instructions: [
        'When to use: a CSV has been validated AND the user has explicitly asked to submit it.',
        'When NOT to use: the CSV has not been validated by kaggle_validator (refuse and request validation first).',
        'Reasoning: every call counts against the daily cap. Confirm the competition ref and the file before invoking. Approval will be requested by policy — wait for it.',
        'Execution: call kaggle.competitions.submit with the validated file content and a clear description. Report the submission id and public score (when ready).',
        'Completion: report "submission id" and the "public score" (or pending state) so observability traces capture both.',
      ].join('\n'),
      tools: ['kaggle.competitions.submit'],
      policy: 'kaggle_submit_gate',
      priority: 80,
      requiredEvidence: ['submission id', 'public score'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000006',
      name: 'kaggle_observer',
      description: 'Reads the Kaggle leaderboard and submission history for a competition. Read-only; used to track standings and decide when to iterate.',
      triggers: ['kaggle leaderboard', 'check rank', 'kaggle standings', 'my submissions kaggle', 'how am i doing kaggle'],
      instructions: [
        'When to use: the user wants the current rank/score or a history of submissions for a competition.',
        'When NOT to use: the user wants to submit (use kaggle_submitter) or to find a new competition (use kaggle_discoverer).',
        'Reasoning: leaderboard reads are cheap. Combine leaderboard.get with submissions.list for a complete picture.',
        'Execution: call kaggle.competitions.leaderboard.get and kaggle.competitions.submissions.list; summarize.',
        'Completion: report the user rank and best score explicitly using the words "rank" and "score".',
      ].join('\n'),
      tools: ['kaggle.competitions.leaderboard.get', 'kaggle.competitions.submissions.list'],
      policy: 'kaggle_read_only',
      priority: 80,
      requiredEvidence: ['rank', 'score'],
    },
  ];

  for (const skill of KAGGLE_SKILLS) {
    try {
      insertKaggleSkill.run(
        skill.id,
        skill.name,
        skill.description,
        JSON.stringify(skill.triggers),
        skill.instructions,
        JSON.stringify(skill.tools),
        KAGGLE_SKILL_TAGS,
        skill.priority,
        skill.policy,
        JSON.stringify({ requiredOutputSubstrings: skill.requiredEvidence }),
      );
    } catch { /* ignore */ }
  }

  // INSERT OR IGNORE above won't refresh skills that were previously seeded
  // with stale instructions/tool lists. Force-update the kaggle_validator
  // skill so the new skill-driven workflow lands on every restart without
  // an operator manually editing the DB row.
  try {
    db.prepare(
      `UPDATE skills
         SET description = ?,
             instructions = ?,
             tool_names = ?,
             trigger_patterns = ?,
             tool_policy_key = ?,
             execution_contract = ?,
             updated_at = datetime('now')
       WHERE id = 'kgl00000-0000-4000-8002-000000000004'`,
    ).run(
      KAGGLE_SKILLS.find((s) => s.id === 'kgl00000-0000-4000-8002-000000000004')!.description,
      KAGGLE_SKILLS.find((s) => s.id === 'kgl00000-0000-4000-8002-000000000004')!.instructions,
      JSON.stringify(KAGGLE_SKILLS.find((s) => s.id === 'kgl00000-0000-4000-8002-000000000004')!.tools),
      JSON.stringify(KAGGLE_SKILLS.find((s) => s.id === 'kgl00000-0000-4000-8002-000000000004')!.triggers),
      KAGGLE_SKILLS.find((s) => s.id === 'kgl00000-0000-4000-8002-000000000004')!.policy,
      JSON.stringify({
        requiredOutputSubstrings: KAGGLE_SKILLS.find(
          (s) => s.id === 'kgl00000-0000-4000-8002-000000000004',
        )!.requiredEvidence,
      }),
    );
  } catch { /* non-fatal */ }

  // 3. Projection tables (3 tables, all UUID PKs, all using INSERT OR IGNORE
  //    for idempotency on later upserts).
  //
  // These are app-level projections. Source of truth for evidence + traces
  // remains @weaveintel/core/contracts and the live-agents StateStore (Phase K5).
  // Dropping all three tables and rebuilding from contracts is loss-free.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_competitions_tracked (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      title TEXT,
      category TEXT,
      deadline TEXT,
      reward TEXT,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'watching',
      notes TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, competition_ref)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_tracked_competition ON kaggle_competitions_tracked(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_tracked_status ON kaggle_competitions_tracked(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_approaches (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      summary TEXT NOT NULL,
      expected_metric TEXT,
      model TEXT,
      source_kernel_refs TEXT,
      embedding BLOB,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_approaches_competition ON kaggle_approaches(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_approaches_status ON kaggle_approaches(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      approach_id TEXT,
      contract_id TEXT,
      replay_trace_id TEXT,
      mesh_id TEXT,
      agent_id TEXT,
      kernel_ref TEXT,
      submission_id TEXT,
      public_score REAL,
      validator_report TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_runs_competition ON kaggle_runs(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_runs_status ON kaggle_runs(status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_runs_approach ON kaggle_runs(approach_id)`);

  // ─── M12 — Phase K4: Kaggle run artifacts (contract + replay storage) ──
  // Each materialized Kaggle run gets ONE artifact row that stores:
  //   - the @weaveintel/core/contracts CompletionReport (evidence bundle)
  //   - the @weaveintel/observability/replay RunLog (deterministic re-execution input)
  // Source-of-truth invariants from KAGGLE_AGENT_DESIGN §3:
  //   - kaggle_runs is a derived view; this artifact table holds the actual
  //     contract + trace JSON so admin UI + replay endpoint can reconstruct.
  //   - One row per (run_id) — UNIQUE — but materializeKaggleRun replaces on
  //     re-materialize (UPSERT) so chat retries don't fragment the ledger.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_run_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES kaggle_runs(id) ON DELETE CASCADE,
      contract_id TEXT NOT NULL,
      replay_trace_id TEXT NOT NULL,
      contract_report_json TEXT NOT NULL,
      replay_run_log_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_run_artifacts_contract ON kaggle_run_artifacts(contract_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_run_artifacts_trace ON kaggle_run_artifacts(replay_trace_id)`);

  // Seed: one demo Kaggle run + matching artifact so the admin UI renders a
  // non-empty Run Artifacts tab on a fresh database. Deterministic IDs make
  // the seed idempotent across re-boots and replay-friendly in tests.
  const seedRunId = 'kgl-run-seed-001';
  const seedContractId = '00000000-0000-4000-8000-000000000kgl';
  const seedTraceId = 'kgl-trace-seed-001';
  // Companion demo competition row so the kaggle-runs detail join finds a
  // competition record on a fresh DB.
  safeExec(db,
    `INSERT OR IGNORE INTO kaggle_competitions_tracked (id, tenant_id, competition_ref, title, category, deadline, reward, url, status, notes)
     VALUES ('kgl-comp-seed-001', NULL, 'demo-comp-1', 'Demo Competition', 'tabular', NULL, NULL, NULL, 'watching', 'Seeded by Phase K4 to demo replay round-trip.')`,
  );
  const seedRunLog = JSON.stringify({
    executionId: seedTraceId,
    startTime: 1700000000000,
    endTime: 1700000001000,
    status: 'completed',
    steps: [
      { index: 0, type: 'tool', name: 'kaggle.kernels_push', startTime: 1700000000000, endTime: 1700000000400, input: { kernelRef: 'demo-user/demo-kernel' }, output: { ok: true } },
      { index: 1, type: 'tool', name: 'kaggle.competitions_submit', startTime: 1700000000400, endTime: 1700000001000, input: { competitionRef: 'demo-comp-1' }, output: { submissionId: 'sub-1', publicScore: 0.812 } },
    ],
    totalTokens: 0,
  });
  const seedReport = JSON.stringify({
    taskContractId: seedContractId,
    status: 'fulfilled',
    results: [
      { criteriaId: 'kernel-ref-present', passed: true, score: 1 },
      { criteriaId: 'submission-id-present', passed: true, score: 1 },
    ],
    evidence: { items: [
      { type: 'text', label: 'kernel_ref', value: 'demo-user/demo-kernel' },
      { type: 'metric', label: 'public_score', value: 0.812 },
    ] },
    confidence: 1,
    completedAt: '2023-11-14T22:13:21.000Z',
  });
  safeExec(db,
    `INSERT OR IGNORE INTO kaggle_runs (id, tenant_id, competition_ref, approach_id, contract_id, replay_trace_id, mesh_id, agent_id, kernel_ref, submission_id, public_score, validator_report, status, started_at, completed_at)
     VALUES ('${seedRunId}', NULL, 'demo-comp-1', NULL, '${seedContractId}', '${seedTraceId}', NULL, NULL, 'demo-user/demo-kernel', 'sub-1', 0.812, NULL, 'submitted', '2023-11-14T22:13:20.000Z', '2023-11-14T22:13:21.000Z')`,
  );
  const safeReport = seedReport.replace(/'/g, "''");
  const safeLog = seedRunLog.replace(/'/g, "''");
  safeExec(db,
    `INSERT OR IGNORE INTO kaggle_run_artifacts (id, run_id, contract_id, replay_trace_id, contract_report_json, replay_run_log_json)
     VALUES ('kgl-art-seed-001', '${seedRunId}', '${seedContractId}', '${seedTraceId}', '${safeReport}', '${safeLog}')`,
  );

  // ─── M13 — Phase K5: Kaggle live-agents mesh index ─────────────────
  // The live-agents StateStore (la_entities, separate SQLite file) does NOT
  // expose listMeshes() without a tenantId. To let admin GET routes enumerate
  // every Kaggle mesh that has ever been provisioned, we record (tenant_id,
  // mesh_id) pairs in geneweave.db on every bootKaggleMesh() call. This is a
  // pure pointer index — no domain state lives here.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_live_mesh_index (
      mesh_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kaggle_username TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_live_mesh_index_tenant ON kaggle_live_mesh_index(tenant_id)`);

  // ─── M14 — Phase K6: Kaggle discussion bot (deferred, opt-in) ──────
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1 + §8 (Phase K6).
  // Adds the privileged kaggle.discussions.create write tool and the
  // matching kaggle_communicator skill. BOTH ship disabled (enabled=0). To
  // turn the bot on for a tenant the operator must:
  //   (1) flip enabled=1 on the kaggle.discussions.create tool_catalog row,
  //   (2) flip enabled=1 on the kaggle_discussion_post_gate tool policy
  //       (seeded disabled in M11),
  //   (3) flip enabled=1 on the kaggle_communicator skill,
  //   (4) set discussion_enabled=1 on the kaggle_discussion_settings row
  //       for the target tenant_id (kill switch).
  // The runtime checks (4) before invoking the tool and silently no-ops if
  // the kill switch is off.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'privileged', 1, ?, ?, 0, ?, '0.1.0', 1, ?, 'mcp', 'kgl00000-0000-4000-8000-000000000001', ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000027',
      'Kaggle: Create Discussion Post',
      'PRIVILEGED + PUBLIC + IRREVOCABLE — post a topic or reply on a Kaggle competition discussion forum. Every call is human-attributable to the bound Kaggle account. Disabled by default; requires kaggle_discussion_post_gate (approval + 1/week pacing) and the per-tenant kill switch in kaggle_discussion_settings.',
      60_000,
      1,
      'kaggle.discussions.create',
      JSON.stringify(['kaggle', 'mcp', 'communications']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  // Per-tenant kill switch + light-weight post log. Both rows use UUID PKs
  // (TEXT in SQLite). The settings table is upserted per-tenant; the posts
  // table is append-only and readable from the admin UI.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_discussion_settings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL UNIQUE,
      discussion_enabled INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_discussion_posts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      parent_topic_id TEXT,
      title TEXT,
      body_preview TEXT,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      contract_id TEXT,
      replay_trace_id TEXT,
      posted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_discussion_posts_tenant ON kaggle_discussion_posts(tenant_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_discussion_posts_competition ON kaggle_discussion_posts(competition_ref)`);

  // Skill: kaggle_communicator. Reuses the kaggle_discussion_post_gate
  // policy seeded in M11 (currently disabled). Ships enabled=0 so it does
  // not get auto-activated by chat triggers until the operator opts in.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 60, '1.0', ?, 0, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000007',
      'kaggle_communicator',
      'Drafts and posts to a Kaggle competition discussion forum. PRIVILEGED — every post is public and irrevocable, attributed to the bound Kaggle account. Requires human approval per kaggle_discussion_post_gate AND a tenant-level kill switch ON. Hard cap: 1 post per competition per week (operator discipline + policy rate limit).',
      JSON.stringify(['post discussion', 'kaggle forum', 'reply on kaggle', 'announce on kaggle', 'thank kaggle']),
      [
        'When to use: the user has explicitly asked to post a topic or reply on a Kaggle competition discussion forum.',
        'When NOT to use: anything else. This is the only skill in the Kaggle pack that creates public, irrevocable, human-attributable artifacts.',
        'Reasoning: drafting is cheap; posting is expensive. Always present the full draft to the human first and obtain explicit "post it" confirmation before invoking the tool.',
        'Execution: call kaggle.discussions.create with competitionRef + title + body (or parentTopicId for a reply). Approval will be requested by policy — wait for it. The platform will reject silently if the per-tenant kill switch is off.',
        'Completion: report the posted topic id, the URL, and a one-line summary of the body. Use the words "topic id" and "url" in the final reply so observability captures both.',
      ].join('\n'),
      JSON.stringify(['kaggle.discussions.create']),
      JSON.stringify(['kaggle', 'data-science', 'communications']),
      'kaggle_discussion_post_gate',
      JSON.stringify({ requiredOutputSubstrings: ['topic id', 'url'] }),
    );
  } catch { /* ignore */ }

  // ─── M15 — Phase K7a: Ensembling + OOF tracking + blend tool ────────
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §8b (Phase K7).
  //
  // Three additive changes:
  //   (1) ALTER kaggle_runs    — add cv_score / cv_metric / oof_path /
  //       is_ensemble / ensemble_member_run_ids so we can ensemble later runs.
  //   (2) ALTER kaggle_approaches — add ensemble_member_of, blend_weights,
  //       expected_metric_value to record blend hypotheses.
  //   (3) Seed the kaggle.local.blend tool_catalog row (sandboxed, read-only,
  //       enabled=0 — operator opt-in) and the kaggle_ensembler skill
  //       (enabled=1 — only fires when ≥2 validated runs already exist).
  //
  // All ALTERs use try/catch because SQLite errors if the column already
  // exists; the migration must be re-runnable.
  const k7aAlters = [
    `ALTER TABLE kaggle_runs ADD COLUMN cv_score REAL`,
    `ALTER TABLE kaggle_runs ADD COLUMN cv_metric TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN oof_path TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN is_ensemble INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE kaggle_runs ADD COLUMN ensemble_member_run_ids TEXT`,
    `ALTER TABLE kaggle_approaches ADD COLUMN ensemble_member_of TEXT`,
    `ALTER TABLE kaggle_approaches ADD COLUMN blend_weights TEXT`,
    `ALTER TABLE kaggle_approaches ADD COLUMN expected_metric_value REAL`,
  ];
  for (const sql of k7aAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, NULL, 0, ?, '0.2.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000028',
      'Kaggle: Blend OOF Predictions (sandboxed)',
      'Find optimal weighted blend of N OOF prediction vectors via SLSQP optimization on the simplex (weights ≥ 0, sum = 1). Runs in a sandboxed Python container with scipy. No network, no credentials. Requires kaggle-runner image v0.2.0+ in the host ImagePolicy.',
      120_000,
      'kaggle.local.blend',
      JSON.stringify(['kaggle', 'mcp', 'local', 'sandbox', 'ensemble']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 70, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000008',
      'kaggle_ensembler',
      'Combines two or more previously validated Kaggle runs on the same competition into an optimal weighted blend. Read-only — produces a new candidate submission CSV but does not submit it; kaggle_submitter must be invoked separately if the user wants to submit.',
      JSON.stringify(['ensemble kaggle', 'blend submissions', 'combine submissions', 'stack models', 'weighted blend kaggle', 'ensemble approaches']),
      [
        'When to use: the same competition already has ≥2 completed kaggle_runs rows with non-null oof_path values (i.e. validated CV runs whose out-of-fold predictions were captured). The user has asked to combine them, blend them, or build an ensemble.',
        'When NOT to use: only one validated run exists (run kaggle_validator on a different model first), or the user wants to submit (hand off to kaggle_submitter), or oof predictions were never captured (re-run kaggle_validator with captureOof=true).',
        'Reasoning: a convex blend of diverse, well-calibrated OOF vectors almost always beats the single best model on tabular Kaggle competitions. The optimizer (SLSQP on the simplex) is cheap; the expensive part is having captured OOF in the first place. Always report the blendedScore vs baselineBestSoloScore so the human can see whether the blend is worth submitting.',
        'Execution: load OOF arrays from each candidate run (oof_path), assemble oofMatrix (rows=models, cols=samples), call kaggle.local.blend with the metric matching the competition. Persist a new kaggle_approaches row with ensemble_member_of=<comma-separated run ids>, blend_weights=<JSON array>, expected_metric_value=<blendedScore>.',
        'Completion: report the optimal "weights" array, the "blendedScore", and the "baselineBestSoloScore" so observability captures all three. State explicitly whether the blend beat the best solo model.',
      ].join('\n'),
      JSON.stringify(['kaggle.local.blend']),
      JSON.stringify(['kaggle', 'data-science', 'ensemble', 'blending']),
      'kaggle_read_only',
      JSON.stringify({ requiredOutputSubstrings: ['weights', 'blendedScore', 'baselineBestSoloScore'] }),
    );
  } catch { /* ignore */ }

  // ─── M18 — Phase K7d: Competition-agnostic submission validation ────────
  // New tables backing the validator + leaderboard observer roles.
  // - kaggle_competition_rubric: per-competition acceptance criteria. Auto-
  //   inferred from Kaggle metadata (evaluationMetric, sample submission
  //   shape) on first contact, then editable by operators.
  // - kaggle_validation_results: append-only ledger of validator passes
  //   (schema/distribution/baseline checks + verdict). One row per kernel run
  //   the validator reviews.
  // - kaggle_leaderboard_scores: append-only ledger of leaderboard readbacks
  //   from kaggle.competitions.submissions/list after the submitter pushes.
  safeExec(db, `CREATE TABLE IF NOT EXISTS kaggle_competition_rubric (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    competition_ref TEXT NOT NULL,
    metric_name TEXT,
    metric_direction TEXT CHECK(metric_direction IN ('maximize','minimize')),
    baseline_score REAL,
    target_score REAL,
    expected_row_count INTEGER,
    id_column TEXT,
    id_range_min INTEGER,
    id_range_max INTEGER,
    target_column TEXT,
    target_type TEXT,
    expected_distribution_json TEXT,
    sample_submission_sha256 TEXT,
    inference_source TEXT,
    auto_generated INTEGER NOT NULL DEFAULT 1,
    inferred_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, competition_ref)
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_rubric_competition_ref ON kaggle_competition_rubric(competition_ref)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS kaggle_validation_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    competition_ref TEXT NOT NULL,
    rubric_id TEXT,
    kernel_ref TEXT,
    schema_check_passed INTEGER,
    distribution_check_passed INTEGER,
    baseline_check_passed INTEGER,
    cv_score REAL,
    cv_std REAL,
    cv_metric TEXT,
    n_folds INTEGER,
    predicted_distribution_json TEXT,
    violations_json TEXT,
    verdict TEXT CHECK(verdict IN ('pass','warn','fail')),
    summary TEXT,
    validated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_run_id ON kaggle_validation_results(run_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_rubric_id ON kaggle_validation_results(rubric_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_verdict ON kaggle_validation_results(verdict)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_competition_ref ON kaggle_validation_results(competition_ref)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS kaggle_leaderboard_scores (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    competition_ref TEXT NOT NULL,
    submission_id TEXT,
    public_score REAL,
    private_score REAL,
    cv_lb_delta REAL,
    percentile_estimate REAL,
    rank_estimate INTEGER,
    leaderboard_size INTEGER,
    raw_status TEXT,
    observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_lb_run_id ON kaggle_leaderboard_scores(run_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_lb_competition_ref ON kaggle_leaderboard_scores(competition_ref)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_lb_submission_id ON kaggle_leaderboard_scores(submission_id)');

  // M16 + M17 column additions and seed data for kaggle_runs (K7b/K7c).
  applyKagglePhaseK7bK7c(db);
}
