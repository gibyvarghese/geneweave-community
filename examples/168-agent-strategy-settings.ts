/**
 * Example 168: Agent Strategy Settings (Phase 7)
 *
 * Demonstrates the global/tenant agent strategy settings introduced in the
 * mid-2026 DB update (m74). These settings are the "dial board" for how all
 * agents behave by default — you set them once in the database and every
 * agent picks them up automatically.
 *
 * New fields added in Phase 7 (m74):
 *   - hitl_threshold          — risk score at which HITL approval fires
 *   - max_agent_hops          — maximum A2A delegation chain depth
 *   - tool_confirmation_level — which tool calls require user confirmation
 *   - memory_policy           — cross-turn memory retention scope
 *
 * Defaults flipped to ON in m74:
 *   - a2a_enabled                   (was 0 → now 1)
 *   - supervisor_parallel_delegation (was 0 → now 1)
 *   - reflect_enabled                (was 0 → now 1)
 *
 * Also covers:
 *   - Reading global settings with getAgentStrategySettings('global')
 *   - Patching settings with updateAgentStrategySettings()
 *   - Listing all settings rows (global + tenant-scoped overrides)
 *
 * Packages used:
 *   apps/geneweave — SQLiteAdapter, db.initialize(), db.seedDefaultData()
 */

import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import type { AgentStrategySettingsRow } from '../apps/geneweave/src/db-types/agents.js';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempDbPath(name: string): string {
  return join(tmpdir(), `weaveintel-${name}-${Date.now()}.db`);
}

async function main() {
  // ── Setup ───────────────────────────────────────────────────────────────
  const dbPath = makeTempDbPath('agent-strategy-settings');
  const db = new SQLiteAdapter(dbPath);
  await db.initialize();
  await db.seedDefaultData();

  // ── 1. Read the global defaults ─────────────────────────────────────────
  const global = await db.getAgentStrategySettings('global');

  if (!global) {
    throw new Error('Global agent strategy settings row not found — seedDefaultData() should create it');
  }

  console.log('\n=== Global Agent Strategy Settings (Phase 7 defaults) ===');
  console.log(`hitl_threshold:          ${global.hitl_threshold}`);           // 0.75
  console.log(`max_agent_hops:          ${global.max_agent_hops}`);           // 5
  console.log(`tool_confirmation_level: ${global.tool_confirmation_level}`);  // 'high-risk-only'
  console.log(`memory_policy:           ${global.memory_policy}`);            // 'session'

  // These three flags are now ON by default (flipped in m74)
  console.log(`\na2a_enabled:                   ${global.a2a_enabled}`);                   // 1
  console.log(`supervisor_parallel_delegation: ${global.supervisor_parallel_delegation}`); // 1
  console.log(`reflect_enabled:                ${global.reflect_enabled}`);               // 1

  // Other strategy fields (set by earlier migrations)
  console.log(`\nreflect_max_revisions:   ${global.reflect_max_revisions}`);   // 2
  console.log(`verify_enabled:          ${global.verify_enabled}`);           // 0 (opt-in)
  console.log(`parallel_tool_calls:     ${global.parallel_tool_calls}`);      // 1

  // ── 2. Update settings for a stricter deployment ───────────────────────
  console.log('\n=== Patching: stricter HITL + tool confirmation ===');
  await db.updateAgentStrategySettings('global', {
    hitl_threshold:          0.85,    // raise the bar — 85% risk triggers approval
    tool_confirmation_level: 'medium', // also confirm write-level tools
    max_agent_hops:          3,        // shorter delegation chains for tighter control
  });

  const patched = await db.getAgentStrategySettings('global');
  console.log(`hitl_threshold after patch:          ${patched?.hitl_threshold}`);          // 0.85
  console.log(`tool_confirmation_level after patch: ${patched?.tool_confirmation_level}`); // 'medium'
  console.log(`max_agent_hops after patch:          ${patched?.max_agent_hops}`);          // 3

  // ── 3. List all settings rows ──────────────────────────────────────────
  const all: AgentStrategySettingsRow[] = await db.listAgentStrategySettings();
  console.log(`\n=== All strategy settings rows (${all.length} total) ===`);
  for (const row of all) {
    console.log(`  id=${row.id}  scope=${row.scope}  tenant_id=${row.tenant_id ?? 'null'}`);
  }

  // ── 4. What these settings mean in practice ────────────────────────────
  console.log('\n=== Interpreting the settings ===');

  const settings = await db.getAgentStrategySettings('global');

  // HITL threshold — when should a human review the agent's decision?
  const hitlMsg = settings!.hitl_threshold < 1
    ? `Requires human approval when risk score > ${(settings!.hitl_threshold * 100).toFixed(0)}%`
    : 'Never requires human approval (threshold = 1.0)';
  console.log(`HITL:   ${hitlMsg}`);

  // Max hops — how deep can agent delegation go?
  console.log(`Hops:   A→B→C→... chain limited to ${settings!.max_agent_hops} hops before forced stop`);

  // Tool confirmation
  const confirmMsg: Record<string, string> = {
    'none':           'Never asks user before calling any tool',
    'medium':         'Asks before any write-level or higher-risk tool',
    'high-risk-only': 'Only asks before destructive or privileged tools',
  };
  console.log(`Tools:  ${confirmMsg[settings!.tool_confirmation_level] ?? settings!.tool_confirmation_level}`);

  // Memory policy
  const memMsg: Record<string, string> = {
    'none':       'No memory persisted — fresh context every turn',
    'session':    'Memory persists within a session, cleared when session ends',
    'persistent': 'Memory persists indefinitely across sessions',
  };
  console.log(`Memory: ${memMsg[settings!.memory_policy] ?? settings!.memory_policy}`);

  // ── 5. Non-existent row returns null ──────────────────────────────────
  const missing = await db.getAgentStrategySettings('no-such-id');
  console.log(`\nGet non-existent id: ${missing}`); // null

  console.log('\n✅ Agent strategy settings example complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
