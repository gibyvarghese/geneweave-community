/**
 * Migration M35 — Memory vectors, governance seeds, and memory tool catalog
 *
 * 1. Adds `embedding TEXT NULL` to semantic_memory for vector similarity search.
 * 2. Seeds default memory governance rules (PII block, max-entry cap, redaction).
 * 3. Seeds memory tool catalog entries:
 *    memory_recall, memory_search, memory_remember, memory_forget, memory_list_entities.
 * 4. Seeds a richer set of memory extraction rules (topic, email, job_title).
 */

import type BetterSqlite3 from 'better-sqlite3';

export function applyM35MemoryVectors(db: BetterSqlite3.Database): void {
  // ── 1. Add embedding column ────────────────────────────────────────────────
  const hasEmbedding = (db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('semantic_memory') WHERE name = 'embedding'")
    .get() as { n: number }).n > 0;

  if (!hasEmbedding) {
    db.prepare('ALTER TABLE semantic_memory ADD COLUMN embedding TEXT').run();
  }

  // ── 2. Memory governance seeds ────────────────────────────────────────────
  const insertGov = db.prepare(`
    INSERT OR IGNORE INTO memory_governance
      (id, name, description, memory_types, tenant_id, block_patterns, redact_patterns,
       max_age, max_entries, enabled)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 1)
  `);

  // memory_types=NULL means the rule applies to all memory types globally.
  insertGov.run(
    'mgov-0000-0000-4000-8000-000000000001',
    'PII Block — credit cards & SSNs',
    'Prevents raw credit card numbers and SSNs from being stored in any memory.',
    null, // applies globally
    JSON.stringify([
      '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b',
      '\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b',
    ]),
    null,
    null,
    null,
  );

  insertGov.run(
    'mgov-0000-0000-4000-8000-000000000002',
    'Redact passwords & tokens',
    'Redacts password and token values before any memory is persisted.',
    null, // applies globally
    null,
    JSON.stringify([
      '(?i)(?:password|passwd|secret|token|api[_-]?key)\\s*[=:]\\s*\\S+',
      '(?:eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})',
    ]),
    null,
    null,
  );

  insertGov.run(
    'mgov-0000-0000-4000-8000-000000000003',
    'Global memory cap — 500 entries per user',
    'Trims oldest semantic memories once a user exceeds 500 entries to control storage growth.',
    null, // applies globally
    null,
    null,
    null,
    500,
  );

  insertGov.run(
    'mgov-0000-0000-4000-8000-000000000004',
    '180-day retention — auto-purge old summaries',
    'Deletes semantic memories older than 180 days.',
    null, // applies globally
    null,
    null,
    'P180D',
    null,
  );

  // ── 3. Additional extraction rule seeds ───────────────────────────────────
  const insertRule = db.prepare(`
    INSERT OR IGNORE INTO memory_extraction_rules
      (id, name, description, rule_type, entity_type, pattern, flags,
       facts_template, priority, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  // Email address extraction
  insertRule.run(
    'mer-00000-0000-4000-8000-000000000010',
    'Email address',
    'Extracts email addresses disclosed by the user.',
    'entity_extraction',
    'general',
    '\\b([a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,})\\b',
    'i',
    JSON.stringify({ email: '$1' }),
    70,
  );

  // Job title / role
  insertRule.run(
    'mer-00000-0000-4000-8000-000000000011',
    'Job title / role',
    'Extracts job titles or professional roles disclosed by the user.',
    'self_disclosure',
    'general',
    "\\b(?:i(?:'m| am) (?:a |an )?(?:senior |lead |chief |head of |director of |vp of |principal |staff )?)(\\w+(?:\\s+\\w+){0,4}?)\\b",
    'i',
    JSON.stringify({ job_title: '$1' }),
    75,
  );

  // Topic interest
  insertRule.run(
    'mer-00000-0000-4000-8000-000000000012',
    'Topic interest',
    'Extracts subjects the user expresses interest in.',
    'entity_extraction',
    'topic',
    "\\b(?:i(?:'m| am) (?:interested|fascinated|obsessed) in|i love learning about|i study|i research)\\s+([a-zA-Z][a-zA-Z\\s]{2,60}?)\\b",
    'i',
    JSON.stringify({ interest: '$1' }),
    65,
  );

  // ── 4. Memory tool catalog entries ────────────────────────────────────────
  const insertTool = db.prepare(`
    INSERT OR IGNORE INTO tool_catalog
      (id, name, description, category, risk_level, requires_approval,
       max_execution_ms, rate_limit_per_min, enabled,
       tool_key, version, side_effects, tags, source,
       created_at, updated_at)
    VALUES (?, ?, ?, 'utility', ?, 0, 5000, 60, 1, ?, '1.0', ?, ?, 'builtin',
            datetime('now'), datetime('now'))
  `);

  insertTool.run(
    'mem-00000-0000-4000-8000-000000000001',
    'Memory Recall',
    'Retrieve relevant long-term memories for the current user. Searches semantic and entity memory stores using the provided query and returns the most relevant results.',
    'read-only',
    'memory_recall',
    0,
    JSON.stringify(['memory', 'personalization', 'recall', 'context']),
  );

  insertTool.run(
    'mem-00000-0000-4000-8000-000000000002',
    'Memory Search',
    'Perform a targeted search of the user\'s long-term memory store using natural language. Returns ranked semantic memories and matching entity facts. Use when memory_recall is too broad.',
    'read-only',
    'memory_search',
    0,
    JSON.stringify(['memory', 'search', 'vector', 'semantic']),
  );

  insertTool.run(
    'mem-00000-0000-4000-8000-000000000003',
    'Remember Fact',
    'Explicitly save a new fact or note to the user\'s long-term memory. Use when the user asks you to remember something specific, or when you learn a durable fact that should be recalled in future conversations.',
    'write',
    'memory_remember',
    1,
    JSON.stringify(['memory', 'remember', 'save', 'personalization']),
  );

  insertTool.run(
    'mem-00000-0000-4000-8000-000000000004',
    'Forget Memory',
    'Remove a specific memory or entity fact from the user\'s long-term store. Use only when the user explicitly asks you to forget something.',
    'write',
    'memory_forget',
    1,
    JSON.stringify(['memory', 'forget', 'delete', 'privacy']),
  );

  insertTool.run(
    'mem-00000-0000-4000-8000-000000000005',
    'List Entity Facts',
    'List all known facts about the current user from the entity memory store — name, location, job, preferences, and other extracted profile attributes.',
    'read-only',
    'memory_list_entities',
    0,
    JSON.stringify(['memory', 'profile', 'entities', 'facts']),
  );
}
