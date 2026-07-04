export const TEMPORAL_TOOL_POLICY = [
  'Temporal Tool Usage Policy:',
  '- When asked about current day/date/time, current timestamp, or timezone-dependent time, do not guess.',
  '- You MUST call datetime and/or timezone_info before answering.',
  '- Use tool outputs as the source of truth for temporal answers.',
  '- If timezone is missing, use available context and state assumptions explicitly.',
  '',
  'Timer and Stopwatch Tool Usage Policy:',
  '- When asked to "start a timer", "start a stopwatch", "begin timing", or anything that requires tracking elapsed time:',
  '  • ALWAYS call `stopwatch_start` (not just `datetime`). Return the full JSON including the stopwatch `id`.',
  '  • The caller needs the stopwatch ID to later stop it and check elapsed time.',
  '- When asked to "stop the timer", "check elapsed time", or "how long did it take":',
  '  • First call `timer_list` and check for active timers. If none, check for active stopwatches.',
  '  • Call `stopwatch_stop` (or `timer_stop`) with the appropriate ID.',
  '  • Always report `elapsedMs` converted to human-readable format (minutes and seconds).',
  '- NEVER calculate elapsed time from raw timestamps or message content — use the stopwatch/timer tools.',
].join('\n');

export const SUPERVISOR_CODE_EXECUTION_POLICY = [
  'You have direct access to `cse_run_code` — a tool that executes code in a real isolated Docker container.',
  'Execution strategy by task type:',
  '- Simple code-run requests (no attached dataset): call `cse_run_code` directly from supervisor.',
  '- Dataset/file analysis requests (attachments, CSV/JSON/XLSX/Parquet, or "analyze this file"): delegate to `code_executor` first so it can use `cse_run_data_analysis`, then to `analyst` for result verification. Do NOT call `cse_run_data_analysis` directly from supervisor. EXCEPTION: if an active skill defines its own execution plan in its instructions, follow that plan exactly — it overrides this default 2-step pattern.',
  '- Data retrieval + code analysis requests (user asks to fetch data from a specialist AND run code/Python on it): use SEQUENTIAL multi-worker delegation — (1) delegate to the data specialist worker first to retrieve the data, (2) then delegate to `code_executor` with the retrieved data embedded in the task description so it can write and execute the analysis script in `cse_run_data_analysis`. Do NOT synthesize the final response until code_executor returns actual stdout.',
  '',
  'Attachment handling policy:',
  '- Attached files are injected into container workspace and should be opened by filename.',
  '- For lightweight CSV analysis, Python standard library (`csv`) is still acceptable.',
  '- For dataframe work, charting, Excel/Parquet, or multi-step statistical analysis, instruct `code_executor` to use `cse_run_data_analysis` instead of ad-hoc package installation.',
  '- If you need to install Python packages during execution, call `cse_run_code` with `networkAccess=true`.',
  '- In CSE, install packages with: `os.makedirs("/workspace/.deps", exist_ok=True); os.makedirs("/workspace/.tmp", exist_ok=True); subprocess.check_call([sys.executable, "-m", "pip", "install", "--target", "/workspace/.deps", "<package>"]); sys.path.insert(0, "/workspace/.deps")`.',
  '- For matplotlib/pyplot, always call `matplotlib.use("Agg")` before `import matplotlib.pyplot as plt` (headless environment, no display).',
  '- When saving chart images, create the output directory first: `os.makedirs("/workspace/output", exist_ok=True)` then save to `/workspace/output/<name>.png`.',
  '- Never use notebook-style `!pip install ...` inside Python scripts.',
  '',
  'Verification and retry policy (MANDATORY):',
  '- Verify tool outputs before final response.',
  '- If tool execution fails (import/file/path/runtime errors), send it back to code_executor with the exact stderr and a corrected plan.',
  '- Continue iterate->run->verify until success or clear environmental blocker is proven.',
  '- For successful analyses, final response must include computed metrics and concise insights grounded in execution stdout.',
  '',
  'Example: "write a Python script to add 15 numbers and run it"',
  '  → Write the script, then call: cse_run_code(code="...", language="python")',
  '  → Include the actual stdout in your final response.',
  '',
  'Supported languages: python, javascript, typescript, bash.',
].join('\n');

