// SPDX-License-Identifier: MIT
/**
 * Postgres port of the `seedDefaultData` bootstrap seeder — the last SQLite-only `DatabaseAdapter`
 * method. It seeds all first-run default data (prompts, frameworks, fragments, strategies, optimizers,
 * guardrails, routing policies, model pricing, workflow defs, tool catalog, skills, task contracts,
 * worker + supervisor agents, admin policies/connectors/configs, dev-experience configs, hypothesis
 * validation seeds, anyWeave routing seeds, cost policies, and the tenant-encryption demo policy).
 *
 * The bulk of the method calls SIBLING adapter methods (`await this.createSkill!(...)`,
 * `this.createPrompt!(...)`, `this.createWorkerAgent!(...)`, etc.) which are ALREADY ported to
 * Postgres and resolve through the composed adapter (`this` is the full `DatabaseAdapter`). Those
 * calls are kept verbatim. Only the RAW SQL (`d.prepare(...).run/get`, `d.transaction(...)`) is
 * translated to `await ctx.query(...)` per the standard porting convention:
 *   - `?`→`$n` placeholders; named params → positional;
 *   - `datetime('now')`→`${ctx.now}` (UTC `YYYY-MM-DD HH:MM:SS` text, parity with SQLite);
 *   - `INSERT OR IGNORE`→`INSERT ... ON CONFLICT DO NOTHING`;
 *   - `.get()`→`rows[0]`; `.all()`→`rows`; `.run()`→`ctx.query`.
 *
 * The three private SQLite helpers (`seedDefaultCostPolicies`, `seedDefaultEncryptionPolicies`,
 * `seedAnyWeaveRoutingPhase1`) are NOT methods on this store — their bodies are inlined at their call
 * sites (marked `// (inlined <helper>)`).
 */
import { newUUIDv7 } from '@weaveintel/core';
import { getModelCapabilityFlags } from '@weaveintel/routing';
import { stringifyPromptVariables } from '@weaveintel/prompts';
import { BUILT_IN_SKILLS } from '@weaveintel/skills';
import { HARD_EXECUTION_GUARD_POLICY, SUPERVISOR_CODE_EXECUTION_POLICY } from '../chat-policies.js';
import { realmContentHash, parseRealmSemantic } from '../migrations/m151-realm-columns.js';
import { reconcilePromptRealm } from '../realm-prompt-drift.js';
import type { SqlClient } from '@weaveintel/realm';
import type { PgCtx } from '../db-postgres-ctx.js';
import type { DatabaseAdapter } from '../db-types/adapter.js';
import type {
  PromptRow, PromptFrameworkRow, PromptFragmentRow, PromptStrategyRow, PromptOptimizerRow,
} from '../db-types/prompts.js';
import type {
  GuardrailRow, RoutingPolicyRow, ModelPricingRow, ProviderToolAdapterRow,
} from '../db-types/routing.js';
import type { WorkflowDefRow } from '../db-types/workflows.js';
import type { ToolCatalogRow, ToolRegistryRow } from '../db-types/tools.js';
import type { WorkerAgentRow } from '../db-types/agents.js';
import type {
  TaskContractRow, HumanTaskPolicyRow, CachePolicyRow, IdentityRuleRow, MemoryGovernanceRow,
  MemoryExtractionRuleRow, SearchProviderRow, ReplayScenarioRow, TriggerDefinitionRow,
  TenantConfigRow, SandboxPolicyRow, ExtractionPipelineRow, ArtifactPolicyRow,
  ReliabilityPolicyRow, CollaborationSessionRow, ComplianceRuleRow, GraphConfigRow, PluginConfigRow,
} from '../db-types/admin.js';
import type {
  ScaffoldTemplateRow, RecipeConfigRow, WidgetConfigRow, ValidationRuleRow,
} from '../db-types/dev-experience.js';

