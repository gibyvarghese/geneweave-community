import type { AgentResult } from '@weaveintel/core';
import type { ResolvedSkillExecutionContract } from '@weaveintel/skills';

const CSE_EXECUTION_TOOLS = new Set(['cse_run_code', 'cse_run_data_analysis']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractWorkerToolTrace(value: string): unknown[] | null {
  const traceIdx = value.indexOf('[WorkerToolTrace]');
  if (traceIdx < 0) {
    return null;
  }

  const traceJson = value.slice(traceIdx + '[WorkerToolTrace]\n'.length).trim();
  const parsed = safeParseJson(traceJson);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  const rec = asRecord(parsed);
  const executions = rec?.['executions'];
  return Array.isArray(executions) ? executions : null;
}

function isSuccessfulCseToolResult(value: unknown): boolean {
  const parsed = typeof value === 'string' ? safeParseJson(value) : value;
  const record = asRecord(parsed);
  return record?.['status'] === 'success';
}

function scanForSuccessfulCseExecution(value: unknown, seen: WeakSet<object>): boolean {
  if (value == null) return false;

  if (typeof value === 'string') {
    const workerTrace = extractWorkerToolTrace(value);
    if (workerTrace && scanForSuccessfulCseExecution(workerTrace, seen)) {
      return true;
    }
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => scanForSuccessfulCseExecution(entry, seen));
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const toolCall = asRecord(record['toolCall']);
  if (toolCall && CSE_EXECUTION_TOOLS.has(String(toolCall['name'] ?? '')) && isSuccessfulCseToolResult(toolCall['result'])) {
    return true;
  }

  if (CSE_EXECUTION_TOOLS.has(String(record['name'] ?? '')) && isSuccessfulCseToolResult(record['result'])) {
    return true;
  }

  for (const nested of Object.values(record)) {
    if (scanForSuccessfulCseExecution(nested, seen)) {
      return true;
    }
  }

  return false;
}

export function hasSuccessfulCseExecution(result: AgentResult): boolean {
  return scanForSuccessfulCseExecution(result, new WeakSet<object>());
}

export function hasCodeExecutorDelegation(result: AgentResult): boolean {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;

    const delegationWorker = String(step.delegation?.worker ?? step.delegation?.workerName ?? '').trim().toLowerCase();
    if (delegationWorker === 'code_executor') return true;

    const toolName = String(step.toolCall?.name ?? '').trim();
    if (toolName !== 'delegate_to_worker') continue;

    const argsRec = asRecord(step.toolCall?.arguments);
    const argWorker = String(argsRec?.['worker'] ?? '').trim().toLowerCase();
    if (argWorker === 'code_executor') return true;
  }

  return false;
}

export function countWorkerDelegations(result: AgentResult): number {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  let count = 0;

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;

    const delegationWorker = String(step.delegation?.worker ?? step.delegation?.workerName ?? '').trim();
    if (delegationWorker) {
      count += 1;
      continue;
    }

    const toolName = String(step.toolCall?.name ?? '').trim();
    if (toolName !== 'delegate_to_worker') continue;

    const argsRec = asRecord(step.toolCall?.arguments);
    const argWorker = String(argsRec?.['worker'] ?? '').trim();
    if (argWorker) count += 1;
  }

  return count;
}

/**
 * Result of evaluating one or more {@link ResolvedSkillExecutionContract}
 * against an {@link AgentResult}. `failures` is empty when every contract
 * passed; otherwise each entry is a single concrete delta the model can
 * act on during retry (e.g. "expected ≥ 2 delegations, got 1" or
 * "missing required substring 'Composite Health Score'").
 */
export interface ExecutionContractEvaluation {
  ok: boolean;
  failures: Array<{ skillId: string; reason: string }>;
}

export function evaluateSkillExecutionContracts(
  result: AgentResult,
  contracts: readonly ResolvedSkillExecutionContract[],
): ExecutionContractEvaluation {
  if (!contracts.length) return { ok: true, failures: [] };

  const output = String(result.output ?? '');
  const lowerOutput = output.toLowerCase();
  const delegations = countWorkerDelegations(result);
  const failures: Array<{ skillId: string; reason: string }> = [];

  for (const { skillId, contract } of contracts) {
    if (typeof contract.minDelegations === 'number' && delegations < contract.minDelegations) {
      failures.push({
        skillId,
        reason: `expected at least ${contract.minDelegations} worker delegation(s), observed ${delegations}`,
      });
    }
    for (const sub of contract.requiredOutputSubstrings ?? []) {
      if (!lowerOutput.includes(sub.toLowerCase())) {
        failures.push({ skillId, reason: `final response is missing required text "${sub}"` });
      }
    }
    for (const pattern of contract.requiredOutputPatterns ?? []) {
      try {
        const re = new RegExp(pattern, 'i');
        if (!re.test(output)) {
          failures.push({ skillId, reason: `final response does not match required pattern /${pattern}/i` });
        }
      } catch {
        // Invalid regex — surface as a failure so the operator notices the misconfigured contract.
        failures.push({ skillId, reason: `execution contract has invalid regex pattern: ${pattern}` });
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

export function formatExecutionContractFailures(failures: ReadonlyArray<{ skillId: string; reason: string }>): string {
  if (!failures.length) return '';
  return failures.map((f, i) => `${i + 1}. [${f.skillId}] ${f.reason}`).join('\n');
}

export function isSuccessfulToolResult(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (
      lower.includes('tool error')
      || lower.includes('"status":"error"')
      || lower.includes('"status": "error"')
    ) {
      return false;
    }
  }
  const parsed = typeof value === 'string' ? safeParseJson(value) : value;
  const record = asRecord(parsed);
  if (!record) return true;
  if (record['isError'] === true) return false;
  const status = record['status'];
  if (status === 'error' || status === 'failed') return false;
  if (record['error']) return false;
  return true;
}
