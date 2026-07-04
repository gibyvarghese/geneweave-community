import type { AgentResult, ExecutionContext, Message } from '@weaveintel/core';
import type { WorkerAgentRow, TaskContractRow } from './db-types.js';

type ParseJson = (text: string) => unknown;
type ValidateAgainstContract = (result: AgentResult, contractRow: TaskContractRow) => Promise<boolean>;

export function outputContainsField(output: string, field: string): boolean {
  switch (field) {
    case 'dataset_id':
      return /\b[A-Z]{2,}_[A-Z0-9]+_[0-9]{3}\b/.test(output);
    case 'period': {
      return /\b(19|20)\d{2}\b/.test(output);
    }
    case 'values': {
      const tokens = output.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? [];
      for (const token of tokens) {
        if (/^(19|20)\d{2}$/.test(token)) continue;
        const numeric = Number(token.replace(/,/g, ''));
        if (Number.isFinite(numeric)) return true;
      }
      return false;
    }
    default:
      return output.toLowerCase().includes(field.toLowerCase());
  }
}

export function extractFieldValue(output: string, field: string): unknown {
  const regex = new RegExp(`"${field}"\\s*:\\s*"?([^",}]+)"?`, 'i');
  const match = output.match(regex);
  return match ? match[1]?.trim() : undefined;
}

export function extractRequiredFields(contractRow: TaskContractRow, parseJson: ParseJson): string {
  const criteria: Array<{ config?: { field?: string }; required?: boolean }> =
    (parseJson(contractRow.acceptance_criteria) as Array<{ config?: { field?: string }; required?: boolean }>) ?? [];
  return criteria
    .filter((criterion) => criterion.required !== false)
    .map((criterion) => criterion.config?.field ?? 'unknown')
    .join(', ');
}

export async function runWithContractGuard(options: {
  agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> };
  ctx: ExecutionContext;
  messages: Message[];
  goal: string;
  workerRow: WorkerAgentRow;
  getTaskContract: (id: string) => Promise<TaskContractRow | null>;
  parseJson: ParseJson;
  validateAgainstContract: ValidateAgainstContract;
}): Promise<AgentResult> {
  const { agent, ctx, messages, goal, workerRow, getTaskContract, parseJson, validateAgainstContract } = options;
  const contractId = workerRow.task_contract_id;
  const maxRetries = workerRow.max_retries ?? 0;

  let contractRow: TaskContractRow | null = null;
  if (contractId) {
    contractRow = await getTaskContract(contractId);
  }

  const first = await agent.run(ctx, { messages, goal });
  if (!contractRow) return first;

  if (await validateAgainstContract(first, contractRow)) return first;

  let lastResult = first;
  const workerToolNames: string[] = parseJson(workerRow.tool_names) as string[] ?? [];
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const retryGoal = `${goal}\n\nEXECUTION GUARD (attempt ${attempt + 2}): Delegate to ${workerRow.name} and ensure the response satisfies the task contract "${contractRow.name}". The worker has tools: ${workerToolNames.join(', ')}. Required output fields: ${extractRequiredFields(contractRow, parseJson)}.`;
    lastResult = await agent.run(ctx, { messages, goal: retryGoal });
    if (await validateAgainstContract(lastResult, contractRow)) return lastResult;
  }

  return lastResult;
}