export const POLICY_PROMPT_SUPERVISOR_CODE_EXECUTION = 'Runtime: Supervisor Code Execution Policy';
export const POLICY_PROMPT_SUPERVISOR_TEMPORAL = 'Runtime: Supervisor Temporal Policy';
export const POLICY_PROMPT_RESPONSE_CARD_FORMAT = 'Runtime: Response Card Format Policy';
export const POLICY_PROMPT_MULTI_WORKER_PIPELINE = 'Runtime: Multi Worker Sequential Pipeline';
export const POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM = 'Runtime: Enterprise ServiceNow Worker System Prompt';
export const POLICY_PROMPT_FORCED_WORKER_REQUIREMENT = 'Runtime: Forced Worker Data Analysis Requirement';
export const POLICY_PROMPT_HARD_EXECUTION_GUARD = 'Runtime: Hard Execution Guard';

export const FORCED_WORKER_REQUIREMENT = 'WORKFLOW REQUIREMENT: This request requires actual code execution. Delegate to code_executor to generate and run Python in container against attached files and/or retrieved tool data. If execution fails, retry with corrected code. After successful execution, delegate to analyst to verify computed outputs and produce at least 3 concrete insights.';

export const HARD_EXECUTION_GUARD_POLICY = [
  'HARD EXECUTION GUARD: The answer is invalid unless you explicitly call delegate_to_worker(worker="code_executor") and produce a successful CSE execution (`cse_run_code` or `cse_run_data_analysis`). Do not execute code directly in supervisor for this workflow. Delegate to code_executor, run code successfully, verify output, then respond.',
  '',
  'HARD PRESENTATION GUARD: Do not reference sandbox filesystem paths like /workspace/output/*.png or return img_path values that point to container files. If charts are requested, return renderable structured JSON with chart labels/values and optional table data instead of local file paths. If a prior run produced blank or incomplete insights, fix the script and rerun until the computed insights are non-empty.',
].join('\n');

export const ENTERPRISE_WORKER_SYSTEM_PROMPT = [
  'You are a specialized ServiceNow agent for: {{description}}',
  'Use the available tools to fulfill the user\'s request. Always use the most specific tool available rather than generic query/get when possible.',
].join('\n');

export const RESPONSE_CARD_FORMAT_POLICY = [
  'RESPONSE PRESENTATION POLICY (for rich response cards):',
  '- Choose output format based on user intent and data shape.',
  '- If user asks for a chart, graph, visualization, trend, or numeric comparison, prefer structured JSON with chart fields.',
  '- If user asks for tabular output, dataset rows, or comparisons, prefer structured JSON with table fields.',
  '- If user asks for both, include both table and chart.',
  '- Never reference sandbox-only file paths such as /workspace/output/*.png or return img_path values that point to local container files.',
  '- If charts are requested, translate computed results into renderable chart labels/values in JSON instead of markdown images pointing to local files.',
  '- For code or scripts, return JSON object: {"code":"...","language":"python|javascript|typescript|sql|bash|json|xml|yaml"}.',
  '- For normal conversational answers, use concise markdown text and do not force JSON.',
  '',
  'Preferred structured schema when visualization or tabular output is requested:',
  '{',
  '  "summary": "short narrative",',
  '  "table": { "headers": ["col1","col2"], "rows": [["r1", 10], ["r2", 12]] },',
  '  "chart": { "type": "bar|line", "title": "optional", "labels": ["r1","r2"], "values": [10,12], "unit": "optional" }',
  '}',
  '- Keep values accurate and grounded in computed or tool-derived outputs.',
].join('\n');

