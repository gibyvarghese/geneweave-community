/**
 * Migration m65 — Agent Phase 4: Portable memory tools, proactive context injection & knowledge graph
 *
 * New columns on chat_settings:
 *   graph_enabled           — enable knowledge graph memory tools for this chat
 *   graph_max_nodes         — max nodes the SQLite graph store will retain per chat
 *   graph_persist_enabled   — persist graph to agent_graph_nodes/edges (vs. in-memory only)
 *   memory_context_enabled  — enable proactive memory context injection (P4-2)
 *   memory_context_max_chars — max chars of memory context prepended to system prompt
 *
 * New tables:
 *   agent_graph_nodes  — persistent knowledge graph entity nodes per chat
 *   agent_graph_edges  — persistent knowledge graph relationship edges per chat
 */

import type BetterSqlite3 from 'better-sqlite3';

function safe(db: BetterSqlite3.Database, sql: string): void {
  try { db.prepare(sql).run(); } catch { /* idempotent */ }
}

export function applyM65AgentPhase4(db: BetterSqlite3.Database): void {
  // ── chat_settings: graph + proactive memory context toggles ─────────────

  safe(db, 'ALTER TABLE chat_settings ADD COLUMN graph_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN graph_max_nodes INTEGER NOT NULL DEFAULT 500');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN graph_persist_enabled INTEGER NOT NULL DEFAULT 1');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN memory_context_enabled INTEGER NOT NULL DEFAULT 0');
  safe(db, 'ALTER TABLE chat_settings ADD COLUMN memory_context_max_chars INTEGER NOT NULL DEFAULT 4000');

  // ── agent_graph_nodes ────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_graph_nodes (
      -- Surrogate PK — UUIDv7 generated in application layer
      id              TEXT PRIMARY KEY,
      -- Scope
      chat_id         TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      -- Entity fields (mirror @weaveintel/memory EntityNode)
      entity_id       TEXT NOT NULL,     -- application-level ID (e.g. "person:alice")
      entity_type     TEXT NOT NULL,
      entity_name     TEXT NOT NULL,
      properties_json TEXT NOT NULL DEFAULT '{}',
      -- Timestamps (Unix epoch ms — matches EntityNode.createdAt/updatedAt)
      entity_created_at INTEGER NOT NULL,
      entity_updated_at INTEGER NOT NULL,
      -- Audit
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
      -- entity_id must be unique per chat scope
      UNIQUE (chat_id, entity_id)
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_nodes_chat ON agent_graph_nodes(chat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_nodes_user ON agent_graph_nodes(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON agent_graph_nodes(chat_id, entity_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON agent_graph_nodes(entity_name)');
  } catch { /* ok if index exists */ }

  // ── agent_graph_edges ────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_graph_edges (
      -- Surrogate PK — mirrors RelationshipEdge.id (already unique)
      id              TEXT PRIMARY KEY,
      -- Scope
      chat_id         TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      -- Edge fields (mirror @weaveintel/memory RelationshipEdge)
      source_entity_id TEXT NOT NULL,    -- references agent_graph_nodes.entity_id
      target_entity_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      properties_json TEXT NOT NULL DEFAULT '{}',
      -- Timestamps (Unix epoch ms)
      edge_created_at INTEGER NOT NULL,
      -- Audit
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    )
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_edges_chat ON agent_graph_edges(chat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON agent_graph_edges(chat_id, source_entity_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON agent_graph_edges(chat_id, target_entity_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON agent_graph_edges(chat_id, relationship_type)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_unique ON agent_graph_edges(chat_id, source_entity_id, target_entity_id, relationship_type)');
  } catch { /* ok if index exists */ }

  // ── tool catalog: extend schema for graph tool metadata ─────────────────
  safe(db, 'ALTER TABLE tool_catalog ADD COLUMN display_name TEXT');
  safe(db, 'ALTER TABLE tool_catalog ADD COLUMN requires_capabilities TEXT NOT NULL DEFAULT \'[]\'');

  // ── tool catalog: seed graph memory tools ───────────────────────────────
  const seedTools = db.prepare(`
    INSERT OR IGNORE INTO tool_catalog (id, name, display_name, description, category, enabled, requires_capabilities)
    VALUES (?, ?, ?, ?, ?, 1, '[]')
  `);

  seedTools.run(
    'tool-graph-entity-add',
    'graph_entity_add',
    'Graph: Add Entity',
    'Add or update an entity node in the knowledge graph with typed facts',
    'memory',
  );
  seedTools.run(
    'tool-graph-entity-search',
    'graph_entity_search',
    'Graph: Search Entities',
    'Full-text search across entity nodes in the knowledge graph',
    'memory',
  );
  seedTools.run(
    'tool-graph-relate',
    'graph_relate',
    'Graph: Create Relationship',
    'Create a directed relationship edge between two entity nodes',
    'memory',
  );
  seedTools.run(
    'tool-graph-recall-neighbours',
    'graph_recall_neighbours',
    'Graph: Recall Neighbours',
    'Traverse neighbour graph up to N hops from a starting entity',
    'memory',
  );
}