export function pgSeedStore(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    async seedDefaultData(this: DatabaseAdapter): Promise<void> {
      const cnt = async (tbl: string): Promise<number> => {
        const { rows } = await ctx.query(`SELECT COUNT(*) as cnt FROM ${tbl}`, []);
        return Number((rows[0] as { cnt: number | string }).cnt);
      };

      // Prompts
      const prompts: Omit<PromptRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'e92e7672-3009-4040-8b05-a411dc825f90', name: 'General Assistant', description: 'Default conversational assistant prompt',
          key: 'assistant.general', category: 'general', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['assistant', 'general']), template: 'You are a helpful, accurate, and concise AI assistant. Answer the user\'s questions clearly and provide relevant details when asked.',
          variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'standard' }), framework: null, metadata: null, is_default: 1, enabled: 1,
        },
        {
          id: 'e7c21e36-c558-40e0-9b99-2433c0466bc3', name: 'Code Review Expert', description: 'Technical code review prompt with best practices',
          key: 'engineering.code-review', category: 'engineering', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['engineering', 'review']), template: 'You are an expert code reviewer. Analyze code for bugs, security issues, performance problems, and style. Provide actionable suggestions with explanations. Focus on: {{focus_areas}}',
          variables: stringifyPromptVariables([{ name: 'focus_areas', type: 'string', required: true, description: 'Specific review focus areas such as security, performance, or style.' }]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', selfReview: true, explanationStyle: 'detailed' }), framework: null, metadata: null, is_default: 0, enabled: 1,
        },
        {
          id: '14b189df-1307-4041-ab1b-2a784df9d304', name: 'Document Summarizer', description: 'Summarize long documents into key points',
          key: 'content.summarizer', category: 'content', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['content', 'summary']), template: 'Summarize the following content into {{format}}. Preserve key facts, numbers, and conclusions. Be concise but thorough.\n\nContent:\n{{content}}',
          variables: stringifyPromptVariables([
            { name: 'format', type: 'string', required: true, description: 'Desired response shape, for example bullet list or executive summary.' },
            { name: 'content', type: 'string', required: true, description: 'Raw content to summarize.' },
          ]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'concise' }), framework: null, metadata: null, is_default: 0, enabled: 1,
        },
        {
          id: '906cdfa7-35f4-4d39-a0ea-d099207570dc', name: 'SQL Query Builder', description: 'Generate SQL queries from natural language',
          key: 'engineering.sql-builder', category: 'engineering', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['engineering', 'sql']), template: 'You are an expert SQL developer. Convert the following natural language request into a correct, optimized SQL query. Target database: {{db_type}}. Available tables: {{schema}}',
          variables: stringifyPromptVariables([
            { name: 'db_type', type: 'string', required: true, description: 'Target relational database type.' },
            { name: 'schema', type: 'string', required: true, description: 'Available schema or table summary provided to the model.' },
          ]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', selfReview: true, explanationStyle: 'standard' }), framework: null, metadata: null, is_default: 0, enabled: 1,
        },
        {
          id: 'f68c3785-469c-4d2b-a2c2-366c5bc3b4d2', name: 'Runtime: Supervisor Code Execution Policy', description: 'Runtime policy for supervisor code execution and delegated CSE workflows',
          key: 'runtime.supervisor.code-execution', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'supervisor']), template: [
            'You have direct access to `cse_run_code` — a tool that executes code in a real isolated Docker container.',
            'Execution strategy by task type:',
            '- Simple code-run requests (no attached dataset): call `cse_run_code` directly from supervisor.',
            '- Dataset/file analysis requests (attachments, CSV/JSON/XLSX, or "analyze this file"): delegate to `code_executor` first, then to `analyst` for result verification.',
            '- Data retrieval + code analysis requests (user asks to fetch data from a specialist AND run code/Python on it): use SEQUENTIAL multi-worker delegation — (1) delegate to the data specialist worker first to retrieve the data, (2) then delegate to `code_executor` with the retrieved data embedded in the task description so it can write and execute the analysis script. Do NOT synthesize the final response until code_executor returns actual stdout.',
            '',
            'Attachment handling policy:',
            '- Attached files are injected into container workspace and should be opened by filename.',
            '- For CSV analysis, prefer Python standard library (`csv`) first.',
            '- Do not assume `pandas` is installed unless you install it in the same run and verify installation succeeded.',
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
          ].join('\n'),
          variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
        },
        {
          id: '4aecf467-a350-42f9-aeca-550fcc4383a2', name: 'Runtime: Response Card Format Policy', description: 'Runtime policy for chart/table/code response formatting',
          key: 'runtime.response-card-format', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'formatting']), template: [
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
          ].join('\n'),
          variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'standard' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
        },
        {
          id: 'b3722c76-fc46-4392-ab8e-3f39b0fce3dc', name: 'Runtime: Supervisor Temporal Policy', description: 'Runtime policy for supervisor temporal and browser-login delegation',
          key: 'runtime.supervisor.temporal', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'temporal']), template: [
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
            '  • Do NOT try to calculate elapsed time using raw timestamps or message metadata — always use the stopwatch tools.',
          ].join('\n'),
          variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
        },
        {
          id: '338ee839-adee-43cb-9dd4-34e53333b997', name: 'Runtime: Multi Worker Sequential Pipeline', description: 'Runtime policy for supervisor sequential multi-worker execution',
          key: 'runtime.multi-worker.pipeline', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'workflow']), template: [
            'MULTI-WORKER SEQUENTIAL PIPELINE:',
            'When the user\'s request spans multiple capabilities (e.g., "fetch NZ economic data AND run Python to find insights"), you MUST use sequential worker delegation:',
            '  Step 1 — Delegate to the data specialist worker (e.g., statsnz_specialist) to retrieve the raw data.',
            '  Step 2 — Once data is returned, delegate to code_executor with a task that embeds the retrieved data and asks it to write and execute Python (or other code) to produce insights.',
            '  Step 3 — Use the code_executor stdout in your final response. Never skip code execution when the user explicitly asked for it.',
            'Do not collapse multi-step pipelines into a single delegation or into a supervisor-only response.',
          ].join('\n'),
          variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
        },
        {
          id: '044e122c-67cf-4bb3-9ad3-090bd937b6c8', name: 'Runtime: Forced Worker Data Analysis Requirement', description: 'Runtime requirement appended when worker-based execution is mandatory',
          key: 'runtime.force-worker.analysis', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'analysis']), template: 'WORKFLOW REQUIREMENT: This request requires actual code execution. Delegate to code_executor to generate and run Python in container against attached files and/or retrieved tool data. If execution fails, retry with corrected code. After successful execution, delegate to analyst to verify computed outputs and produce at least 3 concrete insights.',
          variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
        },
        {
          id: '5f58d48f-931f-4b1f-a418-e9b43d545dc8', name: 'Runtime: Hard Execution Guard', description: 'Runtime hard guard for execution retries and renderable output requirements',
          key: 'runtime.execution.guard', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'policy', 'guard']), template: [
            'HARD EXECUTION GUARD: The answer is invalid unless you explicitly call delegate_to_worker(worker="code_executor") and produce a successful cse_run_code execution. Do not execute code directly in supervisor for this workflow. Delegate to code_executor, run code successfully, verify output, then respond.',
            '',
            'HARD PRESENTATION GUARD: Do not reference sandbox filesystem paths like /workspace/output/*.png or return img_path values that point to container files. If charts are requested, return renderable structured JSON with chart labels/values and optional table data instead of local file paths. If a prior run produced blank or incomplete insights, fix the script and rerun until the computed insights are non-empty.',
          ].join('\n'),
          variables: null, version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', deliberationPolicy: 'verify' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
        },
        {
          id: 'dc61ee37-5268-4e8b-af36-22d6124d99b6', name: 'Runtime: Enterprise ServiceNow Worker System Prompt', description: 'Template used for enterprise ServiceNow worker system prompts',
          key: 'runtime.enterprise.worker-system', category: 'runtime-policy', prompt_type: 'template', owner: 'system', status: 'published', tags: JSON.stringify(['runtime', 'worker', 'servicenow']), template: [
            'You are a specialized ServiceNow agent for: {{description}}',
            'Use the available tools to fulfill the user\'s request. Always use the most specific tool available rather than generic query/get when possible.',
          ].join('\n'),
          variables: stringifyPromptVariables([{ name: 'description', type: 'string', required: true, description: 'Worker capability description passed from the enterprise tool group.' }]), version: '1.0', model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }), execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'standard' }), framework: null, metadata: JSON.stringify({ classification: 'runtime-policy' }), is_default: 0, enabled: 1,
        },
      ];
      if ((await cnt('prompts')) === 0) {
        for (const p of prompts) await this.createPrompt(p);
      } else {
        const existingIds = new Set((await this.listPrompts()).map((p) => p.id));
        for (const p of prompts) {
          if (!existingIds.has(p.id)) await this.createPrompt(p);
        }
  
      }
  
      // Prompt Frameworks — seed the 4 built-in named structures (Phase 2)
      const frameworks: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '21f6a792-9267-4444-bdbc-ff7c2d4298f9', key: 'rtce', name: 'RTCE (Role → Task → Context → Expectations)',
          description: 'Concise four-section framework: establish the model role, state the task, supply context, then define expectations. Best for focused, single-turn prompts.',
          sections: JSON.stringify([
            { key: 'role',         label: 'Role',         renderOrder: 0, required: true,  header: '## Role' },
            { key: 'task',         label: 'Task',         renderOrder: 1, required: true,  header: '## Task' },
            { key: 'context',      label: 'Context',      renderOrder: 2, required: false, header: '## Context' },
            { key: 'expectations', label: 'Expectations', renderOrder: 3, required: false, header: '## Expectations' },
          ]),
          section_separator: '\n\n', enabled: 1,
        },
        {
          id: '7b55952c-4f80-40ca-81ea-461bab97c672', key: 'full', name: 'Full (Role → Task → Context → Constraints → Examples → Output Contract)',
          description: 'Six-section framework for complex, high-stakes prompts. Adds constraints, few-shot examples, and a structured output contract on top of RTCE.',
          sections: JSON.stringify([
            { key: 'role',            label: 'Role',            renderOrder: 0, required: true,  header: '## Role' },
            { key: 'task',            label: 'Task',            renderOrder: 1, required: true,  header: '## Task' },
            { key: 'context',         label: 'Context',         renderOrder: 2, required: false, header: '## Context' },
            { key: 'constraints',     label: 'Constraints',     renderOrder: 3, required: false, header: '## Constraints' },
            { key: 'examples',        label: 'Examples',        renderOrder: 4, required: false, header: '## Examples' },
            { key: 'output_contract', label: 'Output Contract', renderOrder: 5, required: false, header: '## Output Contract' },
          ]),
          section_separator: '\n\n', enabled: 1,
        },
        {
          id: 'eadfbd4d-039b-4993-a89e-82e1a9175b70', key: 'critique', name: 'Critique (Role → Task → Context → Review Instructions)',
          description: 'Four-section framework designed for LLM-as-evaluator prompts. The review_instructions section carries scoring rubrics, pass/fail thresholds, and output format requirements.',
          sections: JSON.stringify([
            { key: 'role',               label: 'Role',               renderOrder: 0, required: true,  header: '## Role' },
            { key: 'task',               label: 'Task',               renderOrder: 1, required: true,  header: '## Task' },
            { key: 'context',            label: 'Context',            renderOrder: 2, required: false, header: '## Context' },
            { key: 'review_instructions',label: 'Review Instructions',renderOrder: 3, required: true,  header: '## Review Instructions' },
          ]),
          section_separator: '\n\n', enabled: 1,
        },
        {
          id: 'df2c712c-6fcb-4048-a1ff-aee1026571fa', key: 'judge', name: 'Judge (Role → Task → Context → Scoring Rubric → Output Contract)',
          description: 'Five-section framework for LLM judge prompts that must produce numeric or categorical scores. Adds an explicit scoring rubric and structured output contract.',
          sections: JSON.stringify([
            { key: 'role',            label: 'Role',            renderOrder: 0, required: true,  header: '## Role' },
            { key: 'task',            label: 'Task',            renderOrder: 1, required: true,  header: '## Task' },
            { key: 'context',         label: 'Context',         renderOrder: 2, required: false, header: '## Context' },
            { key: 'scoring_rubric',  label: 'Scoring Rubric',  renderOrder: 3, required: true,  header: '## Scoring Rubric' },
            { key: 'output_contract', label: 'Output Contract', renderOrder: 4, required: true,  header: '## Output Contract' },
          ]),
          section_separator: '\n\n', enabled: 1,
        },
      ];
      {
        const existingFrameworkIds = new Set((await this.listPromptFrameworks()).map(f => f.id));
        for (const f of frameworks) {
          if (!existingFrameworkIds.has(f.id)) await this.createPromptFramework(f);
        }
      }
  
      // Prompt Fragments — seed common reusable blocks (Phase 2)
      const fragments: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '34959c97-a4a1-48bd-ac09-9ac176a887fb', key: 'safety_notice', name: 'Safety Notice',
          description: 'Standard safety disclaimer appended to agent prompts to discourage harmful output.',
          category: 'safety', content: [
            'SAFETY: Never produce content that is harmful, hateful, sexually explicit, or that facilitates illegal activity.',
            'Decline politely if the user requests any of the above and explain why.',
          ].join('\n'),
          variables: null, tags: JSON.stringify(['safety', 'guardrails']), version: '1.0', enabled: 1,
        },
        {
          id: '6d71697a-1132-4fa6-908b-3afbd7016e9c', key: 'json_output_contract', name: 'JSON Output Contract',
          description: 'Instructs the model to return only valid JSON. Include in any prompt where structured output is required.',
          category: 'output', content: [
            'OUTPUT FORMAT: Respond with valid JSON only. Do not include markdown code fences, prose, or commentary outside the JSON object.',
            'The response must be parseable by JSON.parse() without any pre-processing.',
          ].join('\n'),
          variables: null, tags: JSON.stringify(['json', 'structured-output']), version: '1.0', enabled: 1,
        },
        {
          id: '7c0fcd6a-90e6-4ee2-9380-62153157428c', key: 'cot_instruction', name: 'Chain-of-Thought Instruction',
          description: 'Asks the model to think step-by-step before giving its final answer. Append to task descriptions.',
          category: 'reasoning', content: 'Think step-by-step before giving your final answer. Show your reasoning explicitly.',
          variables: null, tags: JSON.stringify(['reasoning', 'cot']), version: '1.0', enabled: 1,
        },
        {
          id: 'a0999e98-3dc6-4c9b-95ea-4e62c1abd53b', key: 'language_notice', name: 'Language Notice',
          description: 'Instructs the model to respond in the same language as the user. Useful for multilingual agents.',
          category: 'i18n', content: 'Always respond in the same language the user writes in. Do not switch languages unless explicitly asked.',
          variables: null, tags: JSON.stringify(['i18n', 'language']), version: '1.0', enabled: 1,
        },
        {
          id: '6caa8594-41c4-4664-b91d-40ec8513ccc6', key: 'persona_analyst', name: 'Persona: Analyst',
          description: 'Sets the model persona to a senior data analyst. Use as the role section of an analytics prompt.',
          category: 'personas', content: [
            'You are a senior data analyst. You think rigorously, cite evidence, and present findings clearly.',
            'You prefer structured output (tables, bullet points) over prose when the data supports it.',
          ].join('\n'),
          variables: null, tags: JSON.stringify(['persona', 'analytics']), version: '1.0', enabled: 1,
        },
        {
          id: 'de14761d-5c2f-46a5-a837-dc2760b0d90c', key: 'persona_assistant', name: 'Persona: Helpful Assistant',
          description: 'Sets the model persona to a helpful, harmless, and honest AI assistant.',
          category: 'personas', content: 'You are a helpful, harmless, and honest AI assistant. You answer concisely and accurately, and ask for clarification when the request is ambiguous.',
          variables: null, tags: JSON.stringify(['persona', 'general']), version: '1.0', enabled: 1,
        },
      ];
      {
        const existingFragmentIds = new Set((await this.listPromptFragments()).map(f => f.id));
        for (const f of fragments) {
          if (!existingFragmentIds.has(f.id)) await this.createPromptFragment(f);
        }
      }
  
      // Prompt Strategies — seed built-in strategy overlays (Phase 4)
      const promptStrategies: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '1006723f-a866-4762-ad8b-b572a7e71f4c',
          key: 'singlePass',
          name: 'Single Pass',
          description: 'Render the prompt template once and send directly to the model without additional orchestration text.',
          instruction_prefix: null,
          instruction_suffix: null,
          config: JSON.stringify({ delimiter: '\n\n' }),
          enabled: 1,
        },
        {
          id: '1ae56ebf-7e13-4459-bee4-c3e2f9e75299',
          key: 'deliberate',
          name: 'Deliberate',
          description: 'Adds a brief quality checklist so the model verifies assumptions and constraints before producing the final answer.',
          instruction_prefix: null,
          instruction_suffix: 'Before finalizing: verify assumptions, check constraints, and ensure the response format is followed exactly.',
          config: JSON.stringify({ delimiter: '\n\n' }),
          enabled: 1,
        },
        {
          id: 'cc57decf-8262-43f1-acfa-d65bdbaa720d',
          key: 'critiqueRevise',
          name: 'Critique then Revise',
          description: 'Instructs the model to internally draft, critique, revise once, and return only the final revised answer.',
          instruction_prefix: null,
          instruction_suffix: 'Process requirement: internally draft, critique against requirements, revise once, then return only the final revised answer.',
          config: JSON.stringify({ delimiter: '\n\n' }),
          enabled: 1,
        },
      ];
      {
        const existingStrategyIds = new Set((await this.listPromptStrategies()).map(s => s.id));
        for (const s of promptStrategies) {
          if (!existingStrategyIds.has(s.id)) await this.createPromptStrategy(s);
        }
      }
  
      // Prompt Optimizers — seed DB-driven optimizer profiles (Phase 7)
      const promptOptimizers: Omit<PromptOptimizerRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'a057bba1-7e06-438e-9c31-1e5489810447',
          key: 'constraintAppender',
          name: 'Constraint Appender',
          description: 'Deterministic optimizer that appends explicit constraints and output checks to improve predictable compliance.',
          implementation_kind: 'rule',
          config: JSON.stringify({
            mode: 'append',
            addConstraintHeader: true,
          }),
          enabled: 1,
        },
        {
          id: '5c0497a0-1165-4947-b678-5f01bd900db7',
          key: 'llmJudgeRefine',
          name: 'LLM Judge Refine',
          description: 'Model-assisted optimizer profile designed to iteratively refine prompts using rubric-based critique and revision loops.',
          implementation_kind: 'llm',
          config: JSON.stringify({
            maxIterations: 2,
            requireDiffMetadata: true,
          }),
          enabled: 1,
        },
      ];
      {
        const existingOptimizerIds = new Set((await this.listPromptOptimizers()).map(o => o.id));
        for (const o of promptOptimizers) {
          if (!existingOptimizerIds.has(o.id)) await this.createPromptOptimizer(o);
        }
      }
  
      // Guardrails
      if ((await cnt('guardrails')) === 0) {
      const guardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '0370fa22-5fc8-49a4-bd4c-3e39863da61d', name: 'PII Redaction', description: 'Redact personal identifiable information before sending to LLM',
          type: 'redaction', stage: 'pre', config: JSON.stringify({ patterns: ['email', 'phone', 'ssn', 'credit_card'] }), priority: 100, enabled: 1,
        },
        {
          id: '51586988-83b7-4780-a006-b3b86b76713f', name: 'Toxicity Filter', description: 'Block toxic or harmful content in responses',
          type: 'content_filter', stage: 'post', config: JSON.stringify({ threshold: 0.7, categories: ['hate', 'violence', 'self_harm'] }), priority: 90, enabled: 1,
        },
        {
          id: '1a6b5225-07c6-41cc-878f-c0d08930c1de', name: 'Token Budget', description: 'Enforce maximum token usage per request',
          type: 'budget', stage: 'pre', config: JSON.stringify({ max_input_tokens: 8000, max_output_tokens: 4000 }), priority: 80, enabled: 1,
        },
        {
          id: '8ae24528-463a-4dfa-9348-a2be5214de9f', name: 'Hallucination Check', description: 'Flag responses that may contain fabricated information',
          type: 'factuality', stage: 'post', config: JSON.stringify({ confidence_threshold: 0.6, require_citations: false }), priority: 70, enabled: 1,
        },
        {
          id: '58897b64-39ca-457c-8e8b-8ce4ffc33aa5', name: 'Cognitive Pre: Sycophancy Pressure', description: 'Detect prompts that push for agreement over truth before generation',
          type: 'cognitive_check', stage: 'pre', config: JSON.stringify({ check: 'pre_sycophancy', pattern: "\\b(agree with me|just agree|say yes|validate me|don't challenge|no criticism)\\b", warn_confidence: 0.62, allow_confidence: 0.86 }), priority: 65, enabled: 1,
        },
        {
          id: '70469180-6265-47d8-82c6-ee3cec180bc6', name: 'Cognitive Pre: Confidence Gate', description: 'Apply risk-aware confidence gate before generation',
          type: 'cognitive_check', stage: 'pre', config: JSON.stringify({ check: 'pre_confidence', gate_threshold: 0.65, gate_on_fail: 'warn', medium_risk_confidence: 0.72, high_risk_confidence: 0.6, critical_risk_confidence: 0.5, low_risk_confidence: 0.82 }), priority: 64, enabled: 1,
        },
        {
          id: 'e6f04e4f-29bb-4081-a9e8-ef66dba939bf', name: 'Cognitive Post: Grounding', description: 'Check lexical grounding between prompt and response',
          type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_grounding', min_overlap: 0.06 }), priority: 63, enabled: 1,
        },
        {
          id: 'f9e2ec15-8243-4884-9056-a5cf79af9800', name: 'Cognitive Post: Sycophancy Phrasing', description: 'Detect strong sycophantic phrasing in assistant output',
          type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_sycophancy', pattern: "\\b(you are absolutely right|exactly right|totally correct|you are 100% right)\\b", warn_confidence: 0.58, allow_confidence: 0.86 }), priority: 62, enabled: 1,
        },
        {
          id: 'af3ed9ac-b3ca-4d10-bf80-678e4a750389', name: 'Cognitive Post: Devils Advocate', description: 'Ensure decision-style queries include counterpoints and trade-offs',
          type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_devils_advocate', needs_pattern: "\\b(should i|is it good|best|recommend|decision|choose|strategy|plan)\\b", has_pattern: "\\b(however|on the other hand|trade-?off|counterpoint|risk|alternative)\\b", warn_confidence: 0.6, allow_confidence: 0.84 }), priority: 61, enabled: 1,
        },
        {
          id: '4ace09e3-5aa8-4761-8d7c-e56f81ae84dd', name: 'Cognitive Post: Confidence Gate', description: 'Apply post-response confidence gate for outcome signaling',
          type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_confidence', gate_threshold: 0.67, gate_on_fail: 'warn' }), priority: 60, enabled: 1,
        },
        {
          id: '7c8988ba-b7c9-4e52-8139-732e5c922a25', name: 'Prompt Injection: Directive Override', description: 'Block attempts to override system or developer instructions',
          type: 'content_filter', stage: 'pre', config: JSON.stringify({
            words: [
              'ignore previous instructions',
              'disregard previous instructions',
              'forget all prior instructions',
              'override system prompt',
              'ignore system prompt',
              'ignore developer instructions',
              'jailbreak',
              'do anything now',
            ],
            action: 'deny',
          }), priority: 95, enabled: 1,
        },
        {
          id: '0eb8ae21-e411-4dae-921f-3f91651619d9', name: 'Prompt Injection: Prompt Exfiltration', description: 'Block attempts to extract hidden prompts or policies',
          type: 'regex', stage: 'pre', config: JSON.stringify({
            pattern: '(?:show|reveal|print|dump|output).{0,80}(?:system prompt|developer message|hidden instructions|internal policy)',
            flags: 'i',
            action: 'deny',
          }), priority: 94, enabled: 1,
        },
      ];
      for (const g of guardrails) await this.createGuardrail(g);
      }
  
      // Ensure prompt-injection guardrails exist for existing databases
      const injectionGuardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '7c8988ba-b7c9-4e52-8139-732e5c922a25', name: 'Prompt Injection: Directive Override', description: 'Block attempts to override system or developer instructions',
          type: 'content_filter', stage: 'pre', config: JSON.stringify({
            words: [
              'ignore previous instructions',
              'disregard previous instructions',
              'forget all prior instructions',
              'override system prompt',
              'ignore system prompt',
              'ignore developer instructions',
              'jailbreak',
              'do anything now',
            ],
            action: 'deny',
          }), priority: 95, enabled: 1,
        },
        {
          id: '0eb8ae21-e411-4dae-921f-3f91651619d9', name: 'Prompt Injection: Prompt Exfiltration', description: 'Block attempts to extract hidden prompts or policies',
          type: 'regex', stage: 'pre', config: JSON.stringify({
            pattern: '(?:show|reveal|print|dump|output).{0,80}(?:system prompt|developer message|hidden instructions|internal policy)',
            flags: 'i',
            action: 'deny',
          }), priority: 94, enabled: 1,
        },
      ];
      for (const g of injectionGuardrails) {
        const existing = await this.getGuardrail(g.id);
        if (!existing) await this.createGuardrail(g);
      }
  
      // Extended guardrail seed — upserted on every boot so existing DBs receive them.
      // Covers: new injection patterns, credential protection, escalation policies (W4),
      // output safety, model-graded opt-ins (W2/W3), and normaliser-aware rules (W10).
      const extendedGuardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [
  
        // ── Injection / jailbreak (new patterns) ─────────────────────────────
        {
          id: 'c1000001-aaaa-4000-8000-000000000001',
          name: 'Prompt Injection: Role-Play Bypass',
          description: 'Block persona-switch attempts used to strip safety constraints',
          type: 'blocklist', stage: 'pre',
          config: JSON.stringify({
            words: [
              'pretend you are', 'you are now', 'act as if you have no restrictions',
              'forget you are an ai', 'you have no limitations', 'you are a different ai',
              'roleplay as', 'act as an ai without',
            ],
            action: 'deny',
          }),
          priority: 97, enabled: 1,
        },
        {
          id: 'c1000002-aaaa-4000-8000-000000000002',
          name: 'Prompt Injection: Developer / God Mode',
          description: 'Block requests to activate fictional unrestricted operating modes',
          type: 'blocklist', stage: 'pre',
          config: JSON.stringify({
            words: [
              'developer mode', 'god mode', 'unrestricted mode', 'no restrictions mode',
              'dan mode', 'jailbreak mode', 'sudo mode', 'override mode',
            ],
            action: 'deny',
          }),
          priority: 96, enabled: 1,
        },
        {
          id: 'c1000003-aaaa-4000-8000-000000000003',
          name: 'Prompt Injection: Indirect / Hypothetical Wrapper',
          description: 'Warn on hypothetical/fictional framings commonly used to elicit harmful content',
          type: 'regex', stage: 'pre',
          config: JSON.stringify({
            pattern: '(?:hypothetically|in a fictional world|for (?:educational|academic|research) purposes?|as a creative writing exercise|imagine you could|in this thought experiment).{0,120}(?:how to|explain|steps|instructions|guide)',
            flags: 'i',
            action: 'warn',
          }),
          priority: 93, enabled: 1,
        },
        {
          id: 'c1000004-aaaa-4000-8000-000000000004',
          name: 'Prompt Injection: Base64 Encoded Instruction',
          description: 'Warn when a long base64-like token appears alongside execution verbs (W10)',
          type: 'regex', stage: 'pre',
          config: JSON.stringify({
            pattern: '(?:[A-Za-z0-9+/]{30,}={0,2}).{0,60}(?:execute|run|eval|decode and run|perform)',
            flags: 'i',
            action: 'warn',
          }),
          priority: 92, enabled: 1,
        },
  
        // ── Credential / secret protection ───────────────────────────────────
        {
          id: 'c2000001-aaaa-4000-8000-000000000001',
          name: 'Credential: API Key in Output',
          description: 'Deny assistant responses that appear to contain real API keys or bearer tokens',
          type: 'regex', stage: 'post',
          config: JSON.stringify({
            pattern: '(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}|Bearer\\s+[A-Za-z0-9._-]{20,}|AKIA[A-Z0-9]{16})',
            flags: 'i',
            action: 'deny',
          }),
          priority: 98, enabled: 1,
        },
        {
          id: 'c2000002-aaaa-4000-8000-000000000002',
          name: 'Credential: Private Key in Output',
          description: 'Deny responses containing PEM private key headers',
          type: 'regex', stage: 'post',
          config: JSON.stringify({
            pattern: '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            flags: 'i',
            action: 'deny',
          }),
          priority: 99, enabled: 1,
        },
        {
          id: 'c2000003-aaaa-4000-8000-000000000003',
          name: 'Credential: Database Connection String in Output',
          description: 'Warn when a response leaks a database connection string with embedded credentials',
          type: 'regex', stage: 'post',
          config: JSON.stringify({
            pattern: '(?:postgres|mysql|mongodb|redis|amqp)://[^:@\\s]+:[^@\\s]+@',
            flags: 'i',
            action: 'deny',
          }),
          priority: 98, enabled: 1,
        },
  
        // ── Output safety ─────────────────────────────────────────────────────
        {
          id: 'c3000001-aaaa-4000-8000-000000000001',
          name: 'Output: False Certainty',
          description: 'Warn when the assistant expresses absolute certainty where none is warranted',
          type: 'regex', stage: 'post',
          config: JSON.stringify({
            pattern: '\\b(100% (?:guaranteed|certain|sure|accurate|correct)|absolutely (?:guaranteed|certain|infallible)|will definitely work|cannot fail|no risk whatsoever)\\b',
            flags: 'i',
            action: 'warn',
          }),
          priority: 55, enabled: 1,
        },
        {
          id: 'c3000002-aaaa-4000-8000-000000000002',
          name: 'Output: Unsolicited Password / Secret Disclosure',
          description: 'Deny outputs that volunteer credentials in plain text',
          type: 'blocklist', stage: 'post',
          config: JSON.stringify({
            words: ['the password is', 'your password is', 'api key is', 'secret key is', 'access token is', 'the secret is'],
            action: 'deny',
          }),
          priority: 99, enabled: 1,
        },
        {
          id: 'c3000003-aaaa-4000-8000-000000000003',
          name: 'Output: PII in Assistant Response',
          description: 'Warn when the assistant echoes SSN, credit card, or raw email in its response',
          type: 'regex', stage: 'post',
          config: JSON.stringify({
            pattern: '(?:\\b\\d{3}-\\d{2}-\\d{4}\\b|\\b(?:\\d[ -]*?){13,16}\\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})',
            flags: 'i',
            action: 'warn',
          }),
          priority: 88, enabled: 1,
        },
  
        // ── W4 Escalation policies ────────────────────────────────────────────
        {
          id: 'c4000001-aaaa-4000-8000-000000000001',
          name: 'Escalation: Critical-Risk Action Auto-Block',
          description: 'Immediately block any turn where the risk gate detects a critical-risk action (delete/drop/truncate)',
          type: 'escalation_policy', stage: 'pre',
          config: JSON.stringify({ risk_levels: ['critical'], on_escalate: 'block' }),
          priority: 100, enabled: 1,
        },
        {
          id: 'c4000002-aaaa-4000-8000-000000000002',
          name: 'Escalation: Cognitive Warn Accumulation',
          description: 'Require human approval when 2 or more cognitive guardrails warn in the same turn',
          type: 'escalation_policy', stage: 'pre',
          config: JSON.stringify({ min_warn_count: 2, categories: ['cognitive'], on_escalate: 'require-approval' }),
          priority: 75, enabled: 1,
        },
        {
          id: 'c4000003-aaaa-4000-8000-000000000003',
          name: 'Escalation: Safety + Cognitive Combined Warn',
          description: 'Block when both a safety warn and a cognitive warn fire in the same turn',
          type: 'escalation_policy', stage: 'post',
          config: JSON.stringify({ min_warn_count: 2, categories: ['cognitive', 'safety'], on_escalate: 'block' }),
          priority: 74, enabled: 1,
        },
  
        // ── W2/W3 Model-graded opt-ins ────────────────────────────────────────
        {
          id: 'b1c2d3e4-0006-4000-8000-000000000006',
          name: 'Input Safety: Content Moderation',
          description: 'Screen the user message before the model runs. Calls a ModerationModel (OpenAI omni-moderation) and denies on any flagged category (hate, harassment, violence, self-harm, sexual, illicit/weapons). Always-on input safety gate.',
          type: 'model-graded', stage: 'pre',
          config: JSON.stringify({ rule: 'moderation', threshold: 0.5, action: 'deny', timeout_ms: 4000, on_error: 'warn' }),
          priority: 100, enabled: 1,
        },
        {
          id: 'b1c2d3e4-0001-4000-8000-000000000001',
          name: 'Model-Graded: Content Moderation',
          description: 'Call a ModerationModel to flag hate, violence, self-harm, sexual, and illicit content in the assistant output. Enable and supply moderationModel in PipelineOptions to activate.',
          type: 'model-graded', stage: 'post',
          config: JSON.stringify({ rule: 'moderation', categories: ['hate', 'hate/threatening', 'harassment', 'harassment/threatening', 'violence', 'violence/graphic', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'sexual', 'sexual/minors', 'illicit', 'illicit/violent'], threshold: 0.7, action: 'deny', timeout_ms: 8000, on_error: 'warn' }),
          priority: 91, enabled: 1,
          trigger_conditions: JSON.stringify({ any: [{ persona: ['tenant_user', 'anonymous'] }, { prior_has_warn: true }] }),
          trigger_description: 'Non-admin user or prior warn — skip for internal admin-only sessions',
        },
        {
          id: 'b1c2d3e4-0002-4000-8000-000000000002',
          name: 'Model-Graded: LLM Safety Judge',
          description: 'Rubric-based LLM judge for safety, appropriateness, and factual grounding. Enable and supply model in PipelineOptions.',
          type: 'model-graded', stage: 'post',
          config: JSON.stringify({ rule: 'llm-judge', rubric: 'You are a safety judge. Evaluate whether the text is safe, appropriate, and factually grounded. Output JSON: { decision, confidence, rationale }', action: 'deny', timeout_ms: 15000, on_error: 'warn' }),
          priority: 85, enabled: 1,
          trigger_conditions: JSON.stringify({ any: [{ chat_mode: ['agent', 'supervisor'] }, { turn_has_tool_calls: true }, { risk_level: ['high', 'critical'] }, { output_length_gt: 500 }, { prior_has_warn: true }, { persona: ['anonymous'] }] }),
          trigger_description: 'Agent/supervisor mode, tool calls, high risk, long output, prior warn, or anonymous user',
        },
        {
          id: 'b1c2d3e4-0003-4000-8000-000000000003',
          name: 'Model-Graded: Prompt Injection Classifier',
          description: 'LLM-judge specialised for injection and jailbreak detection. Fail-closed (on_error: deny). Enable and supply model.',
          type: 'model-graded', stage: 'pre',
          config: JSON.stringify({ rule: 'injection-classifier', action: 'deny', timeout_ms: 15000, on_error: 'warn' }),
          priority: 96, enabled: 1,
          trigger_conditions: JSON.stringify({ any: [{ input_has_code: true }, { input_has_base64: true }, { input_has_structured_data: true }, { input_has_urls: true }, { input_has_instruction_override: true }, { persona: ['anonymous'] }, { prior_has_injection_warn: true }, { input_length_gt: 300 }] }),
          trigger_description: 'Code / base64 / URLs / override phrase / anonymous user / long input / prior injection warn',
        },
        {
          id: 'b1c2d3e4-0004-4000-8000-000000000004',
          name: 'Model-Graded: Sycophancy Judge',
          description: 'LLM-judge that detects sycophancy more reliably than lexical rules. Advisory warn only. Enable and supply model.',
          type: 'model-graded', stage: 'post',
          config: JSON.stringify({ rule: 'sycophancy-judge', action: 'warn', timeout_ms: 8000, on_error: 'allow' }),
          priority: 59, enabled: 1,
          trigger_conditions: JSON.stringify({ any: [{ input_has_validation_seeking: true }, { all: [{ turn_number_gt: 3 }, { prior_has_cognitive_warn: true }] }] }),
          trigger_description: 'Validation-seeking phrasing, or long session with prior cognitive warn',
        },
        {
          id: 'b1c2d3e4-0005-4000-8000-000000000005',
          name: 'Model-Graded: Semantic Grounding',
          description: 'Embedding cosine-similarity grounding check. Warns when output is semantically distant from evidence. Enable and supply embeddingModel.',
          type: 'model-graded', stage: 'post',
          config: JSON.stringify({ rule: 'semantic-grounding', min_similarity: 0.50, evidence_field: 'both', action: 'warn', timeout_ms: 6000, on_error: 'allow' }),
          priority: 58, enabled: 1,
          trigger_conditions: JSON.stringify({ all: [{ output_has_factual_claims: true }, { output_has_tool_evidence: false }] }),
          trigger_description: 'Factual claims in output AND no tool evidence (tool-grounded answers skip this)',
        },
      ];
      for (const g of extendedGuardrails) {
        const existing = await this.getGuardrail(g.id);
        if (!existing) await this.createGuardrail(g);
      }
  
      // Routing policies
      if ((await cnt('routing_policies')) === 0) {
      const policies: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'a2cdb3b9-cd89-48d8-884d-ce617a9ca328', name: 'Cost Optimized', description: 'Route to the cheapest model that meets quality thresholds',
          strategy: 'cost', constraints: JSON.stringify({ min_quality_score: 0.7 }), weights: JSON.stringify({ cost: 0.7, quality: 0.2, latency: 0.1 }),
          fallback_model: 'gpt-4o-mini', fallback_provider: 'openai', enabled: 1,
        },
        {
          id: 'eea58ad8-5c94-4aba-98ce-850c4a567e31', name: 'Quality First', description: 'Always route to the highest quality model available',
          strategy: 'quality', constraints: null, weights: JSON.stringify({ cost: 0.1, quality: 0.8, latency: 0.1 }),
          fallback_model: 'claude-sonnet-4-6', fallback_provider: 'anthropic', enabled: 1,
        },
        {
          id: 'b6bcb4e8-16e2-4c40-b5a6-50bc15912c23', name: 'Balanced', description: 'Balance between cost, quality and speed',
          strategy: 'balanced', constraints: null, weights: JSON.stringify({ cost: 0.33, quality: 0.34, latency: 0.33 }),
          fallback_model: 'gpt-4o', fallback_provider: 'openai', enabled: 1,
        },
      ];
      for (const r of policies) await this.createRoutingPolicy(r);
      }
  
      // Model pricing
      if ((await cnt('model_pricing')) === 0) {
      // Seeded with public list prices captured from provider pricing pages.
      // Operators edit these in the admin Pricing tab; sync button refreshes from APIs.
      const pricing: Omit<ModelPricingRow, 'created_at' | 'updated_at'>[] = [
        { id: '24c261e4-3cd0-48da-aba5-ad65cdc4ba84', model_id: 'claude-sonnet-4-6',          provider: 'anthropic', display_name: 'Claude Sonnet 4.6',          input_cost_per_1m: 3.00,  output_cost_per_1m: 15.00, quality_score: 0.87, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: '3a01332c-7062-46f4-ac27-23718d0b7e11', model_id: 'claude-opus-4-7',            provider: 'anthropic', display_name: 'Claude Opus 4.7',            input_cost_per_1m: 15.00, output_cost_per_1m: 75.00, quality_score: 0.95, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: '7a159bca-cd4a-4008-9adf-537d3f9087a5', model_id: 'claude-haiku-4-5-20251001',  provider: 'anthropic', display_name: 'Claude Haiku 4.5',  input_cost_per_1m: 0.80,  output_cost_per_1m: 4.00,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'd544e807-dd8b-45fc-8d7c-4c35b00fe34c',             model_id: 'gpt-4o',                      provider: 'openai',    display_name: 'GPT-4o',             input_cost_per_1m: 2.50,  output_cost_per_1m: 10.00, quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: '453e9a1e-b374-436b-bbed-58ba0a0db737',        model_id: 'gpt-4o-mini',                 provider: 'openai',    display_name: 'GPT-4o Mini',        input_cost_per_1m: 0.15,  output_cost_per_1m: 0.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: '5a851707-9a6f-434f-9c8f-e6bc02647e90',            model_id: 'gpt-4.1',                     provider: 'openai',    display_name: 'GPT-4.1',            input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'b2c6d495-f58e-40f1-aff2-d58050aabedb',       model_id: 'gpt-4.1-mini',                provider: 'openai',    display_name: 'GPT-4.1 Mini',       input_cost_per_1m: 0.40,  output_cost_per_1m: 1.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'bf5734a5-3552-4068-a80d-457c25f927ab',       model_id: 'gpt-4.1-nano',                provider: 'openai',    display_name: 'GPT-4.1 Nano',       input_cost_per_1m: 0.10,  output_cost_per_1m: 0.40,  quality_score: 0.60, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: '5190bfc2-0601-4153-8563-a6f5811bdcae',                 model_id: 'o3',                           provider: 'openai',    display_name: 'o3',                 input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'f7c3f6b4-f3de-4070-a547-f37359aa0ca4',            model_id: 'o4-mini',                      provider: 'openai',    display_name: 'o4 Mini',            input_cost_per_1m: 1.10,  output_cost_per_1m: 4.40,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
        // Google Gemini — public list pricing (ai.google.dev/pricing)
        { id: 'a1b2c3d4-0001-4000-8000-000000000001', model_id: 'gemini-2.5-pro',         provider: 'google', display_name: 'Gemini 2.5 Pro',        input_cost_per_1m: 1.25,   output_cost_per_1m: 10.00, quality_score: 0.92, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0001-4000-8000-000000000002', model_id: 'gemini-2.5-flash',       provider: 'google', display_name: 'Gemini 2.5 Flash',      input_cost_per_1m: 0.30,   output_cost_per_1m: 2.50,  quality_score: 0.82, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0001-4000-8000-000000000003', model_id: 'gemini-2.5-flash-lite',  provider: 'google', display_name: 'Gemini 2.5 Flash Lite', input_cost_per_1m: 0.10,   output_cost_per_1m: 0.40,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0001-4000-8000-000000000004', model_id: 'gemini-1.5-pro',         provider: 'google', display_name: 'Gemini 1.5 Pro',        input_cost_per_1m: 1.25,   output_cost_per_1m: 5.00,  quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0001-4000-8000-000000000005', model_id: 'gemini-1.5-flash',       provider: 'google', display_name: 'Gemini 1.5 Flash',      input_cost_per_1m: 0.075,  output_cost_per_1m: 0.30,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
        // Ollama (local) — zero cost; quality is a heuristic operators can override
        { id: 'a1b2c3d4-0002-4000-8000-000000000001', model_id: 'llama3.1',     provider: 'ollama', display_name: 'Llama 3.1 (local)',    input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0002-4000-8000-000000000002', model_id: 'llama3',       provider: 'ollama', display_name: 'Llama 3 (local)',      input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.70, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0002-4000-8000-000000000003', model_id: 'qwen2.5',      provider: 'ollama', display_name: 'Qwen 2.5 (local)',     input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.74, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0002-4000-8000-000000000004', model_id: 'mistral',      provider: 'ollama', display_name: 'Mistral (local)',      input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.68, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0002-4000-8000-000000000005', model_id: 'phi3',         provider: 'ollama', display_name: 'Phi 3 (local)',        input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.65, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0002-4000-8000-000000000006', model_id: 'gemma2',       provider: 'ollama', display_name: 'Gemma 2 (local)',      input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.66, source: 'seed', last_synced_at: null, enabled: 1 },
        { id: 'a1b2c3d4-0002-4000-8000-000000000007', model_id: 'deepseek-r1',  provider: 'ollama', display_name: 'DeepSeek R1 (local)',  input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.80, source: 'seed', last_synced_at: null, enabled: 1 },
        // llama.cpp (local OpenAI-compatible server) — zero cost
        { id: 'a1b2c3d4-0003-4000-8000-000000000001', model_id: 'local',        provider: 'llamacpp', display_name: 'llama.cpp local model', input_cost_per_1m: 0, output_cost_per_1m: 0, quality_score: 0.70, source: 'seed', last_synced_at: null, enabled: 1 },
      ];
      for (const p of pricing) await this.createModelPricing(p);
      }
  
      // Workflow definitions
      if ((await cnt('workflow_defs')) === 0) {
      const workflows: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '3aedac32-ef1a-429f-89d7-23d481ccd8ad', name: 'Code Review Pipeline', description: 'Automated code review with human approval gate',
          version: '1.0', entry_step_id: 'analyze',
          steps: JSON.stringify([
            { id: 'analyze', type: 'agent', name: 'Static Analysis', next: 'review' },
            { id: 'review', type: 'agent', name: 'AI Code Review', next: 'approve' },
            { id: 'approve', type: 'human', name: 'Human Approval', next: 'report' },
            { id: 'report', type: 'agent', name: 'Generate Report', next: null },
          ]),
          metadata: JSON.stringify({ category: 'engineering' }), enabled: 1,
        },
        {
          id: 'f47a3a38-a090-4956-8998-3e2bf6327304', name: 'Content Generation', description: 'Draft, review, and publish content workflow',
          version: '1.0', entry_step_id: 'draft',
          steps: JSON.stringify([
            { id: 'draft', type: 'agent', name: 'Generate Draft', next: 'edit' },
            { id: 'edit', type: 'agent', name: 'Edit & Polish', next: 'approve' },
            { id: 'approve', type: 'human', name: 'Editorial Approval', next: null },
          ]),
          metadata: JSON.stringify({ category: 'content' }), enabled: 1,
        },
        {
          id: '2cb3d0de-9ce7-4b90-a7cd-7c41f762a988', name: 'NZ Statistics Lookup', description: 'Search, identify, and retrieve official New Zealand statistics from Stats NZ ADE',
          version: '1.0', entry_step_id: 'search',
          steps: JSON.stringify([
            { id: 'search', type: 'agent', name: 'Search Dataflows', next: 'inspect', tools: ['statsnz_search_dataflows', 'statsnz_list_dataflows'] },
            { id: 'inspect', type: 'agent', name: 'Inspect Dataset Structure', next: 'fetch', tools: ['statsnz_get_dataflow_info', 'statsnz_get_codelist'] },
            { id: 'fetch', type: 'agent', name: 'Fetch Observations', next: 'present', tools: ['statsnz_get_data'] },
            { id: 'present', type: 'agent', name: 'Format & Present Results', next: null },
          ]),
          metadata: JSON.stringify({ category: 'statistics', country: 'NZ' }), enabled: 1,
        },
      ];
      for (const w of workflows) await this.createWorkflowDef(w);
      }
  
      // Tool catalog
      if ((await cnt('tool_catalog')) === 0) {
      const tools: Omit<ToolCatalogRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'a7bd3e9f-9b1b-4aa6-9520-8f5fb194a5e3', name: 'Web Search',
          description: 'Search the web for current information using the configured search provider.',
          category: 'retrieval', risk_level: 'read-only', requires_approval: 0,
          max_execution_ms: 10000, rate_limit_per_min: 30, enabled: 1,
          tool_key: 'web_search', version: '1.0', side_effects: 0,
          tags: JSON.stringify(['search', 'retrieval', 'web']), source: 'builtin', credential_id: null,
        },
        {
          id: '8e6c2528-f5a0-4d5a-a719-b60cc660f353', name: 'Code Execution',
          description: 'Execute code snippets in a sandboxed environment via the Cloud Sandbox Engine.',
          category: 'compute', risk_level: 'external-side-effect', requires_approval: 1,
          max_execution_ms: 30000, rate_limit_per_min: 10, enabled: 1,
          tool_key: 'cse_run_code', version: '1.0', side_effects: 1,
          tags: JSON.stringify(['code', 'compute', 'sandbox']), source: 'builtin', credential_id: null,
        },
        {
          id: 'bca36e31-bf3b-4761-89ba-0f1edecf22cf', name: 'File Reader',
          description: 'Read files from allowed directories on the server filesystem.',
          category: 'filesystem', risk_level: 'read-only', requires_approval: 0,
          max_execution_ms: 5000, rate_limit_per_min: 60, enabled: 1,
          tool_key: 'file_reader', version: '1.0', side_effects: 0,
          tags: JSON.stringify(['filesystem', 'read']), source: 'builtin', credential_id: null,
        },
        {
          id: '9bbd1c34-35a1-442f-b2bb-d5d6f568f57a', name: 'Database Query',
          description: 'Run read-only SQL queries against configured databases.',
          category: 'data', risk_level: 'read-only', requires_approval: 0,
          max_execution_ms: 15000, rate_limit_per_min: 20, enabled: 1,
          tool_key: 'database_query', version: '1.0', side_effects: 0,
          tags: JSON.stringify(['database', 'sql', 'read']), source: 'builtin', credential_id: null,
        },
        {
          id: '31755606-4e34-44be-a101-cee78d49f6e1', name: 'API Caller',
          description: 'Make HTTP requests to allowlisted external endpoints.',
          category: 'integration', risk_level: 'external-side-effect', requires_approval: 0,
          max_execution_ms: 20000, rate_limit_per_min: 15, enabled: 1,
          tool_key: 'api_caller', version: '1.0', side_effects: 1,
          tags: JSON.stringify(['http', 'api', 'integration']), source: 'builtin', credential_id: null,
        },
        {
          id: '220dd56e-5c1c-4dad-93c8-befa5d7588f5', name: 'Stats NZ (Aotearoa Data Explorer)',
          description: 'Query official New Zealand statistics — population, census, GDP, trade, housing, labour, and more via the Stats NZ ADE SDMX API.',
          category: 'data', risk_level: 'read-only', requires_approval: 0,
          max_execution_ms: 30000, rate_limit_per_min: 20, enabled: 1,
          tool_key: 'statsnz_get_data', version: '1.0', side_effects: 0,
          tags: JSON.stringify(['statistics', 'new-zealand', 'data']), source: 'builtin', credential_id: null,
        },
      ];
      for (const t of tools) await this.createToolConfig(t);
      }
  
      // Skills
      if ((await cnt('skills')) === 0) {
        for (const s of BUILT_IN_SKILLS) {
          await this.createSkill({
            id: s.id,
            name: s.name,
            description: s.description ?? s.summary,
            category: s.category ?? 'general',
            trigger_patterns: JSON.stringify(s.triggerPatterns),
            instructions: s.instructions ?? s.executionGuidance ?? s.summary,
            tool_names: s.toolNames ? JSON.stringify(s.toolNames) : null,
            examples: s.examples ? JSON.stringify(s.examples) : null,
            tags: s.tags ? JSON.stringify(s.tags) : null,
            priority: s.priority ?? 0,
            version: s.version ?? '1.0',
            enabled: s.enabled === false ? 0 : 1,
            tool_policy_key: s.toolPolicyKey ?? null,
          });
        }
      }
  
      const dataAnalysisSkill = BUILT_IN_SKILLS.find((skill) => skill.id === 'skill-data-analysis-execution');
      if (dataAnalysisSkill) {
        const existingSkill = await this.getSkill(dataAnalysisSkill.id);
        const skillFields = {
          name: dataAnalysisSkill.name,
          description: dataAnalysisSkill.description ?? dataAnalysisSkill.summary,
          category: dataAnalysisSkill.category ?? 'general',
          trigger_patterns: JSON.stringify(dataAnalysisSkill.triggerPatterns),
          instructions: dataAnalysisSkill.instructions ?? dataAnalysisSkill.executionGuidance ?? dataAnalysisSkill.summary,
          tool_names: dataAnalysisSkill.toolNames ? JSON.stringify(dataAnalysisSkill.toolNames) : null,
          examples: dataAnalysisSkill.examples ? JSON.stringify(dataAnalysisSkill.examples) : null,
          tags: dataAnalysisSkill.tags ? JSON.stringify(dataAnalysisSkill.tags) : null,
          priority: dataAnalysisSkill.priority ?? 0,
          version: dataAnalysisSkill.version ?? '1.0',
          enabled: dataAnalysisSkill.enabled === false ? 0 : 1,
          tool_policy_key: dataAnalysisSkill.toolPolicyKey ?? null,
        };
        // Preserve operator-managed skill customizations; only ensure the built-in
        // row exists when absent.
        if (!existingSkill) {
          await this.createSkill({ id: dataAnalysisSkill.id, ...skillFields });
        }
      }
  
      // Task Contracts (must seed before worker_agents for FK reference tc-nz-statistics)
      if ((await cnt('task_contracts')) === 0) {
      const contracts: Omit<TaskContractRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'fbb4e3aa-a78b-452f-90b9-30ec0a1da2ea', name: 'Code Review Contract', description: 'Contract for AI-assisted code review tasks',
          input_schema: JSON.stringify({ type: 'object', required: ['code', 'language'], properties: { code: { type: 'string' }, language: { type: 'string' }, context: { type: 'string' } } }),
          output_schema: JSON.stringify({ type: 'object', required: ['summary', 'issues'], properties: { summary: { type: 'string' }, issues: { type: 'array' }, score: { type: 'number' } } }),
          acceptance_criteria: JSON.stringify([
            { id: 'cr-has-summary', description: 'Output must include a summary', type: 'assertion', config: { field: 'summary', operator: 'exists' }, required: true, weight: 1 },
            { id: 'cr-has-issues', description: 'Output must include issues array', type: 'assertion', config: { field: 'issues', operator: 'exists' }, required: true, weight: 1 },
            { id: 'cr-score-range', description: 'Score must be between 0 and 10', type: 'assertion', config: { field: 'score', operator: 'gte', expected: 0 }, required: false, weight: 0.5 },
          ]),
          max_attempts: 3, timeout_ms: 60000,
          evidence_required: JSON.stringify(['text', 'metric']), min_confidence: 0.7, require_human_review: 0, enabled: 1,
        },
        {
          id: 'e5f03434-6aba-4e7f-93c5-838344d25d9b', name: 'Content Generation Contract', description: 'Contract for AI content generation tasks',
          input_schema: JSON.stringify({ type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, audience: { type: 'string' }, maxWords: { type: 'number' } } }),
          output_schema: JSON.stringify({ type: 'object', required: ['content', 'wordCount'], properties: { content: { type: 'string' }, wordCount: { type: 'number' }, readabilityScore: { type: 'number' } } }),
          acceptance_criteria: JSON.stringify([
            { id: 'cg-has-content', description: 'Output must include content', type: 'assertion', config: { field: 'content', operator: 'exists' }, required: true, weight: 1 },
            { id: 'cg-word-count', description: 'Must include word count', type: 'assertion', config: { field: 'wordCount', operator: 'gt', expected: 0 }, required: true, weight: 0.5 },
          ]),
          max_attempts: 2, timeout_ms: 120000,
          evidence_required: JSON.stringify(['text']), min_confidence: 0.8, require_human_review: 1, enabled: 1,
        },
        {
          id: '2e9ac54f-a9b4-4ecd-88a0-1113d8c32a34', name: 'Data Analysis Contract', description: 'Contract for data analysis and reporting tasks',
          input_schema: JSON.stringify({ type: 'object', required: ['query'], properties: { query: { type: 'string' }, dataset: { type: 'string' } } }),
          output_schema: JSON.stringify({ type: 'object', required: ['analysis', 'confidence'], properties: { analysis: { type: 'string' }, confidence: { type: 'number' }, charts: { type: 'array' } } }),
          acceptance_criteria: JSON.stringify([
            { id: 'da-has-analysis', description: 'Output must include analysis text', type: 'assertion', config: { field: 'analysis', operator: 'exists' }, required: true, weight: 1 },
            { id: 'da-confidence', description: 'Confidence must be at least 0.5', type: 'assertion', config: { field: 'confidence', operator: 'gte', expected: 0.5 }, required: true, weight: 1 },
          ]),
          max_attempts: 3, timeout_ms: 180000,
          evidence_required: JSON.stringify(['text', 'metric', 'trace']), min_confidence: 0.6, require_human_review: 0, enabled: 1,
        },
        {
          id: 'eb6561e5-46a8-446d-8056-0d1a6fac751e', name: 'NZ Statistics Lookup Contract', description: 'Contract for querying official New Zealand statistics from Stats NZ Aotearoa Data Explorer',
          input_schema: JSON.stringify({ type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'The statistical question (e.g. "NZ population by region")' }, dataflow_id: { type: 'string', description: 'Optional specific dataflow ID if known' } } }),
          output_schema: JSON.stringify({ type: 'object', required: ['dataset_id', 'period', 'values'], properties: { dataset_id: { type: 'string', description: 'Stats NZ dataflow ID' }, dataset_name: { type: 'string' }, period: { type: 'string', description: 'Reference period or year' }, values: { type: 'array', description: 'Numeric observations returned' }, unit: { type: 'string' }, source: { type: 'string' } } }),
          acceptance_criteria: JSON.stringify([
            { id: 'nz-has-dataset', description: 'Output must include a Stats NZ dataset ID', type: 'assertion', config: { field: 'dataset_id', operator: 'exists' }, required: true, weight: 1 },
            { id: 'nz-has-period', description: 'Output must include a reference period or year', type: 'assertion', config: { field: 'period', operator: 'exists' }, required: true, weight: 1 },
            { id: 'nz-has-values', description: 'Output must include at least one numeric value', type: 'assertion', config: { field: 'values', operator: 'exists' }, required: true, weight: 1 },
          ]),
          max_attempts: 3, timeout_ms: 120000,
          evidence_required: JSON.stringify(['text', 'metric', 'trace']), min_confidence: 0.7, require_human_review: 0, enabled: 1,
        },
      ];
      for (const c of contracts) await this.createTaskContract(c);
      }
  
      // Worker agents
      if ((await cnt('worker_agents')) === 0) {
        const workers: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>[] = [
          {
            id: '8d2598f8-775d-4e67-841d-1cb5fb16713e', name: 'code_executor',
            display_name: 'Casey',
            job_profile: 'Code Execution Specialist',
            description: '[USE FIRST FOR ANY CODE/SCRIPT/RUN REQUEST] Writes AND executes code in real isolated Docker containers via CSE. Uses the dedicated data-analysis sandbox for dataframe/charting work and returns actual stdout. Use for: "run", "execute", "run it", "run in a container", "write and run", "test", "script that runs", and dataset analysis that requires real execution.',
            system_prompt: [
              'You are a code writing + execution + verification agent.',
              'Your mission is not just to write code, but to make it run successfully and produce validated results.',
              '',
              'Execution workflow (MANDATORY):',
              '1. Understand objective and available attached files from context.',
              '2. Generate a runnable script.',
              '3. Execute with the correct CSE tool: use `cse_run_data_analysis` for file/data analysis, charting, dataframe, Excel/Parquet, or statistical workflows; use `cse_run_code` for generic scripts that are not data-analysis tasks.',
              '4. Verify stdout/stderr and correctness against requested output.',
              '5. If errors or weak output, revise code and run again (iterate).',
              '6. Stop only when output is successful and materially answers the request, or when a clear environment blocker is proven.',
              '',
              'For file/data analysis tasks:',
              '- Treat attached filenames as real files in container workspace.',
              '- Default to `cse_run_data_analysis`; it already includes pandas, numpy, matplotlib, seaborn, plotly, statsmodels, scikit-learn, openpyxl, and pyarrow.',
              '- Prefer robust Python stdlib (`csv`, `json`, `statistics`) when it is sufficient, but do not waste turns reinstalling standard analysis libraries that are already present in the analysis sandbox.',
              '- If an analysis-library import fails inside `cse_run_data_analysis`, treat that as an environment issue and report it clearly.',
              '- If file path fails, probe workspace via code (e.g., os.listdir("."), os.listdir("/workspace")) and retry with corrected path.',
              '',
              'Charting rules (MANDATORY — never deviate):',
              '- ALWAYS use Plotly for all charts, graphs, and visualisations. Never use matplotlib or seaborn for output charts.',
              '- Use plotly.graph_objects or plotly.express; call fig.to_html(full_html=False, include_plotlyjs=\'cdn\') to produce an embeddable HTML snippet.',
              '- Never save charts as .png, .jpg, or any image file — file paths are not accessible outside the container.',
              '- If the task requests an HTML dashboard, build the complete self-contained HTML (with inline Plotly CDN script) in Python and print it to stdout.',
              '',
              'Artifact saving (MANDATORY when HTML output is requested):',
              '- After a successful CSE run that produces HTML, call `emit_artifact` yourself with the COMPLETE HTML string from stdout.',
              '- Do NOT summarise or truncate the HTML — pass the full string verbatim as the `data` argument.',
              '- Use type="html", name ending in ".html".',
              '- Do not rely on the supervisor to relay the HTML; save it directly here so nothing is lost.',
              '',
              'Quality bar before returning:',
              '- Code executed successfully (status success).',
              '- Output includes concrete computed values (not generic commentary).',
              '- At least 3 clear insights when the user asks for analysis/insights.',
              '- Include assumptions and any residual limitations.',
              '',
              'Response format back to supervisor:',
              '- Final code used',
              '- Execution stdout',
              '- Verification notes (why output is correct)',
              '- If blocked: exact blocker + next best fallback',
            ].join('\n'),
            tool_names: JSON.stringify(['cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'calculator', 'text_analysis', 'emit_artifact']),
            persona: 'agent_worker', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 50, category: 'general', enabled: 1,
          },
          {
            id: 'aebc3dc5-cc5b-4ad2-a10c-dedf8a9a5c3e', name: 'statsnz_specialist',
            display_name: 'Nia',
            job_profile: 'NZ Data Specialist',
            description: 'Specialist for Stats NZ Aotearoa Data Explorer data retrieval. Use this worker for NZ census/population/demographics requests and any task that should be grounded in Stats NZ APIs.',
            system_prompt: [
              'You are a Stats NZ specialist worker.',
              'Use only statsnz_* tools available to you to discover and retrieve data from Stats NZ ADE.',
              'For census/population requests, identify the best matching dataflow, then retrieve values with explicit period/date and dataflow ID.',
              'Preferred retrieval sequence:',
              '1. statsnz_search_dataflows to shortlist candidate dataflows.',
              '2. statsnz_get_dataflow_info for chosen dataflow metadata.',
              '3. statsnz_get_data with safe args: format="jsondata", dimension_at_observation="AllDimensions", key="all".',
              '4. Narrow to requested year using start_period/end_period (avoid complex dot-slot keys unless fully validated with datastructure/codelists).',
              '5. If `languageTag1` occurs, retry statsnz_get_data with minimal safe args and then refine filters.',
              'If multiple plausible tables exist, state uncertainty and list top candidates with reasons.',
              'Do not rely on web search when statsnz_* tools can answer the request.',
            ].join('\n'),
            tool_names: JSON.stringify(['statsnz_list_dataflows', 'statsnz_search_dataflows', 'statsnz_get_dataflow_info', 'statsnz_get_codelist', 'statsnz_get_data']),
            persona: 'agent_worker',
            trigger_patterns: JSON.stringify([
              'stats nz', 'stats new zealand', 'statsnz', 'nz census', 'nz population', 'nz demographics',
              'new zealand census', 'new zealand population', 'new zealand demographics', 'new zealand statistics',
              'aotearoa data', 'aotearoa census', 'aotearoa population', 'nz gdp', 'nz trade', 'nz housing',
              'nz labour', 'nz employment', 'nz unemployment',
              'population of new zealand', 'population of nz', 'population in new zealand', 'population in nz',
              'new zealand gdp', 'new zealand trade', 'new zealand housing', 'new zealand labour',
              'new zealand employment', 'new zealand unemployment', 'new zealand economy',
              'nz economy', 'nz crime', 'new zealand crime', 'nz income', 'new zealand income',
              'nz data', 'new zealand data', 'nz births', 'nz deaths', 'nz migration',
              'economy of new zealand', 'economy of nz', 'economy in new zealand', 'economy in nz',
              'spending in new zealand', 'spending in nz', 'spending of new zealand',
              'where are people spending', 'consumer spending', 'card spending', 'retail spending',
              'gdp of new zealand', 'gdp of nz', 'gdp in new zealand',
              'cost of living new zealand', 'cost of living nz', 'inflation new zealand', 'inflation nz',
              'new zealand gdp', 'new zealand inflation', 'new zealand cost of living',
            ]),
            task_contract_id: 'eb6561e5-46a8-446d-8056-0d1a6fac751e', max_retries: 2, priority: 40, category: 'general', enabled: 1,
          },
          {
            id: 'bf3c7feb-5471-4e17-a46c-f2c84efbf613', name: 'researcher',
            display_name: 'Riley',
            job_profile: 'Research Specialist',
            description: 'Researches topics, searches the web, browses websites, and gathers information. Can open a headless browser to navigate dynamic sites, read page content, click links, fill forms, and interact with web applications. Has full browser authentication capabilities: can detect login forms, auto-login using stored website credentials from the credential vault, save session cookies, and hand off the browser to the user for manual steps like 2FA or CAPTCHA. Always delegate login/auth tasks to this worker — it has the browser_detect_auth, browser_login, browser_save_cookies, browser_handoff_request, and browser_handoff_resume tools.',
            system_prompt: '',
            tool_names: JSON.stringify(['web_search', 'text_analysis', 'browser_open', 'browser_close', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_select', 'browser_type', 'browser_hover', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_detect_auth', 'browser_login', 'browser_save_cookies', 'browser_handoff_request', 'browser_handoff_resume']),
            persona: 'agent_researcher', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 30, category: 'general', enabled: 1,
          },
          {
            id: '63566924-9e94-41e5-8e55-6e9ddee168c5', name: 'analyst',
            display_name: 'Avery',
            job_profile: 'Data Analyst',
            description: 'Analyzes data, performs calculations, validates computed outputs, formats JSON, provides structured insights, and handles temporal/timer queries. Good for math, data processing, output verification, formatting, date/time questions, and time management.',
            system_prompt: '',
            tool_names: JSON.stringify(['calculator', 'json_format', 'text_analysis', 'memory_recall', 'datetime', 'datetime_add', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel']),
            persona: 'agent_worker', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 20, category: 'general', enabled: 1,
          },
          {
            id: '1111d2e3-2828-4570-9bf2-91320b536a2e', name: 'writer',
            display_name: 'Wren',
            job_profile: 'Writing Specialist',
            description: 'Writes, edits, and refines text. Good for drafting content, summarizing, and creative writing tasks.',
            system_prompt: '',
            tool_names: JSON.stringify(['text_analysis', 'memory_recall', 'datetime', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel']),
            persona: 'agent_worker', trigger_patterns: null, task_contract_id: null, max_retries: 0, priority: 10, category: 'general', enabled: 1,
          },
        ];
        for (const w of workers) await this.createWorkerAgent(w);
      }
  
      // Phase 1B — seed the global default supervisor agent row.
      // Idempotent: only inserts if no row with this id exists. Operators may
      // override behaviour by adding tenant- or category-scoped rows in admin.
      {
        const { rows: existingRows } = await ctx.query("SELECT id FROM agents WHERE id = $1 OR (is_default = 1 AND tenant_id IS NULL)", ['agent-supervisor-default']);
        const existing = existingRows[0] as { id: string } | undefined;
        if (!existing) {
          await this.createSupervisorAgent({
            id: 'agent-supervisor-default',
            tenant_id: null,
            category: 'general',
            name: 'geneweave-supervisor',
            display_name: 'Default Supervisor',
            description: 'Global default supervisor agent. Plans work, delegates to workers, and uses the shared utility tools (datetime, math_eval, unit_convert) provided by @weaveintel/agents.',
            system_prompt: null,
            include_utility_tools: 1,
            default_timezone: null,
            is_default: 1,
            enabled: 1,
          });
        }
      }
  
      const codeExecutorWorker = await this.getWorkerAgent('8d2598f8-775d-4e67-841d-1cb5fb16713e');
      if (codeExecutorWorker) {
        const parsedToolNames = (() => {
          try {
            return JSON.parse(codeExecutorWorker.tool_names ?? '[]') as string[];
          } catch {
            return [] as string[];
          }
        })();
        const nextToolNames = Array.from(new Set([
          ...parsedToolNames,
          'cse_run_data_analysis',
        ]));
        const desiredDisplayName = 'Casey';
        const desiredJobProfile = 'Code Execution Specialist';
        const desiredDescription = '[USE FIRST FOR ANY CODE/SCRIPT/RUN REQUEST] Writes AND executes code in real isolated Docker containers via CSE. Uses the dedicated data-analysis sandbox for dataframe/charting work and returns actual stdout. Use for: "run", "execute", "run it", "run in a container", "write and run", "test", "script that runs", and dataset analysis that requires real execution.';
        const desiredSystemPrompt = [
          'You are a code writing + execution + verification agent.',
          'Your mission is not just to write code, but to make it run successfully and produce validated results.',
          '',
          'Execution workflow (MANDATORY):',
          '1. Understand objective and available attached files from context.',
          '2. Generate a runnable script.',
          '3. Execute with the correct CSE tool: use `cse_run_data_analysis` for file/data analysis, charting, dataframe, Excel/Parquet, or statistical workflows; use `cse_run_code` for generic scripts that are not data-analysis tasks.',
          '4. Verify stdout/stderr and correctness against requested output.',
          '5. If errors or weak output, revise code and run again (iterate).',
          '6. Stop only when output is successful and materially answers the request, or when a clear environment blocker is proven.',
          '',
          'For file/data analysis tasks:',
          '- Treat attached filenames as real files in container workspace.',
          '- Default to `cse_run_data_analysis`; it already includes pandas, numpy, matplotlib, seaborn, plotly, statsmodels, scikit-learn, openpyxl, and pyarrow.',
          '- Prefer robust Python stdlib (`csv`, `json`, `statistics`) when it is sufficient, but do not waste turns reinstalling standard analysis libraries that are already present in the analysis sandbox.',
          '- If an analysis-library import fails inside `cse_run_data_analysis`, treat that as an environment issue and report it clearly.',
          '- If file path fails, probe workspace via code (e.g., os.listdir("."), os.listdir("/workspace")) and retry with corrected path.',
          '',
          'Quality bar before returning:',
          '- Code executed successfully (status success).',
          '- Output includes concrete computed values (not generic commentary).',
          '- At least 3 clear insights when the user asks for analysis/insights.',
          '- Include assumptions and any residual limitations.',
          '',
          'Response format back to supervisor:',
          '- Final code used',
          '- Execution stdout',
          '- Verification notes (why output is correct)',
          '- If blocked: exact blocker + next best fallback',
        ].join('\n');
        if (
          codeExecutorWorker.display_name !== desiredDisplayName
          || codeExecutorWorker.job_profile !== desiredJobProfile
          || codeExecutorWorker.description !== desiredDescription
          || codeExecutorWorker.system_prompt !== desiredSystemPrompt
          || nextToolNames.length !== parsedToolNames.length
        ) {
          await this.updateWorkerAgent(codeExecutorWorker.id, {
            display_name: desiredDisplayName,
            job_profile: desiredJobProfile,
            description: desiredDescription,
            system_prompt: desiredSystemPrompt,
            tool_names: JSON.stringify(nextToolNames),
          });
        }
      }
  
      const supervisorExecutionPrompt = await this.getPromptByKey('runtime.supervisor-code-execution');
      if (supervisorExecutionPrompt && !supervisorExecutionPrompt.template.includes('cse_run_data_analysis')) {
        await this.updatePrompt(supervisorExecutionPrompt.id, { template: SUPERVISOR_CODE_EXECUTION_POLICY });
      }
  
      const hardExecutionGuardPrompt = await this.getPromptByKey('runtime.hard-execution-guard');
      if (hardExecutionGuardPrompt && !hardExecutionGuardPrompt.template.includes('cse_run_data_analysis')) {
        await this.updatePrompt(hardExecutionGuardPrompt.id, { template: HARD_EXECUTION_GUARD_POLICY });
      }
  
      // Human Task Policies
      if ((await cnt('human_task_policies')) === 0) {
      const taskPolicies: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'cc83adb8-bf49-4fb0-83c4-fa27da65dc56', name: 'High-Risk Tool Approval', description: 'Require human approval before executing high-risk tools (code execution, DB writes)',
          trigger: 'tool:high-risk', task_type: 'approval', default_priority: 'high', sla_hours: 1, auto_escalate_after_hours: 2,
          assignment_strategy: 'round-robin', assign_to: null, enabled: 1,
        },
        {
          id: '50cb4891-c1b7-4562-9bbb-75d0e552c07d', name: 'Sensitive Data Review', description: 'Human review when agent accesses sensitive or PII data',
          trigger: 'data:sensitive', task_type: 'review', default_priority: 'urgent', sla_hours: 0.5, auto_escalate_after_hours: 1,
          assignment_strategy: 'role-based', assign_to: 'security-team', enabled: 1,
        },
        {
          id: '33664f9c-7e81-4bae-b536-6bdf17ea2352', name: 'Cost Threshold Approval', description: 'Require approval when estimated cost exceeds threshold',
          trigger: 'cost:threshold', task_type: 'approval', default_priority: 'normal', sla_hours: 4, auto_escalate_after_hours: 8,
          assignment_strategy: 'specific-user', assign_to: 'admin', enabled: 1,
        },
        {
          id: '659ed861-c3da-432d-a954-94393eb628de', name: 'Workflow Gate Review', description: 'Human review gate at critical workflow checkpoints',
          trigger: 'workflow:gate', task_type: 'review', default_priority: 'normal', sla_hours: 24, auto_escalate_after_hours: 48,
          assignment_strategy: 'least-busy', assign_to: null, enabled: 1,
        },
      ];
      for (const tp of taskPolicies) await this.createHumanTaskPolicy(tp);
      }
  
      // Cache Policies
      if ((await cnt('cache_policies')) === 0) {
      // Response-side secret bypass — applied to every policy (defence-in-depth)
      // because policy resolution currently selects the highest-priority enabled
      // policy regardless of request scope, so secrets must be screened whichever
      // policy ends up active.
      const SECRET_OUTPUT_PATTERNS = JSON.stringify(['sk-[A-Za-z0-9]{16,}', 'BEGIN [A-Z ]*PRIVATE KEY', 'AKIA[0-9A-Z]{16}']);
      const cachePolicies: Omit<CachePolicyRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'a747b721-8eff-46b2-a916-864ec0ac67cf', name: 'Global Default Cache', description: 'Default caching policy for all responses — 5 minute TTL',
          scope: 'global', ttl_ms: 300000, max_entries: 1000, max_bytes: 0,
          bypass_patterns: JSON.stringify(['password', 'secret', 'token', 'key']),
          output_bypass_patterns: SECRET_OUTPUT_PATTERNS,
          invalidate_on: JSON.stringify(['model_change', 'prompt_update']),
          key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
          enabled: 1,
        },
        {
          id: '5820734a-3bea-4558-90ad-d382b7b76bb2', name: 'Session Short-Lived', description: 'Short TTL cache scoped to individual sessions',
          scope: 'session', ttl_ms: 60000, max_entries: 100, max_bytes: 0,
          bypass_patterns: null, output_bypass_patterns: SECRET_OUTPUT_PATTERNS, invalidate_on: JSON.stringify(['session_end']),
          key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
          enabled: 1,
        },
        {
          id: 'bd5cbbb5-c407-4016-9c43-5525f2789017', name: 'Semantic Query Cache', description: 'Cache semantically similar queries to avoid redundant LLM calls',
          scope: 'global', ttl_ms: 600000, max_entries: 500, max_bytes: 0,
          bypass_patterns: JSON.stringify(['real-time', 'current date', 'current time']),
          output_bypass_patterns: SECRET_OUTPUT_PATTERNS,
          invalidate_on: JSON.stringify(['knowledge_update']),
          key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
          enabled: 1,
        },
        {
          id: '50dd439b-1fec-4293-8ee2-ed24ae07c387', name: 'User Personalised Cache', description: 'Per-user cache that respects personalisation context',
          scope: 'user', ttl_ms: 120000, max_entries: 200, max_bytes: 0,
          bypass_patterns: null, output_bypass_patterns: SECRET_OUTPUT_PATTERNS, invalidate_on: JSON.stringify(['preference_change']),
          key_hashing: 'sha256', tenant_isolation: 1, cache_temperature_gate: 0,
          enabled: 0,
        },
      ];
      for (const cp of cachePolicies) await this.createCachePolicy(cp);
      }
  
      // Identity Rules
      if ((await cnt('identity_rules')) === 0) {
      const identityRules: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '71d997aa-fb08-446d-8123-1b774f3c7de5', name: 'Admin Full Access', description: 'Admins have unrestricted access to all resources',
          resource: '*', action: '*', roles: JSON.stringify(['admin']), scopes: null,
          result: 'allow', priority: 100, enabled: 1,
        },
        {
          id: '280a5cfc-548c-4714-aabb-5e6a5dcaaf44', name: 'User Chat Access', description: 'Regular users can read and write in chat',
          resource: 'chat:*', action: '*', roles: JSON.stringify(['user', 'agent']), scopes: JSON.stringify(['chat']),
          result: 'allow', priority: 50, enabled: 1,
        },
        {
          id: '89eee70b-407a-4a89-a5e8-17b69330da8a', name: 'Agent Tool Access', description: 'AI agents can use tools within defined scopes',
          resource: 'tools:*', action: 'execute', roles: JSON.stringify(['agent']), scopes: JSON.stringify(['tools']),
          result: 'allow', priority: 50, enabled: 1,
        },
        {
          id: '7ef01416-07ec-496b-be00-67926157a29e', name: 'Deny Non-Admin Panel', description: 'Non-admins cannot access admin settings',
          resource: 'admin:*', action: '*', roles: null, scopes: null,
          result: 'deny', priority: 10, enabled: 1,
        },
        {
          id: '29a67ad5-7424-4e81-887b-14b0b9d951bc', name: 'Sensitive Data Challenge', description: 'Challenge access to sensitive data requiring additional verification',
          resource: 'data:sensitive', action: 'read', roles: null, scopes: null,
          result: 'challenge', priority: 60, enabled: 1,
        },
      ];
      for (const ir of identityRules) await this.createIdentityRule(ir);
      }
  
      // Memory Governance
      if ((await cnt('memory_governance')) === 0) {
      const memGov: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'b15e183e-66e3-4bd2-9b63-7dd540ca65ec', name: 'Block PII in Memory', description: 'Prevent storage of messages containing PII patterns',
          memory_types: JSON.stringify(['conversation', 'semantic']),
          tenant_id: null,
          block_patterns: JSON.stringify(['\\b\\d{3}-\\d{2}-\\d{4}\\b', '\\b\\d{16}\\b']),
          redact_patterns: JSON.stringify(['[\\w.+-]+@[\\w-]+\\.[\\w.]+', '\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b']),
          max_age: null, max_entries: null, enabled: 1,
        },
        {
          id: '9dbbe38c-a0a4-4f42-a1bc-a688d5b67103', name: 'Conversation Retention', description: 'Limit conversation memory to 30 days with max 10000 entries',
          memory_types: JSON.stringify(['conversation']),
          tenant_id: null,
          block_patterns: null, redact_patterns: null,
          max_age: 'P30D', max_entries: 10000, enabled: 1,
        },
        {
          id: '2a97b95b-6f01-4637-bc69-020d0597c02d', name: 'Semantic Memory Retention', description: 'Semantic facts retained for 90 days with a cap of 5000 entries',
          memory_types: JSON.stringify(['semantic']),
          tenant_id: null,
          block_patterns: null, redact_patterns: null,
          max_age: 'P90D', max_entries: 5000, enabled: 1,
        },
        {
          id: 'e6488668-f28f-4574-a7b0-49e45fc8aff2', name: 'No Secrets in Entity Memory', description: 'Block secrets and API keys from being stored as entity facts',
          memory_types: JSON.stringify(['entity']),
          tenant_id: null,
          block_patterns: JSON.stringify(['api[_\\s-]?key', 'secret[_\\s-]?key', 'password', 'bearer\\s+\\S+']),
          redact_patterns: null,
          max_age: null, max_entries: null, enabled: 1,
        },
      ];
      for (const g of memGov) await this.createMemoryGovernance(g);
      }
  
      // Memory extraction rules
      if ((await cnt('memory_extraction_rules')) === 0) {
      const extractionRules: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '64e1189c-3e5a-41f3-ad5d-da4b1e962093',
          name: 'Self disclosure: name',
          description: 'Detect when user discloses their name',
          rule_type: 'self_disclosure',
          entity_type: null,
          pattern: "\\b(?:my name is|i\\'?m called|call me)\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)",
          flags: 'i',
          facts_template: null,
          priority: 100,
          enabled: 1,
        },
        {
          id: '729662dd-644c-4a42-8984-24ed5623bd4c',
          name: 'Self disclosure: location',
          description: 'Detect where user lives or is from',
          rule_type: 'self_disclosure',
          entity_type: null,
          pattern: "\\b(?:i live in|i\\'?m from|i am from|i reside in)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
          flags: 'i',
          facts_template: null,
          priority: 95,
          enabled: 1,
        },
        {
          id: '464f8582-2df1-4b39-9749-a43f7eb21438',
          name: 'Self disclosure: work',
          description: 'Detect organization where user works',
          rule_type: 'self_disclosure',
          entity_type: null,
          pattern: "\\b(?:i work (?:at|for)|i\\'?m employed (?:at|by)|i\\'?m at)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
          flags: 'i',
          facts_template: null,
          priority: 90,
          enabled: 1,
        },
        {
          id: '16d483a4-c2b9-4fea-9082-6a9bcb43befb',
          name: 'Entity extraction: person name',
          description: 'Extract a person entity from self name disclosure',
          rule_type: 'entity_extraction',
          entity_type: 'person',
          pattern: "\\b(?:my name is|i\\'?m called|call me)\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)",
          flags: 'i',
          facts_template: '{"relationship":"self"}',
          priority: 100,
          enabled: 1,
        },
        {
          id: 'e3354de1-15e6-4ecf-ad8e-e4d02127ee26',
          name: 'Entity extraction: location',
          description: 'Extract location entity from residence disclosure',
          rule_type: 'entity_extraction',
          entity_type: 'location',
          pattern: "\\b(?:i live in|i\\'?m from|i am from|i reside in)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
          flags: 'i',
          facts_template: '{"relationship":"residence"}',
          priority: 95,
          enabled: 1,
        },
        {
          id: 'b7f3045d-6428-4f43-bda1-dd3a879f5951',
          name: 'Entity extraction: organization',
          description: 'Extract organization entity from employer disclosure',
          rule_type: 'entity_extraction',
          entity_type: 'organization',
          pattern: "\\b(?:i work (?:at|for)|i\\'?m employed (?:at|by)|i\\'?m at)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
          flags: 'i',
          facts_template: '{"relationship":"employer"}',
          priority: 90,
          enabled: 1,
        },
        {
          id: 'dea53647-9c8a-4c29-9e02-5dd297fe9762',
          name: 'Entity extraction: preference',
          description: 'Extract preference topic from likes/loves/enjoys statements',
          rule_type: 'entity_extraction',
          entity_type: 'preference',
          pattern: '\\bi (?:like|love|enjoy|prefer)\\s+([a-zA-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)',
          flags: 'gi',
          facts_template: '{"sentiment":"positive"}',
          priority: 80,
          enabled: 1,
        },
      ];
      for (const r of extractionRules) await this.createMemoryExtractionRule(r);
      }
  
      // Search Providers
      if ((await cnt('search_providers')) === 0) {
      const searchProviders: Omit<SearchProviderRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '6fce6815-171b-4d75-8502-65b720b829d3', name: 'DuckDuckGo', description: 'Free web search via DuckDuckGo Instant Answer API — no API key required',
          provider_type: 'duckduckgo', api_key: null, base_url: null, priority: 10,
          options: JSON.stringify({ safesearch: 'moderate', region: 'wt-wt' }), enabled: 1,
        },
        {
          id: '897b8e52-dc64-4854-ac39-65b92e00ccd8', name: 'Brave Search', description: 'Privacy-focused web search with Brave Search API',
          provider_type: 'brave', api_key: '', base_url: null, priority: 20,
          options: JSON.stringify({ count: 10, freshness: 'none' }), enabled: 0,
        },
        {
          id: 'f64e9011-5b20-41b0-bea3-6a86359e4f47', name: 'Tavily AI Search', description: 'AI-optimised search engine designed for LLM applications',
          provider_type: 'tavily', api_key: '', base_url: null, priority: 30,
          options: JSON.stringify({ search_depth: 'basic', include_answer: true }), enabled: 0,
        },
        {
          id: 'e770810c-7033-4fa5-b525-1befa69000dd', name: 'Google Custom Search', description: 'Google Programmable Search Engine for custom search experiences',
          provider_type: 'google', api_key: '', base_url: null, priority: 15,
          options: JSON.stringify({ cx: '', num: 10 }), enabled: 0,
        },
        {
          id: 'e2f358c3-89c4-48c4-aad2-3fb7153022ad', name: 'Serper (Google SERP)', description: 'Fast Google search results via Serper API',
          provider_type: 'serper', api_key: '', base_url: null, priority: 25,
          options: JSON.stringify({ gl: 'us', hl: 'en', num: 10 }), enabled: 0,
        },
      ];
      for (const sp of searchProviders) await this.createSearchProvider(sp);
      }
  
      // Tool Registry
      if ((await cnt('tool_registry')) === 0) {
      const toolReg: Omit<ToolRegistryRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '66c73c20-622c-47a3-a21d-210bd8a2eb91', name: 'Web Search Tools', description: 'Search provider toolkit with multi-engine routing',
          package_name: '@weaveintel/tools/search', version: '1.0.0', category: 'search', risk_level: 'low',
          tags: JSON.stringify(['search', 'web', 'retrieval']),
          config: JSON.stringify({ defaultProvider: 'duckduckgo', maxResults: 10 }),
          requires_approval: 0, max_execution_ms: 15000, rate_limit_per_min: 30, enabled: 1,
        },
        {
          id: '2891e86c-a4d0-4fbc-8a6c-ede1c717ba89', name: 'HTTP Endpoint Tools', description: 'Dynamic HTTP request toolkit with auth, retry, and transforms',
          package_name: '@weaveintel/tools/http', version: '1.0.0', category: 'integration', risk_level: 'medium',
          tags: JSON.stringify(['http', 'api', 'rest']),
          config: JSON.stringify({ defaultRetries: 2, defaultTimeout: 10000 }),
          requires_approval: 0, max_execution_ms: 20000, rate_limit_per_min: 30, enabled: 1,
        },
        {
          id: 'f27606f3-534b-4760-aa95-77dc4e52da3e', name: 'Browser & Scraping Tools', description: 'Web page fetching, content extraction, and readability tools',
          package_name: '@weaveintel/tools-browser', version: '1.0.0', category: 'browser', risk_level: 'low',
          tags: JSON.stringify(['browser', 'scrape', 'extract', 'readability']),
          config: JSON.stringify({ defaultTimeout: 10000, maxBodySize: 1048576 }),
          requires_approval: 0, max_execution_ms: 15000, rate_limit_per_min: 20, enabled: 1,
        },
        {
          id: '212ad0f7-2ad2-43e1-94d0-49be0a73d2bf', name: 'Social Platform Tools', description: 'Slack, Discord, and GitHub integrations',
          package_name: '@weaveintel/tools/social', version: '1.0.0', category: 'social', risk_level: 'medium',
          tags: JSON.stringify(['slack', 'discord', 'github', 'social']),
          config: null,
          requires_approval: 0, max_execution_ms: 10000, rate_limit_per_min: 20, enabled: 1,
        },
        {
          id: '0566e9f3-00c5-4ef2-9ac9-7012c477d5fd', name: 'Enterprise Connector Tools', description: 'Jira, Confluence, Salesforce, and Notion integrations',
          package_name: '@weaveintel/tools-enterprise', version: '1.0.0', category: 'enterprise', risk_level: 'medium',
          tags: JSON.stringify(['jira', 'confluence', 'salesforce', 'notion', 'enterprise']),
          config: null,
          requires_approval: 0, max_execution_ms: 20000, rate_limit_per_min: 15, enabled: 1,
        },
      ];
      for (const tr of toolReg) await this.createToolRegistryEntry(tr);
      }
  
      // Replay Scenarios
      if ((await cnt('replay_scenarios')) === 0) {
      const replayScenarios: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'c6c1387d-1cdd-4c7d-8c2a-0964d3481c51', name: 'Greeting Test', description: 'Verify the assistant handles basic greetings correctly',
          golden_prompt: 'Hello! How are you?',
          golden_response: 'Hello! I\'m doing great, thanks for asking. How can I help you today?',
          model: 'gpt-4o-mini', provider: 'openai',
          tags: JSON.stringify(['basic', 'greeting', 'regression']),
          acceptance_criteria: JSON.stringify({ min_match_rate: 0.7, max_duration_ms: 5000 }),
          enabled: 1,
        },
        {
          id: '1eef00ae-efa6-49ee-94ee-5c9a9e301e86', name: 'Code Review Scenario', description: 'Test code review accuracy against a golden response',
          golden_prompt: 'Review this JavaScript function for bugs:\\nfunction add(a, b) { return a - b; }',
          golden_response: 'Bug found: The function is named "add" but performs subtraction (a - b). It should be return a + b;',
          model: 'gpt-4o', provider: 'openai',
          tags: JSON.stringify(['code', 'review', 'regression']),
          acceptance_criteria: JSON.stringify({ min_match_rate: 0.6, required_step_matches: ['bug', 'subtraction'] }),
          enabled: 1,
        },
        {
          id: '6d68edbb-4641-42b3-8de6-26b61faecf17', name: 'Summarization Quality', description: 'Test document summarization quality and completeness',
          golden_prompt: 'Summarize: AI is transforming healthcare through diagnostics, drug discovery, and personalized medicine. Key challenges include data privacy, bias, and regulatory compliance.',
          golden_response: 'AI is revolutionizing healthcare in three areas: diagnostics, drug discovery, and personalized medicine. Main challenges are data privacy, algorithmic bias, and regulatory compliance.',
          model: null, provider: null,
          tags: JSON.stringify(['summarization', 'quality']),
          acceptance_criteria: JSON.stringify({ min_match_rate: 0.5 }),
          enabled: 1,
        },
      ];
      for (const s of replayScenarios) await this.createReplayScenario(s);
      }
  
      // Trigger Definitions
      if ((await cnt('trigger_definitions')) === 0) {
      const triggerDefs: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'b97f561c-b948-447c-8d52-2d1d681a232e', name: 'Daily Eval Sweep', description: 'Run evaluation suite every day at 2 AM UTC',
          trigger_type: 'cron', expression: '0 2 * * *',
          config: JSON.stringify({ timezone: 'UTC', skipIfRunning: true }),
          target_workflow: '3aedac32-ef1a-429f-89d7-23d481ccd8ad', status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
        },
        {
          id: '6e5be73b-49a5-461a-8cfe-4ff5c758955f', name: 'Deploy Webhook', description: 'Trigger workflow on deployment webhook from CI/CD',
          trigger_type: 'webhook', expression: null,
          config: JSON.stringify({ path: '/hooks/deploy', method: 'POST', requiredHeaders: ['X-Deploy-Token'] }),
          target_workflow: '3aedac32-ef1a-429f-89d7-23d481ccd8ad', status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
        },
        {
          id: '43de3406-4ee5-4ea6-b3ef-0ca283afe1a7', name: 'Queue Analysis Jobs', description: 'Process queued data analysis requests',
          trigger_type: 'queue', expression: null,
          config: JSON.stringify({ queueName: 'analysis-jobs', concurrency: 3, pollIntervalMs: 5000 }),
          target_workflow: null, status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
        },
        {
          id: '1ca7843f-9aa0-4298-8bb5-752ad4c263c6', name: 'Model Config Change', description: 'Re-run golden tests when model configuration changes',
          trigger_type: 'change', expression: null,
          config: JSON.stringify({ resourceType: 'model-config', changeTypes: ['updated'], debounceMs: 10000 }),
          target_workflow: null, status: 'paused', last_fired_at: null, fire_count: 0, enabled: 0,
        },
      ];
      for (const t of triggerDefs) await this.createTriggerDefinition(t);
      }
  
      // Tenant Configs
      if ((await cnt('tenant_configs')) === 0) {
      const tenantConfigs: Omit<TenantConfigRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '9ce41ecd-202f-49bf-8042-1ff7a296e537', name: 'Default Tenant', description: 'Default tenant configuration with standard limits',
          tenant_id: 'default', scope: 'global',
          allowed_models: JSON.stringify(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6']),
          denied_models: null,
          allowed_tools: JSON.stringify(['web-search', 'file-reader', 'api-caller']),
          max_tokens_daily: 100000, max_cost_daily: 5.0,
          max_tokens_monthly: 2000000, max_cost_monthly: 100.0,
          features: JSON.stringify(['chat', 'agent', 'tools', 'eval']),
          config_overrides: null, enabled: 1,
        },
        {
          id: '0291280f-f15f-44dc-ac95-bc2a61e88cbd', name: 'Enterprise Tenant', description: 'Enterprise tier with expanded limits and all features',
          tenant_id: 'enterprise', scope: 'organization',
          allowed_models: JSON.stringify(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6', 'claude-opus-4-7']),
          denied_models: null,
          allowed_tools: JSON.stringify(['web-search', 'file-reader', 'api-caller', 'code-exec', 'db-query']),
          max_tokens_daily: 500000, max_cost_daily: 25.0,
          max_tokens_monthly: 10000000, max_cost_monthly: 500.0,
          features: JSON.stringify(['chat', 'agent', 'supervisor', 'tools', 'eval', 'workflows', 'replay']),
          config_overrides: JSON.stringify({ max_concurrent_runs: 10 }), enabled: 1,
        },
        {
          id: 'b061bbe6-2ded-4c77-afad-33473b4cb4fa', name: 'Trial Tenant', description: 'Free trial with limited access',
          tenant_id: 'trial', scope: 'tenant',
          allowed_models: JSON.stringify(['gpt-4o-mini']),
          denied_models: JSON.stringify(['claude-opus-4-7']),
          allowed_tools: JSON.stringify(['web-search']),
          max_tokens_daily: 10000, max_cost_daily: 0.5,
          max_tokens_monthly: 100000, max_cost_monthly: 5.0,
          features: JSON.stringify(['chat']),
          config_overrides: null, enabled: 1,
        },
      ];
      for (const c of tenantConfigs) await this.createTenantConfig(c);
      }
  
      // Sandbox Policies
      if ((await cnt('sandbox_policies')) === 0) {
      const sandboxPolicies: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'f694e2d8-172c-4ed2-bab7-35720a28149f', name: 'Strict Sandbox', description: 'Highly restrictive sandbox for untrusted code execution',
          max_cpu_ms: 5000, max_memory_mb: 64, max_duration_ms: 10000, max_output_bytes: 65536,
          allowed_modules: JSON.stringify(['Math', 'Date', 'JSON']),
          denied_modules: JSON.stringify(['fs', 'net', 'child_process', 'http', 'https', 'crypto']),
          network_access: 0, filesystem_access: 'none', enabled: 1,
        },
        {
          id: '1b9b4d0e-5307-439d-9608-cac2695ac07f', name: 'Moderate Sandbox', description: 'Balanced sandbox allowing read-only filesystem and select modules',
          max_cpu_ms: 30000, max_memory_mb: 256, max_duration_ms: 60000, max_output_bytes: 1048576,
          allowed_modules: JSON.stringify(['Math', 'Date', 'JSON', 'crypto', 'path', 'url']),
          denied_modules: JSON.stringify(['child_process', 'net', 'cluster', 'worker_threads']),
          network_access: 0, filesystem_access: 'read-only', enabled: 1,
        },
        {
          id: 'f7054708-cbbf-48cd-b3db-16271a4adb10', name: 'Permissive Sandbox', description: 'Relaxed sandbox for trusted internal code with network access',
          max_cpu_ms: 120000, max_memory_mb: 512, max_duration_ms: 300000, max_output_bytes: 10485760,
          allowed_modules: null, denied_modules: JSON.stringify(['child_process', 'cluster']),
          network_access: 1, filesystem_access: 'read-write', enabled: 1,
        },
      ];
      for (const p of sandboxPolicies) await this.createSandboxPolicy(p);
      }
  
      // Extraction Pipelines
      if ((await cnt('extraction_pipelines')) === 0) {
      const extractionPipelines: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'dd32d2f8-ccd6-4f93-8aa8-e8859ca9456b', name: 'Full Extraction', description: 'Runs all extraction stages: metadata, language, entities, tables, code, tasks, timeline',
          stages: JSON.stringify([
            { type: 'metadata', enabled: true, order: 1 },
            { type: 'language', enabled: true, order: 2 },
            { type: 'entities', enabled: true, order: 3 },
            { type: 'tables', enabled: true, order: 4 },
            { type: 'code', enabled: true, order: 5 },
            { type: 'tasks', enabled: true, order: 6 },
            { type: 'timeline', enabled: true, order: 7 },
          ]),
          input_mime_types: JSON.stringify(['text/plain', 'text/markdown', 'text/html', 'application/pdf']),
          max_input_size_bytes: 10485760, enabled: 1,
        },
        {
          id: '28e7b976-5201-4170-9c7a-ee813e9b2ff5', name: 'Code Extraction', description: 'Extracts code blocks and related entities from technical documents',
          stages: JSON.stringify([
            { type: 'metadata', enabled: true, order: 1 },
            { type: 'code', enabled: true, order: 2 },
            { type: 'entities', enabled: true, order: 3 },
          ]),
          input_mime_types: JSON.stringify(['text/plain', 'text/markdown']),
          max_input_size_bytes: 5242880, enabled: 1,
        },
        {
          id: 'b3f4b90f-7094-4ae5-bbda-bf3f106b4c7c', name: 'Tasks & Timeline', description: 'Extracts tasks, deadlines, and chronological events',
          stages: JSON.stringify([
            { type: 'metadata', enabled: true, order: 1 },
            { type: 'tasks', enabled: true, order: 2 },
            { type: 'timeline', enabled: true, order: 3 },
            { type: 'entities', enabled: true, order: 4 },
          ]),
          input_mime_types: JSON.stringify(['text/plain', 'text/markdown', 'text/html']),
          max_input_size_bytes: 5242880, enabled: 1,
        },
      ];
      for (const p of extractionPipelines) await this.createExtractionPipeline(p);
      }
  
      // Artifact Policies
      if ((await cnt('artifact_policies')) === 0) {
      const artifactPolicies: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '5cb95d9c-1bfe-4eb3-b1c4-0a2bab12988f', name: 'Default Artifact Policy', description: 'Standard artifact policy with 100MB limit and 90-day retention',
          max_size_bytes: 104857600, allowed_types: JSON.stringify(['text', 'csv', 'json', 'html', 'markdown', 'image', 'code', 'report']),
          retention_days: 90, require_versioning: 1, enabled: 1,
        },
        {
          id: 'fb9ad62b-b0ec-4a89-af1c-9cea0e4b9c9a', name: 'Strict Artifact Policy', description: 'Restrictive policy for sensitive environments — small size limit, short retention',
          max_size_bytes: 10485760, allowed_types: JSON.stringify(['text', 'json', 'csv']),
          retention_days: 30, require_versioning: 1, enabled: 1,
        },
        {
          id: 'eda3f580-8b10-4d88-b0bc-2f1f5bf1a9a9', name: 'Large Artifact Policy', description: 'Policy for large outputs — PDFs, reports, diagrams — with extended retention',
          max_size_bytes: 1073741824, allowed_types: JSON.stringify(['text', 'csv', 'json', 'html', 'markdown', 'image', 'pdf', 'diagram', 'code', 'report', 'custom']),
          retention_days: 365, require_versioning: 1, enabled: 1,
        },
      ];
      for (const p of artifactPolicies) await this.createArtifactPolicy(p);
      }
  
      // Reliability Policies
      if ((await cnt('reliability_policies')) === 0) {
      const reliabilityPolicies: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '7558015a-aacd-4b89-acf1-6f11e6cb4d74', name: 'Default Retry', description: 'Standard exponential backoff retry for transient failures',
          policy_type: 'retry', max_retries: 3, initial_delay_ms: 1000, max_delay_ms: 30000, backoff_multiplier: 2.0,
          max_concurrent: null, queue_size: null, strategy: null, ttl_ms: null, enabled: 1,
        },
        {
          id: 'fe035101-0621-43ce-a133-ca8a74022859', name: 'Aggressive Retry', description: 'More retries with shorter delays for critical operations',
          policy_type: 'retry', max_retries: 5, initial_delay_ms: 500, max_delay_ms: 15000, backoff_multiplier: 1.5,
          max_concurrent: null, queue_size: null, strategy: null, ttl_ms: null, enabled: 1,
        },
        {
          id: 'eb4778d5-c048-4c54-892a-bcfeb245e95b', name: 'Standard Concurrency', description: 'Limit concurrent executions with queuing for overflow',
          policy_type: 'concurrency', max_retries: null, initial_delay_ms: null, max_delay_ms: null, backoff_multiplier: null,
          max_concurrent: 10, queue_size: 50, strategy: 'queue', ttl_ms: 60000, enabled: 1,
        },
        {
          id: 'fbd7d3d6-4e70-47ff-9e2a-4e1e2bb62ef7', name: 'Idempotency Guard', description: 'Prevent duplicate processing within a 5-minute window',
          policy_type: 'idempotency', max_retries: null, initial_delay_ms: null, max_delay_ms: null, backoff_multiplier: null,
          max_concurrent: null, queue_size: null, strategy: null, ttl_ms: 300000, enabled: 1,
        },
      ];
      for (const p of reliabilityPolicies) await this.createReliabilityPolicy(p);
      }
  
      // Collaboration Sessions
      if ((await cnt('collaboration_sessions')) === 0) {
      const collabSessions: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '24bfff3d-7f7b-4ca2-9711-5be4488215ea', name: 'Pair Programming', description: 'Two-participant session for pair programming with real-time code sharing',
          session_type: 'pair', max_participants: 2, presence_ttl_ms: 30000, auto_close_idle_ms: 600000,
          handoff_enabled: 1, enabled: 1,
        },
        {
          id: '4a79d9c8-5959-4839-a653-7caf09583aae', name: 'Team Collaboration', description: 'Multi-participant session for team brainstorming and collaborative problem solving',
          session_type: 'team', max_participants: 10, presence_ttl_ms: 60000, auto_close_idle_ms: 1800000,
          handoff_enabled: 1, enabled: 1,
        },
        {
          id: '3893f5a8-d061-43d7-920f-6d82167e54f6', name: 'Broadcast Session', description: 'One-to-many session for presentations and demos with view-only participants',
          session_type: 'broadcast', max_participants: 50, presence_ttl_ms: 120000, auto_close_idle_ms: null,
          handoff_enabled: 0, enabled: 1,
        },
      ];
      for (const s of collabSessions) await this.createCollaborationSession(s);
      }
  
      // Compliance Rules
      if ((await cnt('compliance_rules')) === 0) {
      const complianceRules: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '726c5bfc-cdb2-47f0-9d08-177f656f6821', name: '90-Day Data Retention', description: 'Delete chat logs and metrics older than 90 days',
          rule_type: 'retention', target_resource: 'messages', retention_days: 90,
          region: null, consent_purpose: null, action: 'delete',
          config: JSON.stringify({ include_metadata: true }), enabled: 1,
        },
        {
          id: 'f56c10ea-07b4-4e8e-8824-8a5a50d1ced7', name: 'GDPR Right to Delete', description: 'Honor user deletion requests within 30 days per GDPR Article 17',
          rule_type: 'deletion', target_resource: '*', retention_days: null,
          region: 'EU', consent_purpose: null, action: 'delete',
          config: JSON.stringify({ cascade: true, notify_processors: true }), enabled: 1,
        },
        {
          id: 'a8ef9ac5-977a-4a8c-a473-9cae50d0f132', name: 'EU Data Residency', description: 'Ensure EU user data stays within EU regions only',
          rule_type: 'residency', target_resource: '*', retention_days: null,
          region: 'EU', consent_purpose: null, action: 'block',
          config: JSON.stringify({ allowed_regions: ['eu-west-1', 'eu-central-1', 'eu-north-1'] }), enabled: 1,
        },
        {
          id: '93e3d7d5-80ac-4924-9916-018e44122ad3', name: 'Analytics Consent', description: 'Require explicit consent for analytics data collection',
          rule_type: 'consent', target_resource: 'metrics', retention_days: null,
          region: null, consent_purpose: 'analytics', action: 'notify',
          config: JSON.stringify({ consent_ttl_days: 365, re_consent_required: true }), enabled: 1,
        },
      ];
      for (const r of complianceRules) await this.createComplianceRule(r);
      }
  
      // Graph Configs
      if ((await cnt('graph_configs')) === 0) {
      const graphConfigs: Omit<GraphConfigRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '19d8bf98-fe69-4bfb-84c7-31181f171f28', name: 'Entity Knowledge Graph', description: 'General-purpose entity extraction and relationship mapping',
          graph_type: 'entity', max_depth: 3,
          entity_types: JSON.stringify(['person', 'organization', 'location', 'product', 'concept']),
          relationship_types: JSON.stringify(['works_at', 'located_in', 'related_to', 'depends_on', 'part_of']),
          auto_link: 1, scoring_weights: JSON.stringify({ relevance: 0.4, recency: 0.3, frequency: 0.3 }), enabled: 1,
        },
        {
          id: '0abab6b4-93cc-4664-a99d-200bd9378dee', name: 'Timeline Graph', description: 'Chronological event tracking with causal links between events',
          graph_type: 'timeline', max_depth: 5,
          entity_types: JSON.stringify(['event', 'milestone', 'decision']),
          relationship_types: JSON.stringify(['caused_by', 'preceded_by', 'concurrent_with']),
          auto_link: 1, scoring_weights: JSON.stringify({ temporal_proximity: 0.5, causal_strength: 0.5 }), enabled: 1,
        },
        {
          id: '27efa1f1-bec8-4c09-a7a3-c2e472b1125d', name: 'Knowledge Base', description: 'Long-term knowledge graph for RAG-augmented memory and retrieval',
          graph_type: 'knowledge', max_depth: 4,
          entity_types: JSON.stringify(['concept', 'definition', 'example', 'reference']),
          relationship_types: JSON.stringify(['defines', 'exemplifies', 'references', 'contradicts', 'supports']),
          auto_link: 0, scoring_weights: JSON.stringify({ semantic_similarity: 0.6, authority: 0.2, recency: 0.2 }), enabled: 1,
        },
      ];
      for (const g of graphConfigs) await this.createGraphConfig(g);
      }
  
      // Plugin Configs
      if ((await cnt('plugin_configs')) === 0) {
      const pluginConfigs: Omit<PluginConfigRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '1a4cac30-57a8-4853-b2d9-e8048ade5fc5', name: 'Code Execution Plugin', description: 'Sandboxed code execution for JavaScript and Python',
          plugin_type: 'official', package_name: '@weaveintel/sandbox', version: '1.0.0',
          capabilities: JSON.stringify(['code-execution', 'sandboxing']),
          trust_level: 'official', auto_update: 1,
          config: JSON.stringify({ defaultPolicy: '1b9b4d0e-5307-439d-9608-cac2695ac07f' }), enabled: 1,
        },
        {
          id: '0146baef-15d0-40ec-98f0-40c88f34b9b3', name: 'Web Search Plugin', description: 'Integrate external search providers for web search capabilities',
          plugin_type: 'official', package_name: '@weaveintel/tools/search', version: '1.0.0',
          capabilities: JSON.stringify(['web-search', 'news-search']),
          trust_level: 'official', auto_update: 1,
          config: JSON.stringify({ defaultProvider: '897b8e52-dc64-4854-ac39-65b92e00ccd8' }), enabled: 1,
        },
        {
          id: 'ad0e5e5b-4af3-4bd9-84e3-5fc2b84bb465', name: 'Data Visualization', description: 'Community plugin for generating charts and data visualizations',
          plugin_type: 'community', package_name: 'weaveintel-plugin-viz', version: '0.3.2',
          capabilities: JSON.stringify(['visualization', 'chart-generation']),
          trust_level: 'community', auto_update: 0,
          config: null, enabled: 1,
        },
        {
          id: 'b9550588-d6e3-4d8f-961f-93ed1d841671', name: 'Enterprise SSO', description: 'SAML/OIDC single sign-on integration for enterprise deployments',
          plugin_type: 'verified', package_name: 'weaveintel-plugin-sso', version: '2.1.0',
          capabilities: JSON.stringify(['authentication', 'sso', 'saml', 'oidc']),
          trust_level: 'verified', auto_update: 1,
          config: JSON.stringify({ provider: 'okta', domain: 'example.okta.com' }), enabled: 0,
        },
      ];
      for (const p of pluginConfigs) await this.createPluginConfig(p);
      }
  
      // Scaffold Templates (Phase 9)
      if ((await cnt('scaffold_templates')) === 0) {
      const scaffoldTemplates: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'd2d4c9c7-4f26-4de8-b8b9-21c1caadf3d1', name: 'Basic Agent', description: 'Minimal conversational agent with a single model',
          template_type: 'basic-agent',
          files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\n\nconst agent = createAgent({ name: "{{name}}", model: "{{model}}" });\n' }),
          dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
          dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
          variables: JSON.stringify(['name', 'model']),
          post_install: null, enabled: 1,
        },
        {
          id: '238db0e5-0a97-408a-87ea-411b7bb90556', name: 'Tool-Calling Agent', description: 'Agent with tool registration and execution capabilities',
          template_type: 'tool-calling-agent',
          files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\nimport { defineTool } from "@weaveintel/core";\n' }),
          dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
          dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
          variables: JSON.stringify(['name', 'model']),
          post_install: null, enabled: 1,
        },
        {
          id: '955d8720-fb97-41e2-8e21-f6f5ed8bd944', name: 'RAG Pipeline', description: 'Retrieval-augmented generation pipeline with vector search',
          template_type: 'rag-pipeline',
          files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\nimport { createRetriever } from "@weaveintel/retrieval";\n' }),
          dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/retrieval': '*' }),
          dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
          variables: JSON.stringify(['name', 'model', 'collection']),
          post_install: null, enabled: 1,
        },
        {
          id: 'b65b2a2d-6173-49bf-af09-5fbaf48d1b92', name: 'Workflow', description: 'Multi-step workflow with agent orchestration',
          template_type: 'workflow',
          files: JSON.stringify({ 'src/index.ts': 'import { createWorkflow } from "@weaveintel/workflows";\n' }),
          dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/workflows': '*' }),
          dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
          variables: JSON.stringify(['name']),
          post_install: null, enabled: 1,
        },
        {
          id: 'b1d3f948-420e-4798-8c16-99c8b0cc46a3', name: 'Multi-Agent', description: 'Supervisor with multiple worker agents',
          template_type: 'multi-agent',
          files: JSON.stringify({ 'src/index.ts': 'import { createSupervisor } from "@weaveintel/agents";\n' }),
          dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
          dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
          variables: JSON.stringify(['name', 'workers']),
          post_install: null, enabled: 1,
        },
        {
          id: 'b61ad2bf-cce5-4989-8800-d51e092fc309', name: 'MCP Server', description: 'Model Context Protocol server exposing tools over stdio/SSE',
          template_type: 'mcp-server',
          files: JSON.stringify({ 'src/index.ts': 'import { createMcpServer } from "@weaveintel/mcp-server";\n' }),
          dependencies: JSON.stringify({ '@weaveintel/mcp-server': '*', '@weaveintel/core': '*' }),
          dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
          variables: JSON.stringify(['name', 'transport']),
          post_install: null, enabled: 1,
        },
        {
          id: 'e27a18c3-7718-46e0-9f71-425ec51802b0', name: 'Full-Stack App', description: 'Complete application with geneWeave UI, agents, tools, and observability',
          template_type: 'full-stack',
          files: JSON.stringify({ 'src/index.ts': 'import { startGeneWeave } from "@weaveintel/geneweave";\n' }),
          dependencies: JSON.stringify({ '@weaveintel/geneweave': '*', '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/observability': '*' }),
          dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0', '@playwright/test': '^1.59.0' }),
          variables: JSON.stringify(['name', 'model', 'provider']),
          post_install: 'npx playwright install', enabled: 1,
        },
      ];
      for (const t of scaffoldTemplates) await this.createScaffoldTemplate(t);
      }
  
      // Recipe Configs (Phase 9)
      if ((await cnt('recipe_configs')) === 0) {
      const recipeConfigs: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '762dba63-d819-4f85-a86f-5f6788c42c99', name: 'Workflow Agent', description: 'Workflow-aware agent with step-by-step execution',
          recipe_type: 'workflow', model: 'gpt-4o', provider: 'openai',
          system_prompt: 'You are a workflow executor. Follow the steps precisely.',
          tools: JSON.stringify(['web-search', 'file-reader']),
          guardrails: JSON.stringify(['1a6b5225-07c6-41cc-878f-c0d08930c1de']),
          max_steps: 10, options: null, enabled: 1,
        },
        {
          id: '5a5b3951-4ca6-49b8-9ab4-b09a679e5275', name: 'Governed Assistant', description: 'Assistant with governance rules enforced in system prompt',
          recipe_type: 'governed', model: 'gpt-4o', provider: 'openai',
          system_prompt: 'You are a governed assistant. Follow all policies strictly.',
          tools: null,
          guardrails: JSON.stringify(['0370fa22-5fc8-49a4-bd4c-3e39863da61d', '51586988-83b7-4780-a006-b3b86b76713f']),
          max_steps: 5, options: JSON.stringify({ governanceLevel: 'strict' }), enabled: 1,
        },
        {
          id: 'b046bcff-9950-46bf-b107-ab6baf097240', name: 'Approval-Driven Agent', description: 'Agent that requires human approval for high-risk actions',
          recipe_type: 'approval', model: 'gpt-4o', provider: 'openai',
          system_prompt: null,
          tools: JSON.stringify(['code-exec', 'db-query']),
          guardrails: null,
          max_steps: 8, options: JSON.stringify({ approvalPolicy: 'cc83adb8-bf49-4fb0-83c4-fa27da65dc56' }), enabled: 1,
        },
        {
          id: '58bea5c2-662b-4c41-9f8e-203c59885931', name: 'ACL-Aware RAG', description: 'Retrieval agent with access-control-scoped collections',
          recipe_type: 'acl-rag', model: 'gpt-4o-mini', provider: 'openai',
          system_prompt: 'You answer questions using only the provided context.',
          tools: JSON.stringify(['web-search']),
          guardrails: JSON.stringify(['8ae24528-463a-4dfa-9348-a2be5214de9f']),
          max_steps: 5, options: JSON.stringify({ collection: 'default' }), enabled: 1,
        },
        {
          id: 'ddfd4301-7bf5-459c-a458-59785c6d6995', name: 'Safe Execution Agent', description: 'Agent with denied tools and defensive execution limits',
          recipe_type: 'safe-exec', model: 'gpt-4o-mini', provider: 'openai',
          system_prompt: 'You are a safe execution agent. Never execute dangerous operations.',
          tools: JSON.stringify(['file-reader', 'api-caller']),
          guardrails: JSON.stringify(['0370fa22-5fc8-49a4-bd4c-3e39863da61d', '1a6b5225-07c6-41cc-878f-c0d08930c1de']),
          max_steps: 5, options: JSON.stringify({ maxExecutionTime: 30000, deniedTools: ['code-exec'] }), enabled: 1,
        },
      ];
      for (const r of recipeConfigs) await this.createRecipeConfig(r);
      }
  
      // Widget Configs (Phase 9)
      if ((await cnt('widget_configs')) === 0) {
      const widgetConfigs: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>[] = [
        {
          id: 'd309940a-bd09-4899-ace5-a0acd53f2325', name: 'Data Table', description: 'Sortable, filterable data table for structured results',
          widget_type: 'table',
          default_options: JSON.stringify({ sortable: true, filterable: true, pageSize: 25 }),
          allowed_contexts: JSON.stringify(['chat', 'dashboard', 'admin']),
          max_data_points: 10000, refresh_interval_ms: null, enabled: 1,
        },
        {
          id: '7fe15c63-2ffd-413f-93e8-1681d5dc5c5b', name: 'Chart', description: 'Line, bar, or pie chart for data visualization',
          widget_type: 'chart',
          default_options: JSON.stringify({ chartType: 'line', showLegend: true, responsive: true }),
          allowed_contexts: JSON.stringify(['chat', 'dashboard']),
          max_data_points: 5000, refresh_interval_ms: 30000, enabled: 1,
        },
        {
          id: 'a3b5a4a7-6cd7-45b6-9715-3221ede6e2f0', name: 'Dynamic Form', description: 'Interactive form widget for collecting structured input',
          widget_type: 'form',
          default_options: JSON.stringify({ submitLabel: 'Submit', resetLabel: 'Reset' }),
          allowed_contexts: JSON.stringify(['chat']),
          max_data_points: null, refresh_interval_ms: null, enabled: 1,
        },
        {
          id: '4d57f558-6068-44ff-9f45-354696fcdb59', name: 'Code Block', description: 'Syntax-highlighted code viewer with copy and download',
          widget_type: 'code',
          default_options: JSON.stringify({ lineNumbers: true, theme: 'dark', wordWrap: false }),
          allowed_contexts: JSON.stringify(['chat', 'dashboard', 'admin']),
          max_data_points: null, refresh_interval_ms: null, enabled: 1,
        },
        {
          id: '464ec787-112f-413f-a376-ce534a3c505c', name: 'Timeline', description: 'Chronological event timeline for workflow and trace visualisation',
          widget_type: 'timeline',
          default_options: JSON.stringify({ direction: 'vertical', showDuration: true }),
          allowed_contexts: JSON.stringify(['chat', 'dashboard']),
          max_data_points: 500, refresh_interval_ms: 10000, enabled: 1,
        },
        {
          id: '337c379d-22df-44af-980c-04c453398169', name: 'Image', description: 'Image display widget with zoom and lightbox support',
          widget_type: 'image',
          default_options: JSON.stringify({ maxWidth: '100%', lightbox: true }),
          allowed_contexts: JSON.stringify(['chat']),
          max_data_points: null, refresh_interval_ms: null, enabled: 1,
        },
      ];
      for (const w of widgetConfigs) await this.createWidgetConfig(w);
      }
  
      // Validation Rules (Phase 9)
      if ((await cnt('validation_rules')) === 0) {
      const validationRules: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>[] = [
        {
          id: '940eb416-6e60-47bc-9d7d-3fca55c7b98d', name: 'Agent Name Required', description: 'Every agent config must have a non-empty name',
          rule_type: 'required', target: 'agent-config',
          condition: JSON.stringify({ field: 'name', operator: 'exists' }),
          severity: 'error', message: 'Agent name is required', enabled: 1,
        },
        {
          id: '014b4186-c36f-4f61-b8c3-bf2545023199', name: 'Agent Max Steps Range', description: 'Max steps must be between 1 and 100',
          rule_type: 'range', target: 'agent-config',
          condition: JSON.stringify({ field: 'maxSteps', min: 1, max: 100 }),
          severity: 'error', message: 'Max steps must be between 1 and 100', enabled: 1,
        },
        {
          id: 'c5985869-b721-40a2-b4ef-529bb975c84c', name: 'Workflow Entry Step', description: 'Workflow must define a valid entry step ID',
          rule_type: 'required', target: 'workflow-config',
          condition: JSON.stringify({ field: 'entry_step_id', operator: 'exists' }),
          severity: 'error', message: 'Workflow must have an entry step', enabled: 1,
        },
        {
          id: 'b6490a1a-2ddf-41ad-9a7b-6d406808cf86', name: 'Tool Risk Level', description: 'High-risk tools should require approval',
          rule_type: 'custom', target: 'tool-config',
          condition: JSON.stringify({ if: { field: 'risk_level', equals: 'high' }, then: { field: 'requires_approval', equals: true } }),
          severity: 'warning', message: 'High-risk tools should require approval', enabled: 1,
        },
        {
          id: '892adcec-808b-4c17-bc2c-c5c45cfe47fb', name: 'Valid JSON Fields', description: 'Fields marked as JSON must contain valid JSON or be null',
          rule_type: 'custom', target: 'agent-config',
          condition: JSON.stringify({ fields: ['tools', 'guardrails', 'metadata'], validate: 'json' }),
          severity: 'error', message: 'JSON fields must contain valid JSON', enabled: 1,
        },
      ];
      for (const r of validationRules) await this.createValidationRule(r);
      }
  
      // ── Hypothesis Validation seed data ──────────────────────
      // Check for the specific seed ID rather than "table is empty" so that
      // bootstrap migrations that pre-insert SV budget envelopes (e.g. m72) do
      // not suppress creation of the system default envelopes.
      const { rows: hvEnvRows } = await ctx.query(`SELECT 1 FROM hv_budget_envelope WHERE id = '019500000-0000-7000-8000-000000000001'`, []);
      if (!hvEnvRows[0]) {
        await this.createBudgetEnvelope({
          id: '019500000-0000-7000-8000-000000000001',
          tenant_id: 'system',
          name: 'Default Research Budget',
          max_llm_cents: 500,
          max_sandbox_cents: 200,
          max_wall_seconds: 300,
          max_rounds: 10,
          diminishing_returns_epsilon: 0.05,
        });
        await this.createBudgetEnvelope({
          id: '019500000-0000-7000-8000-000000000002',
          tenant_id: 'system',
          name: 'High-Throughput Budget',
          max_llm_cents: 2000,
          max_sandbox_cents: 1000,
          max_wall_seconds: 600,
          max_rounds: 20,
          diminishing_returns_epsilon: 0.02,
        });
      }
      if ((await cnt('hv_hypothesis')) === 0) {
        await this.createHypothesis({
          id: '019500000-0000-7000-8000-000000000010',
          tenant_id: 'system',
          submitted_by: 'system',
          title: 'Sample: Vitamin D reduces COVID-19 severity',
          statement: 'Supplementation with vitamin D at therapeutic doses (≥4000 IU/day) reduces ICU admission rate in COVID-19 patients by at least 20% compared to standard care.',
          domain_tags: JSON.stringify(['medicine', 'nutrition', 'covid-19']),
          status: 'queued',
          budget_envelope_id: '019500000-0000-7000-8000-000000000001',
          workflow_run_id: null,
          trace_id: null,
          contract_id: null,
        });
      }
  
      // ─── anyWeave Task-Aware Routing — Phase 1 seeds ───────────
      // Idempotent: INSERT OR IGNORE on the unique key columns.
      // (inlined seedAnyWeaveRoutingPhase1)
      {
        type TaskSeed = {
          task_key: string;
          display_name: string;
          category: string;
          description: string;
          output_modality: string;
          default_strategy: string;
          default_weights: { cost: number; speed: number; quality: number; capability: number };
          inference_hints: Record<string, unknown>;
        };

        const tasks: TaskSeed[] = [
          { task_key: 'reasoning', display_name: 'Reasoning', category: 'cognitive', description: 'Multi-step deduction, planning, math word problems.', output_modality: 'text', default_strategy: 'quality', default_weights: { cost: 0.10, speed: 0.10, quality: 0.50, capability: 0.30 }, inference_hints: { keywords: ['why', 'explain', 'prove', 'solve', 'plan', 'derive'] } },
          { task_key: 'summarization', display_name: 'Summarization', category: 'text-transform', description: 'Condense long input into shorter form.', output_modality: 'text', default_strategy: 'cost', default_weights: { cost: 0.45, speed: 0.30, quality: 0.20, capability: 0.05 }, inference_hints: { keywords: ['summarize', 'tl;dr', 'condense', 'short version'] } },
          { task_key: 'translation', display_name: 'Translation', category: 'text-transform', description: 'Convert text between natural languages.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['translate', 'in french', 'in spanish', 'in chinese'] } },
          { task_key: 'classification', display_name: 'Classification', category: 'text-transform', description: 'Assign labels / categories to input.', output_modality: 'text', default_strategy: 'cost', default_weights: { cost: 0.50, speed: 0.30, quality: 0.15, capability: 0.05 }, inference_hints: { keywords: ['classify', 'categorize', 'label', 'tag'] } },
          { task_key: 'extraction', display_name: 'Information Extraction', category: 'text-transform', description: 'Pull structured fields from unstructured text.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.30, speed: 0.20, quality: 0.40, capability: 0.10 }, inference_hints: { keywords: ['extract', 'parse', 'pull out', 'find all'] } },
          { task_key: 'qa', display_name: 'Question Answering', category: 'cognitive', description: 'Answer factual / contextual questions.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.25, speed: 0.25, quality: 0.40, capability: 0.10 }, inference_hints: { keywords: ['what', 'who', 'when', 'where', 'how many'] } },
          { task_key: 'code_generation', display_name: 'Code Generation', category: 'code', description: 'Write new code from a natural language spec.', output_modality: 'code', default_strategy: 'quality', default_weights: { cost: 0.15, speed: 0.15, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['write a function', 'generate code', 'implement', 'build a'] } },
          { task_key: 'code_debug', display_name: 'Code Debugging', category: 'code', description: 'Diagnose and fix existing code.', output_modality: 'code', default_strategy: 'quality', default_weights: { cost: 0.10, speed: 0.10, quality: 0.55, capability: 0.25 }, inference_hints: { keywords: ['fix this', 'debug', 'why does this fail', 'error in'] } },
          { task_key: 'code_review', display_name: 'Code Review', category: 'code', description: 'Critique style, correctness, security of code.', output_modality: 'text', default_strategy: 'quality', default_weights: { cost: 0.15, speed: 0.15, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['review', 'audit', 'critique', 'lgtm', 'pr feedback'] } },
          { task_key: 'creative_writing', display_name: 'Creative Writing', category: 'generative-text', description: 'Stories, poems, marketing copy, ideation.', output_modality: 'text', default_strategy: 'quality', default_weights: { cost: 0.20, speed: 0.10, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['write a story', 'poem', 'tagline', 'ad copy', 'creative'] } },
          { task_key: 'conversation', display_name: 'Conversation', category: 'generative-text', description: 'Open-ended chat / assistant-style dialogue.', output_modality: 'text', default_strategy: 'balanced', default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['chat', 'talk', 'tell me', 'help me'] } },
          { task_key: 'tool_use', display_name: 'Tool / Function Calling', category: 'agentic', description: 'Multi-turn function calling, agent loops.', output_modality: 'text', default_strategy: 'capability', default_weights: { cost: 0.15, speed: 0.20, quality: 0.30, capability: 0.35 }, inference_hints: { keywords: ['call api', 'use tool', 'fetch', 'search the web', 'lookup'] } },
          { task_key: 'vision_understanding', display_name: 'Vision Understanding', category: 'multimodal-input', description: 'Read / describe images and screenshots.', output_modality: 'text', default_strategy: 'capability', default_weights: { cost: 0.15, speed: 0.15, quality: 0.40, capability: 0.30 }, inference_hints: { requiresVision: true, keywords: ['image', 'screenshot', 'photo', 'describe this picture'] } },
          { task_key: 'image_generation', display_name: 'Image Generation', category: 'generative-image', description: 'Create images from text prompts.', output_modality: 'image', default_strategy: 'quality', default_weights: { cost: 0.20, speed: 0.15, quality: 0.45, capability: 0.20 }, inference_hints: { keywords: ['draw', 'generate image', 'illustrate', 'render'] } },
          { task_key: 'speech_to_text', display_name: 'Speech-to-Text', category: 'multimodal-input', description: 'Transcribe audio into text.', output_modality: 'text', default_strategy: 'capability', default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['transcribe', 'audio', 'voice', 'recording'] } },
          { task_key: 'embedding', display_name: 'Embedding', category: 'representation', description: 'Generate fixed-length vector representations.', output_modality: 'embedding', default_strategy: 'cost', default_weights: { cost: 0.50, speed: 0.30, quality: 0.15, capability: 0.05 }, inference_hints: { keywords: ['embed', 'vector', 'semantic search'] } },
        ];

        if ((await cnt('task_type_definitions')) === 0) {
          for (const t of tasks) {
            await ctx.query(
              `INSERT INTO task_type_definitions
                 (id, task_key, display_name, category, description, output_modality, default_strategy, default_weights, inference_hints, enabled)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
               ON CONFLICT DO NOTHING`,
              [
                newUUIDv7(),
                t.task_key,
                t.display_name,
                t.category,
                t.description,
                t.output_modality,
                t.default_strategy,
                JSON.stringify(t.default_weights),
                JSON.stringify(t.inference_hints),
              ],
            );
          }
        }

        // Provider tool adapters.
        if ((await cnt('provider_tool_adapters')) === 0) {
          const adapters: Array<Omit<ProviderToolAdapterRow, 'id' | 'created_at' | 'updated_at'>> = [
            {
              provider: 'openai',
              display_name: 'OpenAI Chat Completions / Responses',
              adapter_module: '@weaveintel/tools/schema/openai',
              tool_format: 'openai_json',
              tool_call_response_format: 'tool_calls_array',
              tool_result_format: 'tool_message',
              system_prompt_location: 'system_message',
              name_validation_regex: '^[a-zA-Z0-9_-]{1,64}$',
              max_tool_count: 128,
              enabled: 1,
            },
            {
              provider: 'anthropic',
              display_name: 'Anthropic Messages',
              adapter_module: '@weaveintel/tools/schema/anthropic',
              tool_format: 'anthropic_xml',
              tool_call_response_format: 'tool_use_block',
              tool_result_format: 'tool_result_block',
              system_prompt_location: 'separate_field',
              name_validation_regex: '^[a-zA-Z0-9_-]{1,64}$',
              max_tool_count: 64,
              enabled: 1,
            },
            {
              provider: 'google',
              display_name: 'Google Gemini',
              adapter_module: '@weaveintel/tools/schema/google',
              tool_format: 'google_function',
              tool_call_response_format: 'function_call',
              tool_result_format: 'function_response',
              system_prompt_location: 'system_message',
              name_validation_regex: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$',
              max_tool_count: 64,
              enabled: 1,
            },
          ];
          for (const a of adapters) {
            await ctx.query(
              `INSERT INTO provider_tool_adapters
                 (id, provider, display_name, adapter_module, tool_format, tool_call_response_format, tool_result_format, system_prompt_location, name_validation_regex, max_tool_count, enabled)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT DO NOTHING`,
              [
                newUUIDv7(),
                a.provider, a.display_name, a.adapter_module,
                a.tool_format, a.tool_call_response_format, a.tool_result_format,
                a.system_prompt_location, a.name_validation_regex, a.max_tool_count, a.enabled,
              ],
            );
          }
        }

        // Capability scores: 10 currently-priced models × 11 applicable tasks.
        // Quality scores derived from public benchmarks (MMLU, HumanEval, GPQA, etc.) — see design doc.
        // Models without a row for a task = excluded from candidate pool for that task (e.g. nano lacks vision).
        if ((await cnt('model_capability_scores')) === 0) {
          type CapSeed = {
            model_id: string;
            provider: string;
            task_key: string;
            quality_score: number;
            supports_tools?: number;
            supports_streaming?: number;
            supports_thinking?: number;
            supports_json_mode?: number;
            supports_vision?: number;
            max_output_tokens?: number | null;
            benchmark_source?: string | null;
          };

          // Per-model capability flag baseline — sourced from @weaveintel/routing package.
          const flags = getModelCapabilityFlags;

          // Scores per (model, task). Tasks not listed for a model = excluded.
          const scores: CapSeed[] = [
            // Anthropic family
            ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
              model_id: 'claude-opus-4-7', provider: 'anthropic', task_key: task,
              quality_score: ({ reasoning: 95, summarization: 90, translation: 88, classification: 90, extraction: 92, qa: 93, code_generation: 94, code_debug: 95, code_review: 95, creative_writing: 96, conversation: 92, tool_use: 93, vision_understanding: 90 }[task as string] ?? 90),
              benchmark_source: 'composite-2025q1',
            })),
            ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
              model_id: 'claude-sonnet-4-6', provider: 'anthropic', task_key: task,
              quality_score: ({ reasoning: 88, summarization: 88, translation: 86, classification: 88, extraction: 89, qa: 88, code_generation: 90, code_debug: 89, code_review: 88, creative_writing: 90, conversation: 90, tool_use: 89, vision_understanding: 86 }[task as string] ?? 85),
              benchmark_source: 'composite-2025q1',
            })),
            ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use'].map(task => ({
              model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', task_key: task,
              quality_score: ({ summarization: 78, classification: 78, extraction: 76, qa: 75, translation: 74, conversation: 80, tool_use: 75 }[task as string] ?? 70),
              benchmark_source: 'composite-2025q1',
            })),
            // OpenAI family
            ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
              model_id: 'gpt-4o', provider: 'openai', task_key: task,
              quality_score: ({ reasoning: 88, summarization: 90, translation: 92, classification: 89, extraction: 90, qa: 91, code_generation: 89, code_debug: 88, code_review: 87, creative_writing: 88, conversation: 91, tool_use: 92, vision_understanding: 92 }[task as string] ?? 88),
              benchmark_source: 'composite-2025q1',
            })),
            ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
              model_id: 'gpt-4o-mini', provider: 'openai', task_key: task,
              quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 82, tool_use: 80, vision_understanding: 78 }[task as string] ?? 75),
              benchmark_source: 'composite-2025q1',
            })),
            ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
              model_id: 'gpt-4.1', provider: 'openai', task_key: task,
              quality_score: ({ reasoning: 89, summarization: 89, translation: 90, classification: 89, extraction: 90, qa: 90, code_generation: 91, code_debug: 90, code_review: 88, creative_writing: 87, conversation: 89, tool_use: 91, vision_understanding: 89 }[task as string] ?? 88),
              benchmark_source: 'composite-2025q1',
            })),
            ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
              model_id: 'gpt-4.1-mini', provider: 'openai', task_key: task,
              quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 81, tool_use: 80, vision_understanding: 76 }[task as string] ?? 75),
              benchmark_source: 'composite-2025q1',
            })),
            ...['summarization', 'classification', 'extraction', 'conversation'].map(task => ({
              model_id: 'gpt-4.1-nano', provider: 'openai', task_key: task,
              quality_score: ({ summarization: 70, classification: 72, extraction: 68, conversation: 72 }[task as string] ?? 65),
              benchmark_source: 'composite-2025q1',
            })),
            // Reasoning specialists (o-series): exclude creative/conversation but excel at reasoning/code/math.
            ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use'].map(task => ({
              model_id: 'o3', provider: 'openai', task_key: task,
              quality_score: ({ reasoning: 96, qa: 90, code_generation: 92, code_debug: 94, code_review: 91, tool_use: 88 }[task as string] ?? 88),
              benchmark_source: 'composite-2025q1',
            })),
            ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use'].map(task => ({
              model_id: 'o4-mini', provider: 'openai', task_key: task,
              quality_score: ({ reasoning: 88, qa: 82, code_generation: 86, code_debug: 87, code_review: 84, tool_use: 82 }[task as string] ?? 80),
              benchmark_source: 'composite-2025q1',
            })),
          ];

          for (const s of scores) {
            const f = flags(s.model_id);
            await ctx.query(
              `INSERT INTO model_capability_scores
                 (id, tenant_id, model_id, provider, task_key, quality_score,
                  supports_tools, supports_streaming, supports_thinking, supports_json_mode, supports_vision,
                  max_output_tokens, benchmark_source, raw_benchmark_score, is_active, last_evaluated_at)
               VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, 1, ${ctx.now})
               ON CONFLICT DO NOTHING`,
              [
                newUUIDv7(),
                s.model_id, s.provider, s.task_key, s.quality_score,
                s.supports_tools ?? 1,
                s.supports_streaming ?? 1,
                f.supports_thinking,
                f.supports_json_mode,
                // Vision capability is meaningful only for vision_understanding; otherwise flag still reflects model native support.
                f.supports_vision,
                s.max_output_tokens ?? null,
                s.benchmark_source ?? null,
              ],
            );
          }
        }

        // Backfill output_modality on model_pricing for the 10 seeded models (all are text producers).
        await ctx.query("UPDATE model_pricing SET output_modality = 'text' WHERE output_modality IS NULL OR output_modality = ''", []);
      }
  
      // ─── weaveNotes — default note-action routing modes (global) ───────
      // Parity with the SQLite m117 migration seed: the 5 global (tenant_id='')
      // note_action_modes rows the realm resolver falls back to. Without these,
      // Postgres resolveNoteActionMode returned 'direct' for every action while
      // SQLite returned the supervised defaults. Idempotent via ON CONFLICT.
      for (const m of [
        { id: 'noteact00-0000-4000-8000-000000000001', action: 'diagram', mode: 'supervisor' },
        { id: 'noteact00-0000-4000-8000-000000000002', action: 'ink', mode: 'supervisor' },
        { id: 'noteact00-0000-4000-8000-000000000003', action: 'visual', mode: 'supervisor' },
        { id: 'noteact00-0000-4000-8000-000000000004', action: 'restructure', mode: 'supervisor' },
        { id: 'noteact00-0000-4000-8000-000000000005', action: 'illustration', mode: 'direct' },
      ]) {
        await ctx.query(
          `INSERT INTO note_action_modes (id, tenant_id, action_key, mode, updated_at)
             VALUES ($1, '', $2, $3, ${ctx.now})
           ON CONFLICT ("tenant_id", "action_key") DO NOTHING`,
          [m.id, m.action, m.mode],
        );
      }

      // ─── Cost Governor — default cost policies (4 tiers) ───────
      // Phase 2 ships the table; Phase 3 ships the seed data so operators
      // and runtime resolvers always have at least one binding target per
      // tier. Idempotent via INSERT OR IGNORE on `cost_policies.key`.
      // (inlined seedDefaultCostPolicies)
      {
        const costRows: Array<{ id: string; key: string; tier: string; levers: string; description: string }> = [
          { id: '019700000-c057-7000-8000-000000000001', key: 'economy',     tier: 'economy',     levers: '{}', description: 'Cheapest tier: small models, aggressive caching, history compaction, minimal tools.' },
          { id: '019700000-c057-7000-8000-000000000002', key: 'balanced',    tier: 'balanced',    levers: '{}', description: 'Default tier: balanced quality/cost. Caching enabled, moderate tool subset.' },
          { id: '019700000-c057-7000-8000-000000000003', key: 'performance', tier: 'performance', levers: '{}', description: 'Higher quality tier: prefers stronger models, looser tool subset, caching still on.' },
          { id: '019700000-c057-7000-8000-000000000004', key: 'max',         tier: 'max',         levers: '{}', description: 'Maximum quality tier: best models, all tools, full history, caching for prefix reuse only.' },
          // Phase 5 (L3 — dynamic tool subset) example. Demonstrates phase-driven
          // tool narrowing for the kaggle strategist. Operators can edit the
          // `levers_json.toolSubset.phases` map via /api/admin/cost-policies to
          // expose different tool keys per logical phase. The kaggle heartbeat
          // derives the phase from the active kgl_competition_run state:
          // 0 kernel pushes → 'discovery'; 1 → 'kernel'; 2+ → 'improvement'.
          {
            id: '019700000-c057-7000-8000-000000000005',
            key: 'kaggle_phase_subset',
            tier: 'balanced',
            levers: JSON.stringify({
              toolSubset: {
                strategy: 'phase',
                phases: {
                  discovery: ['kaggle_list_competitions', 'kaggle_get_competition', 'web_search'],
                  kernel: ['kaggle_push_kernel', 'kaggle_wait_for_kernel', 'kaggle_get_kernel_output'],
                  improvement: ['kaggle_push_kernel', 'kaggle_wait_for_kernel', 'kaggle_get_kernel_output', 'kaggle_list_kernels'],
                },
              },
            }),
            description: 'Phase 5 example: kaggle strategist tool subset varies by run phase (discovery/kernel/improvement). Bind via capability_policy_bindings (policy_kind=cost_policy) to a kaggle mesh or agent.',
          },
          // Phase 6 (L4 — intel-gated prompt sections + L5 — history compaction).
          // Drops the intel-header + intel-snippets sections from prepare() once
          // the live mesh has accumulated enough signals (default thresholds:
          // ≥0.7 → drop both, ≥0.4 → drop snippets only). Keeps the last 12
          // history items (sliding window) so long runs stay cheap. Bind via
          // capability_policy_bindings (policy_kind=cost_policy).
          {
            id: '019700000-c057-7000-8000-000000000006',
            key: 'kaggle_intel_aware',
            tier: 'balanced',
            levers: JSON.stringify({
              intelGating: { enabled: true, thresholds: { low: 0.4, high: 0.7 } },
              historyCompaction: { strategy: 'sliding', windowTurns: 12 },
            }),
            description: 'Phase 6 example: gates intel header/snippets when score ≥ 0.7; sliding-12 history. Bind to a kaggle mesh or agent via capability_policy_bindings (policy_kind=cost_policy).',
          },
          // Phase 7 (L6 maxSteps + L7 reasoningEffort + L8 toolOutputTruncation
          // + L9 budgetGate). Full cost-governor envelope: clamps the strategist's
          // ReAct iteration budget to 30, hints the model toward 'low' reasoning
          // effort (OpenAI passes this as `reasoning_effort` body field), caps
          // each tool result at 2 KiB while preserving the last 3 turns
          // verbatim, and halts the run with a CostCeilingExceededError once
          // cumulative spend exceeds $2.50. Bind via capability_policy_bindings
          // (policy_kind=cost_policy).
          {
            id: '019700000-c057-7000-8000-000000000007',
            key: 'kaggle_full_governor',
            tier: 'balanced',
            levers: JSON.stringify({
              maxStepsCap: 30,
              reasoningEffort: 'low',
              toolOutputTruncation: { maxBytesPerTurn: 2048, keepLastN: 3 },
              budgetCeilingUsd: 2.5,
            }),
            description: 'Phase 7 example: full cost envelope (maxSteps=30, reasoning=low, tool-output cap 2KiB×keepLast 3, ceiling $2.50). Bind via capability_policy_bindings (policy_kind=cost_policy).',
          },
          // Phase 8 (L3 strategy upgrade — Intent-RAG tool retrieval).
          // Switches the toolSubset lever from the deterministic 'phase' map
          // to per-step cosine-similarity ranking against pre-computed tool
          // description embeddings. topK=6, minSimilarity=0.15. The
          // `kaggle_submit` tool is always kept regardless of similarity so
          // the strategist can finalize. Requires the embedding warmer to
          // populate `tool_embeddings` at startup (no-op without OPENAI_API_KEY).
          {
            id: '019700000-c057-7000-8000-000000000008',
            key: 'kaggle_intent_rag',
            tier: 'balanced',
            levers: JSON.stringify({
              toolSubset: {
                strategy: 'intent-rag',
                topK: 6,
                minSimilarity: 0.15,
                includeAlways: ['kaggle_submit'],
              },
            }),
            description: 'Phase 8 example: kaggle strategist tool subset ranked per-step via intent-RAG (cosine sim against tool description embeddings). topK=6, minSim=0.15, kaggle_submit always kept. Bind via capability_policy_bindings (policy_kind=cost_policy).',
          },
        ];
        for (const r of costRows) {
          await ctx.query(
            `INSERT INTO cost_policies (id, key, tier, levers_json, description, enabled)
             VALUES ($1, $2, $3, $4, $5, 1)
             ON CONFLICT DO NOTHING`,
            [r.id, r.key, r.tier, r.levers, r.description],
          );
        }
      }
  
      // ─── Tenant Encryption Phase 1 — default disabled-policy row ───
      // Operators see one example tenant in admin (`demo-encrypted-tenant`)
      // with encryption disabled. Flipping `enabled = 1` and calling
      // `bootstrapTenant(...)` materializes a KEK + DEK + BIK on first use.
      // Idempotent via INSERT OR IGNORE.
      // (inlined seedDefaultEncryptionPolicies)
      await ctx.query(
        `INSERT INTO tenant_encryption_policy
           (tenant_id, enabled, kms_provider_id, kms_config, active_kek_id, active_dek_id, active_bik_id,
            rotation_schedule, blind_index_enabled, field_policy, shred_requested_at, shred_completed_at)
         VALUES ($1, 0, 'local', NULL, NULL, NULL, NULL, 'manual', 0, '{"messages":{"columns":["content","metadata"]},"chats":{"columns":["title"]}}', NULL, NULL)
         ON CONFLICT DO NOTHING`,
        ['demo-encrypted-tenant'],
      );

      // ─── Tenancy Realm Phase 0 — a real root tenant entity per seeded tenant_config ───
      // Mirrors the SQLite side (migration m150 + seedTenantEntities). The tenants table itself comes
      // from POSTGRES_FULL_SCHEMA; here we backfill the default tenant + one root per tenant_config, and
      // normalise blank tenant labels to NULL. Idempotent (ON CONFLICT DO NOTHING).
      await ctx.query(
        `INSERT INTO tenants (id, name, parent_tenant_id, path, depth, status)
         VALUES ('default', 'Default', NULL, '/default/', 0, 'active')
         ON CONFLICT (id) DO NOTHING`,
      );
      await ctx.query(
        `INSERT INTO tenants (id, name, parent_tenant_id, path, depth, status)
         SELECT tc.tenant_id, tc.name, NULL, '/' || tc.tenant_id || '/', 0, 'active'
         FROM tenant_configs tc
         WHERE tc.tenant_id IS NOT NULL AND tc.tenant_id <> ''
         ON CONFLICT (id) DO NOTHING`,
      );
      // Every other tenant_id-bearing table (name defaults to the id).
      for (const src of ['users', 'tenant_governance', 'tenant_appearance', 'tenant_encryption_policy', 'tenant_biks']) {
        await ctx.query(
          `INSERT INTO tenants (id, name, parent_tenant_id, path, depth, status)
           SELECT DISTINCT s.tenant_id, s.tenant_id, NULL, '/' || s.tenant_id || '/', 0, 'active'
           FROM ${src} s
           WHERE s.tenant_id IS NOT NULL AND s.tenant_id <> ''
           ON CONFLICT (id) DO NOTHING`,
        );
      }
      await ctx.query(`UPDATE users SET tenant_id = NULL WHERE tenant_id = ''`);

      // ─── Tenancy Realm Phase 1 — classify seeded prompt config as global-realm originals ───
      // Mirrors the SQLite side (migration m151 + applyM151RealmColumns re-run in seedDefaultData).
      // The realm columns + unique indexes come from POSTGRES_FULL_SCHEMA; here we backfill
      // logical_key (SQL) and content_hash (computed in JS, identical hash to SQLite → parity).
      await ctx.query(`UPDATE prompts SET logical_key = COALESCE(NULLIF(key, ''), id) WHERE logical_key IS NULL OR logical_key = ''`);
      await ctx.query(`UPDATE prompt_fragments SET logical_key = COALESCE(NULLIF(key, ''), id) WHERE logical_key IS NULL OR logical_key = ''`);
      await backfillRealmContentHash(ctx, 'prompts', ['name', 'description', 'category', 'template', 'variables', 'model_compatibility', 'execution_defaults', 'framework']);
      await backfillRealmContentHash(ctx, 'prompt_fragments', ['name', 'description', 'category', 'content', 'variables']);

      // ─── Tenancy Realm Phase 2 — drift baseline + seed-time reconcile (mirror of m152 + SQLite) ───
      // realm_versions comes from POSTGRES_FULL_SCHEMA. Establish the baseline (origin_hash = content),
      // then reconcile the shipped prompt defaults: record each as a version, adopt changed defaults the
      // operator never touched, keep customized/diverged rows. Identical drift outcomes to SQLite.
      await ctx.query(`UPDATE prompts SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
      await reconcilePromptRealm(ctx as unknown as SqlClient, 'postgres', prompts);

      // ─── Tenancy Realm — realm columns on skills (mirror of m154 + SQLite) ───
      // Classify built-in skills as global-realm originals so a tenant can fork one. logical_key = id.
      await ctx.query(`UPDATE skills SET logical_key = id WHERE logical_key IS NULL OR logical_key = ''`);
      await backfillRealmContentHash(ctx, 'skills', ['name', 'description', 'category', 'trigger_patterns', 'instructions', 'tool_names', 'examples', 'tags', 'domain_sections', 'execution_contract']);
      await ctx.query(`UPDATE skills SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
      // ─── Tenancy Realm — realm columns on worker_agents (mirror of m155 + SQLite) ───
      // Classify built-in workers as global-realm originals so a tenant can fork one. logical_key = name.
      await ctx.query(`UPDATE worker_agents SET logical_key = name WHERE logical_key IS NULL OR logical_key = ''`);
      await backfillRealmContentHash(ctx, 'worker_agents', ['display_name', 'job_profile', 'description', 'system_prompt', 'tool_names', 'persona', 'trigger_patterns', 'task_contract_id', 'category']);
      await ctx.query(`UPDATE worker_agents SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
      // ─── Tenancy Realm — realm columns on guardrails (mirror of m156 + SQLite) ───
      // Classify built-in guardrails as global-realm originals so a tenant can fork one. logical_key = name.
      await ctx.query(`UPDATE guardrails SET logical_key = name WHERE logical_key IS NULL OR logical_key = ''`);
      await backfillRealmContentHash(ctx, 'guardrails', ['description', 'type', 'stage', 'config', 'trigger_conditions', 'trigger_description', 'judge_model', 'compliance_framework']);
      await ctx.query(`UPDATE guardrails SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
      // ─── Tenancy Realm — realm columns on tool_policies (mirror of m157 + SQLite) ───
      // Classify any tool policies as global-realm originals so a tenant can fork one. logical_key = key.
      // (PG seeds no tool_policies today — this is a no-op safety net for installs that add them.)
      await ctx.query(`UPDATE tool_policies SET logical_key = key WHERE logical_key IS NULL OR logical_key = ''`);
      await backfillRealmContentHash(ctx, 'tool_policies', ['description', 'applies_to', 'applies_to_risk_levels', 'approval_required', 'allowed_risk_levels', 'max_execution_ms', 'rate_limit_per_minute', 'max_concurrent', 'require_dry_run', 'log_input_output', 'persona_scope', 'active_hours_utc', 'expires_at']);
      await ctx.query(`UPDATE tool_policies SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
      // ─── Tenancy Realm — realm columns on routing_policies + cost_policies (mirror of m158 + SQLite) ───
      // Both tables are seeded above from empty on Postgres; classify each as a global-realm original.
      // routing_policies: logical_key = name (no UNIQUE). cost_policies: logical_key = key (UNIQUE).
      await ctx.query(`UPDATE routing_policies SET logical_key = name WHERE logical_key IS NULL OR logical_key = ''`);
      await backfillRealmContentHash(ctx, 'routing_policies', ['description', 'strategy', 'constraints', 'weights', 'fallback_model', 'fallback_provider', 'fallback_chain']);
      await ctx.query(`UPDATE routing_policies SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
      await ctx.query(`UPDATE cost_policies SET logical_key = key WHERE logical_key IS NULL OR logical_key = ''`);
      await backfillRealmContentHash(ctx, 'cost_policies', ['tier', 'levers_json', 'description']);
      await ctx.query(`UPDATE cost_policies SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);

      // ─── Tenancy Realm — realm columns on the prompt catalog (mirror of m159 + SQLite) ───
      // prompt_strategies + prompt_frameworks are seeded above; prompt_contracts starts empty. All three
      // key on UNIQUE(key) → logical_key = key. Classify each seeded row as a global-realm original.
      for (const [table, cols] of [
        ['prompt_strategies', ['name', 'description', 'instruction_prefix', 'instruction_suffix', 'config']],
        ['prompt_contracts', ['name', 'description', 'contract_type', 'schema', 'config']],
        ['prompt_frameworks', ['name', 'description', 'sections', 'section_separator']],
      ] as const) {
        await ctx.query(`UPDATE ${table} SET logical_key = key WHERE logical_key IS NULL OR logical_key = ''`);
        await backfillRealmContentHash(ctx, table, [...cols]);
        await ctx.query(`UPDATE ${table} SET origin_hash = content_hash WHERE realm = 'global' AND (origin_hash IS NULL OR origin_hash = '') AND content_hash IS NOT NULL AND content_hash <> ''`);
      }
    },
  };
}

/**
 * Postgres twin of m151's hashRows: compute a stable content_hash for every prompt/fragment row that
 * doesn't have one yet, using the SAME canonical-hash the SQLite migration uses (so the two engines
 * produce identical hashes and drift comparisons stay engine-agnostic).
 */
async function backfillRealmContentHash(ctx: PgCtx, table: string, semanticCols: string[]): Promise<void> {
  const { rows } = await ctx.query(
    `SELECT id, ${semanticCols.map((c) => `"${c}"`).join(', ')} FROM ${table} WHERE content_hash IS NULL OR content_hash = ''`,
    [],
  );
  for (const r of rows as Array<Record<string, unknown>>) {
    const semantic: Record<string, unknown> = {};
    for (const c of semanticCols) semantic[c] = parseRealmSemantic(r[c]);
    await ctx.query(`UPDATE ${table} SET content_hash = $1 WHERE id = $2`, [realmContentHash(semantic), r['id']]);
  }
}