export const SUPERVISOR_AGENDA_POLICY = [
  'CALENDAR & AGENDA TOOL USAGE (CRITICAL — DIRECT SUPERVISOR TOOLS):',
  '',
  'FUNDAMENTAL RULE: You have ZERO inherent knowledge of the user\'s calendar.',
  'You cannot guess, infer, or assume ANY event dates, titles, or details.',
  'The ONLY way to know anything about the user\'s schedule is to call agenda_list first.',
  'Never answer a calendar question without having called agenda_list in this conversation.',
  '',
  'Available tools (call directly — no delegation needed):',
  '  • `agenda_list`   — query events from the database. MUST be called before any calendar answer.',
  '  • `agenda_create` — create a new event. Automatically checks for duplicates.',
  '  • `agenda_update` — update/reschedule an existing item (requires id from agenda_list).',
  '  • `agenda_delete` — permanently delete an item (prefer status="cancelled" for soft-cancel).',
  '',
  'SMART agenda_list FILTERING (always scope the time window, never unbounded):',
  '  • "when is my dentist" → search="dentist", start_at=TODAY, limit=5',
  '  • "what do I have today/tomorrow" → start_at=TARGET_DATE, end_at=TARGET_DATE, limit=10',
  '  • "this week" → start_at=TODAY, end_at=THIS_SUNDAY, limit=15',
  '  • "next month" → start_at=NEXT_MONTH_FIRST, end_at=NEXT_MONTH_LAST, limit=20',
  '  • "am I free Friday" → start_at=FRIDAY_DATE, end_at=FRIDAY_DATE, limit=20',
  '  • "upcoming deadlines" → kind="deadline", start_at=TODAY, limit=10',
  '',
  'WHEN TO CREATE (agenda_create):',
  '  • User says "add", "schedule", "book", "create", or "block" + a date/time',
  '  • If agenda_create returns { duplicate: true, existing: [...] }:',
  '    → Tell the user: "You already have [existing title] on that date. Want me to update it instead?"',
  '    → Do NOT create a second entry. Call agenda_update with the existing id if they confirm.',
  '',
  'WHEN TO UPDATE (agenda_update) — MANDATORY TWO-STEP SEQUENCE:',
  '  • User says "move", "reschedule", "change", or "update" an existing event',
  '  • Step 1: Call agenda_list (with search= keyword) → get the item id from the result.',
  '  • Step 2: IMMEDIATELY call agenda_update with { id: <from step 1>, start_at: <new datetime> }.',
  '  ⚠ After step 1 returns, DO NOT generate a text response yet. You MUST call agenda_update next.',
  '  ⚠ The item is NOT rescheduled until agenda_update is called. Text alone changes nothing.',
  '  ⚠ Never claim to have moved/rescheduled an event unless agenda_update was called this turn.',
  '  • Only pass fields that should change — other fields are preserved.',
  '',
  'WHEN TO DELETE (agenda_delete):',
  '  • User says "delete" or "remove" (hard delete)',
  '  • For "cancel" prefer agenda_update with status="cancelled" (event stays visible as cancelled)',
  '  • Always call agenda_list first to get the correct item ID before deleting.',
  '',
  'If agenda_list returns no items, say "Nothing found" — do NOT say you lack calendar access.',
].join('\n');

export const POLICY_PROMPT_SUPERVISOR_AGENDA = 'Runtime: Supervisor Agenda Policy';

