/**
 * SQLite-backed GraphMemoryStore adapter for geneWeave (P4-3)
 *
 * Wraps an in-memory `createGraphMemoryStore()` with synchronous SQLite
 * read-through and write-through backed by the `agent_graph_nodes` and
 * `agent_graph_edges` tables (added by migration m65).
 *
 * On construction it eagerly loads all existing nodes/edges for the chat
 * from SQLite into the in-memory store, so subsequent reads are O(1).
 * Writes go to both SQLite (sync via better-sqlite3) and the in-memory
 * store so queries see changes immediately.
 *
 * The in-memory store handles `getNeighbors` / `getEdgesBetween` / etc.
 * which would be expensive to express as arbitrary-depth SQLite queries.
 */

import type { GraphMemoryStore } from '@weaveintel/memory';
import { createGraphMemoryStore, createEntityNode, createRelationshipEdge } from '@weaveintel/memory';
import type { EntityNode, RelationshipEdge } from '@weaveintel/memory';
import { newUUIDv7 } from '@weaveintel/core';

export function createSQLiteGraphMemoryStore(
  rawDb: import('better-sqlite3').Database,
  chatId: string,
  userId: string,
): GraphMemoryStore {
  const mem = createGraphMemoryStore();

  // Prepare statements (better-sqlite3 is synchronous)
  const upsertNode = rawDb.prepare(`
    INSERT INTO agent_graph_nodes
      (id, chat_id, user_id, entity_id, entity_type, entity_name, properties_json, entity_created_at, entity_updated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(chat_id, entity_id) DO UPDATE SET
      entity_type = excluded.entity_type,
      entity_name = excluded.entity_name,
      properties_json = excluded.properties_json,
      entity_updated_at = excluded.entity_updated_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);

  const deleteNode = rawDb.prepare(`
    DELETE FROM agent_graph_nodes WHERE chat_id = ? AND entity_id = ?
  `);

  const upsertEdge = rawDb.prepare(`
    INSERT OR IGNORE INTO agent_graph_edges
      (id, chat_id, user_id, source_entity_id, target_entity_id, relationship_type, weight, properties_json, edge_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteEdge = rawDb.prepare(`
    DELETE FROM agent_graph_edges WHERE id = ? AND chat_id = ?
  `);

  // Eager-load existing nodes from SQLite into memory
  const nodeRows = rawDb.prepare(`
    SELECT entity_id, entity_type, entity_name, properties_json, entity_created_at, entity_updated_at
    FROM agent_graph_nodes WHERE chat_id = ?
  `).all(chatId) as Array<{
    entity_id: string; entity_type: string; entity_name: string;
    properties_json: string; entity_created_at: number; entity_updated_at: number;
  }>;

  for (const row of nodeRows) {
    let props: Record<string, unknown> = {};
    try { props = JSON.parse(row.properties_json); } catch { /* ignore */ }
    const node: EntityNode = {
      id: row.entity_id,
      type: row.entity_type,
      name: row.entity_name,
      properties: props,
      createdAt: row.entity_created_at,
      updatedAt: row.entity_updated_at,
    };
    mem.addNode(node);
  }

  // Eager-load existing edges
  const edgeRows = rawDb.prepare(`
    SELECT id, source_entity_id, target_entity_id, relationship_type, weight, properties_json, edge_created_at
    FROM agent_graph_edges WHERE chat_id = ?
  `).all(chatId) as Array<{
    id: string; source_entity_id: string; target_entity_id: string;
    relationship_type: string; weight: number; properties_json: string; edge_created_at: number;
  }>;

  for (const row of edgeRows) {
    let props: Record<string, unknown> = {};
    try { props = JSON.parse(row.properties_json); } catch { /* ignore */ }
    const edge: RelationshipEdge = {
      id: row.id,
      sourceId: row.source_entity_id,
      targetId: row.target_entity_id,
      type: row.relationship_type,
      weight: row.weight,
      properties: props,
      createdAt: row.edge_created_at,
    };
    mem.addEdge(edge);
  }

  // Return a store that delegates to the in-memory store but intercepts
  // mutations to also write/delete from SQLite.
  return {
    addNode(node: EntityNode): void {
      upsertNode.run(
        newUUIDv7(),
        chatId,
        userId,
        node.id,
        node.type,
        node.name,
        JSON.stringify(node.properties),
        node.createdAt,
        node.updatedAt,
      );
      mem.addNode(node);
    },

    getNode: (id) => mem.getNode(id),
    findNodes: (type) => mem.findNodes(type),
    searchNodes: (query) => mem.searchNodes(query),

    removeNode(id: string): boolean {
      // Also cascade-delete edges (mem.removeNode handles in-memory; SQLite has ON DELETE CASCADE via FK,
      // but we explicitly delete edges here to be safe in case FK cascade is not enabled)
      deleteEdge.run(id, chatId); // by edge ID — fine to pass node id, won't match
      // Delete all edges involving this node
      rawDb.prepare('DELETE FROM agent_graph_edges WHERE chat_id = ? AND (source_entity_id = ? OR target_entity_id = ?)').run(chatId, id, id);
      deleteNode.run(chatId, id);
      return mem.removeNode(id);
    },

    addEdge(edge: RelationshipEdge): void {
      upsertEdge.run(
        edge.id,
        chatId,
        userId,
        edge.sourceId,
        edge.targetId,
        edge.type,
        edge.weight,
        JSON.stringify(edge.properties),
        edge.createdAt,
      );
      mem.addEdge(edge);
    },

    getEdge: (id) => mem.getEdge(id),
    getEdgesFrom: (nodeId) => mem.getEdgesFrom(nodeId),
    getEdgesTo: (nodeId) => mem.getEdgesTo(nodeId),
    getEdgesBetween: (sourceId, targetId) => mem.getEdgesBetween(sourceId, targetId),

    removeEdge(id: string): boolean {
      deleteEdge.run(id, chatId);
      return mem.removeEdge(id);
    },

    getNeighbors: (nodeId, depth) => mem.getNeighbors(nodeId, depth),
    nodeCount: () => mem.nodeCount(),
    edgeCount: () => mem.edgeCount(),
    clear(): void {
      rawDb.prepare('DELETE FROM agent_graph_nodes WHERE chat_id = ?').run(chatId);
      rawDb.prepare('DELETE FROM agent_graph_edges WHERE chat_id = ?').run(chatId);
      mem.clear();
    },
  };
}
