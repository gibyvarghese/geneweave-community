import type BetterSqlite3 from 'better-sqlite3';

/**
 * M39 — Extended memory tools in tool catalog
 *
 * Seeds three new tool catalog entries that the agent can invoke:
 *
 * 1. memory_snapshot        — save working state JSON blob (working memory write path)
 * 2. memory_load_state      — load the latest working memory snapshot
 * 3. memory_propose_instruction — propose a procedural memory delta for human approval
 *
 * All three are tagged 'memory', default enabled, require_auth = 1.
 * They are only registered in the tool registry when enable_working / enable_procedural
 * are on in the tenant's memory_settings row (checked at runtime).
 */
export function applyM39MemoryToolsExtended(db: BetterSqlite3.Database): void {
  const existing = (db.prepare('SELECT tool_key FROM tool_catalog').all() as Array<{ tool_key: string }>)
    .map((r) => r.tool_key)
    .filter((k): k is string => typeof k === 'string');

  const tools: Array<{
    id: string;
    key: string;
    name: string;
    description: string;
    category: string;
    tags: string;
    parameters_schema: string;
  }> = [
    {
      id: 'tc-memory-snapshot',
      key: 'memory_snapshot',
      name: 'Memory Snapshot',
      description: 'Save the current working state as a JSON snapshot to working memory. Use to checkpoint progress during multi-step tasks.',
      category: 'memory',
      tags: '["memory","working","state"]',
      parameters_schema: JSON.stringify({
        type: 'object',
        properties: {
          state: { type: 'object', description: 'Arbitrary JSON representing the current task state' },
          label: { type: 'string', description: 'Optional human-readable label for this snapshot' },
        },
        required: ['state'],
      }),
    },
    {
      id: 'tc-memory-load-state',
      key: 'memory_load_state',
      name: 'Memory Load State',
      description: 'Load the most recent working memory snapshot for this user. Use to restore intermediate state when resuming a multi-step task.',
      category: 'memory',
      tags: '["memory","working","state"]',
      parameters_schema: JSON.stringify({
        type: 'object',
        properties: {},
        required: [],
      }),
    },
    {
      id: 'tc-memory-propose-instruction',
      key: 'memory_propose_instruction',
      name: 'Propose Agent Instruction',
      description: 'Propose a persistent behavioural adjustment for how the agent should interact with this user in future conversations. The proposal is submitted for human review and must be approved before it takes effect.',
      category: 'memory',
      tags: '["memory","procedural","proposal"]',
      parameters_schema: JSON.stringify({
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'The behavioural change to propose' },
          reason: { type: 'string', description: 'Brief justification for this proposal' },
          confidence: { type: 'number', description: 'Confidence in this proposal (0.0–1.0)' },
        },
        required: ['instruction'],
      }),
    },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO tool_catalog
      (id, tool_key, name, description, category, tags, config, enabled, source)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 1, 'builtin')
  `);

  for (const tool of tools) {
    if (!existing.includes(tool.key)) {
      insert.run(tool.id, tool.key, tool.name, tool.description, tool.category, tool.tags, tool.parameters_schema);
    }
  }
}
