import type BetterSqlite3 from 'better-sqlite3';

/**
 * m61 — A2A Skills: agent_tools + agent_workers columns
 *
 * Adds two optional columns to `a2a_skills` so each skill can define the exact
 * agent configuration it runs with, independent of chat_settings:
 *
 *   agent_tools   JSON string[] | null
 *     Explicit tool list for the agent.  null = use getDefaultToolsByMode(mode).
 *     Lets admins restrict or expand tools per skill without a code deploy.
 *
 *   agent_workers JSON WorkerDef[] | null
 *     Worker topology for supervisor/ensemble skills.  null = use DB defaults.
 *     Required for skills that delegate to code_executor, analyst, etc.
 *
 * Also seeds agent_workers for the supervisor-orchestration skill with the
 * standard code_executor + analyst worker pair so CSE works out of the box.
 */
export function applyM61A2ASkillsAgentConfig(db: BetterSqlite3.Database): void {
  // Wrapped individually — ALTER TABLE throws if the column already exists.
  try { db.exec(`ALTER TABLE a2a_skills ADD COLUMN agent_tools   TEXT DEFAULT NULL`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE a2a_skills ADD COLUMN agent_workers TEXT DEFAULT NULL`); } catch { /* already exists */ }

  // Backfill execution_contract for skill-data-analysis-execution.
  // The builtin definition declares { minDelegations: 0 } so the skill can call
  // cse_run_data_analysis directly without going through a code_executor worker.
  // Without this, extractSkillExecutionContractsFromPrompt returns [] and the legacy
  // hasCodeExecutorDelegation guard fires even in agent mode, blocking CSE results.
  try {
    db.prepare(`
      UPDATE skills
      SET execution_contract = '{"minDelegations":0}', updated_at = datetime('now')
      WHERE id = 'skill-data-analysis-execution' AND (execution_contract IS NULL OR execution_contract = '')
    `).run();
  } catch { /* skills table may not exist in test environments */ }

  // Seed agent_workers for supervisor-orchestration so it has code_executor + analyst.
  // Mirrors the default workers seeded in db-sqlite.ts for the built-in supervisor chat.
  const supervisorWorkers = JSON.stringify([
    {
      name: 'code_executor',
      description: 'Writes and executes Python code using cse_run_code / cse_run_data_analysis. Handles CSV, JSON, Excel, Parquet files and produces stdout output for downstream analysis.',
      tools: ['cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'json_format'],
      persona: 'agent',
    },
    {
      name: 'analyst',
      description: 'Interprets code_executor output, derives business insights, and produces a clear final answer for the user.',
      tools: ['calculator', 'json_format', 'text_analysis', 'web_search', 'memory_recall'],
      persona: 'agent',
    },
    {
      name: 'researcher',
      description: 'Searches the web and retrieves factual information to support analysis or answer knowledge questions.',
      tools: ['web_search', 'memory_recall', 'text_analysis'],
      persona: 'agent',
    },
  ]);

  db.prepare(`
    UPDATE a2a_skills
    SET agent_workers = ?, updated_at = datetime('now')
    WHERE id = 'supervisor-orchestration'
  `).run(supervisorWorkers);
}
