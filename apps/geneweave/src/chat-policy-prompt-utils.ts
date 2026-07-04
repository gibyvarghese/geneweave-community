import { createSafeTemplate } from '@weaveintel/prompts';
import type { DatabaseAdapter } from './db.js';

export interface PolicyPromptCache {
  ts: number;
  prompts: Map<string, string>;
}

export async function loadPolicyPromptTemplates(
  db: DatabaseAdapter,
  cache: PolicyPromptCache | null,
): Promise<{ prompts: Map<string, string>; cache: PolicyPromptCache | null }> {
  const now = Date.now();
  if (cache && now - cache.ts < 30_000) {
    return { prompts: cache.prompts, cache };
  }
  try {
    const rows = await db.listPrompts();
    const enabled = new Map<string, string>();
    for (const row of rows) {
      if (row.enabled) enabled.set(row.name, row.template);
    }
    const nextCache = { ts: now, prompts: enabled };
    return { prompts: enabled, cache: nextCache };
  } catch {
    return { prompts: new Map<string, string>(), cache };
  }
}

export function renderNamedPolicyPromptTemplate(
  name: string,
  template: string,
  fallbackTemplate: string,
  vars: Record<string, unknown>,
): string {
  try {
    const tpl = createSafeTemplate({ id: name, name, template });
    return tpl.render(vars);
  } catch {
    return fallbackTemplate;
  }
}