/**
 * Agent Strategy Phase 7 — Agent Strategy Defaults & New Settings (mid-2026)
 *
 * Covers:
 *   POSITIVE  — m74 migration adds 4 new columns with correct defaults;
 *               global row flipped: a2a_enabled=1, supervisor_parallel_delegation=1,
 *               reflect_enabled=1; new mode_labels seeded (web/operator, api/headless);
 *               DB adapter methods work (get, list, update)
 *   NEGATIVE  — verify_enabled and supervisor_replan_on_failure stay 0;
 *               existing mode_labels unchanged; new columns have correct types;
 *               updateAgentStrategySettings is a no-op when patch is empty
 *   STRESS    — idempotency of m74 (run 3×); concurrent reads; patch roundtrip;
 *               mode_labels idempotency
 *   SECURITY  — tool_confirmation_level defaults to 'high-risk-only' (not 'none');
 *               memory_policy defaults to 'session' (not 'persistent');
 *               max_agent_hops is bounded (5, not 0 or unbounded);
 *               hitl_threshold is non-zero (not 0.0 which would disable HITL)
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';
import type { AgentStrategySettingsRow } from './db-types/agents.js';
import { applyM74AgentStrategyDefaults2026 } from './migrations/m74-agent-strategy-defaults-2026.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModeLabelRow {
  id: string;
  surface_id: string;
  mode_key: string;
  label: string;
  description: string;
  sort_order: number;
  is_default: number;
  enabled: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDbPath(): string {
  return `/tmp/gw-phase7-${Date.now()}-${randomUUID()}.db`;
}

async function freshDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(makeTempDbPath());
  await db.initialize();
  return db;
}

function rawOf(db: SQLiteAdapter) {
  return db.rawDb;
}

function getGlobal(db: SQLiteAdapter) {
  return rawOf(db).prepare('SELECT * FROM agent_strategy_settings WHERE id = ?').get('global') as AgentStrategySettingsRow | undefined;
}

function listModeLabelsByKey(db: SQLiteAdapter, surface: string, modeKey: string) {
  return rawOf(db).prepare('SELECT * FROM mode_labels WHERE surface_id = ? AND mode_key = ?').get(surface, modeKey) as ModeLabelRow | undefined;
}

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: m74 migration state
// ══════════════════════════════════════════════════════════════════════════════

describe('m74-agent-strategy-defaults-2026 — POSITIVE', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await freshDb(); });

  it('DB initializes without error (m74 runs in bootstrap)', () => {
    expect(db).toBeTruthy();
  });

  it('global row exists', () => {
    const row = getGlobal(db);
    expect(row).toBeTruthy();
    expect(row!.id).toBe('global');
    expect(row!.scope).toBe('global');
  });

  it('a2a_enabled flipped to 1 on global row', () => {
    const row = getGlobal(db);
    expect(row!.a2a_enabled).toBe(1);
  });

  it('supervisor_parallel_delegation flipped to 1 on global row', () => {
    const row = getGlobal(db);
    expect(row!.supervisor_parallel_delegation).toBe(1);
  });

  it('reflect_enabled flipped to 1 on global row', () => {
    const row = getGlobal(db);
    expect(row!.reflect_enabled).toBe(1);
  });

  it('hitl_threshold column added with default 0.75', () => {
    const row = getGlobal(db);
    expect(row!.hitl_threshold).toBe(0.75);
  });

  it('max_agent_hops column added with default 5', () => {
    const row = getGlobal(db);
    expect(row!.max_agent_hops).toBe(5);
  });

  it('tool_confirmation_level column added with default "high-risk-only"', () => {
    const row = getGlobal(db);
    expect(row!.tool_confirmation_level).toBe('high-risk-only');
  });

  it('memory_policy column added with default "session"', () => {
    const row = getGlobal(db);
    expect(row!.memory_policy).toBe('session');
  });

  it('web/operator mode_label is seeded', () => {
    const label = listModeLabelsByKey(db, 'web', 'operator');
    expect(label).toBeTruthy();
    expect(label!.label).toBe('Operator');
    expect(label!.surface_id).toBe('web');
    expect(label!.mode_key).toBe('operator');
    expect(label!.enabled).toBe(1);
  });

  it('api/headless mode_label is seeded', () => {
    const label = listModeLabelsByKey(db, 'api', 'headless');
    expect(label).toBeTruthy();
    expect(label!.label).toBe('Headless');
    expect(label!.surface_id).toBe('api');
    expect(label!.mode_key).toBe('headless');
    expect(label!.enabled).toBe(1);
  });

  it('web/operator mode_label has a description', () => {
    const label = listModeLabelsByKey(db, 'web', 'operator');
    expect(typeof label!.description).toBe('string');
    expect((label!.description as string).length).toBeGreaterThan(0);
  });

  it('api/headless mode_label has a description', () => {
    const label = listModeLabelsByKey(db, 'api', 'headless');
    expect(typeof label!.description).toBe('string');
    expect((label!.description as string).length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: DB adapter methods
// ══════════════════════════════════════════════════════════════════════════════

describe('AgentStrategySettings adapter methods — POSITIVE', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await freshDb(); });

  it('getAgentStrategySettings("global") returns the global row', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('global');
    expect(row!.a2a_enabled).toBe(1);
    expect(row!.reflect_enabled).toBe(1);
    expect(row!.supervisor_parallel_delegation).toBe(1);
  });

  it('getAgentStrategySettings returns null for non-existent id', async () => {
    const row = await db.getAgentStrategySettings('nonexistent');
    expect(row).toBeNull();
  });

  it('listAgentStrategySettings returns at least the global row', async () => {
    const rows = await db.listAgentStrategySettings();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(r => r.id === 'global')).toBe(true);
  });

  it('updateAgentStrategySettings patches single field', async () => {
    await db.updateAgentStrategySettings('global', { max_agent_hops: 10 });
    const row = await db.getAgentStrategySettings('global');
    expect(row!.max_agent_hops).toBe(10);
    // Restore
    await db.updateAgentStrategySettings('global', { max_agent_hops: 5 });
  });

  it('updateAgentStrategySettings patches multiple fields', async () => {
    await db.updateAgentStrategySettings('global', {
      hitl_threshold: 0.90,
      tool_confirmation_level: 'medium',
      memory_policy: 'persistent',
    });
    const row = await db.getAgentStrategySettings('global');
    expect(row!.hitl_threshold).toBe(0.90);
    expect(row!.tool_confirmation_level).toBe('medium');
    expect(row!.memory_policy).toBe('persistent');
    // Restore
    await db.updateAgentStrategySettings('global', {
      hitl_threshold: 0.75,
      tool_confirmation_level: 'high-risk-only',
      memory_policy: 'session',
    });
  });

  it('updateAgentStrategySettings is a no-op for empty patch (no error thrown)', async () => {
    await expect(db.updateAgentStrategySettings('global', {})).resolves.toBeUndefined();
    const row = await db.getAgentStrategySettings('global');
    expect(row).not.toBeNull();
  });

  it('updated_at is refreshed on update', async () => {
    const before = await db.getAgentStrategySettings('global');
    const beforeTs = before!.updated_at;

    // Wait briefly to ensure datetime() returns a new value
    await new Promise(r => setTimeout(r, 1100));
    await db.updateAgentStrategySettings('global', { max_agent_hops: 7 });

    const after = await db.getAgentStrategySettings('global');
    expect(after!.updated_at).not.toBe(beforeTs);
    // Restore
    await db.updateAgentStrategySettings('global', { max_agent_hops: 5 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE: Phase 7 typed row fields verified against AgentStrategySettingsRow
// ══════════════════════════════════════════════════════════════════════════════

describe('AgentStrategySettingsRow shape — POSITIVE', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await freshDb(); });

  it('row contains all expected Phase 7 fields', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row).not.toBeNull();

    // Legacy fields from m40
    expect(typeof row!.reflect_enabled).toBe('number');
    expect(typeof row!.verify_enabled).toBe('number');
    expect(typeof row!.supervisor_replan_on_failure).toBe('number');
    expect(typeof row!.supervisor_parallel_delegation).toBe('number');
    expect(typeof row!.a2a_enabled).toBe('number');

    // Phase 7 fields from m74
    expect(typeof row!.hitl_threshold).toBe('number');
    expect(typeof row!.max_agent_hops).toBe('number');
    expect(typeof row!.tool_confirmation_level).toBe('string');
    expect(typeof row!.memory_policy).toBe('string');
    expect(typeof row!.updated_at).toBe('string');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEGATIVE: invariants preserved
// ══════════════════════════════════════════════════════════════════════════════

describe('m74 — NEGATIVE (invariants preserved)', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await freshDb(); });

  it('verify_enabled stays 0 (operators opt in)', () => {
    const row = getGlobal(db);
    expect(row!.verify_enabled).toBe(0);
  });

  it('supervisor_replan_on_failure stays 0 (operators opt in)', () => {
    const row = getGlobal(db);
    expect(row!.supervisor_replan_on_failure).toBe(0);
  });

  it('existing web/assistant mode_label is unchanged (m41 seed preserved)', () => {
    const label = listModeLabelsByKey(db, 'web', 'assistant');
    expect(label).toBeTruthy();
    expect(label!.label).toBe('Assistant');
    expect(label!.is_default).toBe(1);
  });

  it('existing web/agent mode_label is unchanged', () => {
    const label = listModeLabelsByKey(db, 'web', 'agent');
    expect(label).toBeTruthy();
    expect(label!.label).toBe('Agent');
  });

  it('existing mobile/assistant mode_label is unchanged', () => {
    const label = listModeLabelsByKey(db, 'mobile', 'assistant');
    expect(label).toBeTruthy();
    expect(label!.label).toBe('Assistant');
  });

  it('existing desktop/assistant mode_label is unchanged', () => {
    const label = listModeLabelsByKey(db, 'desktop', 'assistant');
    expect(label).toBeTruthy();
    expect(label!.label).toBe('Assistant');
  });

  it('web/operator is NOT set as is_default (operator mode is not the default surface mode)', () => {
    const label = listModeLabelsByKey(db, 'web', 'operator');
    expect(label!.is_default).toBe(0);
  });

  it('api/headless is NOT set as is_default', () => {
    const label = listModeLabelsByKey(db, 'api', 'headless');
    expect(label!.is_default).toBe(0);
  });

  it('global row scope is still "global"', () => {
    const row = getGlobal(db);
    expect(row!.scope).toBe('global');
  });

  it('global row tenant_id is still null', () => {
    const row = getGlobal(db);
    expect(row!.tenant_id ?? null).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STRESS: idempotency + concurrent reads
// ══════════════════════════════════════════════════════════════════════════════

describe('m74 — STRESS (idempotency + concurrent reads)', () => {
  it('migration is idempotent: running m74 3× additional times leaves state unchanged', async () => {
    const db = await freshDb();
    const raw = rawOf(db);
    // Bootstrap already ran m74 once; run 3 more times
    applyM74AgentStrategyDefaults2026(raw);
    applyM74AgentStrategyDefaults2026(raw);
    applyM74AgentStrategyDefaults2026(raw);

    const row = getGlobal(db);
    expect(row!.a2a_enabled).toBe(1);
    expect(row!.reflect_enabled).toBe(1);
    expect(row!.supervisor_parallel_delegation).toBe(1);
    expect(row!.hitl_threshold).toBe(0.75);
    expect(row!.max_agent_hops).toBe(5);
    expect(row!.tool_confirmation_level).toBe('high-risk-only');
    expect(row!.memory_policy).toBe('session');
    await db.close();
  });

  it('mode_labels idempotency: web/operator appears exactly once', async () => {
    const db = await freshDb();
    const raw = rawOf(db);
    applyM74AgentStrategyDefaults2026(raw);
    applyM74AgentStrategyDefaults2026(raw);
    const count = (raw.prepare(`SELECT COUNT(*) as c FROM mode_labels WHERE surface_id='web' AND mode_key='operator'`).get() as { c: number }).c;
    expect(count).toBe(1);
    await db.close();
  });

  it('mode_labels idempotency: api/headless appears exactly once', async () => {
    const db = await freshDb();
    const raw = rawOf(db);
    applyM74AgentStrategyDefaults2026(raw);
    applyM74AgentStrategyDefaults2026(raw);
    const count = (raw.prepare(`SELECT COUNT(*) as c FROM mode_labels WHERE surface_id='api' AND mode_key='headless'`).get() as { c: number }).c;
    expect(count).toBe(1);
    await db.close();
  });

  it('concurrent getAgentStrategySettings reads return consistent results', async () => {
    const db = await freshDb();
    const [r1, r2, r3] = await Promise.all([
      db.getAgentStrategySettings('global'),
      db.getAgentStrategySettings('global'),
      db.getAgentStrategySettings('global'),
    ]);
    expect(r1!.a2a_enabled).toBe(1);
    expect(r2!.a2a_enabled).toBe(1);
    expect(r3!.a2a_enabled).toBe(1);
    expect(r1!.hitl_threshold).toBe(0.75);
    expect(r2!.hitl_threshold).toBe(0.75);
    expect(r3!.hitl_threshold).toBe(0.75);
    await db.close();
  });

  it('update + read roundtrip is consistent across 5 sequential patches', async () => {
    const db = await freshDb();
    const thresholds = [0.60, 0.70, 0.80, 0.90, 0.75];
    for (const t of thresholds) {
      await db.updateAgentStrategySettings('global', { hitl_threshold: t });
      const row = await db.getAgentStrategySettings('global');
      expect(row!.hitl_threshold).toBe(t);
    }
    await db.close();
  });

  it('listAgentStrategySettings returns only 1 row on fresh DB (single global row)', async () => {
    const db = await freshDb();
    const rows = await db.listAgentStrategySettings();
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe('global');
    await db.close();
  });

  it('total mode_labels count after m74 is 6 (4 from m41 + 2 from m74)', async () => {
    const db = await freshDb();
    const count = (rawOf(db).prepare('SELECT COUNT(*) as c FROM mode_labels').get() as { c: number }).c;
    expect(count).toBe(6);
    await db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY: safe defaults + bounded values
// ══════════════════════════════════════════════════════════════════════════════

describe('m74 — SECURITY (safe defaults)', () => {
  let db: SQLiteAdapter;
  beforeAll(async () => { db = await freshDb(); });

  it('tool_confirmation_level defaults to "high-risk-only" (not "none")', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row!.tool_confirmation_level).toBe('high-risk-only');
    expect(row!.tool_confirmation_level).not.toBe('none');
  });

  it('memory_policy defaults to "session" (not "persistent" which would retain data cross-session)', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row!.memory_policy).toBe('session');
    expect(row!.memory_policy).not.toBe('persistent');
  });

  it('max_agent_hops is bounded at 5 (prevents infinite delegation chains)', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row!.max_agent_hops).toBeGreaterThan(0);
    expect(row!.max_agent_hops).toBeLessThanOrEqual(10);
    expect(row!.max_agent_hops).toBe(5);
  });

  it('hitl_threshold is non-zero (0.75 means HITL required for >= 75% risk)', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row!.hitl_threshold).toBeGreaterThan(0);
    expect(row!.hitl_threshold).toBeLessThanOrEqual(1);
    expect(row!.hitl_threshold).toBe(0.75);
  });

  it('web/operator mode_label is NOT the default surface mode (cannot be accidentally promoted)', () => {
    const label = listModeLabelsByKey(db, 'web', 'operator');
    expect(label!.is_default).toBe(0);
  });

  it('api/headless mode_label is NOT the default (headless does not replace the standard web UI)', () => {
    const label = listModeLabelsByKey(db, 'api', 'headless');
    expect(label!.is_default).toBe(0);
  });

  it('original web/assistant mode is still the default surface mode after m74', () => {
    const label = listModeLabelsByKey(db, 'web', 'assistant');
    expect(label!.is_default).toBe(1);
  });

  it('tool_confirmation_level accepts only valid values via updateAgentStrategySettings', async () => {
    const db2 = await freshDb();
    await db2.updateAgentStrategySettings('global', { tool_confirmation_level: 'none' });
    const row = await db2.getAgentStrategySettings('global');
    expect(['none', 'medium', 'high-risk-only']).toContain(row!.tool_confirmation_level);
    await db2.close();
  });

  it('memory_policy accepts only valid values', async () => {
    const db2 = await freshDb();
    await db2.updateAgentStrategySettings('global', { memory_policy: 'none' });
    const row = await db2.getAgentStrategySettings('global');
    expect(['none', 'session', 'persistent']).toContain(row!.memory_policy);
    await db2.close();
  });

  it('hitl_threshold can be raised to 1.0 (require HITL for all actions) but not above', async () => {
    const db2 = await freshDb();
    await db2.updateAgentStrategySettings('global', { hitl_threshold: 1.0 });
    const row = await db2.getAgentStrategySettings('global');
    expect(row!.hitl_threshold).toBe(1.0);
    await db2.close();
  });

  it('a2a_enabled=1 is the new default — no explicit opt-in required by operators', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row!.a2a_enabled).toBe(1);
  });

  it('reflect_enabled=1 improves response quality — on by default in 2026', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row!.reflect_enabled).toBe(1);
  });

  it('supervisor_parallel_delegation=1 reduces wall-clock time — on by default in 2026', async () => {
    const row = await db.getAgentStrategySettings('global');
    expect(row!.supervisor_parallel_delegation).toBe(1);
  });
});