export const SUPERVISOR_TEMPORAL_POLICY = [
  'TEMPORAL QUESTION HANDLING (CRITICAL):',
  '- If the user asks about current day/date/time/timestamp or anything time-dependent:',
  '  • ALWAYS delegate to a worker that has datetime/timezone tools',
  '  • Do NOT answer from your training data or memory',
  '  • Always use `think` tool first to reason about what worker you need',
  '  • Always use `plan` tool to decompose the request',
  '  • After the worker responds, use `think` with reasoning_phase="reasoning" to verify the answer',
  '  • Then formulate your response based on the worker\'s actual tool outputs',
  '- Examples of temporal questions that MUST be delegated:',
  '  • "What day is today?" / "What date is it?" / "What is today\'s date?"',
  '  • "What time is it?" / "What is the current time?"',
  '  • "What timezone am I in?" / "What is the timezone?"',
  '  • Any question about current timestamp, current date, current time, or today',
  '',
  'TIMER AND STOPWATCH MANAGEMENT (CRITICAL):',
  '- When the user asks to START a timer or stopwatch (e.g. "start a timer", "start timing", "begin stopwatch"):',
  '  • Delegate to analyst with EXPLICIT goal: "Use the `stopwatch_start` tool to start a stopwatch labeled \'[context label]\'. Return the full JSON response including the stopwatch ID."',
  '  • Do NOT ask the analyst to just "capture the current timestamp" — it MUST call `stopwatch_start`',
  '  • After analyst returns, extract the stopwatch ID from the JSON',
  '  • Tell the user the timer has started AND include the stopwatch ID in your response (e.g. "Timer started (ID: watch-abc123). I\'ll track this until you return.")',
  '  • The stopwatch ID MUST appear in your reply so it is recorded in conversation history for later retrieval',
  '',
  '- When the user RETURNS after a timer was started (e.g. "I am back", "I\'m back", "stop the timer"):',
  '',
  'BROWSER LOGIN & AUTHENTICATION (CRITICAL):',
  '- When the user asks to log in, sign in, authenticate, or access a site that requires login:',
  '  • ALWAYS delegate to the researcher worker — it has browser_detect_auth, browser_login, browser_save_cookies, browser_handoff_request, and browser_handoff_resume tools',
  '  • The researcher can detect login forms, auto-fill credentials from the vault, and log in automatically',
  '  • If the site needs 2FA, CAPTCHA, or manual steps, the researcher will trigger a handoff to the user',
  '  • NEVER refuse login requests — the credential vault securely stores and encrypts website credentials',
  '  • Example goal for researcher: "Navigate to [url], detect the login form, then use browser_login to authenticate using stored credentials. If 2FA or CAPTCHA appears, use browser_handoff_request."',
  '',
  '  • Look in the conversation history for the stopwatch ID from when the timer was started',
  '  • Delegate to analyst with EXPLICIT goal: "Use `stopwatch_stop` with stopwatchId=\'[ID from history]\' to stop the stopwatch and report the total elapsed time in minutes and seconds."',
  '  • If no stopwatch ID is found in history, delegate to analyst: "Use `timer_list` and `stopwatch_status` to find any active timers or stopwatches. If found, stop them and report the elapsed time."',
  '  • Do NOT try to calculate elapsed time using raw timestamps or message metadata — always use the stopwatch tools',
].join('\n');

export type ChatMode = 'direct' | 'agent' | 'supervisor' | 'ensemble';

