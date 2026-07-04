import type { WorkerAgentRow } from './db-types.js';
import {
  POLICY_PROMPT_SUPERVISOR_CODE_EXECUTION,
  POLICY_PROMPT_SUPERVISOR_TEMPORAL,
  POLICY_PROMPT_SUPERVISOR_AGENDA,
  POLICY_PROMPT_RESPONSE_CARD_FORMAT,
  POLICY_PROMPT_MULTI_WORKER_PIPELINE,
  POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
  FORCED_WORKER_REQUIREMENT,
  RESPONSE_CARD_FORMAT_POLICY,
  SUPERVISOR_CODE_EXECUTION_POLICY,
  SUPERVISOR_TEMPORAL_POLICY,
  SUPERVISOR_AGENDA_POLICY,
} from './chat-policies.js';

export function buildSupervisorInstructionsPrompt(options: {
  basePrompt: string | undefined;
  forceWorkerDataAnalysis: boolean;
  workerRows?: WorkerAgentRow[];
  prompts: Map<string, string>;
  hasActiveMandatorySkillPlan?: boolean;
}): string {
  const { basePrompt, forceWorkerDataAnalysis, workerRows, prompts, hasActiveMandatorySkillPlan } = options;

  // When an active skill defines its own mandatory multi-step plan, the generic
  // FORCED_WORKER_REQUIREMENT (which implies a 2-step code_executor→analyst flow)
  // must not be injected — it conflicts with and overrides the skill's plan.
  const workflowBlock = forceWorkerDataAnalysis && !hasActiveMandatorySkillPlan
    ? prompts.get(POLICY_PROMPT_FORCED_WORKER_REQUIREMENT) ?? FORCED_WORKER_REQUIREMENT
    : undefined;

  const multiWorkerBlock = prompts.get(POLICY_PROMPT_MULTI_WORKER_PIPELINE) ?? [
    'MULTI-WORKER SEQUENTIAL PIPELINE:',
    'When the user\'s request spans multiple capabilities (e.g., "fetch NZ economic data AND run Python to find insights"), you MUST use sequential worker delegation:',
    '  Step 1 — Delegate to the data specialist worker (e.g., statsnz_specialist) to retrieve the raw data.',
    '  Step 2 — Once data is returned, delegate to code_executor with a task that embeds the retrieved data and asks it to write and execute Python (or other code) to produce insights.',
    '  Step 3 — Use the code_executor stdout in your final response. Never skip code execution when the user explicitly asked for it.',
    'Do not collapse multi-step pipelines into a single delegation or into a supervisor-only response.',
  ].join('\n');

  const routingBlocks: string[] = [];
  if (workerRows) {
    for (const row of workerRows) {
      if (!row.description?.trim()) continue;
      const displayName = (row.display_name?.trim() || row.name).trim();
      const jobProfile = (row.job_profile?.trim() || 'Worker Agent').trim();
      routingBlocks.push(
        `WORKER CAPABILITY — ${displayName.toUpperCase()} (${row.name}):\n`
          + `- Job Profile: ${jobProfile}\n`
          + `- Delegate to \`${row.name}\` when the user's query intent aligns with this capability.\n`
          + `- ${row.description}\n`
          + '- Select workers semantically based on job profile, meaning, and task requirements, not keyword overlap or worker identifier names.',
      );
    }
  }

  const policyBlocks = [
    prompts.get(POLICY_PROMPT_SUPERVISOR_CODE_EXECUTION) ?? SUPERVISOR_CODE_EXECUTION_POLICY,
    workflowBlock,
    multiWorkerBlock,
    prompts.get(POLICY_PROMPT_SUPERVISOR_AGENDA) ?? SUPERVISOR_AGENDA_POLICY,
    prompts.get(POLICY_PROMPT_SUPERVISOR_TEMPORAL) ?? SUPERVISOR_TEMPORAL_POLICY,
    ...routingBlocks,
    prompts.get(POLICY_PROMPT_RESPONSE_CARD_FORMAT) ?? RESPONSE_CARD_FORMAT_POLICY,
  ].filter((value): value is string => Boolean(value && value.trim()));

  const prefix = basePrompt?.trim();
  return prefix ? `${prefix}\n\n${policyBlocks.join('\n\n')}` : policyBlocks.join('\n\n');
}
