export function promptWizardRows(adminData: Record<string, unknown> | null | undefined, tab: string): any[] {
  return ((adminData?.[tab] || []) as any[]).filter(Boolean);
}

export function extractTemplateTokens(template: string): { variables: string[]; fragments: string[] } {
  const variableSet = new Set<string>();
  const fragmentSet = new Set<string>();
  const tokenRegex = /\{\{>\s*([a-zA-Z0-9._-]+)\s*\}\}|\{\{\s*([a-zA-Z0-9._-]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(template)) !== null) {
    if (match[1]) fragmentSet.add(match[1]);
    if (match[2]) variableSet.add(match[2]);
  }
  return {
    variables: [...variableSet],
    fragments: [...fragmentSet],
  };
}