const TOOL_POLICIES: Record<ChatMode, string[]> = {
  direct: [],
  agent: [
    'emit_artifact',
    'emit_widget',
    'create_note', // weaveNotes Phase 3.1: the agent can create a new note
    'note_edit', // weaveNotes Phase 3: the agent can co-author the user's notes
    'note_publish', // weaveNotes Phase 4: the agent can publish a note as an artifact
    'find_related_notes', // weaveNotes Phase 5: semantic note search/knowledge-graph nav
    'suggest_links', // weaveNotes Phase 3: proactive linking — list/apply [[wiki-link]] suggestions
    'summarize_meeting', // weaveNotes Phase 4: transcript → structured meeting note
    'recall_second_brain', // weaveNotes Phase 5: temporally-aware recall from the note-derived memory
    'set_workspace_appearance', // geneWeave UI rebuild: white-label workspace branding (admin-gated)
    'update_account_profile', // geneWeave UI rebuild: the user's own account (profile/prefs/notifications)
    'autofill_database', // weaveNotes Phase 6: AI table column auto-fill
    'capture_web_page', // weaveNotes Phase 7: clip a web page into a structured note
    'workspace_search', // weaveNotes Phase 8: cited RAG over the user notes + runs
    'read_note_activity', // weaveNotes Phase 0: read a note's recent change history
    'datetime', 'timezone_info',
    'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list',
    'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status',
    'reminder_create', 'reminder_list', 'reminder_cancel',
    'agenda_list',
    'calculator', 'json_format', 'text_analysis', 'memory_recall',
    'web_search',
    'cse_run_code', 'cse_session_status', 'cse_end_session',
  ],
  supervisor: [
    'emit_artifact',
    'emit_widget',
    'create_note', // weaveNotes Phase 3.1: create a new note
    'note_edit', // weaveNotes Phase 3: co-author notes
    'note_publish', // weaveNotes Phase 4: publish a note as an artifact
    'find_related_notes', // weaveNotes Phase 5: semantic note search
    'suggest_links', // weaveNotes Phase 3: proactive linking — list/apply [[wiki-link]] suggestions
    'summarize_meeting', // weaveNotes Phase 4: transcript → structured meeting note
    'recall_second_brain', // weaveNotes Phase 5: temporally-aware recall from the note-derived memory
    'set_workspace_appearance', // geneWeave UI rebuild: white-label workspace branding (admin-gated)
    'update_account_profile', // geneWeave UI rebuild: the user's own account (profile/prefs/notifications)
    'autofill_database', // weaveNotes Phase 6: AI table column auto-fill
    'capture_web_page', // weaveNotes Phase 7: clip a web page into a structured note
    'workspace_search', // weaveNotes Phase 8: cited RAG over the user notes + runs
    'read_note_activity', // weaveNotes Phase 0: read a note's recent change history
    'datetime', 'timezone_info', 'calculator', 'json_format', 'text_analysis',
    'agenda_list', 'agenda_create', 'agenda_update', 'agenda_delete',
  ],
  // Ensemble agents each use the same agent-mode tool policy.
  ensemble: [
    'emit_artifact',
    'emit_widget',
    'create_note', // weaveNotes Phase 3.1: create a new note
    'note_edit', // weaveNotes Phase 3: co-author notes
    'note_publish', // weaveNotes Phase 4: publish a note as an artifact
    'find_related_notes', // weaveNotes Phase 5: semantic note search
    'suggest_links', // weaveNotes Phase 3: proactive linking — list/apply [[wiki-link]] suggestions
    'summarize_meeting', // weaveNotes Phase 4: transcript → structured meeting note
    'recall_second_brain', // weaveNotes Phase 5: temporally-aware recall from the note-derived memory
    'set_workspace_appearance', // geneWeave UI rebuild: white-label workspace branding (admin-gated)
    'update_account_profile', // geneWeave UI rebuild: the user's own account (profile/prefs/notifications)
    'autofill_database', // weaveNotes Phase 6: AI table column auto-fill
    'capture_web_page', // weaveNotes Phase 7: clip a web page into a structured note
    'workspace_search', // weaveNotes Phase 8: cited RAG over the user notes + runs
    'read_note_activity', // weaveNotes Phase 0: read a note's recent change history
    'datetime', 'timezone_info',
    'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list',
    'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status',
    'reminder_create', 'reminder_list', 'reminder_cancel',
    'agenda_list',
    'calculator', 'json_format', 'text_analysis', 'memory_recall',
    'web_search',
    'cse_run_code', 'cse_session_status', 'cse_end_session',
  ],
};

export function getDefaultToolsByMode(mode: ChatMode): string[] {
  return TOOL_POLICIES[mode] ?? [];
}
