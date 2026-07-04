export function applyTemporalToolPolicy(options: {
  basePrompt: string | undefined;
  toolNames: string[];
  temporalToolPolicy: string;
}): string | undefined {
  const { basePrompt, toolNames, temporalToolPolicy } = options;
  const hasTemporalTools = toolNames.includes('datetime') || toolNames.includes('timezone_info')
    || toolNames.includes('stopwatch_start') || toolNames.includes('timer_start');
  if (!hasTemporalTools) return basePrompt;

  const enhancedPolicy = [
    temporalToolPolicy,
    '',
    'REASONING REQUIREMENT:',
    '- Always use the `think` tool before acting',
    '- After calling datetime/timezone_info tools, use `think` with reasoning_phase="reasoning"',
    '- Explicitly connect tool outputs to your answer',
    '- Do not guess or hallucinate dates/times',
  ].join('\n');

  const base = basePrompt?.trim();
  return base ? `${base}\n\n${enhancedPolicy}` : enhancedPolicy;
}
